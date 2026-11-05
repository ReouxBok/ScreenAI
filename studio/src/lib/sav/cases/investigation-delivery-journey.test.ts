import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
import { validateSavNativeTestTarget } from "../../../../test/sav-native-db";
import { blockedBehind, finishNativeHandle, openNativeHandle, openNativeObserver } from "../../../../test/sav-native-locks";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
import { readSimulationReport } from "@/app/studio/sav/v2/simulation-report";
import { checkCommonSimulationReport, frozenExpectationHash } from "./simulation-report-common";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
// No model is ever dispatched on this path: B's provider is a port. The real executor imports V1's dispatcher; every function of it throws if called.
vi.mock("../intake/model-dispatch", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => { throw Error(`MODEL_DISPATCH_FORBIDDEN:${name}`); } : value]));
});
import { savCaseEffectExecutions, savCaseReplyValidations, savIntakeEffects, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "../intake/execution-policy";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { getExecutionEffects } from "../intake/execution-store";
import type { ExecutionOptions } from "../intake/execution-types";
import { executeIntakePass } from "../intake/executor";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalBackend, SavRetrievalCandidate } from "../request-retrieval";
import { markSavCaseCallDispatched, releaseSavCaseCall, reserveSavCaseCall, settleSavCaseCall } from "./case-calls";
import { createCaseEffectDriver } from "./case-effect-driver";
import { caseReplyKey, caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply, enqueueApprovedCaseReply, revokeCaseReply, submitCaseReplyProposal, type CaseEffectPayload } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { listCaseEvents, readCase, readCaseByTicket, transitionCaseOwner } from "./case-store";
import { SAV_CASE_AWAITING_V2_ATTRIBUTION, type CaseAdmissionQualification, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { caseCallLedgerAdapter, type CaseCallLedgerPort, type CaseCallMoneyGate } from "./investigation-call-ledger";
import { caseDecisionDraft } from "./investigation-intent";
import { selectCaseKnowledge } from "./investigation-knowledge";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput, runCaseInvestigation, SAV_CASE_INVESTIGATION_MAX_CALLS, type CaseInvestigationModelRequest } from "./investigation-runner";
import { caseInvestigationStorePorts } from "./investigation-store-ports";

/*
 * COMPOSITION ONLY (B, night of 31/10): the whole SIMULATED delivery path on the real stores, the real executor and the synthetic provider, never a socket:
 * stored V1 mail + confirmed execution + accepted analysis + confirmed V2 owner effect → A's relay opens the case and reads the owner back (agent) →
 * B investigates (read-only knowledge double, one call through A's ledger, synthetic model) → B's draft → C's stored proposal → a person approves it as is
 * (fixture authorizer: nobody is granted a role here) → C queues it → the executor sends it on the synthetic Gmail → the case records the outbound mail.
 * Counter-tests on the same path: a new mail, a person, the V2 pause, a crash after the marker, a lost ACK, the wrong case or recipient, OFF / unapproved.
 * B-7 (back vs inbound after a hand back) is reproduced, not decided: see the last describe.
 *
 * HISTORICAL PRECONDITION, explicit: these journeys start from a case ALREADY admitted to the agent, on a V1 `owner_assign` effect confirmed BEFORE
 * A ef74b35 (seeded by `v1Mail`, as older ledgers may still hold it). Since ef74b35 the executor never plans that write, so a NEW ticket never gets it
 * and stays the team's (human / handoff_pending): see "new ticket after A ef74b35". These journeys prove C's driver on admitted cases, not the
 * autonomy of a new ticket, and the SYN report below carries the same precondition.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", policyHash = "", seq = 9_700_000;
let p: ReturnType<typeof executionProvider>, sends = 0, loseAck = false, environment: Record<string, string | undefined> = {}, options: ExecutionOptions;
const AT = "2026-10-30T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000003", V2_OWNER = "90000001", ACCESS = "https://new.limova.ai";
const SENDER = "client@example.invalid";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } };
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
const readQualification = async (input: { requests: { requestId: string }[] }): Promise<CaseAdmissionQualification> =>
  ({ requests: input.requests.map(request => ruled(request.requestId)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] });

/** V1 side as its executor and recorder leave it, then A's relay; the synthetic Gmail knows the mail so a reply can go in its thread.
 * `historicalOwnerConfirmed` (default, the precondition above) seeds a V1 `owner_assign` confirmed before A ef74b35; `false` is a new ticket today. */
async function v1Mail(options_: { ticketId?: string; threadId?: string; historicalOwnerConfirmed?: boolean } = {}) {
  const ticketId = options_.ticketId ?? String(++seq), threadId = options_.threadId ?? randomUUID(), messageId = randomUUID(), gmail = `gm-${messageId}`;
  if (!options_.threadId) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Corps synthétique", headers: { "message-id": `<${messageId}@example.invalid>` }, attachments: [] }), receivedAt: new Date(), gmailMessageId: gmail });
  const runVersion = (await f.db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, threadId))).length + 1;
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion, policyId, policyHash, state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: [{ id: "r0", kind: "support" }] } } }) }).returning();
  const summary = { title: "Connexion impossible", description: "Le code de connexion n'arrive pas." };
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: [{ id: "r0", kind: "support", currentMessageId: messageId }], ticketSummary: { ...summary, requestIds: ["r0"] } };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: runVersion, isCurrent: false, state: "observed", configHash: `delivery-journey-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
      records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  await f.db.update(savIntakeExecutions).set({ runId: run!.id, runVersion }).where(eq(savIntakeExecutions.id, execution!.id));
  const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
  if (options_.historicalOwnerConfirmed !== false) await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
    intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }),
    readAdmissionPolicy: async () => POLICY, readQualification, env: { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" } }) as { caseId: string };
  p.setGmail(gmail, `thread-${threadId}`); p.seedTicket({ id: ticketId });
  return { ticketId, threadId, messageId, gmail, caseId: relayed.caseId };
}

const card = (id: string): SavRetrievalCandidate => ({ id, contentVersionId: `${id}-v1`, title: `Fiche ${id}`, content: "Procédure synthétique.", source: "fixture",
  verifiedAt: new Date(Date.now() - 864_000_000).toISOString(), semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } });
const LOGIN = card("k-login");
const refOf = (row: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: row.id, contentVersionId: row.contentVersionId });
const backend: SavRetrievalBackend = { readRevision: async () => "kb-r1", search: async queries => queries.map(query => /connexion/i.test(query) ? [LOGIN] : []) };
const answer = (request: CaseInvestigationModelRequest) => {
  const snapshot: CaseSnapshot = request.snapshot, open = snapshot.body.openRequests.filter(row => row.status === "open");
  return { status: "ok" as const, output: { caseVersion: snapshot.version,
    understanding: { requests: open.map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
    nextAction: { kind: "answer", requestIds: [open[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: refOf(LOGIN) }], expectedResult: "La connexion fonctionne." },
    reply: { text: `Bonjour, voici la marche à suivre depuis ${ACCESS} : suivre la fiche.`, citations: [refOf(LOGIN)], impossibilityClaims: [], accountAdvice: "none" } } };
};
const realLedger: CaseCallLedgerPort = { reserve: reserveSavCaseCall, markDispatched: markSavCaseCallDispatched, settle: settleSavCaseCall, release: releaseSavCaseCall };
const allowMoney: CaseCallMoneyGate = async () => ({ status: "allowed" });
async function investigate(caseId: string) {
  const now = () => new Date(Date.now() + 6 * 60_000);
  const provider = vi.fn(async (request: CaseInvestigationModelRequest) => answer(request));
  const ports = caseInvestigationStorePorts({
    // Witness: the ticket explicitly carries the V2 owner (Ugo 31/10, the owner read fails closed without it).
    readTicketOwner: async () => "v2",
    holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level,
    knowledge: snapshot => selectCaseKnowledge(snapshot, backend, { locale: "fr-FR", audience: "support", now: now() }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    callModel: caseCallLedgerAdapter({ ledger: realLedger, money: allowMoney, provider, holder: "sav-v2-investigation", leaseSeconds: 60, maxPerSubject: SAV_CASE_INVESTIGATION_MAX_CALLS }),
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id));
      return latest ? { admission: { policy: POLICY, qualification: { requests, identity: CONFIRMED, crmContext: "complete" as const, teamSignals: [] } }, sourceRef: latest.sourceRef } : null;
    },
  });
  return { report: await runCaseInvestigation(caseId, "observe", ports), provider };
}

/** B's draft completed as the console would from the stored message it answers: recipient = stored sender, on the version shown. */
async function proposalOf(mail: { caseId: string; messageId: string }, recipient = SENDER): Promise<CaseReplyProposal> {
  const events = await listCaseEvents(mail.caseId), read = readCaseInvestigationProgress(events, latestInvestigationInput(events)!);
  if (read.state !== "found") throw Error(`NO_RECORD:${read.state}`);
  const draft = caseDecisionDraft(mail.caseId, read.record, events);
  if (!draft?.reply || !draft.triggerEventId) throw Error("NO_REPLY_DRAFTED");
  return { caseId: mail.caseId, caseVersion: (await readCase(mail.caseId))!.version, triggerEventId: draft.triggerEventId, inboundMessageId: mail.messageId, recipient, subject: "Accès à la plateforme", ...draft.reply, text: finalReplyText(draft.reply.text) };
}
const storeDeps = () => ({ env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "policy-r1" });
const allowFixture: CaseReplyAuthorizer = () => ({ allowed: true, basis: "fixture.allow" });
const seenOf = (proposal: CaseReplyProposal) => ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient });
/** C's durable path: stored once, approved as seen by a person (fixture authorizer), queued from the stored validation. */
async function validateAndQueue(proposal: CaseReplyProposal) {
  const submitted = await submitCaseReplyProposal(proposal, storeDeps());
  if (!submitted.ok) throw Error(`SUBMIT_REFUSED:${submitted.code}`);
  const decided = await decideCaseReply({ action: "approve", validationId: submitted.id, approverId: STAFF, seen: seenOf(proposal), authorizer: allowFixture, deps: storeDeps() });
  if (!decided.ok) throw Error(`APPROVE_REFUSED:${decided.code}`);
  const queued = await enqueueApprovedCaseReply({ validationId: submitted.id, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
  if (!queued.ok) throw Error(`ENQUEUE_REFUSED:${queued.code}`);
  return { validationId: submitted.id, executionId: queued.executionId, created: queued.created };
}
/** The same path as `validateAndQueue`, but a refusal is a value and says at which step it came (B-7 scenarios compare refusals and the layer that made them). */
type Attempt = { executionId: string; validationId: string } | { refused: string; stage: "submit" | "approve" | "enqueue"; validationId?: string };
const tryQueue = async (proposal: CaseReplyProposal): Promise<Attempt> => {
  const submitted = await submitCaseReplyProposal(proposal, storeDeps());
  if (!submitted.ok) return { refused: submitted.code, stage: "submit" };
  const decided = await decideCaseReply({ action: "approve", validationId: submitted.id, approverId: STAFF, seen: seenOf(proposal), authorizer: allowFixture, deps: storeDeps() });
  if (!decided.ok) return { refused: decided.code, stage: "approve", validationId: submitted.id };
  const queued = await enqueueApprovedCaseReply({ validationId: submitted.id, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
  return queued.ok ? { executionId: queued.executionId, validationId: submitted.id } : { refused: queued.code, stage: "enqueue", validationId: submitted.id };
};
const SITUATION_TAKEN: Attempt = { refused: "situation_already_answered", stage: "submit" };
/** Written around the store, the way an older database could hold it (the table's guard allows a row born `proposed`, then `proposed -> approved`). */
async function legacyValidation(caseId: string, proposal: CaseReplyProposal, state: "proposed" | "approved") {
  const [row] = await f.db.insert(savCaseReplyValidations).values({ caseId, replyKey: caseReplyKey(caseId, proposal.triggerEventId), payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion,
    recipient: proposal.recipient, proposalCiphertext: encryptSavPayload(proposal) }).returning();
  if (state === "approved") await f.db.update(savCaseReplyValidations).set({ state: "approved", decidedBy: STAFF, decidedAt: new Date(), authorizationBasis: "legacy.fixture" }).where(eq(savCaseReplyValidations.id, row!.id));
  return row!.id;
}
const executionsOf = async (caseId: string) => f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, caseId));
/** A case admitted to the agent, one hand back after its mail, investigated again: B's reply (inbound name) and the other producer's name for the same situation. */
async function afterOneHandBack() {
  const mail = await v1Mail();
  expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded" });
  await handBack(mail.caseId, "b7");
  expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
  const fromB = await proposalOf(mail), backKey = latestInvestigationInput(await listCaseEvents(mail.caseId))!;
  expect(fromB.triggerEventId).toBe(`inbound:${mail.gmail}`);
  expect(backKey).toMatch(/^back:/);
  return { mail, fromB, backKey, fromOther: { ...fromB, triggerEventId: backKey, text: finalReplyText("Bonjour, autre texte après la remise.") } satisfies CaseReplyProposal };
}
/** A second execution ALREADY queued for the same situation, written around the store (an older database; the store itself now refuses it): a legacy approved validation and its
 * execution row, sealed like the store seals it (same mailbox/thread/Message-ID context as the execution it copies). It is created after `like`, so it is the younger one. */
async function seedQueuedLike(like: string, proposal: CaseReplyProposal) {
  const model = await executionOf(like), sealed = decryptSavPayload<CaseEffectPayload>(model.payloadCiphertext);
  const validationId = await legacyValidation(model.caseId, proposal, "approved");
  await new Promise(resolve => setTimeout(resolve, 5));
  const [row] = await f.db.insert(savCaseEffectExecutions).values({ caseId: model.caseId, replyKey: caseReplyKey(model.caseId, proposal.triggerEventId), threadId: model.threadId,
    policyId: model.policyId, policyHash: model.policyHash, payloadCiphertext: encryptSavPayload({ ...sealed, validationId, proposal }) }).returning();
  await f.db.update(savCaseReplyValidations).set({ executionId: row!.id }).where(eq(savCaseReplyValidations.id, validationId));
  return { validationId, executionId: row!.id };
}
const driver = () => createCaseEffectDriver({ env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => "policy-r1" });
const run = (id: string, hooks: Parameters<typeof executeIntakePass>[2] = {}) => executeIntakePass(id, options, hooks, driver());
const executionOf = async (id: string) => (await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, id)))[0]!;
const outbound = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed");
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
async function setV2Pause(level: "actions_paused" | "fully_paused" | null) {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "pause fictive" }) });
}
/** The ready path up to the queued execution: relayed mail, recorded decision, approved and queued reply. */
async function queuedReply() {
  const mail = await v1Mail();
  expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
  const proposal = await proposalOf(mail);
  return { mail, proposal, ...(await validateAndQueue(proposal)) };
}
async function handBack(caseId: string, tag: string) {
  let now = (await readCase(caseId))!;
  await transitionCaseOwner({ caseId, expectedVersion: now.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `dj-take-${tag}-${caseId}`, reason: "fixture" });
  now = (await readCase(caseId))!;
  await transitionCaseOwner({ caseId, expectedVersion: now.version, transition: "hand_back", actor: { type: "human", staffUserId: STAFF }, commandKey: `dj-back-${tag}-${caseId}`, reason: "fixture", to: "agent",
    admission: { policy: POLICY, qualification: { requests: now.body.openRequests.map(request => ruled(request.id)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] } } });
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.spyOn(console, "info").mockImplementation(() => { });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  if (!policyId) {
    const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-delivery-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
    state.user = { id: admin!.clerkId, primaryEmailAddress: { emailAddress: admin!.email, verification: { status: "verified" } } };
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
    const policy: ExecutionPolicy = {
      revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
      createdAfter: new Date(Date.now() - 10_000).toISOString(), receivedAfter: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxDossiers: 50, mutations: ["send_case_reply", "append_case_note"], admission: { kind: "automatic" },
    };
    const grant = await approveIntakeExecutionPolicy(policy);
    policyId = grant.id; policyHash = grant.policyHash;
    options = { runtime: {} as never, policy, config: { policyId, policyHash, codeRevision: "a".repeat(40) }, env: () => environment, signal: AbortSignal.timeout(60_000), adapters: undefined as never };
  }
  environment = { SAV_CASE_EFFECTS: "supervised", SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash, SAV_CODE_REVISION: "a".repeat(40), HUBSPOT_ACCESS_TOKEN: "fake" };
  p = executionProvider(); sends = 0; loseAck = false;
  const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    if (path === "messages/send") sends += 1;
    const result = await p.gmail<T>(mailbox, path, init);
    if (path === "messages/send" && loseAck) throw Error("SAV_TEST_ACK_LOST");
    return result;
  };
  // One deadline per test: a signal shared by the whole file aborted every send after 60 s of a loaded machine (12 false failures, 3/11).
  options = { ...options, signal: AbortSignal.timeout(60_000), adapters: createIntakeExecutorAdapters({ network: p.network, gmailRequest: gmail, gmailPermissions: async () => { }, env: () => environment }) };
});
afterEach(async () => { await setV2Pause(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("new ticket after A ef74b35 (no automatic V2 owner): the case waits for a person, nothing is investigated, proposed, queued or sent", () => {
  it("a confirmed V1 ticket WITHOUT an owner effect (as V1 leaves it since ef74b35) opens a human handoff awaiting V2 attribution; no V2 send", async () => {
    const mail = await v1Mail({ historicalOwnerConfirmed: false });
    expect(await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.kind, "owner_assign"))).not.toContainEqual(expect.objectContaining({ businessKey: expect.stringContaining(mail.messageId) }));
    const opened = (await readCase(mail.caseId))!;
    expect(opened).toMatchObject({ owner: "human", phase: "handoff_pending" });
    expect(opened.body.handoff?.reason).toBe(SAV_CASE_AWAITING_V2_ATTRIBUTION);
    // B does not investigate a case it does not own: no model call, no record, so no draft to propose.
    const { report, provider } = await investigate(mail.caseId);
    expect(report).toMatchObject({ status: "skipped", reason: "not_agent_owned", modelCalls: 0 });
    expect(provider).not.toHaveBeenCalled();
    await expect(proposalOf(mail)).rejects.toThrow(/NO_RECORD|NO_REPLY_DRAFTED/);
    // Another producer handing C a well-formed reply for this mail is refused too: the case is not admitted to the agent.
    const forced = await submitCaseReplyProposal({ caseId: mail.caseId, caseVersion: opened.version, triggerEventId: `inbound:${mail.gmail}`, inboundMessageId: mail.messageId,
      purpose: "answer", recipient: SENDER, subject: "Accès à la plateforme", text: finalReplyText(`Bonjour, voici la marche à suivre depuis ${ACCESS}.`) }, storeDeps());
    expect(forced).toMatchObject({ ok: false, code: "not_admitted" });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, mail.caseId))).toHaveLength(0);
    expect(sends).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect((await readCase(mail.caseId))!).toMatchObject({ owner: "human", phase: "handoff_pending", version: opened.version });
  });
});

describe("HISTORICAL PRECONDITION (owner_assign confirmed before A ef74b35, case already admitted): V1 confirmed → admission → owner read back → investigation → proposal → validation → executor → result", () => {
  it("one stored mail gets one reply: confirmed once on the synthetic Gmail, recorded once on the case, under C's canonical key; a second pass sends nothing", async () => {
    const mail = await v1Mail();
    expect(await readCaseByTicket(mail.ticketId)).toMatchObject({ caseId: mail.caseId, owner: "agent" });
    const { report, provider } = await investigate(mail.caseId);
    expect(report).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
    const proposal = await proposalOf(mail);
    expect(proposal).toMatchObject({ triggerEventId: `inbound:${mail.gmail}`, purpose: "answer", recipient: SENDER });
    const { executionId, created } = await validateAndQueue(proposal);
    expect(created).toBe(true);
    expect(await run(executionId)).toEqual({ state: "confirmed", executionId });
    expect(sends).toBe(1);
    expect(await getExecutionEffects(executionId)).toMatchObject([{ kind: "reply_send", permission: "send_case_reply", state: "confirmed", businessKey: `reply:${mail.caseId}:inbound:${mail.gmail}` }]);
    expect(await outbound(mail.caseId)).toHaveLength(1);
    expect(await run(executionId)).toEqual({ skipped: "occupied" });
    expect(sends).toBe(1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("the same reply queued twice, or proposed again by another producer under the same mail, is still one execution and one mail", async () => {
    const { mail, proposal, validationId, executionId } = await queuedReply();
    const again = await enqueueApprovedCaseReply({ validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
    expect(again).toMatchObject({ ok: true, executionId, created: false });
    expect(await submitCaseReplyProposal({ ...proposal, text: finalReplyText("Bonjour, autre texte saisi par la console.") }, storeDeps())).toMatchObject({ ok: false, code: "trigger_already_approved" });
    expect(await run(executionId)).toEqual({ state: "confirmed", executionId });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, mail.caseId))).toHaveLength(1);
    expect(sends).toBe(1);
  });
});

describe("what changes after the approval stops the simulated send, and nothing reaches the customer", () => {
  it("a new customer mail relayed after the approval cancels the reply for good (new_input); the new mail is a new input with its own key", async () => {
    const { mail, executionId } = await queuedReply();
    const second = await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId });
    expect(await run(executionId)).toMatchObject({ state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT" });
    expect(await executionOf(executionId)).toMatchObject({ state: "refused" });
    expect(sends).toBe(0);
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect((await proposalOf(second)).triggerEventId).toBe(`inbound:${second.gmail}`);
  });

  it("a person taking the case over cancels it (owner_changed)", async () => {
    const { mail, executionId } = await queuedReply();
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: (await readCase(mail.caseId))!.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `dj-own-${mail.caseId}`, reason: "fixture" });
    expect(await run(executionId)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED" });
    expect(sends).toBe(0);
  });

  it("the V2 full pause stops the investigation itself and holds a queued reply without cancelling it; lifted, it goes out once", async () => {
    await setV2Pause("fully_paused");
    const paused = await v1Mail();
    expect((await investigate(paused.caseId)).provider).not.toHaveBeenCalled();
    await setV2Pause(null);
    const { executionId } = await queuedReply();
    await setV2Pause("fully_paused");
    expect(await run(executionId)).toMatchObject({ state: "waiting" });
    expect(await getExecutionEffects(executionId)).toEqual([]);
    expect(sends).toBe(0);
    await setV2Pause(null);
    expect(await run(executionId)).toEqual({ state: "confirmed", executionId });
    expect(sends).toBe(1);
  });

  it("a stored sender that changed after the approval cancels it (recipient_changed)", async () => {
    const { mail, executionId } = await queuedReply();
    await f.db.update(savMessages).set({ fromEmail: "quelquun-dautre@example.invalid" }).where(eq(savMessages.id, mail.messageId));
    expect(await run(executionId)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_RECIPIENT_CHANGED" });
    expect(sends).toBe(0);
  });
});

describe("crash and uncertainty on the simulated provider: verify-only, never a second mail", () => {
  it("a crash right after the marker: nothing sent, the next passes only verify and stay uncertain, even after a new mail or the pause", async () => {
    const { mail, executionId } = await queuedReply();
    expect(await run(executionId, { afterMarker: async () => { throw Error("SAV_TEST_CRASH"); } })).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(0);
    await letReconcile();
    await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId });
    expect(await run(executionId)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(0);
    expect(await outbound(mail.caseId)).toEqual([]);
  });

  it("a lost ACK is uncertain, then the mail that did leave is found and confirmed once: one mail, one outbound event", async () => {
    const { mail, executionId } = await queuedReply();
    loseAck = true;
    expect(await run(executionId)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(1);
    loseAck = false; await letReconcile();
    expect(await run(executionId)).toEqual({ state: "confirmed", executionId });
    expect(sends).toBe(1);
    expect(await outbound(mail.caseId)).toHaveLength(1);
  });
});

describe("refusals and exclusions kept on the path: nothing is stored, approved, queued or sent", () => {
  it("the wrong case (another case's mail) and the wrong recipient are refused at the proposal", async () => {
    const one = await v1Mail(), other = await v1Mail();
    expect((await investigate(one.caseId)).report).toMatchObject({ status: "recorded" });
    const proposal = await proposalOf(one);
    expect(await submitCaseReplyProposal({ ...proposal, inboundMessageId: other.messageId }, storeDeps())).toMatchObject({ ok: false });
    expect(await submitCaseReplyProposal({ ...proposal, triggerEventId: `inbound:${other.gmail}` }, storeDeps())).toMatchObject({ ok: false });
    expect(await submitCaseReplyProposal(await proposalOf(one, "autre@example.invalid"), storeDeps())).toMatchObject({ ok: false, code: "recipient_changed" });
    expect(sends).toBe(0);
  });

  it("effects OFF stores nothing; a reply nobody approved, or approved without an authorization port, cannot be queued", async () => {
    const mail = await v1Mail();
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded" });
    const proposal = await proposalOf(mail);
    environment = { ...environment, SAV_CASE_EFFECTS: "off" };
    expect(await submitCaseReplyProposal(proposal, storeDeps())).toEqual({ ok: false, code: "effects_off" });
    environment = { ...environment, SAV_CASE_EFFECTS: "supervised" };
    const stored = await submitCaseReplyProposal(proposal, storeDeps()) as { ok: true; id: string };
    expect(await enqueueApprovedCaseReply({ validationId: stored.id, policy: { id: policyId, hash: policyHash }, deps: storeDeps() })).toMatchObject({ ok: false, code: "not_approved" });
    expect(await decideCaseReply({ action: "approve", validationId: stored.id, approverId: STAFF, seen: seenOf(proposal), authorizer: null, deps: storeDeps() })).toMatchObject({ ok: false });
    expect(await enqueueApprovedCaseReply({ validationId: stored.id, policy: { id: policyId, hash: policyHash }, deps: storeDeps() })).toMatchObject({ ok: false, code: "not_approved" });
    expect(sends).toBe(0);
  });
});

describe("B-7, one situation = at most one send, whatever name its producers give it (C: situation guard on the durable reply store)", () => {
  // The same stored customer mail has two names after a hand back (B: inbound:<gmail>, another producer: back:<event>). Neutral property, true under both options left
  // to Ugo (B emits back:, or C maps back: to the mail), and it opens NO permission to resend: with no NEW real customer mail, the situation reaches the customer at most once.
  // A reply that was cancelled before any send (nothing left toward the customer) does not consume the situation; a new real customer mail is a new situation.

  it("after one hand back, B's reply and another producer's reply to the same situation cannot both be sent", async () => {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const first = await tryQueue(fromB);
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    await run(first.executionId);
    const second = await tryQueue(fromOther);
    if ("executionId" in second) await run(second.executionId);
    expect(second).toEqual(SITUATION_TAKEN);
    expect(sends).toBeLessThanOrEqual(1);
    expect(sends).toBe(1);
    expect(await executionsOf(mail.caseId)).toHaveLength(1);
    expect(await outbound(mail.caseId)).toHaveLength(1);
  });

  it("the other way round (the hand-back name first, B's name second): still one send, and the later one is refused before it can be approved", async () => {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const first = await tryQueue(fromOther);
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    await run(first.executionId);
    const second = await tryQueue(fromB);
    expect(second).toEqual(SITUATION_TAKEN);
    expect(sends).toBe(1);
    expect(await executionsOf(mail.caseId)).toHaveLength(1);
  });

  it("two approvals racing for the two names: exactly one is approved; whatever is queued afterwards sends once", async () => {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const [a, b] = await Promise.all([tryQueue(fromB), tryQueue(fromOther)]);
    const queued = [a, b].filter((row): row is Extract<typeof row, { executionId: string }> => "executionId" in row);
    expect(queued.length).toBeLessThanOrEqual(1);
    for (const row of queued) await run(row.executionId);
    expect(sends).toBeLessThanOrEqual(1);
    expect(await executionsOf(mail.caseId)).toHaveLength(queued.length);
    expect((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, mail.caseId))).filter(row => row.state === "approved")).toHaveLength(queued.length);
  });

  it("a pre-existing pair, layer 1 (approval): a proposal stored before the guard for the other name of a situation already approved is refused at its approval", async () => {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const first = await tryQueue(fromB);
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    const legacy = await legacyValidation(mail.caseId, fromOther, "proposed");
    expect(await decideCaseReply({ action: "approve", validationId: legacy, approverId: STAFF, seen: seenOf(fromOther), authorizer: allowFixture, deps: storeDeps() })).toEqual({ ok: false, code: "situation_already_answered" });
    expect((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, legacy)))[0]!.state).toBe("proposed");
    await run(first.executionId);
    expect(sends).toBe(1);
    expect(await executionsOf(mail.caseId)).toHaveLength(1);
  });

  it("a pre-existing pair, layer 2 (queue): two APPROVED validations of one situation, as a database written before the guard may hold, are stopped at the queue: one execution, one send", async () => {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const first = await tryQueue(fromB);
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    const legacy = await legacyValidation(mail.caseId, fromOther, "approved");
    expect(await enqueueApprovedCaseReply({ validationId: legacy, policy: { id: policyId, hash: policyHash }, deps: storeDeps() })).toEqual({ ok: false, code: "situation_already_answered" });
    await run(first.executionId);
    expect(sends).toBe(1);
    expect(await executionsOf(mail.caseId)).toHaveLength(1);
  });
  it("a pre-existing pair, layer 2 (queue), nothing queued yet: the first to be queued wins, the other name is refused; one execution, one send", async () => {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const [one, other] = [await legacyValidation(mail.caseId, fromB, "approved"), await legacyValidation(mail.caseId, fromOther, "approved")];
    const queued = await enqueueApprovedCaseReply({ validationId: other, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
    if (!queued.ok) throw Error(`FIRST_QUEUE_REFUSED:${queued.code}`);
    expect(await enqueueApprovedCaseReply({ validationId: one, policy: { id: policyId, hash: policyHash }, deps: storeDeps() })).toEqual({ ok: false, code: "situation_already_answered" });
    expect(await run(queued.executionId)).toEqual({ state: "confirmed", executionId: queued.executionId });
    expect(sends).toBe(1);
    expect(await executionsOf(mail.caseId)).toHaveLength(1);
  });

  it("defensive: even if an execution row says `refused`, a ledger row past `planned` (the mail may have left) still takes the situation", async () => {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const first = await tryQueue(fromB);
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    loseAck = true;
    expect(await run(first.executionId)).toMatchObject({ state: "uncertain" });
    await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'refused' WHERE id = '${first.executionId}'`);
    expect((await getExecutionEffects(first.executionId))[0]).toMatchObject({ kind: "reply_send", state: expect.not.stringMatching(/^planned$/) });
    expect(await tryQueue(fromOther)).toEqual(SITUATION_TAKEN);
    expect(sends).toBe(1);
    expect(await executionsOf(mail.caseId)).toHaveLength(1);
  });

  it("a new REAL customer mail is a new situation: one reply per mail, two sends in all, each under its own key", async () => {
    const { mail, fromB } = await afterOneHandBack();
    const first = await tryQueue(fromB);
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    await run(first.executionId);
    expect(sends).toBe(1);
    const second = await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId });
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    const next = await proposalOf(second);
    expect(next.triggerEventId).toBe(`inbound:${second.gmail}`);
    const queued = await tryQueue(next);
    if (!("executionId" in queued)) throw Error(`SECOND_MAIL_REFUSED:${queued.refused}`);
    expect(await run(queued.executionId)).toEqual({ state: "confirmed", executionId: queued.executionId });
    expect(sends).toBe(2);
    expect((await executionsOf(mail.caseId)).map(row => row.replyKey).sort()).toEqual([`reply:${mail.caseId}:inbound:${mail.gmail}`, `reply:${mail.caseId}:inbound:${second.gmail}`].sort());
  });

  it("an uncertain send is verified, never repeated: a second producer's reply for the same situation is refused while the first is unconfirmed, and the one mail that left is confirmed once", async () => {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const first = await tryQueue(fromB);
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    loseAck = true;
    expect(await run(first.executionId)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(1);
    expect(await tryQueue(fromOther)).toEqual(SITUATION_TAKEN);
    loseAck = false; await letReconcile();
    expect(await run(first.executionId)).toEqual({ state: "confirmed", executionId: first.executionId });
    expect(sends).toBe(1);
    expect(await outbound(mail.caseId)).toHaveLength(1);
    expect(await tryQueue(fromOther)).toEqual(SITUATION_TAKEN);
  });

  it("a reply already sent, then a person takes the case and gives it back with no new mail: the agent cannot send a second one (no resend permission)", async () => {
    const mail = await v1Mail();
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded" });
    const first = await tryQueue(await proposalOf(mail));
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    expect(await run(first.executionId)).toEqual({ state: "confirmed", executionId: first.executionId });
    expect(sends).toBe(1);
    await handBack(mail.caseId, "after-sent");
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    const proposal = await proposalOf(mail), backKey = latestInvestigationInput(await listCaseEvents(mail.caseId))!;
    expect(await tryQueue({ ...proposal, triggerEventId: backKey, text: finalReplyText("Bonjour, nouveau texte après la remise.") })).toEqual(SITUATION_TAKEN);
    expect(await tryQueue({ ...proposal, text: finalReplyText("Bonjour, autre texte, même nom que l'envoyé.") })).toEqual({ refused: "trigger_already_approved", stage: "submit" });
    expect(sends).toBe(1);
    expect(await executionsOf(mail.caseId)).toHaveLength(1);
  });

  it("witness, no over-blocking: an approved reply that a person's takeover cancelled BEFORE any send does not consume the situation; after the hand back the agent's reply goes out once", async () => {
    const { mail, executionId } = await queuedReply();
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: (await readCase(mail.caseId))!.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `dj-take-b7w-${mail.caseId}`, reason: "fixture" });
    expect(await run(executionId)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED" });
    expect(sends).toBe(0);
    const now = (await readCase(mail.caseId))!;
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: now.version, transition: "hand_back", actor: { type: "human", staffUserId: STAFF }, commandKey: `dj-back-b7w-${mail.caseId}`, reason: "fixture", to: "agent",
      admission: { policy: POLICY, qualification: { requests: now.body.openRequests.map(request => ruled(request.id)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] } } });
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    const proposal = await proposalOf(mail), backKey = latestInvestigationInput(await listCaseEvents(mail.caseId))!;
    const again = await tryQueue({ ...proposal, triggerEventId: backKey });
    if (!("executionId" in again)) throw Error(`AFTER_CANCEL_REFUSED:${again.refused}`);
    expect(await run(again.executionId)).toEqual({ state: "confirmed", executionId: again.executionId });
    expect(sends).toBe(1);
  });

  it("witness: a revoked approval (nothing sent) or a declined proposal does not consume the situation", async () => {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const first = await tryQueue(fromB);
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    expect(await revokeCaseReply({ validationId: first.validationId, approverId: STAFF, authorizer: allowFixture })).toMatchObject({ ok: true, state: "revoked" });
    const second = await tryQueue(fromOther);
    if (!("executionId" in second)) throw Error(`AFTER_REVOKE_REFUSED:${second.refused}`);
    expect(await run(first.executionId)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_APPROVAL_REVOKED" });
    expect(await run(second.executionId)).toEqual({ state: "confirmed", executionId: second.executionId });
    expect(sends).toBe(1);
    expect(await executionsOf(mail.caseId)).toHaveLength(2);
  });
});

describe("B-7 at the executor's gate: two executions ALREADY queued for one situation (an older database, a pass resumed late) reach the provider at most once", () => {
  // The store now refuses the second reply, but the data of an older database, or a pass that was queued before the guard, are executions that already exist. The driver's gate
  // judges them in the transaction that writes the plan or the marker, under the case lock. These tests count what really reached the synthetic Gmail (`sends`) and the
  // ledger rows past `planned`, never the store's refusals.
  const dispatched = async (caseId: string) => (await f.db.select().from(savIntakeEffects)).filter(row => row.kind === "reply_send" && row.businessKey.startsWith(`reply:${caseId}:`) && row.state !== "planned");
  /** `older` is queued through the store, the other name is seeded as a younger legacy execution. */
  async function queuedPair(older: "inbound" | "back") {
    const { mail, fromB, fromOther } = await afterOneHandBack();
    const [firstProposal, secondProposal] = older === "inbound" ? [fromB, fromOther] : [fromOther, fromB];
    const first = await tryQueue(firstProposal);
    if (!("executionId" in first)) throw Error(`FIRST_REFUSED:${first.refused}`);
    const second = await seedQueuedLike(first.executionId, secondProposal);
    expect(await executionsOf(mail.caseId)).toHaveLength(2);
    return { mail, older: first.executionId, younger: second.executionId };
  }
  const SITUATION_REASON = "SAV_CASE_EFFECT_CANCELLED_SITUATION_TAKEN";

  it.each(["inbound", "back"] as const)("%s name older: the younger one is cancelled at its first gate, the older one sends once, whatever runs first", async older => {
    const { mail, older: first, younger } = await queuedPair(older);
    expect(await run(younger)).toMatchObject({ state: "waiting", reason: SITUATION_REASON });
    expect(sends).toBe(0);
    expect(await getExecutionEffects(younger)).toEqual([]);
    expect(await run(first)).toEqual({ state: "confirmed", executionId: first });
    expect(sends).toBe(1);
    expect(await dispatched(mail.caseId)).toHaveLength(1);
    expect(await executionOf(younger)).toMatchObject({ state: "refused", reason: SITUATION_REASON });
    expect(await outbound(mail.caseId)).toHaveLength(1);
  });

  it.each(["inbound", "back"] as const)("%s name older, run in age order: the older one sends, the younger one is cancelled by a mail that may already have left", async older => {
    const { mail, older: first, younger } = await queuedPair(older);
    expect(await run(first)).toEqual({ state: "confirmed", executionId: first });
    expect(await run(younger)).toMatchObject({ reason: SITUATION_REASON });
    expect(sends).toBe(1);
    expect(await getExecutionEffects(younger)).toEqual([]);
    expect(await dispatched(mail.caseId)).toHaveLength(1);
  });

  it("an uncertain first send (lost ACK): the other execution is cancelled and sends nothing; the first is only verified, never resent", async () => {
    const { mail, older: first, younger } = await queuedPair("inbound");
    loseAck = true;
    expect(await run(first)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(1);
    loseAck = false;
    expect(await run(younger)).toMatchObject({ reason: SITUATION_REASON });
    expect(await getExecutionEffects(younger)).toEqual([]);
    await letReconcile();
    expect(await run(first)).toEqual({ state: "confirmed", executionId: first });
    expect(sends).toBe(1);
    expect(await dispatched(mail.caseId)).toHaveLength(1);
    expect(await outbound(mail.caseId)).toHaveLength(1);
  });

  it("a crash right after the marker (nothing sent yet): the other execution is cancelled, the first stays verify-only and sends nothing", async () => {
    const { mail, older: first, younger } = await queuedPair("inbound");
    expect(await run(first, { afterMarker: async () => { throw Error("SAV_TEST_CRASH"); } })).toMatchObject({ state: "uncertain" });
    expect(await run(younger)).toMatchObject({ reason: SITUATION_REASON });
    await letReconcile();
    expect(await run(first)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(0);
    expect(await getExecutionEffects(younger)).toEqual([]);
    expect((await dispatched(mail.caseId))).toHaveLength(1);
  });

  it("a NEW real customer mail after both were queued: both are cancelled (new input), nothing is sent for the old situation; the new mail's own reply goes out once", async () => {
    const { mail, older: first, younger } = await queuedPair("inbound");
    const next = await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId });
    expect(await run(first)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT" });
    expect(await run(younger)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT" });
    expect(sends).toBe(0);
    expect((await investigate(mail.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
    const queued = await tryQueue(await proposalOf(next));
    if (!("executionId" in queued)) throw Error(`NEW_MAIL_REFUSED:${queued.refused}`);
    expect(await run(queued.executionId)).toEqual({ state: "confirmed", executionId: queued.executionId });
    expect(sends).toBe(1);
    expect(await dispatched(mail.caseId)).toHaveLength(1);
  });

  it("witness, no over-blocking: the older execution cancelled BEFORE any send (a takeover) frees the situation; after the hand back the other one sends once", async () => {
    const { mail, older: first, younger } = await queuedPair("inbound");
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: (await readCase(mail.caseId))!.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `dj-take-gw-${mail.caseId}`, reason: "fixture" });
    expect(await run(first)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED" });
    expect(sends).toBe(0);
    const now = (await readCase(mail.caseId))!;
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: now.version, transition: "hand_back", actor: { type: "human", staffUserId: STAFF }, commandKey: `dj-back-gw-${mail.caseId}`, reason: "fixture", to: "agent",
      admission: { policy: POLICY, qualification: { requests: now.body.openRequests.map(request => ruled(request.id)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] } } });
    const result = await run(younger);
    expect(sends).toBeLessThanOrEqual(1);
    expect(result, JSON.stringify(result)).toEqual({ state: "confirmed", executionId: younger });
    expect(await dispatched(mail.caseId)).toHaveLength(1);
  });

  it("defensive, a resumed OLD pass: an older execution brought back to life after a younger one already sent is cancelled by the mail that left (not only by age)", async () => {
    const { mail, older: first, younger } = await queuedPair("inbound");
    await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'refused', reason = 'SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED' WHERE id = '${first}'`);
    expect(await run(younger)).toEqual({ state: "confirmed", executionId: younger });
    expect(sends).toBe(1);
    await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'pending', reason = NULL WHERE id = '${first}'`);
    expect(await run(first)).toMatchObject({ reason: SITUATION_REASON });
    expect(sends).toBe(1);
    expect(await getExecutionEffects(first)).toEqual([]);
    expect(await dispatched(mail.caseId)).toHaveLength(1);
  });

  it("a human-owned case is not treated by V2, and a new customer mail does not free it: no investigation, no proposal, no queued reply, no send", async () => {
    const { mail, executionId } = await queuedReply();
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: (await readCase(mail.caseId))!.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `dj-take-own-${mail.caseId}`, reason: "fixture" });
    const second = await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId });
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "human" });
    const { report, provider } = await investigate(mail.caseId);
    expect(report).toMatchObject({ status: "skipped", reason: "not_agent_owned", modelCalls: 0 });
    expect(provider).not.toHaveBeenCalled();
    const forced = { caseId: mail.caseId, caseVersion: (await readCase(mail.caseId))!.version, triggerEventId: `inbound:${second.gmail}`, inboundMessageId: second.messageId, purpose: "answer" as const,
      recipient: SENDER, subject: "Accès à la plateforme", text: finalReplyText(`Bonjour, voici la marche à suivre depuis ${ACCESS}.`) };
    expect(await submitCaseReplyProposal(forced, storeDeps())).toMatchObject({ ok: false, code: "not_admitted" });
    expect(await run(executionId)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED" });
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "human" });
    expect(sends).toBe(0);
    expect(await executionsOf(mail.caseId)).toHaveLength(1);
  });

  it("a lone execution is not slowed down by the fence: no sibling, one send (witness for every test above)", async () => {
    const { mail, executionId } = await queuedReply();
    expect(await run(executionId)).toEqual({ state: "confirmed", executionId });
    expect(sends).toBe(1);
    expect(await dispatched(mail.caseId)).toHaveLength(1);
  });

  describe.skipIf(!process.env.SAV_TEST_POSTGRES_URL)("native: two passes racing for the case lock on two real connections", () => {
    // X holds the case row; both passes reach their first gate and wait behind it; X commits; they run in the order Postgres wakes them. The age rule means the same outcome
    // either way: one send, the other cancelled.
    it.each(["older first in the queue", "younger first in the queue"] as const)("%s: exactly one reaches the provider", async order => {
      const { mail, older: first, younger } = await queuedPair("inbound");
      const url = process.env.SAV_TEST_POSTGRES_URL!;
      validateSavNativeTestTarget(url, process.env.SAV_TEST_POSTGRES_TOKEN);
      const pool = postgres(url, { max: 1, prepare: false, connection: { application_name: "b7_gate_holder", statement_timeout: 20000 } });
      const observer = openNativeObserver(url), holder = await openNativeHandle(pool);
      const pending: Promise<unknown>[] = [];
      try {
        await holder.conn.unsafe("BEGIN");
        await holder.conn.unsafe("SELECT id FROM sav.cases WHERE id = $1 FOR UPDATE", [mail.caseId]);
        const [one, two] = order === "older first in the queue" ? [first, younger] : [younger, first];
        pending.push(run(one)); await blockedBehind(observer, holder.pid, 1);
        pending.push(run(two)); await blockedBehind(observer, holder.pid, 2);
        await holder.conn.unsafe("COMMIT");
        await Promise.all(pending);
      } finally {
        await finishNativeHandle(observer, holder);
        await Promise.allSettled(pending);
        await observer.end({ timeout: 2 }); await pool.end({ timeout: 2 });
      }
      expect(sends).toBe(1);
      expect(await dispatched(mail.caseId)).toHaveLength(1);
      expect((await executionOf(first)).state).toBe("confirmed");
      expect(await executionOf(younger)).toMatchObject({ state: "refused", reason: SITUATION_REASON });
    }, 30_000);
  });
});

/*
 * SYN rehearsal report in the COMMON B -> UX format (CONTRACT_SIMULATION_REPORT_B_UX.md): UX's proposal-1 envelope, read by UX's own pure reader,
 * plus B's additive fields (provenance, simulated executor, sends per reply key, not comparable). Expectations are B's synthetic scenario
 * expectations, written and hashed BEFORE any scenario runs; never a customer's. The verdict is recomputed by the reader, never trusted.
 */
type Observed = { purpose: string | null; final: string; reason: string | null; refusals: string[]; sends: number | null; sendsByReplyKey: { replyKey: string; count: number }[] | null; proposedAt: string | null; latencyMs: number | null; notComparable?: { field: string; reason: string }[] };
const outcomeOf = (result: unknown): { final: string; reason: string | null } => {
  const r = result as { state?: string; reason?: string };
  if (r.state === "confirmed") return { final: "would_send", reason: null };
  if (r.state === "uncertain") return { final: "uncertain", reason: "marker_without_receipt" };
  if (r.reason?.startsWith("SAV_CASE_EFFECT_CANCELLED_")) return { final: "cancelled", reason: r.reason.slice("SAV_CASE_EFFECT_CANCELLED_".length).toLowerCase() };
  if (r.state === "waiting" && /PAUSED/.test(r.reason ?? "")) return { final: "held", reason: "paused" };
  return { final: "unknown", reason: JSON.stringify(result) };
};
// Sends attributed to the execution that made them, then to its reply key: a real distribution, so [2,0] and [1,1] stay distinct.
const distributionOf = async (sendsByExecution: Map<string, number>) => {
  const byKey = new Map<string, number>();
  for (const [executionId, count] of sendsByExecution) {
    const keys = (await getExecutionEffects(executionId)).filter(e => e.kind === "reply_send").map(e => e.businessKey);
    const key = keys.length === 1 ? keys[0]! : `unattributed:${executionId}`;
    byKey.set(key, (byKey.get(key) ?? 0) + count);
  }
  return [...byKey].map(([replyKey, count]) => ({ replyKey, count }));
};

describe("SYN rehearsal report (common B -> UX format), produced from the simulated runs above, under the same HISTORICAL PRECONDITION", () => {
  it("expectations frozen before the runs; every action simulated; verdicts recomputed by UX's reader; B-7 shows as a mismatch, never a match", async () => {
    const SCENARIOS: { caseRef: string; scenario: string; timeline: string[]; expected: { purpose: string | null; final: string; reason: string | null; sends: number; refusals: string[] } | null }[] = [
      { caseRef: "SYN-B01", scenario: "Accès : code non reçu, fiche couvrante (synthétique)", timeline: [], expected: { purpose: "answer", final: "would_send", reason: null, sends: 1, refusals: [] } },
      { caseRef: "SYN-B02", scenario: "Même mail, second producteur après validation (synthétique)", timeline: ["second_producer_after_approval"], expected: { purpose: "answer", final: "would_send", reason: null, sends: 1, refusals: ["trigger_already_approved"] } },
      { caseRef: "SYN-B03", scenario: "Nouveau mail client après validation (synthétique)", timeline: ["new_mail_after_approval"], expected: { purpose: "answer", final: "cancelled", reason: "new_input", sends: 0, refusals: [] } },
      { caseRef: "SYN-B04", scenario: "Prise par une personne après validation (synthétique)", timeline: ["human_takeover_after_approval"], expected: { purpose: "answer", final: "cancelled", reason: "owner_changed", sends: 0, refusals: [] } },
      { caseRef: "SYN-B05", scenario: "Pause complète V2 après validation (synthétique)", timeline: ["pause_full_after_approval"], expected: { purpose: "answer", final: "held", reason: "paused", sends: 0, refusals: [] } },
      { caseRef: "SYN-B06", scenario: "Crash après le marqueur d'envoi (synthétique)", timeline: ["crash_after_marker"], expected: { purpose: "answer", final: "uncertain", reason: "marker_without_receipt", sends: 0, refusals: [] } },
      { caseRef: "SYN-B07", scenario: "Expéditeur stocké changé après validation (synthétique)", timeline: ["sender_changed_after_approval"], expected: { purpose: "answer", final: "cancelled", reason: "recipient_changed", sends: 0, refusals: [] } },
      { caseRef: "SYN-B08", scenario: "B-7 : remise par une personne puis deux producteurs (synthétique, règle non décidée)", timeline: ["hand_back", "second_producer_back_key"], expected: { purpose: "answer", final: "would_send", reason: null, sends: 1, refusals: ["situation_already_answered"] } },
      { caseRef: "SYN-B09", scenario: "Entrée sans attendu figé (synthétique)", timeline: [], expected: null },
      { caseRef: "SYN-B10", scenario: "Attendu figé, exécuteur jamais lancé : résultat inconnu (synthétique)", timeline: ["executor_not_run"], expected: { purpose: "answer", final: "would_send", reason: null, sends: 1, refusals: [] } },
    ];
    // Phase 1, freeze: every expectation hashed (caseRef, scenario, timeline, expected values) before any scenario runs.
    const frozenAt = new Date().toISOString();
    const frozen = new Map(SCENARIOS.map(row => [row.caseRef, row.expected ? { frozenAt, hash: frozenExpectationHash({ caseRef: row.caseRef, scenario: row.scenario, timeline: row.timeline, expected: row.expected }) } : null]));
    await new Promise(resolve => setTimeout(resolve, 5));
    // Phase 2, run: run.startedAt is measured here, at the real start of the first scenario, after the freeze (never shifted by hand).
    const startedAt = new Date().toISOString();
    expect(Date.parse(startedAt)).toBeGreaterThan(Date.parse(frozenAt));

    const observe = async (caseRef: string): Promise<Observed> => {
      sends = 0; loseAck = false; const started = Date.now();
      const { mail, proposal, validationId, executionId } = await queuedReply();
      const proposedAt = new Date().toISOString(), refusals: string[] = [], sendsByExecution = new Map<string, number>();
      const counted = async (id: string, hooks?: Parameters<typeof run>[1]) => {
        const before = sends, outcome = await run(id, hooks);
        sendsByExecution.set(id, (sendsByExecution.get(id) ?? 0) + sends - before); return outcome;
      };
      let result: unknown;
      switch (caseRef) {
        case "SYN-B02": {
          const second = await submitCaseReplyProposal({ ...proposal, text: finalReplyText("Bonjour, texte de la console.") }, storeDeps());
          if (!second.ok) refusals.push(second.code);
          result = await counted(executionId); break;
        }
        case "SYN-B03": await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId }); result = await counted(executionId); break;
        case "SYN-B04": await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: (await readCase(mail.caseId))!.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `syn-own-${mail.caseId}`, reason: "fixture" });
          result = await counted(executionId); break;
        case "SYN-B05": await setV2Pause("fully_paused"); result = await counted(executionId); await setV2Pause(null); break;
        case "SYN-B06": result = await counted(executionId, { afterMarker: async () => { throw Error("SAV_TEST_CRASH"); } }); break;
        case "SYN-B07": await f.db.update(savMessages).set({ fromEmail: "quelquun-dautre@example.invalid" }).where(eq(savMessages.id, mail.messageId)); result = await counted(executionId); break;
        case "SYN-B08": {
          // The approved reply above is decided before the hand back; B-7 needs the reply AFTER it: run the canonical one, then the back: one.
          await enqueueApprovedCaseReply({ validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
          const fresh = await v1Mail();
          expect((await investigate(fresh.caseId)).report).toMatchObject({ status: "recorded" });
          await handBack(fresh.caseId, "syn");
          expect((await investigate(fresh.caseId)).report).toMatchObject({ status: "recorded", outcome: "accepted" });
          sends = 0; sendsByExecution.clear();
          const fromB = await proposalOf(fresh), backKey = latestInvestigationInput(await listCaseEvents(fresh.caseId))!;
          const first = await validateAndQueue(fromB); result = await counted(first.executionId);
          const second = await tryQueue({ ...fromB, triggerEventId: backKey, text: finalReplyText("Bonjour, autre texte après la remise.") });
          if ("executionId" in second) await counted(second.executionId); else refusals.push(second.refused);
          break;
        }
        case "SYN-B10": return { purpose: proposal.purpose, final: "unknown", reason: null, refusals, sends: null, sendsByReplyKey: null, proposedAt, latencyMs: null,
          notComparable: [{ field: "effect.final", reason: "executor_not_run" }, { field: "effect.reason", reason: "executor_not_run" }, { field: "sends.total", reason: "executor_not_run" }] };
        default: result = await counted(executionId);
      }
      return { purpose: proposal.purpose, ...outcomeOf(result), refusals, sends, sendsByReplyKey: await distributionOf(sendsByExecution), proposedAt, latencyMs: Date.now() - started };
    };

    const cases = [];
    for (const row of SCENARIOS) {
      const seen = await observe(row.caseRef), unknown = new Set((seen.notComparable ?? []).map(entry => entry.field));
      const all = row.expected ? [["reply.purpose", row.expected.purpose, seen.purpose], ["effect.final", row.expected.final, seen.final], ["effect.reason", row.expected.reason, seen.reason], ["sends.total", row.expected.sends, seen.sends], ["refusals", row.expected.refusals, seen.refusals]] as const : [];
      // Every compared field takes its expected value from the frozen expectation; an unknown observed field is listed, never compared.
      const fields = all.filter(([field]) => !unknown.has(field)).map(([field, expected, proposed]) => ({ field, expected, proposed }));
      const diffs = fields.filter(field => JSON.stringify(field.expected) !== JSON.stringify(field.proposed)).length;
      // B's own recomputation, same rule as the reader; a case with an unknown observed field is not comparable.
      const declaredVerdict = !row.expected || unknown.size ? "not_comparable" : diffs ? "mismatch" : row.expected.refusals.length ? "refused_as_expected" : "match";
      cases.push({
        caseRef: row.caseRef, scenario: row.scenario, expected: frozen.get(row.caseRef) ?? null, proposedAt: seen.proposedAt, fields, declaredVerdict, refusals: seen.refusals,
        actions: seen.final === "unknown" ? [] : [{ kind: "reply", simulated: true, outcome: seen.final === "would_send" ? "would_send" : seen.final, reason: seen.reason }],
        proofs: [{ kind: "replyKeys", ref: seen.sendsByReplyKey?.map(entry => entry.replyKey).join(" ") || "none" }, { kind: "networkCalls", ref: String(vi.mocked(fetch).mock.calls.length) }],
        cost: { modelCalls: 1, paidCalls: 0 }, latencyMs: seen.latencyMs,
        // B's additive fields (ignored by the proposal-1 reader, required by the common contract):
        timeline: row.timeline, executor: { simulated: true, syntheticSends: seen.sends, sendsByReplyKey: seen.sendsByReplyKey, replyKeys: seen.sendsByReplyKey?.length ?? null },
        notComparable: seen.notComparable ?? [], expectedMeta: row.expected ? { canonicalization: "sorted-keys-json-utf8-sha256", frozenBy: null, b7Policy: "undecided", frozen: { caseRef: row.caseRef, scenario: row.scenario, timeline: row.timeline, expected: row.expected } } : null,
      });
    }
    const report = {
      kind: "sav-v2-simulation-report.proposal-1",
      run: { id: `syn-delivery-${startedAt}`, startedAt, expectationsFrozenAt: frozenAt, base: { sha: process.env.SYN_BASE_SHA ?? "0".repeat(40), tree: process.env.SYN_BASE_TREE ?? "0".repeat(40) }, synthetic: true,
        provenance: { contract: "sav-v2-simulation-report.common-1", generator: "studio/src/lib/sav/cases/investigation-delivery-journey.test.ts", executor: "simulated", provider: "synthetic-gmail-no-socket", model: "synthetic-double",
          policy: { admission: "policy-r1", executionPolicyHash: policyHash, knowledge: "kb-r1", rules: "rules-r1", playbook: "playbook-1", prompt: "prompt-r1" },
          cohort: { id: "syn-delivery-v1", kind: "synthetic", cases: SCENARIOS.length, selection: "fixed list of B scenarios, no customer case" } } },
      cases,
    };
    const read = readSimulationReport(report);
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    // UX 4d92369 reads common-1 (notComparable[] included): B10, whose executor never ran, is "not comparable" (proposal-1 closed it as inconsistent);
    // neither is ever a match, and this is B's own recomputed verdict below.
    expect(read.cases.map(row => [row.caseRef, row.verdict])).toEqual([
      ["SYN-B01", "match"], ["SYN-B02", "refused_as_expected"], ["SYN-B03", "match"], ["SYN-B04", "match"], ["SYN-B05", "match"], ["SYN-B06", "match"], ["SYN-B07", "match"],
      ["SYN-B08", "refused_as_expected"], ["SYN-B09", "not_comparable"], ["SYN-B10", "not_comparable"],
    ]);
    expect(read.paidCalls).toBe(0);
    // B's reference check of the common contract: no gate error; verdicts recomputed; B-7 (C's situation guard): the second name is refused, one send in all.
    const checked = checkCommonSimulationReport(report);
    expect(checked.errors).toEqual([]);
    expect(checked.verdicts).toEqual({ "SYN-B01": "match", "SYN-B02": "refused_as_expected", "SYN-B03": "match", "SYN-B04": "match", "SYN-B05": "match", "SYN-B06": "match",
      "SYN-B07": "match", "SYN-B08": "refused_as_expected", "SYN-B09": "not_comparable", "SYN-B10": "not_comparable" });
    const b08 = cases.find(row => row.caseRef === "SYN-B08")!.executor.sendsByReplyKey!;
    expect(b08.map(entry => entry.count)).toEqual([1]);
    expect(b08.map(entry => entry.replyKey.split(":")[2])).toEqual(["inbound"]);
    expect(cases.find(row => row.caseRef === "SYN-B08")!.fields).toContainEqual({ field: "sends.total", expected: 1, proposed: 1 });
    expect(cases.find(row => row.caseRef === "SYN-B08")!.fields).toContainEqual({ field: "refusals", expected: ["situation_already_answered"], proposed: ["situation_already_answered"] });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    if (process.env.SYN_REPORT_OUT === "1") process.stdout.write(`\nSYN_REPORT_BEGIN${JSON.stringify(report)}SYN_REPORT_END\n`);
  });
});
