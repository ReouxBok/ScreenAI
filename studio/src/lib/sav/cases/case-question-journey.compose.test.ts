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
import { savCaseEffectExecutions, savCaseReplyValidations, savSyncState, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
import { describeCaseReply, readCaseReplies, readCaseReply } from "@/app/studio/sav/v2/case-replies";
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
import { type CaseTicketOwnerPort } from "./case-ticket-owner";
import { listCaseEvents, listCaseTimers, readCase, readCaseByTicket, transitionCaseOwner } from "./case-store";
import { isWithinJ2Slot, nextJ2Slot } from "./j2-calendar";
import { recoverCaseEffects } from "./case-effect-recovery";
import { runDueJ2Pass, type J2Ports } from "./timer-store";
import { type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { observeTicketCrmChange } from "./owner-attribution";
import type { CaseEmbeddingSpendPort, CaseEmbeddingTransport, CaseKnowledgeVectorSearch } from "./investigation-budgeted-retrieval";
import { caseDecisionDraft } from "./investigation-intent";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput, type CaseInvestigationModelRequest } from "./investigation-runner";
import { caseCallLedgerOnStore, runCaseInvestigationRuntime, type CaseInvestigationRuntimeDeps } from "./investigation-runtime";

/*
 * ROOT C10 (01/11), private composition 0258 (B11 e5dc65b), SYN only on PGlite, LOCAL / OFF: the end of the QUESTION cycle, on the real writers and readers.
 * B's runtime decides a real missing-information QUESTION (the model is the only double, with no SDK) → B's draft → C's `proposeCaseReplyFromDraft` (AI mention before the
 * hash) → a person's explicit approval of what the page shows → C's `queueValidatedCaseReply` → C's `runCaseEffectsPass` on the real executor and the synthetic Gmail (no socket)
 * → the receipt: ONE outbound event, ONE question on the case, ONE J2 timer, its due date from the Gmail ACK's own send date and pole A's existing calendar (`nextJ2Slot`).
 * Two journeys only: (1) the nominal question, then a technical pause (due date kept, nothing sent) and either a person or a new customer mail cancelling the old J2;
 * (2) a lost ACK: no J2 before the proof of the send, then the verification-only recovery finds the mail: one receipt, one question, one J2, zero second send.
 *
 * SYN PRECONDITIONS, explicit (not product validation; no application code produces them today), the same as the B8/B11 benches:
 *  - P1 A's D-a adapter policy, approved rule and admission policy are synthetic, approved FOR THIS TEST ONLY (production has none: nobody is admitted).
 *  - P2 the case is given to the agent by a person through A's real writer `transitionCaseOwner(hand_back)` with A's real qualification as admission (no route calls it).
 *  - P3 the HubSpot owner read answers through A10's real reader over an injected synthetic GET transport (no fetch, no CRM); its request counts prove nothing about
 *    provider atomicity: CRM and Gmail steps are not atomic (C's declared limit).
 *  - P4 the reply approval uses a test authorizer (the application wires only `denyAllCaseReplyAuthorizer`) and a synthetic execution policy granted by a synthetic admin
 *    through V1's real `approveIntakeExecutionPolicy`.
 *  - P5 the reply language has no proven source in B's draft: C's documented fallback (`unknown`) is used, nothing is guessed.
 * Not claimed: a real model, real authorization in production, the reminder text/planning (no pole owns it: the J2 pass here only counts what it WOULD plan), a clock-controlled
 * calendar (the real clock runs: the due date is asserted against `nextJ2Slot` of the ACK's own date, and the stored question/timer carry that exact instant).
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", policyHash = "", policy: ExecutionPolicy, seq = 9_810_000;
let loseAck = false, ackOffsetMs = 120_000;
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
let modelAnswer: (request: CaseInvestigationModelRequest) => ReturnType<typeof answer> = answer;
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
    model: { money: async () => { counts.money++; return { status: "allowed" }; }, provider: async request => { counts.model++; return modelAnswer(request); } },
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
  p = executionProvider(SENDER); sends = 0; crmOwner = V2_OWNER; admission.reads.length = 0; ownerInUse = ownerFromA10; crm.requests.length = 0; crm.ownerAt = () => crmOwner; crm.body = null; loseAck = false; ackOffsetMs = 120_000;
  // The synthetic Gmail dates the sent mail itself (`internalDate`): the test fixes it a little AFTER the send (a mail cannot be dated before the customer mail it answers: C's J2 refuses a
  // customer mail not older than the question), so the receipt's date is a known instant and not the marker's. `loseAck` makes the send
  // succeed at the provider while its answer never comes back (the uncertain case).
  const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    if (path === "messages/send") sends += 1;
    const result = await p.gmail<T>(mailbox, path, init);
    if (path === "messages/send") {
      (p.sent[(result as { id: string }).id] as { internalDate: string }).internalDate = String(Date.now() + ackOffsetMs);
      if (loseAck) throw Error("SYN_ACK_LOST");
    }
    return result;
  };
  adapters = createIntakeExecutorAdapters({ network: p.network, gmailRequest: gmail, gmailPermissions: async () => { }, env: () => environment });
});
afterEach(async () => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setV2Pause(null);
});


const QUESTION = "Quel message s'affiche après la saisie de votre adresse ?";
const ASKED = `Bonjour, depuis https://new.limova.ai, ${QUESTION}`;
/** B's decision for a missing fact: ONE targeted question and the reply text that carries it (no card cited: the knowledge does not cover it). */
const askTargeted = (request: CaseInvestigationModelRequest) => {
  const snapshot: CaseSnapshot = request.snapshot, open = snapshot.body.openRequests.filter(row => row.status === "open");
  return { status: "ok" as const, output: { caseVersion: snapshot.version,
    understanding: { requests: open.map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
    nextAction: { kind: "ask", questions: [{ text: QUESTION, requestId: open[0]!.id, reducesUncertainty: "Distingue un code non reçu d'un écran de paiement.", seeks: [{ kind: "observed_result" }] }] },
    reply: { text: ASKED, citations: [], impossibilityClaims: [], accountAdvice: "none" } } };
};
const setV2Pause = async (level: "actions_paused" | "fully_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-agent-pause.v1:v2"));
  if (level) await f.db.insert(savSyncState).values({ key: "sav-agent-pause.v1:v2", status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent: "v2", level, setBy: "fixture@example.invalid", setAt: AT, reason: "release fictive" }) });
};
/** The J2 pass with ports that only COUNT what would be planned: no pole owns the reminder text or its planning, so nothing may be planned on these paths. */
function j2Ports() {
  const planned: string[] = [];
  const ports: J2Ports = { reminderEffect: async () => "none", budgetAvailable: async () => true, onConditionsMet: async ({ timer }) => { planned.push(timer.id); } };
  return { ports, planned };
}
const j2Pass = (ports: J2Ports, now: Date) => runDueJ2Pass({ now, maxEvents: 10, currentPolicyRevision: SYN_POLICY.revision, ports });
const pageAt = async (ticketId: string, now: Date) => {
  const snapshot = (await readCaseByTicket(ticketId))!;
  const [events, timers, pause] = await Promise.all([listCaseEvents(snapshot.caseId), listCaseTimers(snapshot.caseId), readSavAgentPause(f.db as never, "v2")]);
  return buildCasePilotView({ snapshot, events, timers, pause, now });
};
const marker = async (executionId: string) => (await f.client.query<{ d: Date | string }>("SELECT dispatched_at AS d FROM sav.intake_effects WHERE execution_id = $1 AND kind = 'reply_send'", [executionId])).rows[0]?.d;
/** The provider is shared by the whole file: what a journey counts is what happened since it started. */
let sentBase = 0, requestsBase = 0;
const ackDates = () => Object.values(p.sent).slice(sentBase).map(message => new Date(Number((message as { internalDate: string }).internalDate)));
const sendRequests = () => p.calls.filter(call => call.path === "gmail/messages/send").length - requestsBase;
const sentNow = () => sentBodies().slice(sentBase);

/** The question, from the V1 mail to the approved and queued reply; nothing has left. */
async function questionQueued() {
  crm.requests.length = 0; sends = 0; sentBase = Object.keys(p.sent).length; requestsBase = p.calls.filter(call => call.path === "gmail/messages/send").length;
  const mail = await v1Mail();
  await personHandsBack(mail.caseId);
  const { deps, counts } = wiring();
  modelAnswer = askTargeted as never;
  expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "recorded", outcome: "accepted", modelCalls: 1 });
  expect(counts.model).toBe(1);
  const { draft, proposed } = await proposeFromB(mail.caseId);
  // B decided a REAL question: its purpose, its text and its one id come from the stored decision, none from this test.
  expect(draft).toMatchObject({ triggerEventId: `inbound:${mail.gmail}`, reply: { purpose: "question", text: ASKED, question: { text: QUESTION, factKeys: [] } }, replyLimit: null });
  if (!proposed.ok) throw Error(`PROPOSE_REFUSED:${proposed.code}`);
  const stored = decryptSavPayload<CaseReplyProposal>((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, proposed.validationId)))[0]!.proposalCiphertext);
  expect(stored).toMatchObject({ purpose: "question", question: { id: draft.reply!.question!.id, text: QUESTION } });
  expect(stored.text.startsWith(ASKED)).toBe(true);
  expect(caseReplyFinalTextProblem(stored.text)).toBeNull(); // the AI mention is IN the stored text, before the hash
  expect(readCaseReplyDisclosure(stored.text)).toMatchObject({ mode: "manual_reviewed" });
  expect(caseReplyPayloadHash(stored)).toBe(proposed.payloadHash);
  expect(await queueValidatedCaseReply({ validationId: proposed.validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() })).toEqual({ ok: false, code: "not_validated", detail: "proposed" });
  expect((await pass()).supervised).toEqual([]);
  expect(sends).toBe(0);
  const shown = await page(mail.ticketId, proposed.validationId);
  if (shown.reply.state !== "ok") throw Error("PAGE_UNREADABLE");
  expect(shown.reply.reply).toMatchObject({ payloadHash: proposed.payloadHash, recipient: SENDER, proposal: { text: stored.text } });
  expect(await decideCaseReply({ action: "approve", validationId: proposed.validationId, approverId: STAFF, authorizer: allowForTest, deps: storeDeps(),
    seen: { payloadHash: shown.reply.reply.payloadHash, caseVersion: shown.reply.reply.caseVersion, recipient: shown.reply.reply.recipient } })).toMatchObject({ ok: true, state: "approved" });
  const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: { id: policyId, hash: policyHash }, deps: storeDeps() });
  if (!queued.ok) throw Error(`QUEUE_REFUSED:${queued.code}`);
  // Approved and queued is still nothing sent, no event, no question, no timer.
  const idle = { events: (await listCaseEvents(mail.caseId)).filter(e => e.kind === "outbound_observed").length, questions: (await readCase(mail.caseId))!.body.questions.length, timers: (await listCaseTimers(mail.caseId)).length };
  expect(idle).toEqual({ events: 0, questions: 0, timers: 0 });
  return { mail, proposed, queued, stored, draft };
}
/** What the case holds for ONE sent question: counts of the three records the receipt writes. */
async function receipt(caseId: string) {
  const [events, snapshot, timers] = [await listCaseEvents(caseId), (await readCase(caseId))!, await listCaseTimers(caseId)];
  return { outbound: events.filter(e => e.kind === "outbound_observed"), questions: snapshot.body.questions, timers };
}

describe("C10 end of the question cycle: B's question → C's proposal, approval, simulated send, receipt → ONE event, ONE question, ONE J2 (0258, SYN)", () => {
  it("nominal question: one send, the receipt dated by the Gmail ACK; a technical pause keeps the due date and sends nothing; then a person OR a new customer mail cancels the old J2", async () => {
    for (const ending of ["person_takes_the_ticket", "new_customer_mail"] as const) {
      ackOffsetMs = ending === "person_takes_the_ticket" ? 120_000 : 180_000;
      const { mail, queued, stored } = await questionQueued();
      expect((await pass()).supervised).toEqual([{ executionId: queued.executionId, state: "confirmed", reason: null }]);
      expect(sends).toBe(1);
      expect(sendRequests()).toBe(1);
      expect(sentNow()).toEqual([stored.text]);
      // Every owner read is A10's one GET of this very ticket, owner property only (a count of local calls, not an atomicity claim about the CRM and Gmail).
      expect(crm.requests.length).toBeGreaterThan(0);
      expect(crm.requests).toEqual(crm.requests.map(() => ownerGet(mail.ticketId)));

      // ONE outbound event, ONE question against the effect that sent it, ONE timer: all dated by the ACK's own send date, not by the marker.
      const [ack] = ackDates();
      expect(ackDates()).toHaveLength(1);
      const markedAt = new Date(String(await marker(queued.executionId)));
      expect(ack!.getTime()).not.toBe(markedAt.getTime());
      const done = await receipt(mail.caseId);
      expect(done.outbound).toHaveLength(1);
      expect(done.outbound[0]).toMatchObject({ direction: "agent_outbound", occurredAt: ack!.toISOString(), detail: { purpose: "question", triggerEventId: `inbound:${mail.gmail}` } });
      expect(done.questions).toHaveLength(1);
      const effectId = (done.outbound[0]!.detail as { effectId: string }).effectId;
      expect(done.questions[0]).toMatchObject({ id: stored.question!.id, text: QUESTION, askedAt: ack!.toISOString(), askedInEffect: effectId });
      expect(done.timers).toHaveLength(1);
      const timer = done.timers[0]!;
      expect(timer).toMatchObject({ state: "scheduled", questionEffectId: effectId, sentAt: ack!.toISOString(), dueAt: nextJ2Slot(ack!).toISOString(), cancelReason: null });
      // Pole A's EXISTING calendar: at least 24 real hours after the mail, inside a Paris business slot; no 48 h, no weekend, no invented rule.
      expect(Date.parse(timer.dueAt) - ack!.getTime()).toBeGreaterThanOrEqual(24 * 3_600_000);
      expect(isWithinJ2Slot(new Date(timer.dueAt))).toBe(true);
      const due = new Date(timer.dueAt);
      // What the page reads is what the receipt wrote.
      const shown = await pageAt(mail.ticketId, new Date());
      expect(shown.observedOutbound).toHaveLength(1);
      expect(shown.openQuestions).toEqual([{ text: QUESTION, askedAt: ack!.toISOString() }]);
      expect(shown.followUp).toMatchObject({ label: "Relance J2 programmée", dueAt: timer.dueAt });
      // Another pass sends nothing and records nothing more.
      await pass(); await pass();
      expect(sends).toBe(1);
      expect(await receipt(mail.caseId)).toEqual(done);

      // A technical pause: the due date comes, nothing is fired, planned or sent; the timer is kept as it is.
      await setV2Pause("fully_paused");
      const paused = j2Ports();
      expect(await j2Pass(paused.ports, due)).toEqual({ outcomes: [], paused: true });
      expect(paused.planned).toEqual([]);
      expect((await pass()).skipped).not.toBeNull();
      expect(sends).toBe(1);
      expect((await listCaseTimers(mail.caseId))[0]).toMatchObject({ id: timer.id, state: "scheduled", dueAt: timer.dueAt, cancelReason: null });
      expect((await pageAt(mail.ticketId, due)).followUp).toMatchObject({ label: "Relance J2 suspendue (pause), conservée", dueAt: timer.dueAt });

      // Then the old J2 is cancelled by what the current contracts say cancels it, whichever comes first.
      if (ending === "person_takes_the_ticket") {
        crmOwner = HUMAN_OWNER;
        expect(await observeTicketCrmChange({ ticketId: mail.ticketId, ownerId: HUMAN_OWNER, hubspotUpdatedAt: new Date().toISOString(), env: ENV })).toMatchObject({ recorded: true, takeover: true });
        expect(await readCase(mail.caseId)).toMatchObject({ owner: "human" });
      } else {
        const next = await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId });
        expect(next.caseId).toBe(mail.caseId);
      }
      expect((await listCaseTimers(mail.caseId))[0]).toMatchObject({ id: timer.id, state: "cancelled", dueAt: timer.dueAt, cancelReason: ending === "person_takes_the_ticket" ? "owner_changed" : "customer_inbound" });
      // The pause ends: the old J2 is not revived, nothing is planned, nothing is sent, the question's record is untouched.
      await setV2Pause(null);
      const resumed = j2Ports();
      expect((await j2Pass(resumed.ports, new Date(due.getTime() + 60_000))).outcomes.filter(o => o.timerId === timer.id)).toEqual([]);
      expect(resumed.planned).toEqual([]);
      expect(sends).toBe(1);
      expect(sendRequests()).toBe(1);
      const finish = await receipt(mail.caseId);
      expect(finish.outbound).toHaveLength(1);
      expect(finish.questions).toHaveLength(1);
      expect(finish.timers.filter(t => t.id === timer.id)).toHaveLength(1);
      crmOwner = V2_OWNER; // the next ending starts from a fresh ticket of its own
    }
  });

  it("a lost ACK: no J2 before the proof of the send; the verification-only recovery finds the mail by its own date: one receipt, one question, one J2, zero second send, and a second pass changes nothing", async () => {
    ackOffsetMs = 150_000;
    const { mail, queued, stored } = await questionQueued();
    loseAck = true;
    expect((await pass()).supervised).toEqual([{ executionId: queued.executionId, state: "uncertain", reason: expect.any(String) }]);
    loseAck = false;
    expect(sends).toBe(1);
    expect(sendRequests()).toBe(1);
    // The mail may have left, but nothing proves it yet: no event, no question, no timer, and the page says it is only being verified.
    expect(await receipt(mail.caseId)).toEqual({ outbound: [], questions: [], timers: [] });
    const unsure = await page(mail.ticketId);
    if (unsure.replies.state !== "ok") throw Error("PAGE_UNREADABLE");
    expect(describeCaseReply(unsure.replies.items[0]!)).toMatchObject({ sent: expect.stringContaining("Seule une vérification aura lieu, rien ne sera renvoyé") });
    expect((await pageAt(mail.ticketId, new Date())).followUp).toBeNull();
    // A pass before the verification is due re-sends nothing and records nothing.
    await pass();
    expect(sends).toBe(1);
    expect(await receipt(mail.caseId)).toEqual({ outbound: [], questions: [], timers: [] });
    // The verification becomes due: the schedule reached is the only thing a test can bring forward (attempts, lease and ledger are left as the executor wrote them).
    await f.client.query("UPDATE sav.intake_effects SET next_reconcile_at = now() - interval '1 second' WHERE execution_id = $1 AND next_reconcile_at IS NOT NULL", [queued.executionId]);
    const found = await pass();
    expect(sends).toBe(1);
    expect(sendRequests()).toBe(1);
    expect(found.recovery.find(row => "executionId" in row && row.executionId === queued.executionId)).toMatchObject({ state: "confirmed" });
    const [ack] = ackDates();
    expect(ackDates()).toHaveLength(1);
    const done = await receipt(mail.caseId);
    expect(done.outbound).toHaveLength(1);
    expect(done.outbound[0]).toMatchObject({ direction: "agent_outbound", occurredAt: ack!.toISOString(), detail: { purpose: "question" } });
    expect(done.questions).toHaveLength(1);
    expect(done.questions[0]).toMatchObject({ id: stored.question!.id, askedAt: ack!.toISOString(), askedInEffect: (done.outbound[0]!.detail as { effectId: string }).effectId });
    expect(done.timers).toHaveLength(1);
    expect(done.timers[0]).toMatchObject({ state: "scheduled", sentAt: ack!.toISOString(), dueAt: nextJ2Slot(ack!).toISOString() });
    expect(isWithinJ2Slot(new Date(done.timers[0]!.dueAt))).toBe(true);
    expect(await f.db.select({ state: savCaseEffectExecutions.state }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, queued.executionId))).toEqual([{ state: "confirmed" }]);
    expect(await rows(mail.caseId)).toEqual({ validations: 1, executions: 1, outbound: 1 });
    // A second and a third pass (supervised and verification-only) are idempotent: same records, no send.
    await pass(); await pass();
    const again = await recoverCaseEffects({ ...storeDeps(), adapters: { verify: adapters.verify }, deadlineMs: Date.now() + 60_000, context: { runtime: {} as never, policy } });
    expect(again).toEqual({ skipped: "nothing_due" });
    expect(sends).toBe(1);
    expect(await receipt(mail.caseId)).toEqual(done);
    expect(sentNow()).toEqual([stored.text]);
    expect(crm.requests).toEqual(crm.requests.map(() => ownerGet(mail.ticketId)));
  });
});
