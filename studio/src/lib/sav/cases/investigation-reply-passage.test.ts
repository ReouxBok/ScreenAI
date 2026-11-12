import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savCaseEffectExecutions, savCaseReplyValidations, savCaseTimers, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// B7 T8: pole A's journal read, passed through as is, except once when a test arms a failure (sav.case_events is append-only:
// an unreadable journal cannot be produced in the database itself).
const journal = vi.hoisted(() => ({ failNext: false }));
vi.mock("./case-store", async importOriginal => {
  const actual = await importOriginal<typeof import("./case-store")>();
  return { ...actual, listCaseEvents: async (...args: Parameters<typeof actual.listCaseEvents>) => {
    if (journal.failNext) { journal.failNext = false; throw Error("SAV_CASE_JOURNAL_UNREADABLE_SYN"); }
    return actual.listCaseEvents(...args);
  } };
});
// Strict local ports: no V1 executor, no model dispatcher, and fetch throws.
vi.mock("../intake/executor", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
// The passage reaches C's store, whose module graph imports the V1 dispatcher: imported, but every function of it throws if called.
vi.mock("../intake/model-dispatch", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value === "function" ? () => { throw Error(`MODEL_DISPATCH_FORBIDDEN:${name}`); } : value]));
});
import { encryptSavPayload } from "../crypto";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { readCase, recordCustomerReturn } from "./case-store";
import { readCaseReplyDisclosure } from "./case-reply-outbound";
import { decideCaseReply } from "./case-reply-store";
import { caseInvestigationReturnAwareQualify, type CaseReturnRulePort } from "./investigation-return-qualify";
import { bindCaseInvestigationToReplyPlan, caseAccessAutoReplyAuthorizer, CASE_REPLY_PLAN_PORTS, passCaseInvestigationToReplyPlan, runCaseInvestigationToReplyPlan, type CaseReplyPassageDeps } from "./investigation-reply-passage";
import { pilotProvenanceGate, type PilotProvenanceDeps } from "./pilot-passage-provenance";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import type { CaseAdmissionQualification, CaseSnapshot, KnowledgeRef } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { type CaseInvestigationModelRequest, type CaseInvestigationPauseLevel, type CaseInvestigationTicketOwner } from "./investigation-runner";
import { type CaseEmbeddingSpendPort, type CaseEmbeddingTransport, type CaseKnowledgeVectorSearch } from "./investigation-budgeted-retrieval";
import { caseCallLedgerOnStore, runCaseInvestigationRuntime, type CaseInvestigationRuntimeDeps } from "./investigation-runtime";

/*
 * Night 31/10 (SAV-7/SAV-11, review K-COST1): the assembled V2 path, local and OFF, on real modules. A synthetic V1 mail
 * relayed by A → B's runtime entrypoint → A's store ports → the budgeted knowledge search, its embedding reserved in A's
 * real call ledger and gated by a spend double → the model through the same ledger and a money double → the decision
 * stored. Only the transports are doubles (vector index, embedding, model), counted; no key, no SDK, fetch throws.
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId = "", policyId = "", seq = 8_970_000;
const AT = "2026-10-31T09:00:00.000Z", STAFF = "20000000-0000-4000-8000-000000000004", V2_OWNER = "90000001";
const ENV = { SAV_V2_HUBSPOT_OWNER_ID: V2_OWNER, SAV_CASE_RECORDING: "on" };
const SENDER = "client@example.invalid";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: STAFF, approvedAt: AT };
const CONFIRMED: CaseAdmissionQualification["identity"] = { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } };
const ruled = (requestId: string) => ({ requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } });
const readQualification = async (input: { requests: { requestId: string }[] }): Promise<CaseAdmissionQualification> =>
  ({ requests: input.requests.map(request => ruled(request.requestId)), identity: CONFIRMED, crmContext: "complete", teamSignals: [] });

/** One stored V1 mail on a ticket, relayed by A. `ownerEffect`: V1's confirmed V2 owner effect on it (historic ledger row). */
async function v1Mail(options: { ticketId?: string; threadId?: string; ownerEffect: boolean }) {
  const ticketId = options.ticketId ?? String(++seq), threadId = options.threadId ?? randomUUID(), messageId = randomUUID();
  if (!options.threadId) await f.db.insert(savThreads).values({ id: threadId, mailboxId, gmailThreadId: `thread-${threadId}`, subject: "Synthétique", customerEmail: SENDER });
  await f.db.insert(savMessages).values({ id: messageId, threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Synthétique",
    bodyCiphertext: encryptSavPayload({ text: "Corps synthétique", headers: { "message-id": `<${messageId}@example.invalid>` } }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
  const runVersion = (await f.db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, threadId))).length + 1;
  const [execution] = await f.db.insert(savIntakeExecutions).values({ messageId, threadId, runVersion, policyId, policyHash: "fixture", state: "confirmed", ticketId,
    payloadCiphertext: encryptSavPayload({ plan: { decision: { classification: "support", requests: [{ id: "r0", kind: "support" }] } } }) }).returning();
  const input = { message: { id: messageId }, attempt: 0 };
  const result = { messageId, requests: [{ id: "r0", kind: "support", currentMessageId: messageId }], ticketSummary: { title: "Connexion impossible", description: "Le code n'arrive pas.", requestIds: ["r0"] } };
  const [run] = await f.db.insert(savIntakeRuns).values({ threadId, messageId, version: runVersion, isCurrent: false, state: "observed", configHash: `runtime-${messageId}`, policyHash: "fixture",
    payloadCiphertext: encryptSavPayload({ revision: "sav-intake-runtime-2026-10-21.v1", effects: "not_connected", semantics: { revision: SAV_INTAKE_SEMANTIC_RECORD_REVISION, validatorRevision: SAV_INTAKE_MODEL_REVISION,
      records: [{ method: "analyseMessage", input, result, inputHash: intakeSemanticInputHash(input), resultHash: savIntakeEvidenceContentHash(result), acceptedAt: AT }] } }) }).returning();
  await f.db.update(savIntakeExecutions).set({ runId: run!.id, runVersion }).where(eq(savIntakeExecutions.id, execution!.id));
  if (options.ownerEffect) {
    const intent = { kind: "owner_assign", permission: "assign_v2_owner", key: `owner-v2:${messageId}:${ticketId}`, ticketId, sourceMessageId: messageId, expectedOwnerId: null, properties: { hubspot_owner_id: V2_OWNER } };
    await f.db.insert(savIntakeEffects).values({ businessKey: intent.key, executionId: execution!.id, kind: "owner_assign", permission: "assign_v2_owner", state: "confirmed",
      intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), confirmedAt: new Date(), dispatchedAt: new Date() });
  }
  const relayed = await recordCaseAfterConfirmedIntake(messageId, { readProgress: async () => ({ state: "confirmed", ticketId, confirmed: true }),
    readAdmissionPolicy: async () => POLICY, readQualification, env: ENV }) as { caseId: string; appended: boolean; owner: string };
  return { ticketId, threadId, gmail: `gm-${messageId}`, caseId: relayed.caseId, relayed };
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
type Knobs = { pause?: CaseInvestigationPauseLevel[]; owners?: (CaseInvestigationTicketOwner | "throws")[]; spend?: "allowed" | "refused"; embed?: "ok" | "hangs"; money?: "allowed" | "refused";
  available?: boolean; onModel?: () => Promise<void>; leaseSeconds?: number; revision?: () => string };
/** Every port of the runtime; the transports are counted doubles. `pause` / `owners`: answers in order, the last repeats. */
function wiring(knobs: Knobs = {}) {
  const counts = { embeddings: 0, vectorSearches: 0, spendReserve: 0, spendSettle: [] as unknown[], money: 0, model: 0, ownerReads: 0 };
  const pauses = [...(knobs.pause ?? ["running"])], owners = [...(knobs.owners ?? ["v2"])];
  const next = <T,>(list: T[]) => list.length > 1 ? list.shift()! : list[0]!;
  const vectors: CaseKnowledgeVectorSearch = { dimension: DIM, readRevision: async () => knobs.revision?.() ?? "kb-syn-r1", available: async () => knobs.available ?? true,
    search: async (queries, given) => { counts.vectorSearches++; expect(given).toHaveLength(queries.length); return queries.map(() => [card]); } };
  const embed: CaseEmbeddingTransport = async ({ texts, signal }) => {
    counts.embeddings++;
    if (knobs.embed === "hangs") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Error("ABORTED"))));
    return { vectors: texts.map((_, i) => Array.from({ length: DIM }, (__, j) => (i + 1) / (j + 3))), usage: null };
  };
  const spend: CaseEmbeddingSpendPort = {
    reserve: async () => { counts.spendReserve++; return knobs.spend === "refused" ? { status: "refused", reason: "stop_paid_fixture" } : { status: "allowed", reservationId: `res-${counts.spendReserve}` }; },
    settle: async input => { counts.spendSettle.push(input); },
    release: async () => undefined,
  };
  const deps: CaseInvestigationRuntimeDeps = {
    mode: "observe", holder: "sav-v2-investigation", scope: { locale: "fr-FR", audience: "support" }, now: () => new Date(Date.now() + 6 * 60_000), leaseSeconds: knobs.leaseSeconds ?? 60,
    pauseState: async () => next(pauses),
    readTicketOwner: async () => { counts.ownerReads++; const owner = next(owners); if (owner === "throws") throw Error("CRM_UNREADABLE"); return owner; },
    // Pilot ACCÈS (3/11): a SYNTHETIC approved scope listing the fixture card; the runtime is closed without one.
    accessScope: async () => ({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: "policy-r1", revision: "syn-scope-r1", family: "access", sources: [{ knowledgeId: card.id, contentVersionId: card.contentVersionId, use: "answer" }] }),
    admissionPolicyRevision: async () => "policy-r1",
    qualify: async (snapshot, events) => {
      const latest = events.filter(event => event.kind === "inbound_confirmed").at(-1);
      const requests = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ruled(row.id));
      return latest ? { admission: { policy: POLICY, qualification: { requests, identity: CONFIRMED, crmContext: "complete" as const, teamSignals: [] } }, sourceRef: latest.sourceRef } : null;
    },
    customerTexts: async (_caseId, refs) => Object.fromEntries(refs.map(row => [`${row.type}:${row.id}`, "Bonjour, je n'arrive plus à me connecter."])),
    revisions: async () => ({ rules: "rules-r1", playbookId: "playbook-1", model: "model-fixture", prompt: "prompt-r1" }),
    ledger: caseCallLedgerOnStore,
    knowledge: { vectors, embed, spend },
    model: {
      money: async () => { counts.money++; return knobs.money === "refused" ? { status: "refused", reason: "fixture" } : { status: "allowed" }; },
      provider: async request => { counts.model++; await knobs.onModel?.(); return answer(request); },
    },
  };
  return { deps, counts };
}
async function sideEffects(caseId: string) {
  const count = async (table: typeof savCaseEffectExecutions | typeof savCaseReplyValidations | typeof savCaseTimers) => (await f.db.select().from(table).where(eq(table.caseId, caseId))).length;
  return { effects: await count(savCaseEffectExecutions), validations: await count(savCaseReplyValidations), timers: await count(savCaseTimers) };
}

beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "runtime-journey-fixture-key-32-chars!!");
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-runtime-admin", email: "runtime-admin@example.invalid", role: "admin" }).returning();
  const [mailbox] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  const [policy] = await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning();
  mailboxId = mailbox!.id; policyId = policy!.id;
}, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "runtime-journey-fixture-key-32-chars!!");
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });


const RULE_POLICY = { read: async () => ({ policy: POLICY, validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2027-12-31T00:00:00.000Z" }), now: () => new Date() };
const later = () => new Date(Date.now() + 1_000).toISOString();
const rule = (family: "access" | "finance"): CaseReturnRulePort => async ({ requests }) =>
  requests.map(row => ({ requestId: row.requestId, family, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: later() } }));
function returnWiring(returnRules?: CaseReturnRulePort, knobs: Knobs = {}) {
  const base = wiring(knobs);
  base.deps.qualify = caseInvestigationReturnAwareQualify(base.deps.qualify!, { readPolicyRecord: RULE_POLICY.read, now: RULE_POLICY.now, ...(returnRules ? { returnRules } : {}) });
  return base;
}
/** A's committed `continue`: the stored return mail, then A's store (the copied admission when a policy is given, stale otherwise). */
async function customerReturn(mail: Awaited<ReturnType<typeof v1Mail>>, text: string, withPolicy: boolean) {
  const messageId = randomUUID(), gmail = `gm-${messageId}`;
  await f.db.insert(savMessages).values({ id: messageId, threadId: mail.threadId, mailboxId, direction: "inbound", fromEmail: SENDER, toEmails: ["support@example.invalid"], subject: "Re: Synthétique",
    bodyCiphertext: encryptSavPayload({ text }), receivedAt: new Date(), gmailMessageId: gmail });
  const snapshot = (await readCase(mail.caseId))!;
  const record = await recordCustomerReturn({ route: "continue", reason: "open_case_v2_owner", caseId: mail.caseId, expectedVersion: snapshot.version, ticketId: mail.ticketId,
    threadId: mail.threadId, messageId, gmailMessageId: gmail, receivedAt: new Date().toISOString(), ...(withPolicy ? { policy: POLICY } : {}) });
  return { messageId, gmail, record };
}
const answered = async () => {
  const mail = await v1Mail({ ownerEffect: true });
  expect(await runCaseInvestigationRuntime(mail.caseId, wiring().deps)).toMatchObject({ status: "recorded", outcome: "accepted" });
  return mail;
};

describe("passage to the send plan (B): C's store, A's rule, nothing short of every proof", () => {
  const APPROVER = "30000000-0000-4000-8000-000000000042";
  const provenance: PilotProvenanceDeps = {
    accessScope: () => wiring().deps.accessScope!(), currentPolicyRevision: async () => "policy-r1", now: () => new Date(),
    readActiveSource: async () => ({ active: true, title: card.title, content: card.content, verifiedAt: card.verifiedAt! }),
  };
  const passage = (env: Record<string, string>, owner: "v2" | "human" = "v2"): CaseReplyPassageDeps => ({
    store: { env: () => ({ SAV_CASE_EFFECTS: "supervised", ...env }), currentPolicyRevision: async () => "policy-r1", readTicketOwner: async () => owner, pilotProvenance: pilotProvenanceGate(provenance) },
    provenance, policy: { id: policyId, hash: "fixture" },
  });
  const AUTO = { SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: APPROVER };

  it("auto off: one proposal for a person, idempotent on replay, no execution", async () => {
    const mail = await answered();
    const first = await passCaseInvestigationToReplyPlan(mail.caseId, passage({}));
    expect(first).toMatchObject({ status: "awaiting_person", reasons: ["auto_disabled"] });
    const again = await passCaseInvestigationToReplyPlan(mail.caseId, passage({}));
    expect(again).toEqual(first);
    expect(await sideEffects(mail.caseId)).toEqual({ effects: 0, validations: 1, timers: 0 });
  });
  it("queues a fully proven access reply in the automated mode exactly once", async () => {
    const mail = await answered();
    const report = await passCaseInvestigationToReplyPlan(mail.caseId, passage(AUTO));
    expect(report).toMatchObject({ status: "queued", created: true });
    const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, mail.caseId));
    expect(row).toMatchObject({ state: "approved", decidedBy: APPROVER, authorizationBasis: "auto_access.v1" });
    const { decryptSavPayload } = await import("../crypto");
    expect(readCaseReplyDisclosure(decryptSavPayload<{ text: string }>(row!.proposalCiphertext).text)?.mode).toBe("automated");
    const again = await passCaseInvestigationToReplyPlan(mail.caseId, passage(AUTO));
    expect(again).toMatchObject({ status: "queued", executionId: row!.executionId, created: false });
    expect((await sideEffects(mail.caseId)).effects).toBe(1);
  });
  it("auto on but a person holds the ticket, or the scope is gone: no automated text asked, the proposal waits", async () => {
    const mail = await answered();
    expect(await passCaseInvestigationToReplyPlan(mail.caseId, passage(AUTO, "human"))).toMatchObject({ status: "proposal_refused" });
    // Without the approved scope the recorded decision has no reply at all (its scope cannot be checked): nothing is proposed.
    const gone = { ...passage(AUTO), provenance: { ...provenance, accessScope: async () => null } };
    expect(await passCaseInvestigationToReplyPlan(mail.caseId, gone)).toEqual({ status: "no_reply", caseId: mail.caseId, reason: "access_scope_unknown" });
    expect((await sideEffects(mail.caseId)).effects).toBe(0);
  });
  it("the B authorizer refuses an absent, falsified or other approver, and an unknown payload; C refuses no authorizer", async () => {
    const mail = await answered();
    const proposed = await passCaseInvestigationToReplyPlan(mail.caseId, passage({}));
    if (proposed.status !== "awaiting_person") throw Error("NO_PROPOSAL");
    const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, proposed.validationId));
    const seen = { payloadHash: row!.payloadHash, caseVersion: row!.caseVersion, recipient: row!.recipient };
    const deps = passage(AUTO);
    const authorizer = caseAccessAutoReplyAuthorizer(deps);
    expect(await authorizer({ action: "approve", approverId: APPROVER, caseId: mail.caseId, replyKey: row!.replyKey, payloadHash: "f".repeat(64), purpose: "answer" }))
      .toEqual({ allowed: false, reason: "proposal_unknown" });
    expect(await authorizer({ action: "approve", approverId: APPROVER, caseId: mail.caseId, replyKey: row!.replyKey, payloadHash: row!.payloadHash, purpose: "answer" }))
      .toEqual({ allowed: false, reason: "auto_text_mode_not_automated" });
    for (const [approverId, given] of [[randomUUID(), authorizer], [APPROVER, null]] as const) {
      expect(await decideCaseReply({ action: "approve", validationId: proposed.validationId, approverId, seen, authorizer: given, deps: deps.store })).toMatchObject({ ok: false });
    }
    expect(await sideEffects(mail.caseId)).toEqual({ effects: 0, validations: 1, timers: 0 });
  });
  it("A's entry point after a crash: the decision recorded before the crash is passed on later, with no new model call", async () => {
    const mail = await answered();
    const { deps, counts } = wiring();
    const resumed = await runCaseInvestigationToReplyPlan(mail.caseId, { investigation: deps, reply: passage({}) });
    expect(resumed.investigation.status).toBe("already_recorded");
    expect(resumed.reply).toMatchObject({ status: "awaiting_person" });
    expect(counts.model).toBe(0);
    const twice = await runCaseInvestigationToReplyPlan(mail.caseId, { investigation: deps, reply: passage({}) });
    expect(twice.reply).toEqual(resumed.reply);
    expect((await sideEffects(mail.caseId)).validations).toBe(1);
  });
  it("A's entry point on a committed return whose trigger never ran: requalified, investigated and proposed on the new mail", async () => {
    const mail = await answered();
    const back = await customerReturn(mail, "Je ne reçois toujours pas le code.", true);
    const { deps } = returnWiring(rule("access"));
    const report = await runCaseInvestigationToReplyPlan(mail.caseId, { investigation: deps, reply: passage({}) });
    expect(report.investigation).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(report.reply).toMatchObject({ status: "awaiting_person" });
    const rows = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, mail.caseId));
    expect(rows.some(row => row.replyKey.includes(back.gmail))).toBe(true);
  });
  it("the binding names every missing port and runs nothing; complete, it is A's callable entry", async () => {
    const mail = await answered();
    const none = bindCaseInvestigationToReplyPlan({ investigation: { ...wiring().deps, model: {}, knowledge: {} }, provenance: {}, store: {}, policy: null });
    expect(none.ok).toBe(false);
    expect(!none.ok && none.missing).toEqual(expect.arrayContaining(["investigation.knowledge.spend", "investigation.model.money", "provenance.accessScope",
      "provenance.currentPolicyRevision", "provenance.readActiveSource", "provenance.now", "store.pilotProvenance"]));
    const full = passage({});
    const bound = bindCaseInvestigationToReplyPlan({ investigation: wiring().deps, provenance, store: full.store, policy: full.policy });
    expect(bound.ok).toBe(true);
    if (bound.ok) expect((await bound.run(mail.caseId)).reply).toMatchObject({ status: "awaiting_person" });
    expect(CASE_REPLY_PLAN_PORTS).toHaveLength(20);
  });

  // Per-block switch (12/11): stored like the agent pause; the default (no row) is today's behaviour, tested above.
  const BLOCK_KEY = "sav-block-switch.v1:access";
  const setBlock = async (mode: "off" | "draft" | "auto", paused: boolean) => {
    const values = { key: BLOCK_KEY, status: "active", cursor: encryptSavPayload({ revision: "sav-block-switch.v1", blockId: "access", mode, paused,
      setBy: "admin@example.invalid", setAt: new Date().toISOString(), reason: "Réglage synthétique" }) };
    await f.db.insert(savSyncState).values(values).onConflictDoUpdate({ target: savSyncState.key, set: values });
  };
  const clearBlock = () => f.db.delete(savSyncState).where(eq(savSyncState.key, BLOCK_KEY));
  describe("per-block switch: off, pause and draft never send; the global switch off wins over the block's auto", () => {
    afterEach(async () => { await clearBlock(); });
    it("no row: Access keeps today's automatic send under the global switch (default unchanged)", async () => {
      await clearBlock();
      const mail = await answered();
      expect(await passCaseInvestigationToReplyPlan(mail.caseId, passage(AUTO))).toMatchObject({ status: "queued", created: true });
    });
    for (const [mode, paused, code] of [["off", false, "block_off"], ["auto", true, "block_paused"], ["draft", true, "block_paused"]] as const) {
      it(`${mode}${paused ? " + pause" : ""}: a visible wait (${code}), no proposal, no approval, no execution, even with the global switch on`, async () => {
        await setBlock(mode, paused);
        const mail = await answered();
        const report = await passCaseInvestigationToReplyPlan(mail.caseId, passage(AUTO));
        expect(report).toEqual({ status: "block_held", caseId: mail.caseId, blockId: "access", reason: code, detail: "access" });
        expect(await passCaseInvestigationToReplyPlan(mail.caseId, passage(AUTO))).toEqual(report);
        expect(await sideEffects(mail.caseId)).toEqual({ effects: 0, validations: 0, timers: 0 });
      });
    }
    it("draft: the reply is proposed for a person and never approved or queued by the rule", async () => {
      await setBlock("draft", false);
      const mail = await answered();
      const report = await passCaseInvestigationToReplyPlan(mail.caseId, passage(AUTO));
      expect(report).toMatchObject({ status: "awaiting_person", reasons: ["block_draft"] });
      const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, mail.caseId));
      expect(row).toMatchObject({ state: "proposed" });
      expect(await sideEffects(mail.caseId)).toEqual({ effects: 0, validations: 1, timers: 0 });
    });
    it("draft: B's authorizer refuses the rule's approval even on an automated, proven proposal", async () => {
      const mail = await answered();
      // Proposed in the automated mode while the block was auto but the approval is asked after the switch to draft.
      await setBlock("draft", false);
      const proposed = await passCaseInvestigationToReplyPlan(mail.caseId, passage(AUTO));
      if (proposed.status !== "awaiting_person") throw Error("NO_PROPOSAL");
      const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, proposed.validationId));
      expect(await caseAccessAutoReplyAuthorizer(passage(AUTO))({ action: "approve", approverId: APPROVER, caseId: mail.caseId, replyKey: row!.replyKey, payloadHash: row!.payloadHash, purpose: "answer" }))
        .toEqual({ allowed: false, reason: "block_draft" });
      expect((await sideEffects(mail.caseId)).effects).toBe(0);
    });
    it("global switch off wins over the block's explicit auto: a person validates, nothing is queued", async () => {
      await setBlock("auto", false);
      const mail = await answered();
      expect(await passCaseInvestigationToReplyPlan(mail.caseId, passage({}))).toMatchObject({ status: "awaiting_person", reasons: ["auto_disabled"] });
      expect(await sideEffects(mail.caseId)).toEqual({ effects: 0, validations: 1, timers: 0 });
    });
  });
});
