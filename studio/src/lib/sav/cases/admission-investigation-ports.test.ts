import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savCaseCalls, savCaseEffectExecutions, savCaseReplyValidations, savCaseTimers, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// Strict local ports: no V1 executor, no model dispatcher, and fetch throws.
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { SAV_INTAKE_CONTRACT_REVISION, type SavIntakeDecision } from "../intake/contract";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { readConfirmedV1Context } from "./admission-context-reader";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import { caseInvestigationAdmissionPorts, caseInvestigationQualify, caseRelayAdmissionDeps, type AdmissionInvestigationDeps, type CaseApprovedRulePort } from "./admission-investigation-ports";
import { ticketOwnerPort, type AdmissionPolicyRecord, type V1AdmissionAdapterPolicy } from "./admission-runtime";
import { readFileSync } from "node:fs";
import { appendCaseEvent, listCaseEvents, readCase, readCaseDiagnostics, readCaseQualificationDiagnostic, transitionCaseOwner, type CaseDiagnosticCaller } from "./case-store";
import { caseQualificationPrecheck, isCaseQualificationUnavailable, serializeCaseQualificationUnavailable } from "./qualification-diagnostic";
import type { CaseEvent, CaseSnapshot, KnowledgeRef } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { caseBudgetedKnowledge, caseKnowledgeSubjectKey, createCaseBudgetedRetrieval, type CaseEmbeddingSpendPort, type CaseEmbeddingTransport, type CaseKnowledgeVectorSearch } from "./investigation-budgeted-retrieval";
import type { CaseCallLedgerPort } from "./investigation-call-ledger";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput, type CaseInvestigationModelRequest, type CaseInvestigationPauseLevel } from "./investigation-runner";
import { caseCallLedgerOnStore, runCaseInvestigationRuntime, type CaseInvestigationRuntimeDeps } from "./investigation-runtime";

/*
 * Pole A lot 4, SYN only on PGlite: the qualification consumer A → B really composed. V1's records in the database
 * (message, confirmed execution with its ticket decision, accepted analysis, V2 owner effect) → A's relay with the
 * consumer's ports → A's qualification (context reader, target compared, D-a adapter, rules, policy) → B's runtime on
 * A's store → budgeted knowledge (embedding double, A's real call ledger) → model double → decision stored.
 * The adapter policy, the rule and the admission policy below are synthetic, approved FOR THIS TEST ONLY: production has
 * none of them, and the consumer without them admits nobody. No HubSpot, no Gmail, no model, fetch throws.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 8_990_000;
const AT = "2026-11-01T01:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000005", V2_OWNER = "90000001", HUMAN_OWNER = "70000001";
const ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" };
const SENDER = "client@example.invalid";
const SYN_ADAPTER: V1AdmissionAdapterPolicy = { revision: "syn-adapter-r1-pour-test", decidedBy: "synthetic-test-approval-not-production", identity: "sender_unique_crm_match" };
const SYN_RULE = { ruleId: "syn-rule-access-pour-test", revision: "r1" };
const SYN_POLICY = { revision: "syn-policy-r1-pour-test", admittedFamilies: ["access"], qualifiedRules: [{ ...SYN_RULE, families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const SYN_RECORD: AdmissionPolicyRecord = { policy: SYN_POLICY, validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2099-01-01T00:00:00.000Z" };
/** The synthetic rule approved for this test: a V1 "support" request is an access request. */
const synRule: CaseApprovedRulePort = async ({ requests }) => requests.filter(request => request.kind === "support")
  .map(request => ({ requestId: request.requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ...SYN_RULE, at: AT } }));

/** The consumer's sources, counted: the real context reader, the synthetic adapter, rule and policy record. */
function sources(overrides: Partial<AdmissionInvestigationDeps> = {}) {
  const reads: string[] = [], rules = { calls: 0 };
  const deps: AdmissionInvestigationDeps = {
    readConfirmedContext: async messageId => { reads.push(messageId); return readConfirmedV1Context(messageId); },
    adapterPolicy: async () => SYN_ADAPTER, readPolicyRecord: async () => SYN_RECORD, now: () => new Date(),
    approvedRules: async input => { rules.calls++; return synRule(input); },
    ...overrides,
  };
  return { deps, reads, rules };
}

const evidence = (id: string, source: "current_message" | "crm_contact" | "crm_ticket", sourceId: string) => ({ id, source, sourceId, observedAt: "2026-10-20T09:00:00.000Z", contentHash: "a".repeat(43) });
/** V1's ticket decision for one message: one support request, the sender uniquely matched in the CRM. */
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

async function inbound(threadId: string, ticketId: string | null) {
  const messageId = randomUUID();
  if (ticketId !== null) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER }).onConflictDoNothing();
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Corps synthétique" }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
  const runVersion = (await f.db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, threadId))).length + 1;
  return { messageId, runVersion };
}

/** One V1 mail on a ticket as V1 leaves it (confirmed execution with its full decision, accepted analysis with the
 * request's summary, optionally the V2 owner effect), then A's relay with the consumer's admission ports. */
async function v1Mail(deps: AdmissionInvestigationDeps, options: { ticketId?: string; threadId?: string; ownerEffect?: boolean } = {}) {
  const ticketId = options.ticketId ?? String(++seq), threadId = options.threadId ?? randomUUID();
  const { messageId, runVersion } = await inbound(threadId, ticketId);
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: [{ id: "request-1", kind: "support", currentMessageId: messageId }], ticketSummary: { title: "Connexion impossible", description: "Le code n'arrive pas.", requestIds: ["request-1"] } };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: runVersion, isCurrent: false, state: "observed", configHash: `bridge-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
      records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runId: run!.id, runVersion, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: ticketDecision(messageId, threadId, ticketId) } }) }).returning();
  if (options.ownerEffect) {
    const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
    await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
      intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
  }
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }), ...caseRelayAdmissionDeps(deps), env: ENV }) as
    { caseId: string; owner: string; admission: { target: string; reasons: string[] } | null };
  return { ticketId, threadId, messageId, executionId: execution!.id, runId: run!.id, runVersion, gmail: `gm-${messageId}`, ...relayed };
}

/** A case of the agent (mail 1, admitted, V2 owner verified) whose admission a second mail made stale: B re-evaluates
 * it through `qualify` before anything else. */
async function staleAgentCase(deps: AdmissionInvestigationDeps) {
  const first = await v1Mail(deps, { ownerEffect: true });
  expect(first).toMatchObject({ owner: "agent", admission: { target: "agent", reasons: ["admitted"] } });
  const second = await v1Mail(deps, { ticketId: first.ticketId, threadId: first.threadId });
  const snapshot = (await readCase(first.caseId))!;
  expect(snapshot.admissionInputVersion).toBeGreaterThan(snapshot.admission!.inputVersion);
  return { first, second, caseId: first.caseId };
}

const card: SavRetrievalCandidate = { id: "k-login", contentVersionId: "k-login-v1", title: "Fiche connexion", content: "Procédure synthétique.", source: "fixture",
  verifiedAt: new Date(Date.now() - 864_000_000).toISOString(), semanticScore: null, resolution: { steps: ["Étape synthétique"] },
  availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } };
const ref: KnowledgeRef = { knowledgeId: card.id, contentVersionId: card.contentVersionId };
const answer = (request: CaseInvestigationModelRequest) => {
  const snapshot: CaseSnapshot = request.snapshot, open = snapshot.body.openRequests.filter(row => row.status === "open");
  return { status: "ok" as const, output: { caseVersion: snapshot.version,
    understanding: { requests: open.map(row => ({ id: row.id, summary: "Connexion impossible.", family: "access", status: "open" })), newFacts: [] },
    nextAction: { kind: "answer", requestIds: [open[0]!.id], steps: [{ text: "Suivre la fiche citée.", knowledge: ref }], expectedResult: "La connexion fonctionne." },
    reply: { text: "Bonjour, voici la marche à suivre depuis https://new.limova.ai : suivre la fiche.", citations: [ref], impossibilityClaims: [], accountAdvice: "none" } } };
};

const DIM = 8;
type Knobs = { pause?: CaseInvestigationPauseLevel; owner?: () => Promise<string | null | undefined>; onDispatched?: (input: { callKey: string }) => void };
/** B's runtime on the consumer's admission ports and A's real ticket owner port; the transports are counted doubles. */
function wiring(admission: AdmissionInvestigationDeps, knobs: Knobs = {}) {
  const counts = { embeddings: 0, vectorSearches: 0, spendReserve: 0, spendSettle: [] as unknown[], money: 0, model: 0, ownerReads: 0 };
  const vectors: CaseKnowledgeVectorSearch = { dimension: DIM, readRevision: async () => "kb-syn-r1", available: async () => true,
    search: async queries => { counts.vectorSearches++; return queries.map(() => [card]); } };
  const embed: CaseEmbeddingTransport = async ({ texts }) => { counts.embeddings++; return { vectors: texts.map((_, i) => Array.from({ length: DIM }, (__, j) => (i + 1) / (j + 3))), usage: null }; };
  const spend: CaseEmbeddingSpendPort = {
    reserve: async () => { counts.spendReserve++; return { status: "allowed", reservationId: `res-${counts.spendReserve}` }; },
    settle: async input => { counts.spendSettle.push(input); }, release: async () => undefined,
  };
  const ledger: CaseCallLedgerPort = { ...caseCallLedgerOnStore, markDispatched: async input => { const marked = await caseCallLedgerOnStore.markDispatched(input); knobs.onDispatched?.(input); return marked; } };
  const deps: CaseInvestigationRuntimeDeps = {
    mode: "observe", holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now: () => new Date(Date.now() + 6 * 60_000), leaseSeconds: 60,
    pauseState: async () => knobs.pause ?? "running",
    readTicketOwner: ticketOwnerPort({ readHubspotTicketOwner: async () => { counts.ownerReads++; return knobs.owner ? knobs.owner() : V2_OWNER; }, env: ENV }),
    // Pilot ACCÈS (3/11): a SYNTHETIC approved scope listing the fixture card; the runtime is closed without one.
    accessScope: async () => ({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: await caseInvestigationAdmissionPorts(admission).admissionPolicyRevision(), revision: "syn-scope-r1", family: "access", sources: [{ knowledgeId: card.id, contentVersionId: card.contentVersionId, use: "answer" }] }),
    ...caseInvestigationAdmissionPorts(admission),
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    ledger, knowledge: { vectors, embed, spend },
    model: { money: async () => { counts.money++; return { status: "allowed" }; }, provider: async request => { counts.model++; return answer(request); } },
  };
  return { deps, counts, vectors, embed, spend, ledger };
}
async function calls(caseId: string) {
  return (await f.db.select({ key: savCaseCalls.callKey, purpose: savCaseCalls.purpose, state: savCaseCalls.state, status: savCaseCalls.resultStatus, uncertain: savCaseCalls.resultUncertain })
    .from(savCaseCalls).where(eq(savCaseCalls.caseId, caseId))).sort((a, b) => a.key.localeCompare(b.key));
}
async function sideEffects(caseId: string) {
  const count = async (table: typeof savCaseEffectExecutions | typeof savCaseReplyValidations | typeof savCaseTimers) => (await f.db.select().from(table).where(eq(table.caseId, caseId))).length;
  return { effects: await count(savCaseEffectExecutions), validations: await count(savCaseReplyValidations), timers: await count(savCaseTimers) };
}
const NO_EFFECT = { effects: 0, validations: 0, timers: 0 };
const admissionEvents = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "admission_decided").length;
const journal = async (caseId: string) => ({ snapshot: (await readCase(caseId))!, events: await listCaseEvents(caseId) });

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "bridge-journey-fixture-key-32-chars!!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-bridge-admin", email: "bridge-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support-bridge@example.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "bridge-journey-fixture-key-32-chars!!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("relay side: A's qualification on the consumer's ports, closed by default", () => {
  it("with the synthetic adapter, rule and policy approved for the test, the relay reads V1 on its own target and admits", async () => {
    const { deps, reads, rules } = sources();
    const mail = await v1Mail(deps, { ownerEffect: true });
    expect(mail).toMatchObject({ owner: "agent", admission: { target: "agent", reasons: ["admitted"] } });
    expect(reads).toEqual([mail.messageId]);
    expect(rules.calls).toBe(1);
    const recorded = (await readCase(mail.caseId))!.admission!;
    expect(recorded).toMatchObject({ policyRevision: SYN_POLICY.revision, qualification: { identity: { status: "confirmed", source: { type: "hubspot_object", id: "101" } }, crmContext: "complete",
      requests: [{ requestId: `${mail.gmail}/request-1`, family: "access", provenance: { kind: "qualified_rule", ...SYN_RULE } }] } });
  });

  it.each([
    ["no approved rule (production today)", { approvedRules: undefined }, ["family_unknown"], 0],
    ["no adapter policy (D-a closed)", { adapterPolicy: async (): Promise<V1AdmissionAdapterPolicy | null> => null }, ["family_unknown", "identity_unconfirmed", "context_incomplete"], 0],
    ["no policy record", { readPolicyRecord: async (): Promise<AdmissionPolicyRecord | null> => null }, ["policy_missing"], 1],
    ["an expired policy record", { readPolicyRecord: async (): Promise<AdmissionPolicyRecord | null> => ({ ...SYN_RECORD, validUntil: "2026-02-01T00:00:00.000Z" }) }, ["policy_missing"], 1],
  ] as const)("%s: nobody is admitted, the case waits for the team", async (_label, override, reasons, ruleCalls) => {
    const { deps, rules } = sources(override as Partial<AdmissionInvestigationDeps>);
    const mail = await v1Mail(deps);
    expect(mail.owner).toBe("human");
    expect(mail.admission!.target).not.toBe("agent");
    for (const reason of reasons) expect(mail.admission!.reasons).toContain(reason);
    expect(rules.calls).toBe(ruleCalls);
  });

  it.each([
    ["claims a human provenance", async ({ requests }: { requests: { requestId: string }[] }) => requests.map(request => ({ requestId: request.requestId, family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } })), "SAV_CASE_RULE_PROVENANCE_INVALID"],
    ["names a request V1 did not open", async () => [{ requestId: "gm-other/request-9", family: "access" as const, provenance: { kind: "qualified_rule" as const, ...SYN_RULE, at: AT } }], "SAV_CASE_QUALIFICATION_REQUEST_UNKNOWN"],
  ])("a rule that %s throws: no case is opened on it", async (_label, rule, code) => {
    const { deps } = sources({ approvedRules: rule as CaseApprovedRulePort });
    const ticketId = String(++seq);
    await expect(v1Mail(deps, { ticketId })).rejects.toThrow(code);
    expect(await f.client.query("SELECT 1 FROM sav.cases WHERE ticket_id=$1", [ticketId]).then(r => r.rows)).toEqual([]);
  });
});

describe("qualify (contract §2): only the case's current relayed V1 mail, on the relay's target", () => {
  it("reads the input's V1 message once, on the relay's target, and returns the relay's composition with the current policy", async () => {
    const { deps, reads } = sources();
    const { second, caseId } = await staleAgentCase(deps);
    reads.length = 0;
    const { snapshot, events } = await journal(caseId);
    const qualified = await caseInvestigationQualify(deps)(snapshot, events);
    expect(reads).toEqual([second.messageId]);
    expect(qualified).toEqual({ sourceRef: { type: "email", id: second.gmail }, admission: { policy: SYN_POLICY, qualification: {
      requests: [{ requestId: `${second.gmail}/request-1`, family: "access", provenance: { kind: "qualified_rule", ...SYN_RULE, at: AT } }],
      identity: { status: "confirmed", source: { type: "hubspot_object", id: "101" } }, crmContext: "complete", teamSignals: [] } } });
  });

  it("no customer input, or an input that is not the current admission input: null, nothing read", async () => {
    const { deps, reads } = sources();
    const { caseId } = await staleAgentCase(deps);
    reads.length = 0;
    const { snapshot, events } = await journal(caseId);
    const qualify = caseInvestigationQualify(deps);
    expect(await qualify(snapshot, events.filter(event => event.direction !== "customer_inbound"))).toBeNull();
    expect(await qualify({ ...snapshot, admissionInputVersion: snapshot.admissionInputVersion + 1 }, events)).toBeNull();
    expect(reads).toEqual([]);
  });

  it("a hand-back as latest input refuses explicitly: no V1 entry is designated and none is invented", async () => {
    const { deps, reads } = sources();
    const { caseId } = await staleAgentCase(deps);
    reads.length = 0;
    const { snapshot, events } = await journal(caseId);
    const last = events.at(-1)!;
    const handBack = { ...last, id: randomUUID(), kind: "owner_changed", direction: "system", caseVersion: last.caseVersion + 1,
      detail: { transition: "give_back", from: "human", to: "agent" } } as unknown as CaseEvent;
    const withHandBack = [...events, handBack];
    expect(latestInvestigationInput(withHandBack)).toBe(`back:${handBack.id}`);
    await expect(caseInvestigationQualify(deps)(snapshot, withHandBack)).rejects.toThrow("SAV_CASE_QUALIFY_HANDBACK_UNPROVEN");
    expect(reads).toEqual([]);
  });

  it.each([
    ["an unreadable relay proof", (event: CaseEvent) => ({ ...event, detail: { ...event.detail, relay: { kind: "invented" } } }), "SAV_CASE_QUALIFY_RELAY_INVALID", 0],
    ["a relay proof of another message", (event: CaseEvent) => ({ ...event, detail: { ...event.detail, messageId: randomUUID() } }), "SAV_CASE_QUALIFY_RELAY_INVALID", 0],
    ["an acknowledgement (no execution)", (event: CaseEvent) => ({ ...event, detail: { ...event.detail, relay: { kind: "acknowledgement_on_case_thread", messageId: (event.detail as { messageId: string }).messageId,
      intakeRunId: randomUUID(), intakeRunVersion: 2, sourceHash: "syn-ack" } } }), "SAV_CASE_QUALIFICATION_UNAVAILABLE:acknowledgement_input", 0],
    ["another run version than V1's", (event: CaseEvent) => ({ ...event, detail: { ...event.detail, relay: { ...(event.detail as { relay: object }).relay, intakeRunVersion: 9 } } }), "SAV_V1_QUALIFICATION_SOURCE_MISMATCH", 1],
    ["another execution than V1's", (event: CaseEvent) => ({ ...event, detail: { ...event.detail, relay: { ...(event.detail as { relay: object }).relay, executionId: randomUUID() } } }), "SAV_V1_QUALIFICATION_SOURCE_MISMATCH", 1],
  ])("%s throws before any qualification", async (_label, alter, code, readCount) => {
    const { deps, reads, rules } = sources();
    const { caseId } = await staleAgentCase(deps);
    reads.length = 0; rules.calls = 0;
    const { snapshot, events } = await journal(caseId);
    const input = latestInvestigationInput(events)!.slice(3);
    await expect(caseInvestigationQualify(deps)(snapshot, events.map(event => event.id === input ? alter(event) as CaseEvent : event))).rejects.toThrow(code);
    expect(reads).toHaveLength(readCount);
    expect(rules.calls).toBe(0);
  });

  it("another ticket than V1's throws (A's port compares the whole target)", async () => {
    const { deps } = sources();
    const { caseId } = await staleAgentCase(deps);
    const { snapshot, events } = await journal(caseId);
    await expect(caseInvestigationQualify(deps)({ ...snapshot, ticketId: String(++seq) }, events)).rejects.toThrow("SAV_V1_QUALIFICATION_SOURCE_MISMATCH");
  });

  it("requests that are not exactly those V1's decision opens throw", async () => {
    const { deps, rules } = sources();
    const { second, caseId } = await staleAgentCase(deps);
    rules.calls = 0;
    const { snapshot, events } = await journal(caseId);
    const without = { ...snapshot, body: { ...snapshot.body, openRequests: snapshot.body.openRequests.filter(row => !row.id.startsWith(`${second.gmail}/`)) } };
    await expect(caseInvestigationQualify(deps)(without, events)).rejects.toThrow("SAV_CASE_QUALIFY_REQUESTS_MISMATCH");
    expect(rules.calls).toBe(0);
  });

  it("no V1 execution for the message any more: null (hints only)", async () => {
    const { deps } = sources();
    const { caseId } = await staleAgentCase(deps);
    const { snapshot, events } = await journal(caseId);
    expect(await caseInvestigationQualify({ ...deps, readConfirmedContext: async () => null })(snapshot, events)).toBeNull();
  });
});

describe("composed SYN path: V1 in the database → A's relay → A's qualification → B's runtime → budgeted knowledge → model → stored decision", () => {
  it("C1/C9 nominal: re-evaluated through qualify, one embedding and one model call in A's real ledger under separate subjects, decision stored, no effect", async () => {
    const source = sources();
    const { second, caseId } = await staleAgentCase(source.deps);
    source.reads.length = 0;
    const admissionsBefore = await admissionEvents(caseId);
    const { deps, counts } = wiring(source.deps);
    expect(await runCaseInvestigationRuntime(caseId, deps)).toMatchObject({ status: "recorded", modelCalls: 1 });
    expect(source.reads).toEqual([second.messageId]);
    expect(await admissionEvents(caseId)).toBe(admissionsBefore + 1);
    const snapshot = (await readCase(caseId))!;
    expect(snapshot).toMatchObject({ owner: "agent", admission: { target: "agent", policyRevision: SYN_POLICY.revision, inputVersion: snapshot.admissionInputVersion } });
    expect(counts).toMatchObject({ embeddings: 1, vectorSearches: 1, spendReserve: 1, money: 1, model: 1 });
    const events = await listCaseEvents(caseId), input = latestInvestigationInput(events)!;
    expect(input).toMatch(/^in:/);
    // C9: the `.knowledge` subject is accepted by the ledger's CHECKs, with its own ceiling, apart from the model call.
    expect(await calls(caseId)).toEqual([
      { key: `${caseKnowledgeSubjectKey(caseId, input)}:call1`, purpose: "knowledge_embedding", state: "settled", status: "ok", uncertain: false },
      { key: `sav-case:${caseId}:${input}:call1`, purpose: expect.any(String), state: "settled", status: "ok", uncertain: false },
    ].sort((a, b) => a.key.localeCompare(b.key)));
    const read = readCaseInvestigationProgress(events, input);
    expect(read).toMatchObject({ state: "found", record: { progress: { modelCalls: 1, waiting: null } } });
    expect(JSON.stringify(read.state === "found" ? read.record : null)).toContain("k-login-v1");
    expect(await sideEffects(caseId)).toEqual(NO_EFFECT);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("C2 an acknowledgement as latest input: qualify refuses before reading V1, 0 embedding, 0 model, nothing written", async () => {
    const source = sources();
    const first = await v1Mail(source.deps, { ownerEffect: true });
    const { messageId, runVersion } = await inbound(first.threadId, null);
    const [run] = await f.db.insert(savIntakeRuns).values({ threadId: first.threadId, messageId, version: runVersion, isCurrent: false, state: "observed", configHash: `ack-${messageId}`, policyHash: "fixture",
      payloadCiphertext: encryptSavPayload({}) }).returning();
    const acknowledgement = { runId: run!.id, runVersion, sourceHash: "syn-ack-source", decision: { classification: "acknowledgement", requests: [{ id: "a0", kind: "acknowledgement" }] } } as never;
    expect(await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => null, readAcknowledgement: async () => acknowledgement, ...caseRelayAdmissionDeps(source.deps), env: ENV }))
      .toMatchObject({ relay: "acknowledgement_on_case_thread", caseId: first.caseId });
    source.reads.length = 0;
    const admissionsBefore = await admissionEvents(first.caseId);
    const before = await journal(first.caseId), effectsBefore = await sideEffects(first.caseId);
    const { deps, counts } = wiring(source.deps);
    // ROOT B5/B7 contract: the runtime reports the typed refusal, not persisted, and does not throw (the direct
    // caseInvestigationQualify tests above still check the typed throw).
    expect(await runCaseInvestigationRuntime(first.caseId, deps)).toMatchObject({ status: "qualification_unavailable", caseId: first.caseId, persisted: false, modelCalls: 0,
      qualification: { code: "acknowledgement_input", nature: "contract_blocked", causeCode: null } });
    expect(source.reads).toEqual([]);
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
    expect(await calls(first.caseId)).toEqual([]);
    expect(await admissionEvents(first.caseId)).toBe(admissionsBefore);
    // Nothing written anywhere for the case: same snapshot and journal, same effects, no fetch.
    expect(await journal(first.caseId)).toEqual(before);
    expect(await sideEffects(first.caseId)).toEqual(effectsBefore);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("C3 a newer V1 run of the message: unknown/unknown, the rule is not asked, the case goes to the team, 0 paid call", async () => {
    const source = sources();
    const { second, caseId } = await staleAgentCase(source.deps);
    await f.db.insert(savIntakeRuns).values({ threadId: second.threadId, messageId: second.messageId, version: second.runVersion + 1, isCurrent: false, state: "observed", configHash: `newer-${second.messageId}`,
      policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) });
    source.rules.calls = 0;
    const { deps, counts } = wiring(source.deps);
    expect(await runCaseInvestigationRuntime(caseId, deps)).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(source.rules.calls).toBe(0);
    const snapshot = (await readCase(caseId))!;
    expect(snapshot.owner).toBe("human");
    expect(snapshot.admission!.reasons).toEqual(expect.arrayContaining(["family_unknown", "identity_unconfirmed", "context_incomplete"]));
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
    expect(await calls(caseId)).toEqual([]);
  });

  it.each([
    ["C4 no valid policy", { readPolicyRecord: async (): Promise<AdmissionPolicyRecord | null> => null }, "policy_missing"],
    ["default adapter (D-a closed)", { adapterPolicy: async (): Promise<V1AdmissionAdapterPolicy | null> => null }, "identity_unconfirmed"],
    ["no approved rule", { approvedRules: undefined }, "family_unknown"],
  ] as const)("%s: the re-evaluation withdraws the case, 0 paid call", async (_label, override, reason) => {
    const admitted = sources();
    const { caseId } = await staleAgentCase(admitted.deps);
    const closed = sources(override as Partial<AdmissionInvestigationDeps>);
    const { deps, counts } = wiring(closed.deps);
    expect(await runCaseInvestigationRuntime(caseId, deps)).toMatchObject({ modelCalls: 0 });
    const snapshot = (await readCase(caseId))!;
    expect(snapshot.owner).toBe("human");
    expect(snapshot.admission!.reasons).toContain(reason);
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
    expect(await calls(caseId)).toEqual([]);
  });

  it.each([
    ["C5 an unknown owner", async (): Promise<string | undefined> => undefined, "ticket_owner_unverified"],
    ["C5 an owner read that fails", async (): Promise<string | undefined> => { throw Error("CRM_UNREADABLE_SYN"); }, "ticket_owner_unverified"],
    ["a human owner", async (): Promise<string | undefined> => HUMAN_OWNER, null],
  ] as const)("%s: stops before qualify, nothing read, nothing written, 0 paid call", async (_label, owner, reason) => {
    const source = sources();
    const { caseId } = await staleAgentCase(source.deps);
    source.reads.length = 0;
    const before = await journal(caseId);
    const { deps, counts } = wiring(source.deps, { owner });
    const report = await runCaseInvestigationRuntime(caseId, deps);
    expect(report).toMatchObject({ status: "skipped", modelCalls: 0 });
    if (reason) expect(report).toMatchObject({ reason });
    expect(source.reads).toEqual([]);
    expect(await journal(caseId)).toEqual(before);
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
  });

  it.each(["actions_paused", "fully_paused"] as const)("pause %s: no re-evaluation, nothing read, 0 paid call", async pause => {
    const source = sources();
    const { caseId } = await staleAgentCase(source.deps);
    source.reads.length = 0;
    const before = await journal(caseId);
    const { deps, counts } = wiring(source.deps, { pause });
    expect(await runCaseInvestigationRuntime(caseId, deps)).toMatchObject({ modelCalls: 0 });
    expect(source.reads).toEqual([]);
    expect(await journal(caseId)).toEqual(before);
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
  });

  it("C6 a human owner written while the embedding call is marked dispatched: 0 transport, the key held uncertain, spend unknown, the next run pays nothing", async () => {
    const source = sources();
    const { caseId } = await staleAgentCase(source.deps);
    let owner: string = V2_OWNER;
    const { deps, counts } = wiring(source.deps, { owner: async () => owner, onDispatched: input => { if (input.callKey.includes(".knowledge")) owner = HUMAN_OWNER; } });
    expect(await runCaseInvestigationRuntime(caseId, deps)).toMatchObject({ status: "ticket_owner_stop", modelCalls: 0 });
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 1, money: 0, model: 0 });
    expect(counts.spendSettle).toEqual([{ reservationId: "res-1", usage: "unknown", uncertain: true }]);
    expect((await calls(caseId)).map(row => [row.purpose, row.state, row.status, row.uncertain])).toEqual([["knowledge_embedding", "settled", "failed", true]]);
    const again = wiring(source.deps);
    await runCaseInvestigationRuntime(caseId, again.deps);
    expect(again.counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
  });

  it("C7/C8 bounds on the composed case: a non-canonical input key or four queries cost nothing and touch no ledger row", async () => {
    const source = sources();
    const { caseId } = await staleAgentCase(source.deps);
    const { snapshot } = await journal(caseId);
    const w = wiring(source.deps);
    const ledgerCalls: string[] = [];
    const ledger: CaseCallLedgerPort = { reserve: async i => { ledgerCalls.push("reserve"); return caseCallLedgerOnStore.reserve(i); }, markDispatched: async i => { ledgerCalls.push("mark"); return caseCallLedgerOnStore.markDispatched(i); },
      settle: async i => { ledgerCalls.push("settle"); return caseCallLedgerOnStore.settle(i); }, release: async i => { ledgerCalls.push("release"); return caseCallLedgerOnStore.release(i); } };
    const common = { holder: "sav-v2-investigation", leaseSeconds: 60, vectors: w.vectors, embed: w.embed, spend: w.spend, ledger, pauseState: async () => "running" as const,
      readTicketOwner: w.deps.readTicketOwner!, readCase: async (id: string) => ({ snapshot: (await readCase(id))!, events: await listCaseEvents(id) }) };
    expect(await caseBudgetedKnowledge({ ...common, scope: { locale: "fr-FR", audience: "support" }, now: () => new Date() })(snapshot, { inputKey: "in:not-a-canonical-key" }))
      .toEqual({ status: "stopped", stop: { reason: "knowledge_request_invalid", problem: "input_key_invalid" } });
    const retrieval = createCaseBudgetedRetrieval({ ...common, snapshot, inputKey: latestInvestigationInput(await listCaseEvents(caseId))! });
    await expect(retrieval.backend.search(["q1", "q2", "q3", "q4"], 5)).rejects.toThrow();
    expect(retrieval.stop()).toMatchObject({ reason: "knowledge_request_invalid", problem: "query_count_invalid" });
    expect(ledgerCalls).toEqual([]);
    expect(w.counts).toMatchObject({ embeddings: 0, spendReserve: 0 });
    expect(await calls(caseId)).toEqual([]);
  });
});

describe("A6 typed refusals: qualify throws closed codes only, never a raw error", () => {
  type Alter = { deps?: Partial<AdmissionInvestigationDeps>; snapshot?: (s: CaseSnapshot, gmail: string) => CaseSnapshot; event?: (e: CaseEvent) => CaseEvent; extra?: (events: CaseEvent[]) => CaseEvent[] };
  const relayOf = (event: CaseEvent) => (event.detail as { relay: Record<string, unknown> }).relay;
  const table: Array<[string, Alter, { code: string; nature: string; causeCode: string | null }]> = [
    ["V1 reader fails with a known code", { deps: { readConfirmedContext: async () => { throw Error("SAV_V1_CONTEXT_RUN_MISSING"); } } }, { code: "v1_context_unavailable", nature: "technical", causeCode: "SAV_V1_CONTEXT_RUN_MISSING" }],
    ["V1 reader fails with a raw message carrying synthetic PII", { deps: { readConfirmedContext: async () => { throw Error("contact client@example.invalid gm-123 unreachable"); } } }, { code: "v1_context_unavailable", nature: "technical", causeCode: null }],
    ["the D-a adapter cannot be read", { deps: { adapterPolicy: async () => { throw Error("adapter store down"); } } }, { code: "policy_unavailable", nature: "technical", causeCode: null }],
    ["the D-a adapter is malformed", { deps: { adapterPolicy: async () => ({ revision: "", decidedBy: "x", identity: "none" }) } }, { code: "policy_unavailable", nature: "technical", causeCode: null }],
    ["the rule port fails (CRM unreadable)", { deps: { approvedRules: async () => { throw Error("CRM unreadable client@example.invalid"); } } }, { code: "rule_unavailable", nature: "technical", causeCode: null }],
    ["the policy record cannot be read", { deps: { readPolicyRecord: async () => { throw Error("policy store down"); } } }, { code: "policy_unavailable", nature: "technical", causeCode: null }],
    ["a rule claims a human provenance", { deps: { approvedRules: async ({ requests }) => requests.map(request => ({ requestId: request.requestId, family: "access" as const, provenance: { kind: "human" as const, staffUserId: STAFF, at: AT } })) } },
      { code: "rule_invalid", nature: "contract_blocked", causeCode: "SAV_CASE_RULE_PROVENANCE_INVALID" }],
    ["another ticket than V1's", { snapshot: s => ({ ...s, ticketId: String(++seq) }) }, { code: "v1_source_mismatch", nature: "contract_blocked", causeCode: "SAV_V1_QUALIFICATION_SOURCE_MISMATCH" }],
    ["another run version than V1's", { event: e => ({ ...e, detail: { ...e.detail, relay: { ...relayOf(e), intakeRunVersion: 9 } } }) }, { code: "v1_source_mismatch", nature: "contract_blocked", causeCode: "SAV_V1_QUALIFICATION_SOURCE_MISMATCH" }],
    ["requests apart from V1's decision", { snapshot: (s, gmail) => ({ ...s, body: { ...s.body, openRequests: s.body.openRequests.filter(row => !row.id.startsWith(`${gmail}/`)) } }) },
      { code: "v1_requests_mismatch", nature: "contract_blocked", causeCode: "SAV_CASE_QUALIFY_REQUESTS_MISMATCH" }],
    ["an unreadable relay proof", { event: e => ({ ...e, detail: { ...e.detail, relay: { kind: "invented" } } }) }, { code: "relay_proof_invalid", nature: "contract_blocked", causeCode: "SAV_CASE_QUALIFY_RELAY_INVALID" }],
    ["an acknowledgement", { event: e => ({ ...e, detail: { ...e.detail, relay: { kind: "acknowledgement_on_case_thread", messageId: (e.detail as { messageId: string }).messageId, intakeRunId: randomUUID(), intakeRunVersion: 2, sourceHash: "syn" } } }) },
      { code: "acknowledgement_input", nature: "contract_blocked", causeCode: null }],
    ["a hand-back", { extra: events => [...events, { ...events.at(-1)!, id: randomUUID(), kind: "owner_changed", direction: "internal", caseVersion: events.at(-1)!.caseVersion + 1,
      detail: { transition: "hand_back", from: "human", to: "agent" } } as unknown as CaseEvent] }, { code: "handback_unproven", nature: "contract_blocked", causeCode: "SAV_CASE_QUALIFY_HANDBACK_UNPROVEN" }],
  ];
  it.each(table)("%s", async (_label, alter, expected) => {
    const admitted = sources();
    const { second, caseId } = await staleAgentCase(admitted.deps);
    const { snapshot, events } = await journal(caseId);
    const input = latestInvestigationInput(events)!.slice(3);
    const altered = (alter.extra ?? (e => e))(events.map(event => event.id === input && alter.event ? alter.event(event) : event));
    const shot = alter.snapshot ? alter.snapshot(snapshot, second.gmail) : snapshot;
    const error = await caseInvestigationQualify(sources(alter.deps ?? {}).deps)(shot, altered).then(() => null, (thrown: unknown) => thrown);
    expect(isCaseQualificationUnavailable(error)).toBe(true);
    const serialized = serializeCaseQualificationUnavailable(error);
    expect(serialized).toEqual({ ...expected, inputKey: latestInvestigationInput(altered), inputVersion: snapshot.admissionInputVersion });
    // Nothing raw travels: no synthetic address, Gmail id or CRM id in the message or the fields, and no cause attached.
    const visible = JSON.stringify(serialized) + (error as Error).message;
    for (const leak of ["client@", "gm-", "unreachable", "down", second.ticketId]) expect(visible).not.toContain(leak);
    expect((error as Error).cause).toBeUndefined();
    // The journal blocks are the shared precheck's own.
    const precheck = caseQualificationPrecheck(shot, altered);
    if (precheck.outcome === "blocked") expect(precheck.block).toBe(expected.code);
    else expect(precheck.outcome).toBe("eligible");
  });

  it("a defect that is no refusal (a rule port answering garbage) still throws as is, untyped and visible", async () => {
    const { caseId } = await staleAgentCase(sources().deps);
    const { snapshot, events } = await journal(caseId);
    const error = await caseInvestigationQualify(sources({ approvedRules: async () => null as never }).deps)(snapshot, events).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TypeError);
    expect(isCaseQualificationUnavailable(error)).toBe(false);
  });

  it("A4's nulls stay null (no customer input, input not current, no V1 execution): no refusal is invented", async () => {
    const { deps } = sources();
    const { caseId } = await staleAgentCase(deps);
    const { snapshot, events } = await journal(caseId);
    const qualify = caseInvestigationQualify(deps);
    expect(await qualify(snapshot, events.filter(event => event.direction !== "customer_inbound"))).toBeNull();
    expect(await qualify({ ...snapshot, admissionInputVersion: snapshot.admissionInputVersion + 1 }, events)).toBeNull();
    expect(await caseInvestigationQualify({ ...deps, readConfirmedContext: async () => null })(snapshot, events)).toBeNull();
  });
});

describe("A6 readCaseQualificationDiagnostic: read only, closed codes, since = the input to re-qualify", () => {
  const CALLER: CaseDiagnosticCaller = { kind: "staff_session_verified", staffUserId: STAFF };
  const tables = async () => {
    const names = (await f.client.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'sav' ORDER BY table_name")).rows.map(row => row.name);
    const out: Record<string, unknown[]> = {};
    for (const name of names) out[name] = (await f.client.query(`SELECT to_jsonb(t)::text AS row FROM sav."${name}" t ORDER BY 1`)).rows;
    return out;
  };
  const inputEvent = async (caseId: string) => {
    const snapshot = (await readCase(caseId))!;
    return (await listCaseEvents(caseId)).find(event => event.caseVersion === snapshot.admissionInputVersion)!;
  };
  /** Reads the diagnostic and checks it changed nothing anywhere in `sav` and carries no synthetic id or text. */
  async function diagnose(caseId: string, forbidden: string[]) {
    const before = await tables();
    const transaction = vi.spyOn(f.db, "transaction");
    const diagnostic = await readCaseQualificationDiagnostic(caseId, CALLER);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
    expect(await tables()).toEqual(before);
    const json = JSON.stringify(diagnostic);
    for (const leak of ["gm-", "@", "hubspot", "contact", ...forbidden]) expect(json).not.toContain(leak);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    return diagnostic!;
  }

  it("an admitted case is current: no input, no since", async () => {
    const mail = await v1Mail(sources().deps, { ownerEffect: true });
    expect(await diagnose(mail.caseId, [mail.ticketId])).toEqual({ revision: "sav-case-qualification-diagnostic.v1", caseId: mail.caseId, caseVersion: (await readCase(mail.caseId))!.version,
      state: "current", inputVersion: (await readCase(mail.caseId))!.admissionInputVersion, inputKey: null, since: null, block: null, nature: null, runtimeCause: "not_recorded" });
  });

  it("a second relayed mail: stale_ready on that mail, since = its occurrence, never the last admission decision", async () => {
    const { second, caseId } = await staleAgentCase(sources().deps);
    const diagnostic = await diagnose(caseId, [second.ticketId]);
    const event = await inputEvent(caseId);
    expect(diagnostic).toMatchObject({ state: "stale_ready", inputKey: `in:${event.id}`, inputVersion: event.caseVersion, since: event.occurredAt, block: null, nature: null, runtimeCause: "not_recorded" });
    expect(diagnostic.inputKey).toBe(latestInvestigationInput(await listCaseEvents(caseId)));
    expect(diagnostic.since).not.toBe((await readCaseDiagnostics(second.ticketId))!.admission!.since);
  });

  it("a newer CRM change: stale_unknown, since = the CRM change", async () => {
    const mail = await v1Mail(sources().deps, { ownerEffect: true });
    await appendCaseEvent({ caseId: mail.caseId, kind: "crm_observed", direction: "internal", dedupeKey: `crm:${mail.ticketId}:${Date.now()}`, sourceRef: { type: "hubspot_object", id: mail.ticketId },
      occurredAt: new Date().toISOString(), detail: { crmChange: "unknown" } });
    const event = await inputEvent(mail.caseId);
    expect(event.kind).toBe("crm_observed");
    expect(await diagnose(mail.caseId, [mail.ticketId])).toMatchObject({ state: "stale_unknown", since: event.occurredAt, block: null, inputVersion: event.caseVersion });
  });

  it("a real hand-back then a CRM change: stale_blocked handback_unproven", async () => {
    const mail = await v1Mail(sources().deps, { ownerEffect: true });
    let snapshot = (await readCase(mail.caseId))!;
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: snapshot.version, transition: "human_takeover", actor: { type: "human", staffUserId: STAFF }, commandKey: `take-${mail.caseId}`, reason: "syn_take" });
    snapshot = (await readCase(mail.caseId))!;
    await transitionCaseOwner({ caseId: mail.caseId, expectedVersion: snapshot.version, transition: "hand_back", actor: { type: "human", staffUserId: STAFF }, commandKey: `back-${mail.caseId}`, reason: "syn_back",
      to: "agent", admission: { policy: SYN_POLICY, qualification: (await readCase(mail.caseId))!.admission!.qualification } });
    await appendCaseEvent({ caseId: mail.caseId, kind: "crm_observed", direction: "internal", dedupeKey: `crm:${mail.ticketId}:${Date.now()}`, sourceRef: { type: "hubspot_object", id: mail.ticketId },
      occurredAt: new Date().toISOString(), detail: { crmChange: "unknown" } });
    const events = await listCaseEvents(mail.caseId);
    expect(latestInvestigationInput(events)).toMatch(/^back:/);
    expect(await diagnose(mail.caseId, [mail.ticketId])).toMatchObject({ state: "stale_blocked", block: "handback_unproven", nature: "contract_blocked", inputKey: latestInvestigationInput(events),
      since: (await inputEvent(mail.caseId)).occurredAt });
  });

  it("a real relayed acknowledgement: stale_blocked acknowledgement_input", async () => {
    const source = sources();
    const first = await v1Mail(source.deps, { ownerEffect: true });
    const { messageId, runVersion } = await inbound(first.threadId, null);
    const [run] = await f.db.insert(savIntakeRuns).values({ threadId: first.threadId, messageId, version: runVersion, isCurrent: false, state: "observed", configHash: `ack-diag-${messageId}`, policyHash: "fixture",
      payloadCiphertext: encryptSavPayload({}) }).returning();
    const acknowledgement = { runId: run!.id, runVersion, sourceHash: "syn-ack-source", decision: { classification: "acknowledgement", requests: [{ id: "a0", kind: "acknowledgement" }] } } as never;
    await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => null, readAcknowledgement: async () => acknowledgement, ...caseRelayAdmissionDeps(source.deps), env: ENV });
    const event = await inputEvent(first.caseId);
    expect(await diagnose(first.caseId, [first.ticketId])).toMatchObject({ state: "stale_blocked", block: "acknowledgement_input", nature: "contract_blocked", inputKey: `in:${event.id}`, since: event.occurredAt });
  });

  it("the caller contract is explicit: without a verified staff caller nothing is read, not even the database handle", async () => {
    const mail = await v1Mail(sources().deps, { ownerEffect: true });
    const held = state.db;
    state.db = null;
    try {
      for (const caller of [undefined, null, {}, { kind: "staff_session_verified" }, { kind: "anonymous", staffUserId: STAFF }, { kind: "staff_session_verified", staffUserId: "not-a-uuid" }])
        await expect(readCaseQualificationDiagnostic(mail.caseId, caller as never)).rejects.toThrow("SAV_CASE_DIAGNOSTIC_CALLER_INVALID");
    } finally { state.db = held; }
    expect(await readCaseQualificationDiagnostic("not-a-uuid", CALLER)).toBeNull();
    expect(await readCaseQualificationDiagnostic(randomUUID(), CALLER)).toBeNull();
  });

  it("an unreadable input payload or an unsupported contract revision refuses, and changes nothing", async () => {
    const first = await staleAgentCase(sources().deps);
    // The journal is append-only: an owner change whose payload does not decrypt is appended raw (the check decrypts it).
    const top = (await listCaseEvents(first.caseId)).at(-1)!;
    await f.client.query(`INSERT INTO sav.case_events (case_id, kind, dedupe_key, case_version, direction, occurred_at, payload_ciphertext)
      VALUES ($1, 'owner_changed', $2, $3, 'internal', now(), 'not-a-ciphertext')`, [first.caseId, `cmd:syn-unreadable-${first.caseId}`, top.caseVersion + 1]);
    const second = await staleAgentCase(sources().deps);
    await f.client.query("UPDATE sav.cases SET contract_revision = 'sav-case-unsupported.v0' WHERE id = $1", [second.caseId]);
    const before = await tables();
    await expect(readCaseQualificationDiagnostic(first.caseId, CALLER)).rejects.toThrow("SAV_CASE_DIAGNOSTIC_UNREADABLE");
    await expect(readCaseQualificationDiagnostic(second.caseId, CALLER)).rejects.toThrow("SAV_CASE_DIAGNOSTIC_UNREADABLE");
    expect(await tables()).toEqual(before);
  });

  it("its source takes no lock, no upgrade, no write, reads no case body and no V1, CRM or provider source", () => {
    const store = readFileSync(new URL("./case-store.ts", import.meta.url), "utf8");
    const start = store.indexOf("export async function readCaseQualificationDiagnostic");
    const body = store.slice(start, store.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    for (const banned of ['for("update")', 'for("share")', "lockTicket", "lockedCase", "upgradeLocked", "advisory", ".insert(", ".update(", ".delete(", "savCases.payloadCiphertext",
      "savIntake", "savMessages", "readConfirmed", "hubspot", "fetch(", "assertWritable"]) expect(body).not.toContain(banned);
  });
});
