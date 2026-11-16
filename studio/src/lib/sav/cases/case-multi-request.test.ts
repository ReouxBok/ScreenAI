import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
import { savCaseCalls, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { decideCaseAdmission } from "./admission-policy";
import { markSavCaseCallDispatched, releaseSavCaseCall, reserveSavCaseCall, settleSavCaseCall } from "./case-calls";
import type { CaseBlockDetector, CaseEntryRule } from "./case-blocks";
import { SAV_CASE_BLOCK_REGISTRY } from "./case-block-registry";
import { caseReplyKey, caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { handoffNoticeTrigger, HANDOFF_REASON_LABELS, HANDOFF_TEAM_PART_INTERVENTION } from "./case-handoff-notice";
import { decideCaseReply, submitCaseReplyProposal } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { listCaseEvents, readCase } from "./case-store";
import { caseTeamPartRequests, type CaseAdmissionQualification, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { planCaseTicketStage, readCaseTicketStageConfig } from "./customer-return";
import { SAV_CASE_TEAM_PART_MENTION } from "./decision-contract";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { caseCallLedgerAdapter } from "./investigation-call-ledger";
import { caseDecisionDraft } from "./investigation-intent";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput, runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";
import { firstPersonalLoginRequest } from "./investigation-return-qualify";
import { SAV_CASE_COVER_EVERY_REQUEST_INSTRUCTION, SAV_CASE_TEAM_PARTS_INSTRUCTION } from "./investigation-v2-providers";
import { SAV_V2_BLOCK_SCOPES_ENV } from "./investigation-pilot-readers";
import { SAV_CASE_BLOCK_SCOPE_REVISION } from "./investigation-access-scope";
import { firstBlockEvidence } from "./v2-entry";

/*
 * SAV-92 (Ugo 14/11), mails with several requests, SYN data only, on the real stores (PGlite): V1's stored run (its accepted analysis and each request's
 * verified words) → the entry reads each request on its own → A's relay opens the case (a team part opened handed off) → ONE investigation, ONE decision, ONE
 * reply proposal for the mail, which says the rest went to the team → the team's notice names exactly that part. Nothing is sent: no network, no Slack.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 9_200_000;
const AT = "2026-11-14T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000092", V2_OWNER = "90000092", ACCESS = "https://new.limova.ai";
const SENDER = "client@example.invalid";
const ACCESS_RULE: CaseEntryRule = { ruleId: "rule-access", revision: "r1", v1Kind: "support", family: "access", at: AT };
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
// Review of batch 2 (finding 1): a team part is only ever left to the team through its notice, so the notice channel is configured (SYN values, nothing is sent).
const NOTICE_ENV = { SAV_HANDOFF_NOTICE: "on", SAV_HANDOFF_SLACK_BOT_TOKEN: "xoxb-synthetic-0000000000", SAV_HANDOFF_SLACK_CHANNEL_ID: "C0SYNTHETIC0" };
const ENV = { SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([ACCESS_RULE]), ...NOTICE_ENV };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } };

const LOGIN_CODE = "Je ne reçois pas le code de connexion à mon compte.";
const LOGIN_LINK = "Le lien de connexion envoyé à mon adresse ne fonctionne pas, je ne peux pas me connecter.";
const LOGIN_AGAIN = "Je n'arrive plus à me connecter à mon compte depuis hier.";
const LOGIN_MORNING = "Impossible de me connecter à la plateforme ce matin.";
const LOGIN_ADDRESS = "Je n'arrive pas à me connecter avec mon adresse.";
const DOCS = "Pouvez-vous m'envoyer la documentation générale ?";
const BILLING = "Pouvez-vous rembourser ma dernière facture ?";
type Req = { id: string; kind: string; quote: string };

/** V1 as its executor and recorder leave it, for one mail of several requests: the decision, the accepted analysis (one shared summary), each request's
 * verified words captured beside it (`requestQuotes`), the V2 owner effect; then A's relay with the entry's per-request reading as its qualification. */
async function v1Mail(requests: Req[], options: { text?: string; quotes?: boolean } = {}) {
  const ticketId = String(++seq), threadId = randomUUID(), messageId = randomUUID(), gmail = `gm-${messageId}`;
  const text = options.text ?? `Bonjour, ${requests.map(row => row.quote).join(" ")} Merci.`;
  await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Plusieurs questions", customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Plusieurs questions",
    bodyCiphertext: encryptSavPayload({ text }), receivedAt: new Date(AT), gmailMessageId: gmail });
  const decided = requests.map(row => ({ id: row.id, kind: row.kind }));
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion: 1, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: decided } } }) }).returning();
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: decided.map(row => ({ ...row, currentMessageId: messageId })),
    ticketSummary: { title: "Plusieurs questions", description: "Le client pose plusieurs questions.", requestIds: decided.map(row => row.id) } };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: 1, isCurrent: false, state: "observed", configHash: `multi-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected",
      ...(options.quotes === false ? {} : { requestQuotes: { messageId, requests: requests.map(row => ({ id: row.id, quote: row.quote })) } }),
      semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
        records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  await f.db.update(savIntakeExecutions).set({ runId: run!.id, runVersion: 1 }).where(eq(savIntakeExecutions.id, execution!.id));
  const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
  await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
    intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
  // The entry's real reading (v2-entry `rulesPort`), on this run; the rest of the qualification as a confirmed V1 context gives it.
  const readQualification = async (port: { messageId: string; gmailMessageId: string; requests: { requestId: string; kind: string }[] }): Promise<CaseAdmissionQualification> =>
    ({ requests: await firstBlockEvidence(ENV, port.messageId, port.gmailMessageId, port.requests, SAV_CASE_BLOCK_REGISTRY, { run: { runId: run!.id, runVersion: 1 } }),
      identity: CONFIRMED, crmContext: "complete", teamSignals: [] });
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }),
    readAdmissionPolicy: async () => POLICY, readQualification, env: { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" } }) as { caseId: string };
  return { ticketId, messageId, gmail, caseId: relayed.caseId, id: (v1Id: string) => `${gmail}/${v1Id}` };
}

const DAY = 86_400_000;
const LOGIN: SavRetrievalCandidate = { id: "k-login", contentVersionId: "k-login-v1", title: "Fiche connexion", content: "Procédure synthétique.", source: "fixture",
  verifiedAt: new Date(Date.now() - 10 * DAY).toISOString(), semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });
const backend: SavRetrievalBackend = { readRevision: async () => "kb-r1", search: async queries => queries.map(() => [LOGIN]) };

/** The synthetic model: ONE decision answering every open request together (the team's part is not open), in ONE reply. */
const answer = (request: CaseInvestigationModelRequest) => {
  const snapshot: CaseSnapshot = request.snapshot, open = snapshot.body.openRequests.filter(row => row.status === "open");
  return { status: "ok" as const, output: { caseVersion: snapshot.version,
    understanding: { requests: open.map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
    nextAction: { kind: "answer", requestIds: open.map(row => row.id), steps: [{ text: "Suivre la fiche citée.", knowledge: refOf(LOGIN) }], expectedResult: "La connexion fonctionne." },
    reply: { text: `Bonjour, voici la marche à suivre depuis ${ACCESS} : suivre la fiche.`, citations: [refOf(LOGIN)], impossibilityClaims: [], accountAdvice: "none" } } };
};

/** B's runner on A's stores; the qualification is the one the relay stored (the entry's reading is deterministic on the same run). */
async function investigate(caseId: string, model: typeof answer = answer) {
  const now = () => new Date(Date.now() + 6 * 60_000);
  const provider = vi.fn(async (request: CaseInvestigationModelRequest) => model(request));
  const ports = caseInvestigationStorePorts({
    readTicketOwner: async () => "v2", holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now, pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, plusieurs questions."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: caseCallLedgerAdapter({ ledger: { reserve: reserveSavCaseCall, markDispatched: markSavCaseCallDispatched, settle: settleSavCaseCall, release: releaseSavCaseCall },
      money: async () => ({ status: "allowed" }), provider, holder: "sav-v2-investigation", leaseSeconds: 60, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS }),
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      return latest && snapshot.admission ? { admission: { policy: POLICY, qualification: snapshot.admission.qualification }, sourceRef: latest.sourceRef } : null;
    },
  });
  return { report: await runCaseInvestigation(caseId, "observe", ports), provider };
}
const recordOf = async (caseId: string) => {
  const events = await listCaseEvents(caseId), read = readCaseInvestigationProgress(events, latestInvestigationInput(events)!);
  return read.state === "found" ? read.record : null;
};
async function proposalFor(caseId: string, inboundMessageId: string): Promise<CaseReplyProposal> {
  const draft = caseDecisionDraft(caseId, (await recordOf(caseId))!, await listCaseEvents(caseId))!;
  return { caseId, caseVersion: (await readCase(caseId))!.version, triggerEventId: draft.triggerEventId!, inboundMessageId, recipient: SENDER, subject: "Vos questions",
    ...draft.reply!, text: finalReplyText(draft.reply!.text) };
}
const deps = { env: () => ({ SAV_CASE_EFFECTS: "supervised" }), readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "policy-r1" };
const allowFixture: CaseReplyAuthorizer = () => ({ allowed: true, basis: "fixture.allow" });
const stagesOn = readCaseTicketStageConfig({ SAV_V2_TICKET_STAGES: "on", SAV_V2_STAGE_WAITING_CUSTOMER: "syn-waiting", SAV_V2_STAGE_CLOSED: "syn-closed" });
/** The stage the ticket would move to after the reply, as the queue computes it (owner, phase, sensitivity, cycle, a pending team part). */
const stageAfterReply = (snapshot: CaseSnapshot) => planCaseTicketStage({ config: stagesOn, caseId: snapshot.caseId, ticketId: snapshot.ticketId,
  case: { owner: snapshot.owner, phase: snapshot.phase, sensitivity: snapshot.sensitivity, cycle: snapshot.body.cycle,
    ...(snapshot.body.openRequests.some(row => row.status === "handed_off") ? { teamPartPending: true } : {}) },
  trigger: { kind: "reply_confirmed", replyKey: `reply:${snapshot.caseId}:x`, sentAt: new Date().toISOString() }, lastCustomerInboundAt: null });

/** One reply per mail: B's proposal submitted twice (a rerun, a crash replay) is ONE validation row on C's key for that stored mail. */
async function oneReplyPerMail(mail: { caseId: string; gmail: string; messageId: string }) {
  const proposal = await proposalFor(mail.caseId, mail.messageId);
  expect(proposal.triggerEventId).toBe(`inbound:${mail.gmail}`);
  const first = await submitCaseReplyProposal(proposal, deps) as { ok: true; id: string };
  expect(first).toMatchObject({ ok: true, created: true });
  expect(await submitCaseReplyProposal(proposal, deps)).toEqual({ ok: true, id: first.id, created: false, state: "proposed" });
  expect(await decideCaseReply({ action: "approve", validationId: first.id, approverId: STAFF, authorizer: allowFixture, deps,
    seen: { payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient } })).toMatchObject({ ok: true, changed: true });
  // Any other text for the same mail (a second reply) is refused once one is approved.
  expect(await submitCaseReplyProposal({ ...proposal, text: finalReplyText("Bonjour, une seconde réponse.") }, deps)).toEqual({ ok: false, code: "trigger_already_approved" });
  expect(caseReplyKey(mail.caseId, proposal.triggerEventId)).toBe(`reply:${mail.caseId}:inbound:${mail.gmail}`);
  return proposal;
}

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "multi-request-fixture-key-32-chars!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-multi-admin", email: "multi-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "multi-request-fixture-key-32-chars!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("SAV-92 preconditions: the real Access detector reads each request's own words", () => {
  it("the three login requests are Access's, the documentation and billing requests are not", () => {
    expect([LOGIN_CODE, LOGIN_LINK, LOGIN_AGAIN, DOCS, BILLING].map(text => firstPersonalLoginRequest(text, ""))).toEqual([true, true, true, false, false]);
    expect([LOGIN_MORNING, LOGIN_ADDRESS].map(text => firstPersonalLoginRequest(text, ""))).toEqual([true, true]);
    // Read as one mail, the whole-mail detector refuses a mail with another topic: that is why each request is read on its own.
    expect(firstPersonalLoginRequest(`${LOGIN_CODE} ${DOCS}`, "Plusieurs questions")).toBe(false);
  });
});

describe("finance, cancellation or billing anywhere: the WHOLE mail goes to the team", () => {
  it("a login request with a finance request: nobody admitted, no team part, the case is not the agent's", async () => {
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "finance", quote: BILLING }]);
    const stored = (await readCase(mail.caseId))!;
    expect(stored.admission!.qualification.requests.some(row => row.provenance.kind === "qualified_rule" || row.provenance.kind === "team_part")).toBe(false);
    expect(stored.admission!.target).not.toBe("agent");
    expect(stored.owner).not.toBe("agent");
    expect(caseTeamPartRequests(stored)).toEqual([]);
    expect(stored.body.openRequests.every(row => row.status === "open")).toBe(true);
  });
  it("two support requests whose own words speak of billing: the wording alone keeps the whole mail with the team", async () => {
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "support", quote: BILLING }]);
    const stored = (await readCase(mail.caseId))!;
    expect(stored.admission!.qualification.requests.some(row => row.provenance.kind === "qualified_rule" || row.provenance.kind === "team_part")).toBe(false);
    expect(stored.owner).not.toBe("agent");
  });
  it("cancellation: same", async () => {
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "cancellation", quote: "Je veux arrêter mon abonnement." }]);
    expect((await readCase(mail.caseId))!.owner).not.toBe("agent");
  });
});

describe("three requests of the active block: ONE decision, ONE reply", () => {
  it("each request is admitted on its own words; one model call answers the three; one proposal on the mail's key; no team mention, no notice", async () => {
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "support", quote: LOGIN_LINK }, { id: "r2", kind: "support", quote: LOGIN_AGAIN }]);
    const stored = (await readCase(mail.caseId))!;
    expect(stored).toMatchObject({ owner: "agent" });
    expect(stored.admission!.qualification.requests.filter(row => row.provenance.kind === "qualified_rule").map(row => [row.requestId, row.family]))
      .toEqual([[mail.id("r0"), "access"], [mail.id("r1"), "access"], [mail.id("r2"), "access"]]);
    expect(stored.body.openRequests.map(row => [row.id, row.status])).toEqual([[mail.id("r0"), "open"], [mail.id("r1"), "open"], [mail.id("r2"), "open"]]);
    // Each request's own words are its search subject (the shared summary would make them indistinguishable).
    expect(stored.body.openRequests.map(row => row.subject)).toEqual([LOGIN_CODE, LOGIN_LINK, LOGIN_AGAIN].map(text => expect.objectContaining({ status: "available", text })));

    const { report, provider } = await investigate(mail.caseId);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(provider.mock.calls[0]![0])).not.toContain("handedToTeam");
    const record = (await recordOf(mail.caseId))!;
    expect(record.decision!.validation).toMatchObject({ outcome: "accepted", decision: { nextAction: { kind: "answer", requestIds: [mail.id("r0"), mail.id("r1"), mail.id("r2")] } } });
    const proposal = await oneReplyPerMail(mail);
    expect(proposal.text).not.toContain(SAV_CASE_TEAM_PART_MENTION);
    expect(handoffNoticeTrigger((await readCase(mail.caseId))!, await listCaseEvents(mail.caseId))).toEqual({ ok: false, why: "not_handoff" });
    expect((await f.db.select().from(savCaseCalls).where(eq(savCaseCalls.caseId, mail.caseId)))).toHaveLength(1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("SAV-92 review P2-3: a reply covers EVERY open request of the block, or nothing is sent", () => {
  /** The reviewer's probe: the model answers the first open request only and forgets the other one. */
  const firstOnly = (request: CaseInvestigationModelRequest) => {
    const full = answer(request), first = full.output.nextAction.requestIds.slice(0, 1);
    return { ...full, output: { ...full.output, nextAction: { ...full.output.nextAction, requestIds: first } } };
  };
  it("two Access requests, a reply on r0 only: refused with `proposal_request_uncovered` naming r1, and no reply to propose", async () => {
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "support", quote: LOGIN_LINK }]);
    expect((await readCase(mail.caseId))!.body.openRequests.map(row => [row.id, row.status])).toEqual([[mail.id("r0"), "open"], [mail.id("r1"), "open"]]);
    const { report } = await investigate(mail.caseId, firstOnly);
    // The model gets its bounded correction turn, forgets r1 again: refused, nothing proposed.
    expect(report).toMatchObject({ status: "recorded", outcome: "needs_review", refusal: { codes: ["proposal_request_uncovered"] } });
    const recorded = (await listCaseEvents(mail.caseId)).filter(event => event.kind === "observation_recorded").at(-1)!;
    const validation = (recorded.detail as { record: { decision: { validation: { outcome: string; rejections: Array<{ code: string; detail?: string }> } } } }).record.decision.validation;
    expect(validation.outcome).toBe("needs_review");
    expect(validation.rejections).toEqual([expect.objectContaining({ code: "proposal_request_uncovered", path: "nextAction", detail: mail.id("r1") })]);
    // No accepted record, so no reply draft and nothing to propose or send.
    expect(await recordOf(mail.caseId)).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it("two Access requests, both covered by the reply: accepted, one reply proposal", async () => {
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "support", quote: LOGIN_LINK }]);
    const { report } = await investigate(mail.caseId);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect((await recordOf(mail.caseId))!.decision!.validation).toMatchObject({ outcome: "accepted", decision: { nextAction: { kind: "answer", requestIds: [mail.id("r0"), mail.id("r1")] } } });
    await oneReplyPerMail(mail);
  });
});

describe("two requests of the active block and one no block covers: ONE reply that says the rest went to the team, and a precise handoff", () => {
  it("the uncovered request is opened handed off; the decision answers the two; the reply ends with the team mention; the notice names exactly the third", async () => {
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "support", quote: DOCS }, { id: "r2", kind: "support", quote: LOGIN_LINK }]);
    const stored = (await readCase(mail.caseId))!;
    expect(stored.owner).toBe("agent");
    expect(stored.admission!.qualification.requests.map(row => [row.requestId, row.provenance.kind, (row.provenance as { reason?: string }).reason ?? null])).toEqual(expect.arrayContaining([
      [mail.id("r0"), "qualified_rule", null], [mail.id("r2"), "qualified_rule", null], [mail.id("r1"), "team_part", "no_block_match"]]));
    expect(stored.body.openRequests.map(row => [row.id, row.status])).toEqual([[mail.id("r0"), "open"], [mail.id("r1"), "handed_off"], [mail.id("r2"), "open"]]);
    expect(caseTeamPartRequests(stored).map(row => row.id)).toEqual([mail.id("r1")]);
    // The pure admission rule admits the two covered requests; the team part never admits on its own.
    expect(decideCaseAdmission({ caseSensitivity: stored.sensitivity, policy: POLICY, qualification: stored.admission!.qualification })).toMatchObject({ target: "agent" });
    expect(decideCaseAdmission({ caseSensitivity: stored.sensitivity, policy: POLICY, qualification: { ...stored.admission!.qualification,
      requests: stored.admission!.qualification.requests.filter(row => row.provenance.kind === "team_part") } })).not.toMatchObject({ target: "agent" });

    const { report, provider } = await investigate(mail.caseId);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    // The model is told which part is the team's (its words, never the mail), and not to answer it.
    const sent = provider.mock.calls[0]![0] as unknown as { snapshot: CaseSnapshot };
    expect(sent.snapshot.body.openRequests.find(row => row.id === mail.id("r1"))).toMatchObject({ status: "handed_off" });
    const record = (await recordOf(mail.caseId))!;
    expect(record.decision!.validation).toMatchObject({ outcome: "accepted", decision: { nextAction: { kind: "answer", requestIds: [mail.id("r0"), mail.id("r2")] } } });
    const reply = (record.decision!.validation as { decision: { reply: { text: string } } }).decision.reply.text;
    expect(reply.endsWith(`\n\n${SAV_CASE_TEAM_PART_MENTION}`)).toBe(true);
    expect(reply.split(SAV_CASE_TEAM_PART_MENTION)).toHaveLength(2);

    // Exactly one reply for the customer's mail, and it carries the mention.
    const proposal = await oneReplyPerMail(mail);
    expect(proposal.text).toContain(SAV_CASE_TEAM_PART_MENTION);

    // The team is told exactly which part is theirs, on the same input key, without the case being transferred; the trigger is for Slack, never for the customer.
    const now = (await readCase(mail.caseId))!, events = await listCaseEvents(mail.caseId);
    const notice = handoffNoticeTrigger(now, events);
    expect(notice).toMatchObject({ ok: true, caseId: mail.caseId, ticketId: mail.ticketId, reason: "outside_active_blocks", inputKey: latestInvestigationInput(events),
      report: { expectedIntervention: HANDOFF_TEAM_PART_INTERVENTION, trialIds: [], hypotheses: [] } });
    const need = (notice as { report: { need: string } }).report.need;
    expect(need).toContain(DOCS);
    expect(need).not.toContain(LOGIN_CODE);
    expect(need).not.toContain(LOGIN_LINK);
    expect(HANDOFF_REASON_LABELS.outside_active_blocks).toMatch(/aucun bloc actif/);
    expect(now.owner).toBe("agent");
    // The ticket is not moved to « attente client » while the team has its part.
    expect(stageAfterReply(now)).toEqual({ plan: false, reason: "team_part_pending" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("counter-review of 66e648a: 5 open requests of the block: the first 4 stay the agent's, the 5th is the team's (`request_limit`) with the mention and the notice", async () => {
    const quotes = [LOGIN_CODE, LOGIN_LINK, LOGIN_AGAIN, LOGIN_MORNING, LOGIN_ADDRESS];
    const mail = await v1Mail(quotes.map((quote, index) => ({ id: `r${index}`, kind: "support", quote })));
    const stored = (await readCase(mail.caseId))!;
    expect(stored.owner).toBe("agent");
    expect(stored.body.openRequests.map(row => [row.id, row.status])).toEqual([0, 1, 2, 3, 4].map(index => [mail.id(`r${index}`), index < 4 ? "open" : "handed_off"]));
    expect(stored.admission!.qualification.requests.find(row => row.requestId === mail.id("r4"))!.provenance).toMatchObject({ kind: "team_part", reason: "request_limit" });
    const { report, provider } = await investigate(mail.caseId);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    const { caseInvestigationPrompt } = await import("./investigation-v2-providers");
    expect(caseInvestigationPrompt(provider.mock.calls[0]![0] as never).instruction).toContain(SAV_CASE_COVER_EVERY_REQUEST_INSTRUCTION);
    const record = (await recordOf(mail.caseId))!;
    expect(record.decision!.validation).toMatchObject({ outcome: "accepted", decision: { nextAction: { kind: "answer", requestIds: [0, 1, 2, 3].map(index => mail.id(`r${index}`)) } } });
    expect((record.decision!.validation as { decision: { reply: { text: string } } }).decision.reply.text.endsWith(`\n\n${SAV_CASE_TEAM_PART_MENTION}`)).toBe(true);
    const notice = handoffNoticeTrigger((await readCase(mail.caseId))!, await listCaseEvents(mail.caseId));
    expect(notice).toMatchObject({ ok: true, reason: "outside_active_blocks", report: { expectedIntervention: HANDOFF_TEAM_PART_INTERVENTION } });
    const need = (notice as { report: { need: string } }).report.need;
    expect(need).toContain(LOGIN_ADDRESS);
    expect(need).toContain(`« ${LOGIN_ADDRESS} » (couverte par un bloc, mais au-delà de 4 demandes par réponse)`);
    expect(HANDOFF_REASON_LABELS.outside_active_blocks).toMatch(/dépasse la limite de demandes/);
    for (const quote of quotes.slice(0, 4)) expect(need).not.toContain(quote);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("the provider prompt carries the team-part instruction only when a part is the team's", async () => {
    const { caseInvestigationPrompt } = await import("./investigation-v2-providers");
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "support", quote: DOCS }]);
    const { provider } = await investigate(mail.caseId);
    const prompt = caseInvestigationPrompt(provider.mock.calls[0]![0] as never);
    expect(JSON.stringify(prompt)).toContain(SAV_CASE_TEAM_PARTS_INSTRUCTION.slice(0, 40));
    expect(JSON.stringify(prompt)).toContain("handedToTeam");
    const plain = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "support", quote: LOGIN_LINK }]);
    const again = await investigate(plain.caseId);
    expect(JSON.stringify(caseInvestigationPrompt(again.provider.mock.calls[0]![0] as never))).not.toContain("handedToTeam");
  });

  it("no request of the active block: nobody admitted (the whole mail stays with the team)", async () => {
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: DOCS }, { id: "r1", kind: "support", quote: "Comment exporter mes contacts ?" }]);
    const stored = (await readCase(mail.caseId))!;
    expect(stored.owner).not.toBe("agent");
    expect(caseTeamPartRequests(stored)).toEqual([]);
  });

  it("no stored words for the requests (an older run, the single-call reader): nobody admitted", async () => {
    const mail = await v1Mail([{ id: "r0", kind: "support", quote: LOGIN_CODE }, { id: "r1", kind: "support", quote: LOGIN_LINK }], { quotes: false });
    expect((await readCase(mail.caseId))!.owner).not.toBe("agent");
  });
});

describe("two blocks claiming the same request: that request goes to the team (per request)", () => {
  const TWIN: CaseBlockDetector = { blockId: "syn-twin", family: "usage", firstRequest: text => /lien de connexion/i.test(text) };
  const TWIN_RULE: CaseEntryRule = { ruleId: "rule-syn-twin", revision: "r1", v1Kind: "support", family: "usage", at: AT, blockId: "syn-twin" };
  const TWIN_POLICY = { ...POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [...POLICY.qualifiedRules, { ruleId: "rule-syn-twin", revision: "r1", families: ["usage"], blockId: "syn-twin" }] };
  const twinEnv = { ...NOTICE_ENV, SAV_V2_ADMISSION_RULES_JSON: JSON.stringify([ACCESS_RULE, TWIN_RULE]),
    SAV_V2_ADMISSION_POLICY_JSON: JSON.stringify({ policy: TWIN_POLICY, validFrom: "2025-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" }),
    [SAV_V2_BLOCK_SCOPES_ENV]: JSON.stringify([{ schema: SAV_CASE_BLOCK_SCOPE_REVISION, blockId: "syn-twin", family: "usage", policyRevision: "policy-r1", revision: "scope-syn-twin-r1",
      sources: [{ knowledgeId: "k-syn-twin", contentVersionId: "k-syn-twin-v1", use: "answer" }] }]) };
  async function stored(text: string) {
    const threadId = randomUUID(), messageId = randomUUID();
    await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Plusieurs questions", customerEmail: SENDER });
    await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Plusieurs questions",
      bodyCiphertext: encryptSavPayload({ text }), receivedAt: new Date(AT), gmailMessageId: `gm-${messageId}` });
    return { messageId, gmail: `gm-${messageId}` };
  }
  const read = (mail: { messageId: string; gmail: string }, quotes: Record<string, string>) => firstBlockEvidence(twinEnv, mail.messageId, mail.gmail,
    Object.keys(quotes).map(id => ({ requestId: `${mail.gmail}/${id}`, kind: "support" })), [...SAV_CASE_BLOCK_REGISTRY, TWIN],
    { readQuotes: async () => new Map(Object.entries(quotes).map(([id, quote]) => [`${mail.gmail}/${id}`, quote])) });

  it("the request both Access and the twin claim is the team's (ambiguous_block); the other is Access's", async () => {
    const mail = await stored(`Bonjour, ${LOGIN_CODE} ${LOGIN_LINK}`);
    expect(await read(mail, { r0: LOGIN_CODE, r1: LOGIN_LINK })).toEqual([
      { requestId: `${mail.gmail}/r0`, family: "access", provenance: { kind: "qualified_rule", ruleId: "rule-access", revision: "r1", at: AT } },
      { requestId: `${mail.gmail}/r1`, family: "unknown", provenance: { kind: "team_part", reason: "ambiguous_block", at: AT } },
    ]);
  });
  it("when every request is ambiguous, nobody is admitted", async () => {
    const mail = await stored(`Bonjour, ${LOGIN_LINK} Encore : le lien de connexion ne marche pas.`);
    expect(await read(mail, { r0: LOGIN_LINK, r1: "le lien de connexion ne marche pas." })).toEqual([]);
  });
  it("a quote that is not in the stored mail is no reading: that request is the team's", async () => {
    const mail = await stored(`Bonjour, ${LOGIN_CODE} ${DOCS}`);
    expect(await read(mail, { r0: LOGIN_CODE, r1: "Un texte qui n'est pas dans le mail." })).toEqual([
      expect.objectContaining({ requestId: `${mail.gmail}/r0`, family: "access" }),
      { requestId: `${mail.gmail}/r1`, family: "unknown", provenance: { kind: "team_part", reason: "request_text_unavailable", at: AT } },
    ]);
  });
});
