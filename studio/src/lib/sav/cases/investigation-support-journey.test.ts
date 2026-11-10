import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savSyncState } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Strict local ports: importing HubSpot, the model dispatcher or the call ledger fails the file; fetch throws.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
vi.mock("../intake/runtime-store", () => { throw Error("LEDGER_IMPORTED"); });
import { caseAdmissionStatus, type CaseAdmissionInput } from "./admission-policy";
import { markSavCaseCallDispatched, releaseSavCaseCall, reserveSavCaseCall, settleSavCaseCall } from "./case-calls";
import { listCaseEvents, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey, caseRequestId, type CaseAdmissionQualification, type CaseRequestSubject, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { caseReplyPayloadHash, checkCaseReplyApproval, decideCaseEffect, type CaseReplyApproval, type CaseReplyProposal } from "./case-effects";
import { caseCallLedgerAdapter } from "./investigation-call-ledger";
import { caseDecisionDraft, type CaseDecisionDraft } from "./investigation-intent";
import { selectCaseKnowledge, type CaseSubjectPort } from "./investigation-knowledge";
import { readCaseInvestigationProgress } from "./investigation-record";
import { runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest, type CaseInvestigationModelResult, type CaseInvestigationPorts } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * Weekend 30/10 → 01/11: B's useful investigation on the real pole A store (A 99e0fcd, migrations 0046-0048 after MCP
 * 0045, PGlite), from the relayed mail to the per-request knowledge, a supervised proposal and its versioned intents.
 * Read-only local test doubles outside A and B: the search backend, the model, the rules and the clock. No real model,
 * CRM or Gmail; nothing is sent, nothing published. Synthetic data only.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 8_800_000;
const STAFF = "20000000-0000-4000-8000-000000000002", AT = "2026-10-30T09:00:00.000Z", ACCESS = "https://new.limova.ai";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
type Identity = CaseAdmissionQualification["identity"];
const CONFIRMED: Identity = { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } };
const qualification = (requests: CaseAdmissionQualification["requests"], identity = CONFIRMED): CaseAdmissionQualification =>
  ({ requests, identity, crmContext: "complete", teamSignals: [] });
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
const byRule = (...requestIds: string[]): CaseAdmissionInput => ({ policy: POLICY, qualification: qualification(requestIds.map(ruled)) });
const hint = (id: string): CaseAdmissionInput =>
  ({ policy: POLICY, qualification: qualification([{ requestId: caseRequestId(id, "r1"), family: "unknown", provenance: { kind: "intake_hint", source: { type: "email", id } } }]) });

const DAY = 86_400_000, recent = () => new Date(Date.now() - 10 * DAY).toISOString();
const card = (id: string, version: string, extra: Partial<SavRetrievalCandidate["resolution"]> = {}): SavRetrievalCandidate => ({
  id, contentVersionId: version, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture", verifiedAt: recent(), semanticScore: null,
  resolution: { steps: ["Étape synthétique"], ...extra }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" },
});
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });

/** Read-only search double: cards by a pattern on the query; `down` fails the search, `unstable` moves the revision. */
const kb = { revision: "kb-r1", down: false, unstable: false, searches: 0, cards: [] as Array<{ match: RegExp; card: SavRetrievalCandidate }>, during: null as null | (() => Promise<void>) };
const backend: SavRetrievalBackend = {
  readRevision: async () => kb.unstable ? `kb-moving-${randomUUID()}` : kb.revision,
  search: async queries => {
    kb.searches += 1;
    if (kb.during) { const during = kb.during; kb.during = null; await during(); }
    if (kb.down) throw Error("SEARCH_DOWN_FIXTURE");
    return queries.map(query => kb.cards.filter(row => row.match.test(query)).map(row => row.card));
  },
};

/** The subject pole A's relay stores for a request (v10): V1's accepted, masked summary of it, with its provenance. */
const subject = (text: string): CaseRequestSubject => ({ status: "available", text, provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
  runId: "30000000-0000-4000-8000-000000000001", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: AT } });
/** A mail relayed by V1, opening `opens` (id suffix → searchable subject, or why it has none) under the relay's generic label, with the given admission. */
async function mail(ticketId: string, threadId: string, id: string, admission: CaseAdmissionInput, opens: Record<string, string | CaseRequestSubject> = { r1: "Connexion impossible à la plateforme." }, admissionMode?: "exclusions_only") {
  return (await openCaseEvent({ ticketId, threadId, admission, admissionMode, opens: Object.entries(opens).map(([suffix, about]) => ({ id: caseRequestId(id, suffix),
    summary: `Demande « support » relevée par l'analyse V1 du mail ${id}.`, subject: typeof about === "string" ? subject(about) : about })),
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(id), sourceRef: { type: "email", id }, occurredAt: new Date().toISOString() })).case;
}
async function accessCase(gmail: string) {
  const ticketId = String(++ticketSeq), threadId = randomUUID();
  return { ticketId, threadId, c: await mail(ticketId, threadId, gmail, byRule(caseRequestId(gmail, "r1"))) };
}

type Answer = (request: CaseInvestigationModelRequest) => CaseInvestigationModelResult;
const understood = (snapshot: CaseSnapshot) => ({ requests: snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] });
/** The procedure of `cited`, for `target` (default: the first open request), with the access link `link`. */
const answerWith = (cited: KnowledgeRef, options: { target?: (snapshot: CaseSnapshot) => string; link?: string } = {}): Answer => request => {
  const u = understood(request.snapshot), requestId = options.target?.(request.snapshot) ?? u.requests[0]!.id;
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "answer", requestIds: [requestId], steps: [{ text: "Suivre la fiche citée.", knowledge: cited }], expectedResult: "La connexion fonctionne." },
    reply: { text: `Bonjour, voici la marche à suivre${options.link === "" ? "" : ` depuis ${options.link ?? ACCESS}`} : suivre la fiche.`, citations: [cited], impossibilityClaims: [], accountAdvice: "none" } } };
};
/** A targeted question: what the customer saw, for the request without knowledge. */
const askTargeted: Answer = request => {
  const u = understood(request.snapshot);
  return { status: "ok", output: { caseVersion: request.snapshot.version, understanding: u,
    nextAction: { kind: "ask", questions: [{ text: "Quel message s'affiche après la saisie de votre adresse ?", requestId: u.requests[0]!.id, reducesUncertainty: "Distingue un code non reçu d'un écran de paiement.", seeks: [{ kind: "observed_result" }] }] },
    reply: { text: `Bonjour, depuis ${ACCESS}, quel message s'affiche après la saisie de votre adresse d'inscription ?`, citations: [], impossibilityClaims: [], accountAdvice: "none" } } };
};

type Run = { report: Awaited<ReturnType<typeof runCaseInvestigation>>; calls: CaseInvestigationModelRequest[] };
async function investigate(caseId: string, answers: Answer[], options: { identity?: Identity; during?: () => Promise<void>; subjectOf?: CaseSubjectPort; callModel?: CaseInvestigationPorts["callModel"] } = {}): Promise<Run> {
  const calls: CaseInvestigationModelRequest[] = [];
  const now = () => new Date(Date.now() + 6 * 60_000);
  const ports = caseInvestigationStorePorts({
    // Witness: the ticket explicitly carries the V2 owner (Ugo 31/10, the owner read fails closed without it).
    readTicketOwner: async () => "v2",
    holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    // Pole A's own subject port (`caseRequestSearchText`) unless a test overrides it.
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: now() }, options.subjectOf),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: async request => {
      calls.push(structuredClone(request));
      if (options.callModel) return options.callModel(request);
      const next = answers.shift();
      if (options.during) { const during = options.during; options.during = undefined; await during(); }
      return next?.(request) ?? { status: "failed", uncertain: false };
    },
    admissionPolicyRevision: async () => "policy-r1",
    // Q10: the approved rule qualifies every open request of the latest input as access, with the given identity.
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id));
      return latest ? { admission: { policy: POLICY, qualification: qualification(requests, options.identity ?? CONFIRMED) }, sourceRef: latest.sourceRef } : null;
    },
  });
  return { report: await runCaseInvestigation(caseId, "observe", ports), calls };
}

const latestRecord = async (caseId: string, inputKey: string) => {
  const read = readCaseInvestigationProgress(await listCaseEvents(caseId), inputKey);
  return read.state === "found" ? read.record : null;
};
const lastInputKey = async (caseId: string) => {
  const events = await listCaseEvents(caseId);
  const record = events.filter(event => event.kind === "observation_recorded").at(-1)?.detail?.record as { inputKey: string } | undefined;
  return record!.inputKey;
};
/** C's proposal as the console would complete it from the stored thread (synthetic recipient and subject), on the version shown. */
async function proposalOf(draft: CaseDecisionDraft): Promise<CaseReplyProposal> {
  return { caseId: draft.caseId, caseVersion: (await readCase(draft.caseId))!.version, triggerEventId: draft.triggerEventId!, inboundMessageId: "stored-inbound-1",
    recipient: "client@example.invalid", subject: "Accès à la plateforme", ...draft.reply! };
}
const approve = (proposal: CaseReplyProposal): CaseReplyApproval =>
  ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient, approvedBy: STAFF, approvedAt: new Date().toISOString() });
/** C's own gate on what A and the pause say now; B's draft never decides an effect. */
async function gate(proposal: CaseReplyProposal, approval: CaseReplyApproval) {
  return decideCaseEffect("none", { mode: "supervised", pause: { intake: "running", v2: (await readSavAgentPause(f.db as never, "v2")).level }, leaseValid: true,
    admission: caseAdmissionStatus((await readCase(proposal.caseId))!, "policy-r1"), recipient: "match", approval: checkCaseReplyApproval(proposal, approval) });
}
async function setV2Pause(level: "actions_paused" | "fully_paused" | null) {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
}
/** The input of the case, even before any decision was recorded. */
const lastInputKeyOrInbound = async (caseId: string) => `in:${(await listCaseEvents(caseId)).filter(event => event.direction === "customer_inbound").at(-1)!.id}`;
const outbound = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.direction === "agent_outbound").length;

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "support-journey-fixture-key-32-chars");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  Object.assign(kb, { revision: "kb-r1", down: false, unstable: false, searches: 0, cards: [], during: null });
});
afterEach(async () => { await setV2Pause(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const LOGIN = card("k-login", "k-login-v1"), CODE = card("k-code", "k-code-v1");

describe("useful supervised proposal: published knowledge per request, provenance, C's proposal and gate", () => {
  it("a covered access request: the model sees the card retrieved for it, the answer is recorded with its provenance, and C's gate sends nothing a person did not validate as is", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const { c } = await accessCase("gm-sj-ok");
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(calls[0]!.coverage).toEqual([{ requestId: "gm-sj-ok/r1", family: "access", status: "covered", knowledge: [refOf(LOGIN)], limitations: [] }]);
    expect(calls[0]!.knowledge).toEqual([LOGIN]);

    const stored = (await latestRecord(c.caseId, await lastInputKey(c.caseId)))!;
    expect(stored.decision).toMatchObject({ knowledgeRevision: "kb-r1", knowledge: [refOf(LOGIN)],
      coverage: [{ requestId: "gm-sj-ok/r1", status: "covered", knowledge: [refOf(LOGIN)], limitations: [] }], revisions: { model: "model-fixture", prompt: "prompt-r1" } });

    const draft = caseDecisionDraft(c.caseId, stored, await listCaseEvents(c.caseId))!;
    expect(draft).toMatchObject({ triggerEventId: "inbound:gm-sj-ok", decidedOn: stored.decision!.caseVersion, replyLimit: null, citations: [refOf(LOGIN)], decidedWhileActionsPaused: false,
      reply: { purpose: "answer", text: `Bonjour, voici la marche à suivre depuis ${ACCESS} : suivre la fiche.` } });
    expect(draft.noteText).toContain("Procédure proposée au client");
    expect(draft.noteText).toContain("[fiche k-login@k-login-v1]");

    const proposal = await proposalOf(draft), approval = approve(proposal);
    expect(await gate(proposal, approval)).toEqual({ action: "dispatch" });
    expect(await gate({ ...proposal, text: `${proposal.text} ` }, approval)).toEqual({ action: "cancel", code: "payload_changed" });
    expect(await gate(proposal, { ...approval, approvedBy: "" })).toEqual({ action: "cancel", code: "approval_invalid" });
    await setV2Pause("actions_paused");
    expect(await gate(proposal, approval)).toEqual({ action: "hold", code: "paused" });
    await setV2Pause("fully_paused");
    expect(await gate(proposal, approval)).toEqual({ action: "hold", code: "paused" });
    expect({ outbound: await outbound(c.caseId), network: vi.mocked(fetch).mock.calls.length }).toEqual({ outbound: 0, network: 0 });
  });

  it("a card retrieved for another request cannot support this one: refused with its own code, then corrected", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }, { match: /code/i, card: CODE }];
    const ticketId = String(++ticketSeq), threadId = randomUUID(), id = "gm-sj-link";
    const c = await mail(ticketId, threadId, id, byRule(caseRequestId(id, "r1"), caseRequestId(id, "r2")), { r1: "Connexion impossible à la plateforme.", r2: "Code de vérification jamais reçu." });
    const second = () => caseRequestId(id, "r2");
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(LOGIN), { target: second }), answerWith(refOf(CODE), { target: second })]);
    expect(calls[0]!.coverage!.map(row => [row.requestId, row.status, row.knowledge.map(ref => ref.knowledgeId)]))
      .toEqual([[caseRequestId(id, "r1"), "covered", ["k-login"]], [second(), "covered", ["k-code"]]]);
    expect(calls[1]!.feedback.map(row => [row.code, row.path])).toEqual([["knowledge_not_linked_to_request", "nextAction.steps.0.knowledge"]]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
  });
});

describe("what the model does not get: absent, stale or unreachable knowledge, sensitive or unconfirmed cases", () => {
  it("knowledge absent: the gap is shown per request; an answer without a card is refused, a targeted question is accepted", async () => {
    const { c } = await accessCase("gm-sj-gap");
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(LOGIN)), askTargeted]);
    expect(kb.searches).toBe(1);
    expect(calls[0]!.coverage).toEqual([{ requestId: "gm-sj-gap/r1", family: "access", status: "no_applicable_knowledge", knowledge: [], limitations: [] }]);
    expect(calls[0]!.knowledge).toEqual([]);
    expect(calls[1]!.feedback.map(row => row.code)).toEqual(["knowledge_reference_unknown", "knowledge_reference_unknown"]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 2 });
    const stored = (await latestRecord(c.caseId, await lastInputKey(c.caseId)))!;
    expect(stored.decision!.coverage).toEqual([{ requestId: "gm-sj-gap/r1", status: "no_applicable_knowledge", knowledge: [], limitations: [] }]);
    const draft = caseDecisionDraft(c.caseId, stored, await listCaseEvents(c.caseId))!;
    expect(draft.reply).toEqual({ purpose: "question", text: `Bonjour, depuis ${ACCESS}, quel message s'affiche après la saisie de votre adresse d'inscription ?`,
      question: { id: `${stored.inputKey}:q1`, text: "Quel message s'affiche après la saisie de votre adresse ?", factKeys: [] } });
    expect(draft.noteText).toContain("Question : Quel message s'affiche après la saisie de votre adresse ?");
  });

  it("stale knowledge: an expired card is never offered; a stored proposal on an older card version is corrected, never trusted", async () => {
    const EXPIRED = card("k-expired", "k-expired-v1", { validUntil: "2026-01-01" });
    kb.cards = [{ match: /connexion/i, card: LOGIN }, { match: /connexion/i, card: EXPIRED }];
    const { c } = await accessCase("gm-sj-stale");
    // Run 1: a proposal missing the access link, then a technical failure: the proposal is stored, not recorded.
    const first = await investigate(c.caseId, [answerWith(refOf(LOGIN), { link: "" })]);
    expect(first.report).toMatchObject({ status: "technical_wait", modelCalls: 2 });
    expect(first.calls[0]!.knowledge.map(row => row.id)).toEqual(["k-login"]);
    // The card is republished in a new version before the next run.
    const LOGIN2 = card("k-login", "k-login-v2");
    kb.cards = [{ match: /connexion/i, card: LOGIN2 }, { match: /connexion/i, card: EXPIRED }];
    kb.revision = "kb-r2";
    const second = await investigate(c.caseId, [answerWith(refOf(LOGIN2))]);
    expect(second.calls[0]!.feedback.map(row => row.code).sort()).toEqual(["access_link_missing", "knowledge_revision_mismatch", "knowledge_revision_mismatch"]);
    expect(second.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 3 });
    expect([...first.calls, ...second.calls].flatMap(call => call.knowledge.map(row => row.id))).not.toContain("k-expired");
    expect((await latestRecord(c.caseId, await lastInputKey(c.caseId)))!.decision).toMatchObject({ knowledgeRevision: "kb-r2", knowledge: [refOf(LOGIN2)] });
  });

  it("search down or revision moving: a visible technical wait with no model call; a failed search is never an absence", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const { c } = await accessCase("gm-sj-down");
    kb.down = true;
    const down = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(down).toMatchObject({ report: { status: "technical_wait", modelCalls: 0 }, calls: [] });
    const inputKey = await lastInputKey(c.caseId);
    const waiting = (await latestRecord(c.caseId, inputKey))!.progress.waiting;
    expect(waiting).toMatchObject({ reason: "technical_wait" });
    kb.down = false; kb.unstable = true;
    const moving = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(moving).toMatchObject({ report: { status: "technical_wait", modelCalls: 0 }, calls: [] });
    // Still the same wait, with its first start time: a case stuck on the search stays measurable.
    expect((await latestRecord(c.caseId, inputKey))!.progress.waiting!.since).toBe(waiting!.since);
    kb.unstable = false;
    expect((await investigate(c.caseId, [answerWith(refOf(LOGIN))])).report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
  });

  it("a mixed mail (access + finance) is stopped before any search or model call", async () => {
    const ticketId = String(++ticketSeq), threadId = randomUUID(), id = "gm-sj-mixed";
    const admission: CaseAdmissionInput = { policy: POLICY, qualification: qualification([ruled(caseRequestId(id, "r1")),
      { requestId: caseRequestId(id, "r2"), family: "finance", provenance: { kind: "intake_hint", source: { type: "email", id } } }]) };
    const c = await mail(ticketId, threadId, id, admission, { r1: "Connexion impossible à la plateforme.", r2: "Demande de remboursement." });
    expect(c.admission).toMatchObject({ target: "team" });
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(report).toMatchObject({ status: "skipped", reason: "excluded_sensitive", modelCalls: 0 });
    expect({ calls: calls.length, searches: kb.searches }).toEqual({ calls: 0, searches: 0 });
  });

  it("wrong contact: a new mail from an unconfirmed identity; the rules re-evaluate it, the team keeps it, no search, no call", async () => {
    const { ticketId, threadId, c } = await accessCase("gm-sj-contact");
    await mail(ticketId, threadId, "gm-sj-contact-2", hint("gm-sj-contact-2"), undefined, "exclusions_only");
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(LOGIN))], { identity: { status: "ambiguous" } as Identity });
    expect(report).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect((await readCase(c.caseId))!.admission).toMatchObject({ target: "qualification", reasons: ["identity_unconfirmed"] });
    expect({ calls: calls.length, searches: kb.searches }).toEqual({ calls: 0, searches: 0 });
  });
});

describe("budget, uncertain usage and a new message during the investigation", () => {
  it("a deferred call consumes nothing; an uncertain call is verify-only, even when the search is down", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const { c } = await accessCase("gm-sj-budget");
    expect((await investigate(c.caseId, [() => ({ status: "deferred" })])).report).toMatchObject({ status: "deferred_budget", modelCalls: 0 });
    expect((await investigate(c.caseId, [() => ({ status: "failed", uncertain: true })])).report).toMatchObject({ status: "usage_uncertain", modelCalls: 1 });
    const again = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(again).toMatchObject({ report: { status: "usage_uncertain", modelCalls: 1 }, calls: [] });
    kb.down = true;
    const down = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(down).toMatchObject({ report: { status: "usage_uncertain", modelCalls: 1 }, calls: [] });
  });

  it("a message arriving during the call: stale_requeue; the old intents are blocked; the next input is decided on fresh knowledge", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const { ticketId, threadId, c } = await accessCase("gm-sj-new");
    expect((await investigate(c.caseId, [answerWith(refOf(LOGIN))])).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    const firstInput = await lastInputKey(c.caseId);
    const proposal = await proposalOf(caseDecisionDraft(c.caseId, (await latestRecord(c.caseId, firstInput))!, await listCaseEvents(c.caseId))!), approval = approve(proposal);
    expect(await gate(proposal, approval)).toEqual({ action: "dispatch" });

    await mail(ticketId, threadId, "gm-sj-new-2", hint("gm-sj-new-2"), undefined, "exclusions_only");
    const during = await investigate(c.caseId, [answerWith(refOf(LOGIN))],
      { during: async () => { await mail(ticketId, threadId, "gm-sj-new-3", hint("gm-sj-new-3"), undefined, "exclusions_only"); } });
    expect(during.report).toMatchObject({ status: "stale_requeue", modelCalls: 1 });
    // The validated draft of the first input may not be sent any more: a newer message exists (C's gate on A's admission).
    expect(await gate(proposal, approval)).toEqual({ action: "cancel", code: "new_input" });

    kb.revision = "kb-r2";
    const next = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(next.report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    const nextInput = await lastInputKey(c.caseId);
    expect(nextInput).not.toBe(firstInput);
    expect((await latestRecord(c.caseId, nextInput))!.decision).toMatchObject({ knowledgeRevision: "kb-r2" });
    expect(await outbound(c.caseId)).toBe(0);
  });
});

describe("during the search or the call: subject, pause, a person, an uncertain answer (ROOT 30/10 13:39)", () => {
  it("a request without a searchable subject (pole A: V1's summary covers two requests) is not searched, and the cause is stored for the console", async () => {
    kb.cards = [{ match: /./, card: LOGIN }];
    const ticketId = String(++ticketSeq), id = "gm-sj-nosubject";
    const c = await mail(ticketId, randomUUID(), id, byRule(caseRequestId(id, "r1")), { r1: { status: "absent", reason: "summary_shared" } });
    const { report, calls } = await investigate(c.caseId, [askTargeted]);
    expect(kb.searches).toBe(0);
    expect(calls[0]!.knowledge).toEqual([]);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted" });
    const stored = (await latestRecord(c.caseId, await lastInputKey(c.caseId)))!;
    expect(stored.decision!.coverage).toEqual([{ requestId: "gm-sj-nosubject/r1", status: "not_searched", knowledge: [], limitations: ["subject_unavailable", "subject_summary_shared"] }]);
  });

  it("a full pause set while the knowledge is searched: no call, the wait is stored as paused", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const { c } = await accessCase("gm-sj-pause-search");
    kb.during = () => setV2Pause("fully_paused");
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(report).toMatchObject({ status: "paused", modelCalls: 0 });
    expect(calls).toHaveLength(0);
    const progress = readCaseInvestigationProgress(await listCaseEvents(c.caseId), await lastInputKeyOrInbound(c.caseId));
    expect(progress).toMatchObject({ state: "found", record: { progress: { waiting: { reason: "paused" }, modelCalls: 0 } } });
  });

  it("a person takes the case while the knowledge is searched: nothing is recorded for the agent (stale), the call already made is counted", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const { c } = await accessCase("gm-sj-takeover");
    kb.during = async () => {
      const now = (await readCase(c.caseId))!;
      await transitionCaseOwner({ caseId: c.caseId, expectedVersion: now.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: "sj-takeover", reason: "fixture" });
    };
    const { report, calls } = await investigate(c.caseId, [answerWith(refOf(LOGIN))]);
    expect(report).toMatchObject({ status: "stale_requeue" });
    // Observed, not patched (score 2 x 2 = 4, issue only): the ownership is re-read at the write, not before the call.
    expect(calls).toHaveLength(1);
    expect((await readCase(c.caseId))!.owner).toBe("human");
    expect(await outbound(c.caseId)).toBe(0);
  });

  it("an uncertain answer on pole A's real ledger: stored as usage_uncertain, never dispatched again by a later run", async () => {
    kb.cards = [{ match: /connexion/i, card: LOGIN }];
    const { c } = await accessCase("gm-sj-uncertain");
    const provider = vi.fn(async () => { throw Error("PROVIDER_TIMEOUT_FIXTURE"); });
    const callModel = caseCallLedgerAdapter({ ledger: { reserve: reserveSavCaseCall, markDispatched: markSavCaseCallDispatched, settle: settleSavCaseCall, release: releaseSavCaseCall },
      money: async () => ({ status: "allowed" }), provider, holder: "sav-v2-investigation", leaseSeconds: 60, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS });
    expect((await investigate(c.caseId, [], { callModel })).report).toMatchObject({ status: "usage_uncertain", modelCalls: 1 });
    expect((await investigate(c.caseId, [], { callModel })).report).toMatchObject({ status: "usage_uncertain", modelCalls: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
