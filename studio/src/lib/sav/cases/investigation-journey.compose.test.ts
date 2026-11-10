import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
// No model is dispatched on this path: B's provider is a port. The real executor imports V1's dispatcher; every function of it throws if called.
vi.mock("../intake/model-dispatch", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => { throw Error(`MODEL_DISPATCH_FORBIDDEN:${name}`); } : value]));
});
import { savCaseCalls, savCaseEffectExecutions, savCaseReplyValidations, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { describeCaseReply, describeCaseReplyDetail, readCaseReplies, readCaseReply } from "@/app/studio/sav/v2/case-replies";
import { caseReplyReaders } from "@/app/studio/sav/v2/case-replies-port";
import { buildCasePilotView } from "@/app/studio/sav/v2/case-view";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { SAV_INTAKE_CONTRACT_REVISION, type SavIntakeDecision } from "../intake/contract";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { approveIntakeExecutionPolicy, type ExecutionPolicy } from "../intake/execution-policy";
import type { ExecutorAdapters } from "../intake/execution-types";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { readConfirmedV1Context } from "./admission-context-reader";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import { caseInvestigationAdmissionPorts, caseInvestigationQualify, caseRelayAdmissionDeps, type AdmissionInvestigationDeps, type CaseApprovedRulePort } from "./admission-investigation-ports";
import { caseTicketOwnerPortFromTransport, type CaseOwnerReadTransport } from "./admission-owner-reader";
import { ticketOwnerPort, type AdmissionPolicyRecord, type V1AdmissionAdapterPolicy } from "./admission-runtime";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { caseReplyFinalTextProblem, readCaseReplyDisclosure } from "./case-reply-outbound";
import { decideCaseReply } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { proposeCaseReplyFromDraft, queueValidatedCaseReply, runCaseEffectsPass } from "./case-runtime-effects";
import { judgeCurrentTicketOwner, type CaseTicketOwnerPort } from "./case-ticket-owner";
import { listCaseEvents, listCaseTimers, readCase, readCaseByTicket, transitionCaseOwner } from "./case-store";
import { caseAwaitsV2Attribution, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { observeTicketCrmChange } from "./owner-attribution";
import type { CaseEmbeddingSpendPort, CaseEmbeddingTransport, CaseKnowledgeVectorSearch } from "./investigation-budgeted-retrieval";
import { caseDecisionDraft } from "./investigation-intent";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput, type CaseInvestigationModelRequest } from "./investigation-runner";
import { caseCallLedgerOnStore, runCaseInvestigationRuntime, type CaseInvestigationRuntimeDeps } from "./investigation-runtime";

/*
 * ROOT B8 (night of 01/11), raccord bench on the private composition 0131 (ad9744a), SYN only on PGlite, LOCAL / OFF. The junction no test held yet,
 * end to end on the real writers and readers: V1's records of a NEW ticket today (no V2 owner effect since A ef74b35) → A's relay with A's admission
 * ports → A's qualification → B's runtime (budgeted knowledge: embedding and vector doubles; A's real call ledger; model double) → decision stored →
 * B's draft → C's `proposeCaseReplyFromDraft` (AI mention before the hash) → a person's approval → C's `queueValidatedCaseReply` → C's
 * `runCaseEffectsPass` on the real executor and the synthetic Gmail (no socket) → the V2 page's real readers (`buildCasePilotView`, C's registry readers).
 *
 * SYN PRECONDITIONS, explicit (not product validation; no application code produces them today):
 *  - P1 A's D-a adapter policy, approved rule and admission policy are synthetic, approved FOR THIS TEST ONLY (production has none: nobody is admitted).
 *  - P2 the case is given to the agent by a person through A's real writer `transitionCaseOwner(hand_back)`, with A's real qualification as admission:
 *    no route or Studio action calls it, and V1 no longer attributes a new ticket to V2 (ef74b35).
 *  - P3 the HubSpot owner read (A's `ticketOwnerPort`) answers the V2 owner: nobody writes it on a new ticket today.
 *  - P4 the reply approval uses a test authorizer (the application wires only `denyAllCaseReplyAuthorizer`) and a synthetic execution policy granted by
 *    a synthetic admin through V1's real `approveIntakeExecutionPolicy`.
 *  - P5 the reply language has no proven source in B's draft: C's documented fallback (`unknown`, French footer) is used, nothing is guessed.
 * Not claimed: the knowledge revision B checked before recording is not carried to C's proposal nor re-checked at the send (ROOT: no KB freshness up to the SDK).
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", policyHash = "", policy: ExecutionPolicy, seq = 9_810_000;
let p: ReturnType<typeof executionProvider>, adapters: ExecutorAdapters, sends = 0, crmOwner = "90000001", environment: Record<string, string | undefined> = {};
const AT = "2026-11-01T01:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000008", V2_OWNER = "90000001", HUMAN_OWNER = "70000001";
const ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" };
const SENDER = "client@example.invalid";
const SYN_ADAPTER: V1AdmissionAdapterPolicy = { revision: "syn-adapter-r1-pour-test", decidedBy: "synthetic-test-approval-not-production", identity: "sender_unique_crm_match" };
const SYN_RULE = { ruleId: "syn-rule-access-pour-test", revision: "r1" };
const SYN_POLICY = { revision: "syn-policy-r1-pour-test", admittedFamilies: ["access"], qualifiedRules: [{ ...SYN_RULE, families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const SYN_RECORD: AdmissionPolicyRecord = { policy: SYN_POLICY, validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2099-01-01T00:00:00.000Z" };
const synRule: CaseApprovedRulePort = async ({ requests }) => requests.filter(request => request.kind === "support")
  .map(request => ({ requestId: request.requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ...SYN_RULE, at: AT } }));
/** P1: A's consumer on its real V1 context reader, with the synthetic adapter, rule and policy; V1 reads counted. */
const admission = { reads: [] as string[] };
const sources: AdmissionInvestigationDeps = {
  readConfirmedContext: async messageId => { admission.reads.push(messageId); return readConfirmedV1Context(messageId); },
  adapterPolicy: async () => SYN_ADAPTER, readPolicyRecord: async () => SYN_RECORD, now: () => new Date(), approvedRules: synRule,
};
/** P3: A's real owner port; only the HubSpot read under it is the double. */
const owner = ticketOwnerPort({ readHubspotTicketOwner: async () => crmOwner, env: ENV });
/** B11: the owner port B and C are given; the B8 journeys keep P3's direct double (reset before each test), the B11 describe swaps in A10's real reader. */
let ownerInUse: CaseTicketOwnerPort = owner;
/**
 * B11: A10's real reader (`caseTicketOwnerPortFromTransport` → `hubspotTicketOwnerReader` → A's `ticketOwnerPort`) on an injected GET transport. The transport
 * is a local double answering synthetic JSON (no fetch, no HubSpot); it records every request. `ownerAt(n)` is the owner of the n-th read since the last reset;
 * `body` replaces the JSON when a probe needs a malformed or foreign answer.
 */
const crm = {
  requests: [] as Array<{ method: string; path: string }>,
  ownerAt: (() => crmOwner) as (n: number) => string | null,
  body: null as null | ((ticketId: string, ownerId: string | null) => unknown),
};
const crmTransport: CaseOwnerReadTransport = async request => {
  crm.requests.push({ ...request });
  const ticketId = /^\/crm\/v3\/objects\/tickets\/([0-9]{1,30})\?properties=hubspot_owner_id$/.exec(request.path)?.[1];
  if (request.method !== "GET" || !ticketId) throw Error("SYN_TRANSPORT_UNEXPECTED_REQUEST");
  const ownerId = crm.ownerAt(crm.requests.length);
  return crm.body ? crm.body(ticketId, ownerId)
    : { id: ticketId, archived: false, properties: { hs_object_id: ticketId, hubspot_owner_id: ownerId }, createdAt: AT, updatedAt: AT };
};
const ownerFromA10 = caseTicketOwnerPortFromTransport({ transport: crmTransport, env: ENV });
/** The only request A10 may make for a ticket: one GET, fixed path, the owner property only. */
const ownerGet = (ticketId: string) => ({ method: "GET", path: `/crm/v3/objects/tickets/${ticketId}?properties=hubspot_owner_id` });
const { admissionPolicyRevision } = caseInvestigationAdmissionPorts(sources);
const storeDeps = () => ({ env: () => environment, readTicketOwner: ownerInUse, currentPolicyRevision: admissionPolicyRevision });
/** P4: the test's authorizer; the code under test never builds one. */
const allowForTest: CaseReplyAuthorizer = () => ({ allowed: true, basis: "syn.precondition.test-authorizer" });

const evidence = (id: string, source: "current_message" | "crm_contact" | "crm_ticket", sourceId: string) => ({ id, source, sourceId, observedAt: "2026-10-20T09:00:00.000Z", contentHash: "a".repeat(43) });
function ticketDecision(messageId: string, threadId: string, ticketId: string): SavIntakeDecision {
  return {
    revision: SAV_INTAKE_CONTRACT_REVISION, messageId, latestInboundMessageId: messageId, threadId, receivedAt: "2026-10-20T09:00:00.000Z",
    classification: "support", requests: [{ id: "request-1", kind: "support", evidenceIds: ["current"] }],
    evidence: [evidence("current", "current_message", messageId), evidence("contact", "crm_contact", "101"), evidence("ticket", "crm_ticket", ticketId),
      { ...evidence("ticket-contact", "crm_ticket", `synthetic-association-${ticketId}-101`), source: "ticket_contact_association" as const, ticketId, contactId: "101", direction: "ticket_to_contact" as const }],
    disposition: {
      kind: "ticket", target: { operation: "link", contactId: "101", ticketId, alreadyNew: false, ticketEvidenceId: "ticket", contactAssociationEvidenceId: "ticket-contact" },
      requestIds: ["request-1"],
      contactScope: { primaryContactId: "101", contacts: [{ origin: "email_lookup", addressOrigin: "sender", contactId: "101", evidenceIds: ["contact"] }], complete: true },
      search: "complete", history: "complete",
      identity: { kind: "unique_crm_match_for_intake", addressOrigin: "sender", scope: "intake_only", evidenceIds: ["current", "contact"] },
      sameIssueEvidenceIds: ["current", "ticket"], requiredPermissions: ["link_ticket", "associate_email", "append_ticket_note", "set_ticket_new"],
      multiTicketNote: { openTicketIdsOnTargetContact: [ticketId] },
      note: { kind: "existing_return_summary", version: 2, previousState: "open", warningPrefix: null, sourceMessageId: messageId, sourceEvidenceIds: ["current"], renderedContentHash: "a".repeat(43), deduplication: "source_message_and_final_ticket" },
      learning: "eligible_after_confirmed_effect", evidenceIds: ["current", "contact", "ticket", "ticket-contact"],
    },
  };
}

/** One V1 mail on a ticket as today's V1 leaves it (confirmed execution with its decision, accepted analysis; NO V2 owner effect), then A's relay. */
async function v1Mail(options: { ticketId?: string; threadId?: string } = {}) {
  const ticketId = options.ticketId ?? String(++seq), threadId = options.threadId ?? randomUUID(), messageId = randomUUID(), gmail = `gm-${messageId}`;
  if (!options.threadId) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Corps synthétique", headers: { "message-id": `<${messageId}@example.invalid>` }, attachments: [] }), receivedAt: new Date(), gmailMessageId: gmail });
  const runVersion = (await f.db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, threadId))).length + 1;
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: [{ id: "request-1", kind: "support", currentMessageId: messageId }], ticketSummary: { title: "Connexion impossible", description: "Le code n'arrive pas.", requestIds: ["request-1"] } };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: runVersion, isCurrent: false, state: "observed", configHash: `journey-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
      records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runId: run!.id, runVersion, policyId, policyHash, state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: ticketDecision(messageId, threadId, ticketId) } }) });
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }), ...caseRelayAdmissionDeps(sources), env: ENV }) as { caseId: string };
  p.setGmail(gmail, `thread-${threadId}`); p.seedTicket({ id: ticketId });
  return { ticketId, threadId, messageId, gmail, caseId: relayed.caseId };
}

/** P2: a person gives the case to the agent through A's writer, with A's real qualification of the case's current input as the admission. */
async function personHandsBack(caseId: string) {
  const snapshot = (await readCase(caseId))!, qualified = await caseInvestigationQualify(sources)(snapshot, await listCaseEvents(caseId));
  if (!qualified) throw Error("A_QUALIFICATION_NULL");
  return transitionCaseOwner({ caseId, expectedVersion: snapshot.version, transition: "hand_back", to: "agent", actor: { type: "human", staffUserId: STAFF },
    commandKey: `journey-back-${caseId}`, reason: "syn_precondition_person_gives_case", admission: qualified.admission });
}

const card: SavRetrievalCandidate = { id: "k-login", contentVersionId: "k-login-v1", title: "Fiche connexion", content: "Procédure synthétique.", source: "fixture",
  verifiedAt: new Date(Date.now() - 864_000_000).toISOString(), semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
const ref: KnowledgeRef = { knowledgeId: card.id, contentVersionId: card.contentVersionId };
const DRAFTED = "Bonjour, voici la marche à suivre depuis https://new.limova.ai : suivre la fiche.";
const answer = (request: CaseInvestigationModelRequest) => {
  const snapshot: CaseSnapshot = request.snapshot, open = snapshot.body.openRequests.filter(row => row.status === "open");
  return { status: "ok" as const, output: { caseVersion: snapshot.version,
    understanding: { requests: open.map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
    nextAction: { kind: "answer", requestIds: [open[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: ref }], expectedResult: "La connexion fonctionne." },
    reply: { text: DRAFTED, citations: [ref], impossibilityClaims: [], accountAdvice: "none" } } };
};
const DIM = 8;
/** B's runtime on A's admission ports, A's owner port and A's real call ledger; the embedding, vector search, spend and model are counted doubles. */
function wiring() {
  const counts = { embeddings: 0, vectorSearches: 0, spendReserve: 0, money: 0, model: 0 };
  const vectors: CaseKnowledgeVectorSearch = { dimension: DIM, readRevision: async () => "kb-syn-r1", available: async () => true,
    search: async queries => { counts.vectorSearches++; return queries.map(() => [card]); } };
  const embed: CaseEmbeddingTransport = async ({ texts }) => { counts.embeddings++; return { vectors: texts.map((_, i) => Array.from({ length: DIM }, (__, j) => (i + 1) / (j + 3))), usage: null }; };
  const spend: CaseEmbeddingSpendPort = { reserve: async () => { counts.spendReserve++; return { status: "allowed", reservationId: `res-${counts.spendReserve}` }; }, settle: async () => undefined, release: async () => undefined };
  const deps: CaseInvestigationRuntimeDeps = {
    mode: "observe", holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now: () => new Date(Date.now() + 6 * 60_000), leaseSeconds: 60,
    pauseState: async () => (await readSavAgentPause(f.db as never, "v2")).level, readTicketOwner: ownerInUse,
    ...caseInvestigationAdmissionPorts(sources),
    // Pilot ACCÈS (3/11): a SYNTHETIC approved scope listing the fixture card; the runtime is closed without one.
    accessScope: async () => ({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: await admissionPolicyRevision(), revision: "syn-scope-r1", family: "access", sources: [{ knowledgeId: card.id, contentVersionId: card.contentVersionId, use: "answer" }] }),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    ledger: caseCallLedgerOnStore, knowledge: { vectors, embed, spend },
    model: { money: async () => { counts.money++; return { status: "allowed" }; }, provider: async request => { counts.model++; return answer(request); } },
  };
  return { deps, counts };
}

/** B's draft of the latest recorded decision, handed to C's entrypoint as is, with P5's language. */
async function proposeFromB(caseId: string) {
  const events = await listCaseEvents(caseId), read = readCaseInvestigationProgress(events, latestInvestigationInput(events)!);
  if (read.state !== "found") throw Error(`NO_RECORD:${read.state}`);
  const draft = caseDecisionDraft(caseId, read.record, events, { accessScope: { revision: "syn-scope-r1", policyRevision: (await admissionPolicyRevision())! } });
  if (!draft) throw Error("NO_DRAFT");
  const proposed = await proposeCaseReplyFromDraft({ caseId, triggerEventId: draft.triggerEventId, decidedOn: draft.decidedOn, reply: draft.reply, language: { code: "unknown", proven: false } }, storeDeps());
  return { draft, proposed };
}
const pass = () => runCaseEffectsPass({ ...storeDeps(), adapters, deadlineMs: Date.now() + 60_000, context: { runtime: {} as never, policy } });
/** The V2 case page's own reading sequence (page.tsx), after its staff check: the same real readers, nothing rendered. */
async function page(ticketId: string, replyId?: string) {
  const snapshot = (await readCaseByTicket(ticketId))!;
  const [events, timers, pause, replies, reply] = await Promise.all([listCaseEvents(snapshot.caseId), listCaseTimers(snapshot.caseId), readSavAgentPause(f.db as never, "v2"),
    readCaseReplies(caseReplyReaders, { caseId: snapshot.caseId }), readCaseReply(caseReplyReaders, { caseId: snapshot.caseId, id: replyId })]);
  return { view: buildCasePilotView({ snapshot, events, timers, pause, now: new Date() }), replies, reply };
}
const calls = async (caseId: string) => (await f.db.select({ purpose: savCaseCalls.purpose, state: savCaseCalls.state }).from(savCaseCalls).where(eq(savCaseCalls.caseId, caseId))).length;
const rows = async (caseId: string) => ({
  validations: (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, caseId))).length,
  executions: (await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, caseId))).length,
  outbound: (await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed").length,
});
const sentBodies = () => Object.values(p.sent).map(message => Buffer.from((message as { payload: { body: { data: string } } }).payload.body.data, "base64url").toString("utf8"));

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-journey-encryption-key-32-characters");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-journey-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
  state.user = { id: admin!.clerkId, primaryEmailAddress: { emailAddress: admin!.email, verification: { status: "verified" } } };
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
  policy = {
    revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
    createdAfter: new Date(Date.now() - 10_000).toISOString(), receivedAfter: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    maxDossiers: 10, mutations: ["send_case_reply", "append_case_note"], admission: { kind: "automatic" },
  };
  const grant = await approveIntakeExecutionPolicy(policy);
  policyId = grant.id; policyHash = grant.policyHash;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-journey-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); vi.stubEnv("SAV_CASE_EFFECTS", "supervised");
  vi.spyOn(console, "info").mockImplementation(() => { });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  environment = { SAV_CASE_EFFECTS: "supervised", SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash, SAV_CODE_REVISION: "a".repeat(40), HUBSPOT_ACCESS_TOKEN: "fake" };
  p = executionProvider(SENDER); sends = 0; crmOwner = V2_OWNER; admission.reads.length = 0; ownerInUse = owner;
  const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => { if (path === "messages/send") sends += 1; return p.gmail<T>(mailbox, path, init); };
  adapters = createIntakeExecutorAdapters({ network: p.network, gmailRequest: gmail, gmailPermissions: async () => { }, env: () => environment });
});
afterEach(() => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("B8 raccord: V1 → A relay and qualification → B budgeted decision → C proposal, approval, simulated send → V2 page readers (0131, SYN)", () => {
  it("nominal today, under P1–P5: nothing before a person gives the case; then exactly 1 embedding, 1 model call, 1 proposal, 1 approval, 1 simulated send, read back by the page", async () => {
    const mail = await v1Mail();
    // Today's V1 attributes nobody: the case waits for its V2 attribution and B does nothing.
    expect(caseAwaitsV2Attribution((await readCase(mail.caseId))!)).toBe(true);
    const idle = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, idle.deps)).toMatchObject({ modelCalls: 0 });
    expect(idle.counts).toEqual({ embeddings: 0, vectorSearches: 0, spendReserve: 0, money: 0, model: 0 });
    expect((await page(mail.ticketId)).view.humanHold).toEqual({ state: "awaiting_attribution" });

    await personHandsBack(mail.caseId);
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(counts).toEqual({ embeddings: 1, vectorSearches: 1, spendReserve: 1, money: 1, model: 1 });
    expect(await calls(mail.caseId)).toBe(2); // one knowledge embedding call and one model call, in A's ledger

    const { draft, proposed } = await proposeFromB(mail.caseId);
    expect(draft).toMatchObject({ triggerEventId: `inbound:${mail.gmail}`, reply: { purpose: "answer", text: DRAFTED }, replyLimit: null });
    if (!proposed.ok) throw Error(`PROPOSE_REFUSED:${proposed.code}`);
    expect(proposed).toMatchObject({ created: true, state: "proposed", recipient: SENDER, language: { language: "unknown", proof: "fallback" } });
    // The AI mention is in the stored text BEFORE the hash; nothing can be queued or sent before a person decides.
    const stored = decryptSavPayload<CaseReplyProposal>((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, proposed.validationId)))[0]!.proposalCiphertext);
    expect(stored.text.startsWith(DRAFTED)).toBe(true);
    expect(caseReplyFinalTextProblem(stored.text)).toBeNull();
    expect(readCaseReplyDisclosure(stored.text)).toMatchObject({ mode: "manual_reviewed" });
    expect(caseReplyPayloadHash(stored)).toBe(proposed.payloadHash);
    expect(await queueValidatedCaseReply({ validationId: proposed.validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() })).toEqual({ ok: false, code: "not_validated", detail: "proposed" });
    expect((await pass()).supervised).toEqual([]);
    expect(sends).toBe(0);

    // What the page shows is what the person approves: the stored text, its stored hash.
    const before = await page(mail.ticketId, proposed.validationId);
    if (before.reply.state !== "ok" || before.replies.state !== "ok") throw Error("PAGE_UNREADABLE");
    expect(before.view.proposal).toMatchObject({ state: "found", reply: DRAFTED });
    expect(describeCaseReply(before.replies.items[0]!)).toMatchObject({ status: "En attente de validation humaine", sent: "Rien n’est parti vers le client." });
    expect(before.reply.reply).toMatchObject({ payloadHash: proposed.payloadHash, recipient: SENDER, proposal: { text: stored.text } });
    expect(describeCaseReplyDetail(before.reply.reply, value => value).mentionOk).toBe(true);
    const decided = await decideCaseReply({ action: "approve", validationId: proposed.validationId, approverId: STAFF, authorizer: allowForTest, deps: storeDeps(),
      seen: { payloadHash: before.reply.reply.payloadHash, caseVersion: before.reply.reply.caseVersion, recipient: before.reply.reply.recipient } });
    expect(decided).toMatchObject({ ok: true, state: "approved" });
    const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
    if (!queued.ok) throw Error(`QUEUE_REFUSED:${queued.code}`);

    expect((await pass()).supervised).toEqual([{ executionId: queued.executionId, state: "confirmed", reason: null }]);
    expect(sends).toBe(1);
    expect(sentBodies()).toEqual([stored.text]);
    expect(await rows(mail.caseId)).toEqual({ validations: 1, executions: 1, outbound: 1 });
    const after = await page(mail.ticketId, proposed.validationId);
    if (after.replies.state !== "ok") throw Error("PAGE_UNREADABLE");
    expect(describeCaseReply(after.replies.items[0]!)).toMatchObject({ status: "Envoyée, reçu confirmé", tone: "success" });
    expect(after.view.observedOutbound).toHaveLength(1);
    // A second pass sends nothing more.
    await pass();
    expect(sends).toBe(1);
    expect(counts.model + idle.counts.model).toBe(1);
  });

  it("a person takes the ticket back in HubSpot after giving it to the agent and before any investigation: 0 qualification, 0 investigation, 0 proposal, 0 send; the page says a person took it", async () => {
    const mail = await v1Mail();
    await personHandsBack(mail.caseId);
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "agent" });
    crmOwner = HUMAN_OWNER;
    // A's real observation of the HubSpot change: a person owner on an agent's case takes it from the agent.
    expect(await observeTicketCrmChange({ ticketId: mail.ticketId, ownerId: HUMAN_OWNER, hubspotUpdatedAt: new Date().toISOString(), env: ENV })).toMatchObject({ recorded: true, takeover: true });
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "human" });
    admission.reads.length = 0;
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(counts).toEqual({ embeddings: 0, vectorSearches: 0, spendReserve: 0, money: 0, model: 0 });
    expect(admission.reads).toEqual([]);
    expect(await calls(mail.caseId)).toBe(0);
    expect((await pass()).supervised.filter(row => row.executionId)).toEqual([]);
    expect(sends).toBe(0);
    expect(await rows(mail.caseId)).toEqual({ validations: 0, executions: 0, outbound: 0 });
    const shown = await page(mail.ticketId);
    expect(shown.view.humanHold).toMatchObject({ state: "taken" });
    expect(shown.replies).toEqual({ state: "ok", items: [], next: null });
  });

  it("a new customer mail after the approval and before the SDK: the old reply sends 0; the new mail is a new input whose reply waits for its own explicit approval", async () => {
    const mail = await v1Mail();
    await personHandsBack(mail.caseId);
    expect(await runCaseInvestigationRuntime(mail.caseId, wiring().deps)).toMatchObject({ status: "recorded", outcome: "accepted" });
    const first = await proposeFromB(mail.caseId);
    if (!first.proposed.ok) throw Error(`PROPOSE_REFUSED:${first.proposed.code}`);
    const shown = await page(mail.ticketId, first.proposed.validationId);
    if (shown.reply.state !== "ok") throw Error("PAGE_UNREADABLE");
    expect(await decideCaseReply({ action: "approve", validationId: first.proposed.validationId, approverId: STAFF, authorizer: allowForTest, deps: storeDeps(),
      seen: { payloadHash: shown.reply.reply.payloadHash, caseVersion: shown.reply.reply.caseVersion, recipient: shown.reply.reply.recipient } })).toMatchObject({ ok: true });
    const queued = await queueValidatedCaseReply({ validationId: first.proposed.validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
    if (!queued.ok) throw Error(`QUEUE_REFUSED:${queued.code}`);
    const oldId = first.proposed.validationId;

    const second = await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId });
    expect(second.caseId).toBe(mail.caseId);
    const ran = await pass();
    expect(ran.supervised.filter(row => row.executionId === queued.executionId)).toEqual([{ executionId: queued.executionId, state: "refused", reason: expect.stringMatching(/NEW_INPUT/i) }]);
    expect(sends).toBe(0);
    const cancelled = await page(mail.ticketId, first.proposed.validationId);
    if (cancelled.replies.state !== "ok") throw Error("PAGE_UNREADABLE");
    expect(describeCaseReply(cancelled.replies.items.find(item => item.id === oldId)!)).toMatchObject({ status: "Annulée avant l’envoi : nouveau message du client", sent: "Rien n’est parti vers le client." });

    // The new mail: re-qualified by A (stale admission), decided by B on its own input, proposed by C under its own key, and NOT sent without a person.
    admission.reads.length = 0;
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(admission.reads).toEqual([second.messageId]);
    expect(counts).toEqual({ embeddings: 1, vectorSearches: 1, spendReserve: 1, money: 1, model: 1 });
    const next = await proposeFromB(mail.caseId);
    expect(next.draft.triggerEventId).toBe(`inbound:${second.gmail}`);
    if (!next.proposed.ok) throw Error(`PROPOSE_REFUSED:${next.proposed.code}`);
    expect(next.proposed).toMatchObject({ created: true, state: "proposed" });
    const newId = next.proposed.validationId;
    expect(await queueValidatedCaseReply({ validationId: next.proposed.validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() })).toEqual({ ok: false, code: "not_validated", detail: "proposed" });
    expect((await pass()).supervised.filter(row => row.executionId !== queued.executionId)).toEqual([]);
    expect(sends).toBe(0);
    const waiting = await page(mail.ticketId, next.proposed.validationId);
    if (waiting.replies.state !== "ok") throw Error("PAGE_UNREADABLE");
    expect(describeCaseReply(waiting.replies.items.find(item => item.id === newId)!)).toMatchObject({ status: "En attente de validation humaine" });
    expect(await rows(mail.caseId)).toEqual({ validations: 2, executions: 1, outbound: 0 });
  });
});

/*
 * ROOT B11 (01/11), private composition 0258 (4e8fa10), SYN only: the same journey with A10's REAL owner reader instead of P3's direct double. Only the GET
 * transport under it is local: it answers synthetic JSON and records every request (no fetch, no HubSpot, no connection). P1, P2, P4 and P5 above stay SYN
 * preconditions; an injected GET JSON is not a CRM connection, not a compare-and-set and no proof that the CRM and Gmail steps are atomic (C's declared limit).
 */
describe("B11 raccord: A10's HubSpot owner reader on a synthetic GET JSON transport → real B → real C (0258, SYN)", () => {
  /** Reads of the ticket owner made by one nominal effects pass (observed on 0258, then fixed): the last one is C's look right before the SDK. */
  const PASS_READS = 4;
  beforeEach(() => { ownerInUse = ownerFromA10; crm.requests.length = 0; crm.ownerAt = () => crmOwner; crm.body = null; });
  const onlyThisTicket = (ticketId: string) => expect(crm.requests).toEqual(crm.requests.map(() => ownerGet(ticketId)));

  /** B's stored decision → C's proposal → a person's approval of what the page shows → C's queue (nothing sent yet). */
  async function approvedAndQueued(mail: Awaited<ReturnType<typeof v1Mail>>) {
    const { proposed } = await proposeFromB(mail.caseId);
    if (!proposed.ok) throw Error(`PROPOSE_REFUSED:${proposed.code}`);
    const shown = await page(mail.ticketId, proposed.validationId);
    if (shown.reply.state !== "ok") throw Error("PAGE_UNREADABLE");
    expect(await decideCaseReply({ action: "approve", validationId: proposed.validationId, approverId: STAFF, authorizer: allowForTest, deps: storeDeps(),
      seen: { payloadHash: shown.reply.reply.payloadHash, caseVersion: shown.reply.reply.caseVersion, recipient: shown.reply.reply.recipient } })).toMatchObject({ ok: true, state: "approved" });
    const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
    if (!queued.ok) throw Error(`QUEUE_REFUSED:${queued.code}`);
    const stored = decryptSavPayload<CaseReplyProposal>((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, proposed.validationId)))[0]!.proposalCiphertext);
    return { proposed, queued, stored };
  }
  /** Nothing new anywhere for this case: no model, embedding or vector call, no V1 read for A's qualification, no ledger row, no proposal, no execution, no send. */
  async function noNewWork(caseId: string, counts: ReturnType<typeof wiring>["counts"]) {
    expect(counts).toEqual({ embeddings: 0, vectorSearches: 0, spendReserve: 0, money: 0, model: 0 });
    expect(admission.reads).toEqual([]);
    expect(await calls(caseId)).toBe(0);
    const events = await listCaseEvents(caseId);
    expect(readCaseInvestigationProgress(events, latestInvestigationInput(events)!).state).not.toBe("found");
    expect((await pass()).supervised.filter(row => row.executionId)).toEqual([]);
    expect(sends).toBe(0);
    expect(await rows(caseId)).toEqual({ validations: 0, executions: 0, outbound: 0 });
  }

  it("nominal: the JSON names the V2 owner of THIS ticket; B decides once, C sends once (simulated), the text sent is the text stored, hashed and approved, AI mention included", async () => {
    const mail = await v1Mail();
    await personHandsBack(mail.caseId);
    crm.requests.length = 0;
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
    expect(counts).toEqual({ embeddings: 1, vectorSearches: 1, spendReserve: 1, money: 1, model: 1 });
    expect(await calls(mail.caseId)).toBe(2);
    const byB = crm.requests.length;
    const { proposed, queued, stored } = await approvedAndQueued(mail);
    const byC = crm.requests.length - byB;
    expect((await pass()).supervised).toEqual([{ executionId: queued.executionId, state: "confirmed", reason: null }]);
    const byPass = crm.requests.length - byB - byC;
    expect(sends).toBe(1);
    expect(sentBodies()).toEqual([stored.text]);
    expect(caseReplyPayloadHash(stored)).toBe(proposed.payloadHash);
    expect(stored.text.startsWith(DRAFTED)).toBe(true);
    expect(caseReplyFinalTextProblem(stored.text)).toBeNull();
    expect(readCaseReplyDisclosure(stored.text)).toMatchObject({ mode: "manual_reviewed" });
    // Every read is A10's one GET of this very ticket, owner property only; the counts are those of 0258.
    onlyThisTicket(mail.ticketId);
    const url = new URL(crm.requests[0]!.path, "https://local.invalid");
    expect([url.pathname, [...url.searchParams.entries()]]).toEqual([`/crm/v3/objects/tickets/${mail.ticketId}`, [["properties", "hubspot_owner_id"]]]);
    expect({ byB, byC, byPass }).toEqual({ byB: 8, byC: 2, byPass: PASS_READS });
    await pass();
    expect(sends).toBe(1);
    expect(await rows(mail.caseId)).toEqual({ validations: 1, executions: 1, outbound: 1 });
  });

  it("the CRM alone names a person (the local case still says agent, no observation recorded): B stops at its first look and writes nothing; 0 new work", async () => {
    const mail = await v1Mail();
    await personHandsBack(mail.caseId);
    crmOwner = HUMAN_OWNER; crm.requests.length = 0; admission.reads.length = 0;
    const before = { snapshot: await readCase(mail.caseId), events: await listCaseEvents(mail.caseId) };
    expect(before.snapshot).toMatchObject({ owner: "agent" });
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "skipped", reason: "ticket_owner_human", detail: "human", modelCalls: 0 });
    expect(crm.requests).toEqual([ownerGet(mail.ticketId)]);
    // Taking the case from the agent is the CRM observation's: B neither writes the owner nor anything else.
    expect(await readCase(mail.caseId)).toEqual(before.snapshot);
    expect(await listCaseEvents(mail.caseId)).toEqual(before.events);
    expect(await judgeCurrentTicketOwner(ownerFromA10, mail.ticketId)).toEqual({ ok: false, code: "owner_human" });
    await noNewWork(mail.caseId, counts);
  });

  it.each([
    ["an answer for another ticket (naming the V2 owner)", (_ticketId: string, ownerId: string | null) => ({ id: "1", archived: false, properties: { hubspot_owner_id: ownerId } }),
      "throws", "owner_read_failed", "owner_read_failed"],
    ["a valid answer without the owner property", (ticketId: string) => ({ id: ticketId, archived: false, properties: { hs_object_id: ticketId } }),
      "unknown", "unknown", "owner_unknown"],
  ] as const)("%s: never read as none nor v2; B stops unverified, C refuses; 0 new work", async (_label, body, portReads, bDetail, cCode) => {
    const mail = await v1Mail();
    await personHandsBack(mail.caseId);
    crm.body = body;
    if (portReads === "throws") await expect(ownerFromA10({ ticketId: mail.ticketId })).rejects.toThrow("SAV_CASE_OWNER_READ_TICKET_MISMATCH");
    else expect(await ownerFromA10({ ticketId: mail.ticketId })).toBe("unknown");
    expect(await judgeCurrentTicketOwner(ownerFromA10, mail.ticketId)).toEqual({ ok: false, code: cCode });
    crm.requests.length = 0; admission.reads.length = 0;
    const before = await readCase(mail.caseId);
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "skipped", reason: "ticket_owner_unverified", detail: bDetail, modelCalls: 0 });
    expect(crm.requests).toEqual([ownerGet(mail.ticketId)]);
    expect(await readCase(mail.caseId)).toEqual(before);
    await noNewWork(mail.caseId, counts);
  });

  it("the JSON turns to a person on C's last look before the SDK: 0 send, and no resend on the next pass", async () => {
    const mail = await v1Mail();
    await personHandsBack(mail.caseId);
    expect(await runCaseInvestigationRuntime(mail.caseId, wiring().deps)).toMatchObject({ status: "recorded", outcome: "accepted" });
    const { proposed, queued } = await approvedAndQueued(mail);
    // Every read of the pass answers the V2 owner except the last one, as in the nominal pass.
    const base = crm.requests.length;
    crm.ownerAt = n => n - base >= PASS_READS ? HUMAN_OWNER : V2_OWNER;
    expect((await pass()).supervised).toEqual([{ executionId: queued.executionId, state: "refused", reason: expect.stringMatching(/OWNER_HUMAN/i) }]);
    expect(crm.requests.length - base).toBe(PASS_READS);
    expect(sends).toBe(0);
    await pass();
    expect(sends).toBe(0);
    expect(p.sent).toEqual({});
    onlyThisTicket(mail.ticketId);
    expect(await rows(mail.caseId)).toEqual({ validations: 1, executions: 1, outbound: 0 });
    const shown = await page(mail.ticketId, proposed.validationId);
    if (shown.replies.state !== "ok") throw Error("PAGE_UNREADABLE");
    expect(describeCaseReply(shown.replies.items[0]!)).toMatchObject({ sent: "Rien n’est parti vers le client." });
  });
});
