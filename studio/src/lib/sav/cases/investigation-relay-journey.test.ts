import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
import { savCaseCalls, savCaseEffectExecutions, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Strict local ports: no V1 executor or model dispatcher, and fetch throws (A's relay imports the CRM module, never calls it here).
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { caseAdmissionStatus } from "./admission-policy";
import { markSavCaseCallDispatched, releaseSavCaseCall, reserveSavCaseCall, settleSavCaseCall } from "./case-calls";
import { caseRecipientCheck, caseReplyKey, caseReplyPayloadHash, checkCaseReplyApproval, decideCaseEffect, inboundInteractionId, type CaseReplyApproval, type CaseReplyProposal } from "./case-effects";
import { listCaseEvents, readCase, readCaseByTicket, transitionCaseOwner } from "./case-store";
import type { CaseAdmissionQualification, CaseSnapshot, KnowledgeRef } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { decideCaseReply, enqueueApprovedCaseReply, submitCaseReplyProposal } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { caseCallLedgerAdapter, type CaseCallLedgerPort, type CaseCallMoneyGate } from "./investigation-call-ledger";
import { caseDecisionDraft } from "./investigation-intent";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput, runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * ROOT 30/10 (B-raccord-v10-durable): the whole path on the real stores of A and B, without any real port. A V1 execution
 * and its accepted analysis are stored → pole A's relay opens the case and records each request's subject (v10) →
 * V1's verified V2 owner effect gives it to the agent (v9) → B searches the subject read only, never the relay's label →
 * one model call through A's call ledger (reserve → money gate → mark dispatched → provider → settle) → a recorded
 * decision → the CaseReplyProposal for C and the console, behind C's pure gate. Synthetic data; nothing sent or published.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 8_900_000;
const AT = "2026-10-30T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000003", V2_OWNER = "90000001", ACCESS = "https://new.limova.ai";
const SENDER = "client@example.invalid";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } };
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
/** The qualification port a future approved rule would give: every relayed request is access, identity confirmed. Never injected in production. */
const readQualification = async (input: { requests: { requestId: string }[] }): Promise<CaseAdmissionQualification> =>
  ({ requests: input.requests.map(request => ruled(request.requestId)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] });

/** V1 side, as its executor and recorder leave it: the message, the confirmed execution, the accepted analysis, the V2 owner effect. */
async function v1Mail(options: { ticketId?: string; threadId?: string; summary?: { title: string; description: string } | null } = {}) {
  const ticketId = options.ticketId ?? String(++seq), threadId = options.threadId ?? randomUUID(), messageId = randomUUID();
  if (!options.threadId) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Corps synthétique" }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
  // V1 numbers its runs per thread: a second mail of the thread is run 2.
  const runVersion = (await f.db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, threadId))).length + 1;
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: [{ id: "r0", kind: "support" }] } } }) }).returning();
  const summary = options.summary === undefined ? { title: "Connexion impossible", description: "Le code de connexion n'arrive pas. Contact : client@example.invalid, commande 12345678." } : options.summary;
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: [{ id: "r0", kind: "support", currentMessageId: messageId }], ...(summary ? { ticketSummary: { ...summary, requestIds: ["r0"] } } : {}) };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: runVersion, isCurrent: false, state: "observed", configHash: `relay-journey-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
      records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  await f.db.update(savIntakeExecutions).set({ runId: run!.id, runVersion }).where(eq(savIntakeExecutions.id, execution!.id));
  const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
  await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
    intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }),
    readAdmissionPolicy: async () => POLICY, readQualification, env: { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" } }) as { caseId: string };
  return { ticketId, threadId, messageId, gmail: `gm-${messageId}`, caseId: relayed.caseId };
}

const DAY = 86_400_000;
const card = (id: string): SavRetrievalCandidate => ({ id, contentVersionId: `${id}-v1`, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture",
  verifiedAt: new Date(Date.now() - 10 * DAY).toISOString(), semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } });
const LOGIN = card("k-login"), LABEL = card("k-label");
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });
/** Read-only search double: the login card for a login subject; a card that only the relay's label would find. */
const kb = { queries: [] as string[][], during: null as null | (() => Promise<void>) };
const backend: SavRetrievalBackend = {
  readRevision: async () => "kb-r1",
  search: async queries => {
    kb.queries.push([...queries]);
    if (kb.during) { const during = kb.during; kb.during = null; await during(); }
    return queries.map(query => /relevée par l'analyse/.test(query) ? [LABEL] : /connexion/i.test(query) ? [LOGIN] : []);
  },
};

/** The synthetic model behind the provider port: the login procedure for the first open request. */
const answer = (request: CaseInvestigationModelRequest) => {
  const snapshot: CaseSnapshot = request.snapshot, open = snapshot.body.openRequests.filter(row => row.status === "open");
  return { status: "ok" as const, output: { caseVersion: snapshot.version,
    understanding: { requests: open.map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
    nextAction: { kind: "answer", requestIds: [open[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: refOf(LOGIN) }], expectedResult: "La connexion fonctionne." },
    reply: { text: `Bonjour, voici la marche à suivre depuis ${ACCESS} : suivre la fiche.`, citations: [refOf(LOGIN)], impossibilityClaims: [], accountAdvice: "none" } } };
};
const realLedger: CaseCallLedgerPort = { reserve: reserveSavCaseCall, markDispatched: markSavCaseCallDispatched, settle: settleSavCaseCall, release: releaseSavCaseCall };
const allow: CaseCallMoneyGate = async () => ({ status: "allowed" });

/** B's runner on A's store, A's call ledger and B's knowledge read, with only the provider, search, rules and clock as doubles. */
async function investigate(caseId: string, options: { provider?: (request: CaseInvestigationModelRequest) => Promise<{ status: "ok"; output: unknown }>; money?: CaseCallMoneyGate; ledger?: CaseCallLedgerPort } = {}) {
  const now = () => new Date(Date.now() + 6 * 60_000);
  const provider = vi.fn(options.provider ?? (async (request: CaseInvestigationModelRequest) => answer(request)));
  const ports = caseInvestigationStorePorts({
    // Witness: the ticket explicitly carries the V2 owner (Ugo 31/10, the owner read fails closed without it).
    readTicketOwner: async () => "v2",
    holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: caseCallLedgerAdapter({ ledger: options.ledger ?? realLedger, money: options.money ?? allow, provider, holder: "sav-v2-investigation", leaseSeconds: 60, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS }),
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id));
      return latest ? { admission: { policy: POLICY, qualification: { requests, identity: CONFIRMED, crmContext: "complete" as const, teamSignals: [] } }, sourceRef: latest.sourceRef } : null;
    },
  });
  return { report: await runCaseInvestigation(caseId, "observe", ports), provider };
}

const inputKeyOf = async (caseId: string) => `in:${(await listCaseEvents(caseId)).filter(event => event.direction === "customer_inbound").at(-1)!.id}`;
const recordOf = async (caseId: string) => {
  const events = await listCaseEvents(caseId), read = readCaseInvestigationProgress(events, latestInvestigationInput(events)!);
  return read.state === "found" ? read.record : null;
};
const callsOf = async (caseId: string) => f.db.select().from(savCaseCalls).where(eq(savCaseCalls.caseId, caseId));
/** C's proposal as the console completes it from the stored thread: recipient and inbound from the stored message, on the version shown. */
async function proposalFor(caseId: string, recipient = SENDER): Promise<CaseReplyProposal> {
  const draft = caseDecisionDraft(caseId, (await recordOf(caseId))!, await listCaseEvents(caseId))!;
  return { caseId, caseVersion: (await readCase(caseId))!.version, triggerEventId: draft.triggerEventId!, inboundMessageId: "stored-inbound", recipient, subject: "Accès à la plateforme", ...draft.reply!, text: finalReplyText(draft.reply!.text) };
}
const approve = (proposal: CaseReplyProposal): CaseReplyApproval =>
  ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient, approvedBy: STAFF, approvedAt: new Date().toISOString() });
/** C's pure gate on what A, the pause and the stored sender say now. B decides no effect. */
async function gate(proposal: CaseReplyProposal, approval: CaseReplyApproval, storedSender: string | null = SENDER) {
  return decideCaseEffect("none", { mode: "supervised", pause: { intake: "running", v2: (await readSavAgentPause(f.db as never, "v2")).level }, leaseValid: true,
    admission: caseAdmissionStatus((await readCase(proposal.caseId))!, "policy-r1"), recipient: caseRecipientCheck(proposal.recipient, storedSender), approval: checkCaseReplyApproval(proposal, approval) });
}
async function setV2Pause(level: "actions_paused" | "fully_paused" | null) {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
}

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "relay-journey-fixture-key-32-chars!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-relay-journey-admin", email: "relay-journey-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "relay-journey-fixture-key-32-chars!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  Object.assign(kb, { queries: [], during: null });
});
afterEach(async () => { await setV2Pause(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("stored V1 mail → A's relay (subject, verified owner) → B's read-only knowledge and one ledger call → a proposal for C and the console", () => {
  it("searches V1's masked subject, never the label; one call through A's ledger; the proposal passes C's gate only as validated", async () => {
    const mail = await v1Mail();
    const stored = (await readCaseByTicket(mail.ticketId))!;
    expect(stored).toMatchObject({ owner: "agent", body: { openRequests: [{ id: `${mail.gmail}/r0`, family: "access", subject: { status: "available" } }] } });
    expect(stored.body.openRequests[0]!.summary).toMatch(/relevée par l'analyse V1/);

    const { report, provider } = await investigate(mail.caseId);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(kb.queries).toEqual([["Connexion impossible. Le code de connexion n'arrive pas. Contact : [email masqué], commande [numéro masqué]."]]);
    expect(provider.mock.calls[0]![0].knowledge).toEqual([LOGIN]);
    expect(await callsOf(mail.caseId)).toMatchObject([{ state: "settled" }]);
    const record = (await recordOf(mail.caseId))!;
    expect(record.decision).toMatchObject({ knowledgeRevision: "kb-r1", coverage: [{ requestId: `${mail.gmail}/r0`, status: "covered", knowledge: [refOf(LOGIN)], limitations: [] }] });

    const proposal = await proposalFor(mail.caseId), approval = approve(proposal);
    expect(proposal).toMatchObject({ triggerEventId: `inbound:${mail.gmail}`, purpose: "answer", recipient: SENDER });
    expect(await gate(proposal, approval)).toEqual({ action: "dispatch" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("a relayed request without a V1 summary is not searched: the call still happens, the cause is stored", async () => {
    const mail = await v1Mail({ summary: null });
    expect((await readCase(mail.caseId))!.body.openRequests[0]!.subject).toEqual({ status: "absent", reason: "not_in_summary" });
    await investigate(mail.caseId, { provider: async request => ({ status: "ok", output: { caseVersion: request.snapshot.version,
      understanding: { requests: [{ id: `${mail.gmail}/r0`, summary: "Connexion impossible.", family: "access", status: "open" }], newFacts: [] },
      nextAction: { kind: "ask", questions: [{ text: "Quel message s'affiche après la saisie de votre adresse ?", requestId: `${mail.gmail}/r0`, reducesUncertainty: "Code ou paiement.", seeks: [{ kind: "observed_result" }] }] },
      reply: { text: `Bonjour, depuis ${ACCESS}, quel message s'affiche après la saisie de votre adresse d'inscription ?`, citations: [], impossibilityClaims: [], accountAdvice: "none" } } }) });
    expect(kb.queries).toEqual([]);
    expect((await recordOf(mail.caseId))!.decision!.coverage).toEqual([{ requestId: `${mail.gmail}/r0`, status: "not_searched", knowledge: [], limitations: ["subject_unavailable", "subject_not_in_summary"] }]);
  });
});

describe("one stored mail, one reply key (B-5): every producer derives C's key from the stored inbound fact", () => {
  it("B's draft, the console's own derivation from the stored message, a rerun and a hand back on the same mail give the same key; a new mail a new key", async () => {
    const mail = await v1Mail();
    await investigate(mail.caseId);
    const key = (trigger: string) => caseReplyKey(mail.caseId, trigger), fromB = (await proposalFor(mail.caseId)).triggerEventId;
    // The console knows only the stored message it shows: it derives the same trigger from the row, never from the case's input key.
    const [row] = await f.db.select({ gmail: savMessages.gmailMessageId }).from(savMessages).where(eq(savMessages.id, mail.messageId));
    expect(key(fromB)).toBe(key(inboundInteractionId(row!.gmail!)));
    expect(key(fromB)).toBe(`reply:${mail.caseId}:inbound:${mail.gmail}`);
    expect(fromB).not.toBe(await inputKeyOf(mail.caseId));
    // A rerun of the same input is already recorded: the draft and its key do not move.
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "already_recorded" });
    expect((await proposalFor(mail.caseId)).triggerEventId).toBe(fromB);

    // A person takes the case and gives it back without a new mail: a new input (`back:`), still a reply to the same mail, so the same key.
    let now = (await readCase(mail.caseId))!;
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: now.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `rj-key-take-${mail.caseId}`, reason: "fixture" });
    now = (await readCase(mail.caseId))!;
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: now.version, transition: "hand_back", actor: { type: "human", staffUserId: STAFF }, commandKey: `rj-key-back-${mail.caseId}`, reason: "fixture", to: "agent",
      admission: { policy: POLICY, qualification: { requests: now.body.openRequests.map(request => ruled(request.id)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] } } });
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(latestInvestigationInput(await listCaseEvents(mail.caseId))).toMatch(/^back:/);
    expect(key((await proposalFor(mail.caseId)).triggerEventId)).toBe(key(fromB));

    // A new customer mail is a new input and a new key.
    const second = await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId, summary: { title: "Connexion toujours impossible", description: "Le lien expire." } });
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect((await proposalFor(mail.caseId)).triggerEventId).toBe(`inbound:${second.gmail}`);
    expect(key(`inbound:${second.gmail}`)).not.toBe(key(fromB));
  });
});

describe("counter-tests on the same path: pause, new message, a person, crash, double key, money gate, wrong recipient, stale proposal", () => {
  it("full pause: no search, no reservation, no call", async () => {
    const mail = await v1Mail();
    await setV2Pause("fully_paused");
    const { report, provider } = await investigate(mail.caseId);
    expect(report).toMatchObject({ status: "paused", modelCalls: 0 });
    expect({ searches: kb.queries.length, reserved: (await callsOf(mail.caseId)).length, sent: provider.mock.calls.length }).toEqual({ searches: 0, reserved: 0, sent: 0 });
  });

  it("the money gate refuses before dispatch: the key is released, nothing is sent, the ceiling is intact; allowed later, call 1 goes out once", async () => {
    const mail = await v1Mail();
    const refused = await investigate(mail.caseId, { money: async () => ({ status: "refused", reason: "daily_budget" }) });
    expect(refused.report).toMatchObject({ status: "deferred_budget", modelCalls: 0 });
    expect(refused.provider).not.toHaveBeenCalled();
    expect((await callsOf(mail.caseId)).map(row => row.state)).toEqual(["released"]);
    const allowed = await investigate(mail.caseId);
    expect(allowed.report).toMatchObject({ status: "recorded", modelCalls: 1 });
    expect((await callsOf(mail.caseId)).map(row => [row.callKey.endsWith(":call1"), row.state])).toEqual([[true, "settled"]]);
  });

  it("a crash after dispatch (settle never written): the next run never sends the key again and stays verify-only", async () => {
    const mail = await v1Mail();
    const dying: CaseCallLedgerPort = { ...realLedger, settle: async () => { throw Error("PROCESS_KILLED_FIXTURE"); } };
    const first = await investigate(mail.caseId, { ledger: dying }).catch((error: Error) => error);
    expect(first).toBeInstanceOf(Error);
    const again = await investigate(mail.caseId);
    expect(again.report).toMatchObject({ status: "usage_uncertain" });
    expect(again.provider).not.toHaveBeenCalled();
    expect((await callsOf(mail.caseId)).map(row => row.state)).toEqual(["dispatched"]);
  });

  it("two runs at once on the same input (same call key): one dispatch, one record", async () => {
    const mail = await v1Mail();
    const provider = vi.fn(async (request: CaseInvestigationModelRequest) => { await new Promise(resolve => setTimeout(resolve, 5)); return answer(request); });
    const runs = await Promise.all([investigate(mail.caseId, { provider }), investigate(mail.caseId, { provider })]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(runs.map(run => run.report.status).sort()).toEqual(["claim_refused", "recorded"]);
    expect((await callsOf(mail.caseId)).length).toBe(1);
  });

  it("a person takes the case after the proposal: C's gate cancels it (owner_changed)", async () => {
    const mail = await v1Mail();
    await investigate(mail.caseId);
    const proposal = await proposalFor(mail.caseId), approval = approve(proposal), now = (await readCase(mail.caseId))!;
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: now.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `rj-takeover-${mail.caseId}`, reason: "fixture" });
    expect(await gate(proposal, approval)).toEqual({ action: "cancel", code: "owner_changed" });
  });

  it("a new mail relayed after the proposal makes it stale (new_input); the new mail is its own input, searched on its own subject", async () => {
    const mail = await v1Mail();
    await investigate(mail.caseId);
    const firstInput = await inputKeyOf(mail.caseId), proposal = await proposalFor(mail.caseId), approval = approve(proposal);
    expect(await gate(proposal, approval)).toEqual({ action: "dispatch" });
    await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId, summary: { title: "Connexion toujours impossible", description: "Le lien de connexion expire." } });
    expect(await gate(proposal, approval)).toEqual({ action: "cancel", code: "new_input" });
    kb.queries = [];
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(await inputKeyOf(mail.caseId)).not.toBe(firstInput);
    expect(kb.queries.flat()).toContain("Connexion toujours impossible. Le lien de connexion expire.");
    expect(kb.queries.flat().some(query => /relevée par l'analyse/.test(query))).toBe(false);
  });

  it("a proposal addressed to someone else than the stored sender, or whose sender is unreadable, is never dispatched", async () => {
    const mail = await v1Mail();
    await investigate(mail.caseId);
    const wrong = await proposalFor(mail.caseId, "autre@example.invalid");
    expect(await gate(wrong, approve(wrong))).toEqual({ action: "cancel", code: "recipient_changed" });
    const right = await proposalFor(mail.caseId);
    expect(await gate(right, approve(right), null)).toEqual({ action: "hold", code: "recipient_unreadable" });
    const [message] = await f.db.select({ fromEmail: savMessages.fromEmail }).from(savMessages).where(eq(savMessages.gmailMessageId, mail.gmail));
    expect(caseRecipientCheck(right.recipient, message!.fromEmail)).toBe("match");
  });
});

describe("composition C 4652e46 (A 0051, C's canonical trigger): B's proposal through C's durable validation, one key per stored mail", () => {
  const deps = { env: () => ({ SAV_CASE_EFFECTS: "supervised" }), readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "policy-r1" };
  const allowFixture: CaseReplyAuthorizer = () => ({ allowed: true, basis: "fixture.allow" });
  const seenOf = (proposal: CaseReplyProposal) => ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient });
  const approveRow = (id: string, proposal: CaseReplyProposal) => decideCaseReply({ action: "approve", validationId: id, approverId: STAFF, seen: seenOf(proposal), authorizer: allowFixture, deps });
  /** B's proposal answering the stored inbound of the relayed mail. */
  const fromB = async (mail: { caseId: string; messageId: string }, recipient = SENDER) => ({ ...(await proposalFor(mail.caseId, recipient)), inboundMessageId: mail.messageId });
  /** The console's own proposal for the stored message it shows: its trigger is derived from that row, with another text. */
  const fromConsole = async (mail: { caseId: string; messageId: string }, text = finalReplyText("Bonjour, texte saisi depuis la console.")) => {
    const [row] = await f.db.select({ gmail: savMessages.gmailMessageId }).from(savMessages).where(eq(savMessages.id, mail.messageId));
    return { ...(await fromB(mail)), triggerEventId: inboundInteractionId(row!.gmail!), text };
  };
  /** The RFC Message-ID the executor's context needs, added to the synthetic stored mail. */
  const withHeaders = (messageId: string) => f.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: "Corps synthétique", headers: { "message-id": `<${messageId}@example.invalid>` }, attachments: [] }) }).where(eq(savMessages.id, messageId));
  const queue = (validationId: string) => enqueueApprovedCaseReply({ validationId, policy: { id: policyId, hash: "fixture" }, deps });

  it("two producers of a reply to the same mail share C's key: B's former alias resolves to it, a made-up one is refused; one approval, one execution", async () => {
    const mail = await v1Mail();
    await investigate(mail.caseId);
    await withHeaders(mail.messageId);
    const agent = await fromB(mail), console_ = await fromConsole(mail);
    expect(caseReplyKey(mail.caseId, agent.triggerEventId)).toBe(caseReplyKey(mail.caseId, console_.triggerEventId));
    // A made-up or suffixed name of the same mail is refused, nothing written; B's former input key (`in:<event>`) is resolved by C to the same canonical key.
    expect(await submitCaseReplyProposal({ ...agent, triggerEventId: `${agent.triggerEventId}:2` }, deps)).toMatchObject({ ok: false, code: "trigger_invalid" });
    expect(await submitCaseReplyProposal({ ...agent, triggerEventId: `inbound:gm-other-${mail.caseId}` }, deps)).toMatchObject({ ok: false });
    const first = await submitCaseReplyProposal(agent, deps) as { id: string };
    expect(await submitCaseReplyProposal({ ...agent, triggerEventId: await inputKeyOf(mail.caseId) }, deps)).toEqual({ ok: true, id: first.id, created: false, state: "proposed" });
    expect(await submitCaseReplyProposal(agent, deps)).toEqual({ ok: true, id: first.id, created: false, state: "proposed" });
    expect(await approveRow(first.id, agent)).toMatchObject({ ok: true, changed: true });
    // The console, same mail, another text: same key, so refused once the agent's reply is approved.
    expect(await submitCaseReplyProposal(console_, deps)).toEqual({ ok: false, code: "trigger_already_approved" });
    const [a, b] = await Promise.all([queue(first.id), queue(first.id)]);
    expect(a).toMatchObject({ ok: true }); expect(b).toMatchObject({ ok: true });
    expect((a as { executionId: string }).executionId).toBe((b as { executionId: string }).executionId);
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, mail.caseId))).toHaveLength(1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("before any approval, the second producer replaces the first on the same key: only the latest can be approved", async () => {
    const mail = await v1Mail();
    await investigate(mail.caseId);
    const agent = await fromB(mail), console_ = await fromConsole(mail);
    const first = await submitCaseReplyProposal(agent, deps) as { id: string }, second = await submitCaseReplyProposal(console_, deps) as { id: string };
    expect(await approveRow(first.id, agent)).toEqual({ ok: false, code: "not_proposed", detail: "superseded" });
    expect(await approveRow(second.id, console_)).toMatchObject({ ok: true, changed: true });
  });

  it("a new mail is a new key: the old proposal is stale (new_input), the reply to the new mail is its own row", async () => {
    const mail = await v1Mail();
    await investigate(mail.caseId);
    const old = await fromB(mail), stored = await submitCaseReplyProposal(old, deps) as { id: string };
    const second = await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId, summary: { title: "Connexion toujours impossible", description: "Le lien expire." } });
    expect(await approveRow(stored.id, old)).toMatchObject({ ok: false, code: "new_input" });
    await investigate(mail.caseId);
    const next = await fromB({ caseId: mail.caseId, messageId: second.messageId });
    expect(next.triggerEventId).toBe(`inbound:${second.gmail}`);
    expect(caseReplyKey(mail.caseId, next.triggerEventId)).not.toBe(caseReplyKey(mail.caseId, old.triggerEventId));
    const created = await submitCaseReplyProposal(next, deps) as { id: string; created: boolean };
    expect(created).toMatchObject({ ok: true, created: true });
    expect(await approveRow(created.id, next)).toMatchObject({ ok: true, changed: true });
  });

  it("wrong recipient, a person who took the case, effects OFF: nothing is stored or approved", async () => {
    const mail = await v1Mail();
    await investigate(mail.caseId);
    expect(await submitCaseReplyProposal(await fromB(mail, "autre@example.invalid"), deps)).toMatchObject({ ok: false, code: "recipient_changed" });
    expect(await submitCaseReplyProposal(await fromB(mail), { ...deps, env: () => ({}) })).toEqual({ ok: false, code: "effects_off" });
    const proposal = await fromB(mail), stored = await submitCaseReplyProposal(proposal, deps) as { id: string }, now = (await readCase(mail.caseId))!;
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: now.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `rj-c-takeover-${mail.caseId}`, reason: "fixture" });
    expect(await approveRow(stored.id, proposal)).toMatchObject({ ok: false, code: "not_admitted" });
    expect(await decideCaseReply({ action: "approve", validationId: stored.id, approverId: STAFF, seen: seenOf(proposal), authorizer: null, deps })).toMatchObject({ ok: false });
  });
});

