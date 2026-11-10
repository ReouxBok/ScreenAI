import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savCaseCalls, savCases, savCaseEffectExecutions, savCaseReplyValidations, savCaseTimers, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savThreads, staffUsers } from "@/db/schema";
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
vi.mock("../intake/executor", () => ({ readIntakeExecutionProgress: () => { throw Error("EXECUTOR_NOT_ALLOWED"); } }));
vi.mock("../intake/model-dispatch", () => { throw Error("DISPATCHER_IMPORTED"); });
import { encryptSavPayload } from "../crypto";
import { savIntakeEvidenceContentHash } from "../intake/engine";
import { SAV_INTAKE_MODEL_REVISION } from "../intake/model-readers";
import { intakeRuntimeHash } from "../intake/runtime-contract";
import { intakeSemanticInputHash, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "../intake/semantic-records";
import type { SavRetrievalCandidate } from "../request-retrieval";
import { claimCaseForDecision, listCaseEvents, openCaseEvent, readCase, recordCustomerReturn } from "./case-store";
import { caseInvestigationReturnAwareQualify, caseReturnContentRule, type CaseReturnRulePort } from "./investigation-return-qualify";
import { SAV_CASE_ACCESS_SCOPE_REVISION } from "./investigation-access-scope";
import { SAV_INTAKE_CONTRACT_REVISION } from "../intake/contract";
import { readConfirmedV1Context } from "./admission-context-reader";
import { caseInvestigationQualify, type AdmissionInvestigationDeps } from "./admission-investigation-ports";
import { CaseQualificationUnavailableError } from "./qualification-diagnostic";
import { caseDedupeKey, type CaseAdmissionQualification, type CaseSnapshot, type KnowledgeRef } from "./case-types";
import { recordCaseAfterConfirmedIntake } from "./intake-boundary";
import { readCaseInvestigationProgress } from "./investigation-record";
import { listCaseInvestigationWaits } from "./investigation-waits";
import { latestInvestigationInput, type CaseInvestigationModelRequest, type CaseInvestigationPauseLevel, type CaseInvestigationTicketOwner } from "./investigation-runner";
import { caseKnowledgeSubjectKey, type CaseEmbeddingSpendPort, type CaseEmbeddingTransport, type CaseKnowledgeVectorSearch } from "./investigation-budgeted-retrieval";
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
    bodyCiphertext: encryptSavPayload({ text: "Corps synthétique" }), receivedAt: new Date(), gmailMessageId: `gm-${messageId}` });
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
async function calls(caseId: string) {
  return (await f.db.select({ key: savCaseCalls.callKey, purpose: savCaseCalls.purpose, state: savCaseCalls.state, status: savCaseCalls.resultStatus, uncertain: savCaseCalls.resultUncertain })
    .from(savCaseCalls).where(eq(savCaseCalls.caseId, caseId))).sort((a, b) => a.key.localeCompare(b.key));
}
async function progressOf(caseId: string) {
  const events = await listCaseEvents(caseId), input = latestInvestigationInput(events)!;
  return { input, read: readCaseInvestigationProgress(events, input) };
}
async function sideEffects(caseId: string) {
  const count = async (table: typeof savCaseEffectExecutions | typeof savCaseReplyValidations | typeof savCaseTimers) => (await f.db.select().from(table).where(eq(table.caseId, caseId))).length;
  return { effects: await count(savCaseEffectExecutions), validations: await count(savCaseReplyValidations), timers: await count(savCaseTimers) };
}
const NO_EFFECT = { effects: 0, validations: 0, timers: 0 };

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

describe("runtime entrypoint: OFF unless asked, closed when a port is missing", () => {
  it("mode off, or any missing port: nothing read, nothing written, no call", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const before = (await readCase(mail.caseId))!;
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, { ...deps, mode: "off" })).toEqual({ status: "off", caseId: mail.caseId, modelCalls: 0 });
    const noOwner: CaseInvestigationRuntimeDeps = { ...deps };
    delete noOwner.readTicketOwner;
    expect(await runCaseInvestigationRuntime(mail.caseId, { ...noOwner, knowledge: { vectors: deps.knowledge.vectors, embed: deps.knowledge.embed }, model: { provider: deps.model.provider } }))
      .toEqual({ status: "not_wired", caseId: mail.caseId, missing: ["readTicketOwner", "knowledge.spend", "model.money"], modelCalls: 0 });
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0, ownerReads: 0 });
    expect(await readCase(mail.caseId)).toMatchObject({ version: before.version, owner: "agent" });
    expect(await calls(mail.caseId)).toEqual([]);
  });
});

describe("pole A's documented ports (A/INTERFACE.md, 903fddb), as local doubles: B imports none of A's unmerged code", () => {
  it.each([
    ["admissionPolicyRevisionPort answers null (no approved policy)", { admissionPolicyRevision: async () => null }],
    ["ticketOwnerPort answers unknown (owner property not returned)", { readTicketOwner: async () => "unknown" as const }],
    ["ticketOwnerPort throws (read failed)", { readTicketOwner: async () => { throw Error("HUBSPOT_UNREADABLE"); } }],
  ])("%s: nothing is searched, paid or called", async (_name, port) => {
    const mail = await v1Mail({ ownerEffect: true });
    const { deps, counts } = wiring();
    const report = await runCaseInvestigationRuntime(mail.caseId, { ...deps, ...port });
    expect(report).toMatchObject({ modelCalls: 0 });
    expect(["skipped", "claim_refused"]).toContain(report.status);
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
    expect(await calls(mail.caseId)).toEqual([]);
  });
});

describe("pilot ACCÈS: the runtime is closed without an approved scope of sources", () => {
  it("no scope injected (or one that is not a scope): the access case is refused before any embedding, search or call; nothing is written", async () => {
    for (const accessScope of [undefined, async () => null, async () => ({ revision: "syn-scope-r1", family: "access", sources: [] }),
      async () => ({ schema: SAV_CASE_ACCESS_SCOPE_REVISION, policyRevision: "policy-other", revision: "syn-scope-r1", family: "access", sources: [{ knowledgeId: "k-login", contentVersionId: "k-login-v1", use: "answer" }] })]) {
      const mail = await v1Mail({ ownerEffect: true });
      const { deps, counts } = wiring();
      expect(await runCaseInvestigationRuntime(mail.caseId, { ...deps, accessScope }))
        .toMatchObject({ status: "skipped", reason: "access_scope_missing", modelCalls: 0 });
      expect(counts).toMatchObject({ embeddings: 0, vectorSearches: 0, spendReserve: 0, money: 0, model: 0 });
      expect({ calls: await calls(mail.caseId), effects: await sideEffects(mail.caseId) }).toEqual({ calls: [], effects: NO_EFFECT });
    }
  });
});

describe("the assembled path on synthetic data: V1 mail → A's case → budgeted knowledge → model → stored decision", () => {
  it("one paid embedding and one model call, both in A's ledger under their own subjects; the cited card is stored; no effect; no network", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "recorded", modelCalls: 1 });
    expect(counts).toMatchObject({ embeddings: 1, vectorSearches: 1, spendReserve: 1, money: 1, model: 1 });
    // The transport double reports no usage: settled unknown, the reservation kept, never free.
    expect(counts.spendSettle).toEqual([{ reservationId: "res-1", usage: "unknown", uncertain: false }]);
    const { input, read } = await progressOf(mail.caseId);
    expect(await calls(mail.caseId)).toEqual([
      { key: `${caseKnowledgeSubjectKey(mail.caseId, input)}:call1`, purpose: "knowledge_embedding", state: "settled", status: "ok", uncertain: false },
      { key: `sav-case:${mail.caseId}:${input}:call1`, purpose: expect.any(String), state: "settled", status: "ok", uncertain: false },
    ].sort((a, b) => a.key.localeCompare(b.key)));
    expect(read).toMatchObject({ state: "found", record: { progress: { modelCalls: 1, waiting: null } } });
    expect(JSON.stringify(read.state === "found" ? read.record : null)).toContain("k-login-v1");
    expect(await sideEffects(mail.caseId)).toEqual(NO_EFFECT);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    // A second run on the same input never calls again, nor pays the embedding again.
    const again = wiring();
    await runCaseInvestigationRuntime(mail.caseId, again.deps);
    expect(again.counts).toMatchObject({ embeddings: 0, spendReserve: 0, model: 0 });
  });

  it("the V2 pause read by the search (after the lease): zero embedding, zero model, the case waits paused", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const { deps, counts } = wiring({ pause: ["running", "fully_paused"] });
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "paused", modelCalls: 0 });
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
    expect(await calls(mail.caseId)).toEqual([]);
    expect((await progressOf(mail.caseId)).read).toMatchObject({ state: "found", record: { progress: { waiting: { reason: "paused" } } } });
  });

  it.each([["human", "ticket_owner_human"], ["throws", "ticket_owner_unverified"]] as const)("the ticket goes to %s when the search starts: zero embedding, zero model, nothing kept", async (owner, reason) => {
    const mail = await v1Mail({ ownerEffect: true });
    const { deps, counts } = wiring({ owners: ["v2", "v2", owner] });
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "ticket_owner_stop", reason, modelCalls: 0 });
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0, ownerReads: 3 });
    expect(await calls(mail.caseId)).toEqual([]);
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "agent" });
  });

  it("spend refused (STOP paid or no budget): the embedding key is released, zero embedding, zero model, the case waits deferred_budget", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const { deps, counts } = wiring({ spend: "refused" });
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "deferred_budget", modelCalls: 0 });
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 1, money: 0, model: 0 });
    expect((await calls(mail.caseId)).map(row => [row.purpose, row.state])).toEqual([["knowledge_embedding", "released"]]);
    expect((await progressOf(mail.caseId)).read).toMatchObject({ state: "found", record: { progress: { waiting: { reason: "deferred_budget" } } } });
  });

  it("an embedding past the lease is uncertain in A's ledger and the spend port; the case is verify-only and the next run pays nothing", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const { deps, counts } = wiring({ embed: "hangs", leaseSeconds: 1 });
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "usage_uncertain", modelCalls: 0 });
    expect(counts).toMatchObject({ embeddings: 1, model: 0 });
    expect(counts.spendSettle).toEqual([{ reservationId: "res-1", usage: "unknown", uncertain: true }]);
    expect((await calls(mail.caseId)).map(row => [row.purpose, row.state, row.status, row.uncertain])).toEqual([["knowledge_embedding", "settled", "failed", true]]);
    const again = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, again.deps)).toMatchObject({ status: "usage_uncertain", modelCalls: 0 });
    expect(again.counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
    expect(await calls(mail.caseId)).toHaveLength(1);
  }, 15_000);

  it("no active SAV card: no embedding is paid and no vector search is made", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const { deps, counts } = wiring({ available: false });
    await runCaseInvestigationRuntime(mail.caseId, deps);
    expect(counts).toMatchObject({ embeddings: 0, spendReserve: 0, vectorSearches: 0 });
    expect((await calls(mail.caseId)).map(row => row.purpose)).not.toContain("knowledge_embedding");
  });

  it("a new mail lands on the case during the model call: the decision is not recorded on the old version", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    const { deps, counts } = wiring({ onModel: async () => { await v1Mail({ ticketId: mail.ticketId, threadId: mail.threadId, ownerEffect: true }); } });
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "stale_requeue", modelCalls: 1 });
    expect(counts).toMatchObject({ embeddings: 1, model: 1 });
    expect(await sideEffects(mail.caseId)).toEqual(NO_EFFECT);
  });
});

describe("B5 (night 01/11): a knowledge change after the search is a stored wait, read back by B's reader, through the claim's own observation", () => {
  const stored = async (caseId: string) => {
    const { input, read } = await progressOf(caseId);
    if (read.state !== "found") throw Error(`progress ${read.state}`);
    return { input, progress: read.record.progress, record: read.record };
  };
  it("archived while the model answers: wait knowledge_changed with a closed code, listed without ids; the next run pays no embedding again and keeps its call", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    let revision = "kb-syn-r1";
    const { deps, counts } = wiring({ revision: () => revision, onModel: async () => { revision = "kb-syn-r2"; } });
    const report = await runCaseInvestigationRuntime(mail.caseId, deps);
    expect(report).toMatchObject({ status: "knowledge_requeue", searchedRevision: "kb-syn-r1", currentRevision: "kb-syn-r2", modelCalls: 1 });
    expect(counts).toMatchObject({ embeddings: 1, spendReserve: 1, money: 1, model: 1 });
    const first = await stored(mail.caseId);
    // The wait names the version investigated; the observation that carries it is the next version of the journal.
    expect(first.progress).toMatchObject({ modelCalls: 1, recordedOn: null, waiting: { reason: "knowledge_changed", problem: "revision_moved", caseVersion: (report as { caseVersion: number }).caseVersion } });
    expect(first.progress.proposal).not.toBeNull();
    expect(first.record.decision).toBeNull();
    // What the UI reads: a mapped reason and a closed code, never a revision id, an address or a customer text.
    const listed = listCaseInvestigationWaits([{ caseId: mail.caseId, inputKey: first.input, progress: first.progress }], new Date(Date.now() + 7 * 60_000));
    expect(listed).toEqual([expect.objectContaining({ reason: "knowledge_changed", problem: "revision_moved", needsPerson: false, modelCalls: 1, label: expect.stringMatching(/Connaissances modifiées/) })]);
    expect(JSON.stringify(listed)).not.toMatch(/kb-syn|@|Bonjour/);
    expect(JSON.stringify(first.progress.waiting)).not.toMatch(/kb-syn/);
    expect((await calls(mail.caseId)).map(row => [row.purpose === "knowledge_embedding" ? "embedding" : "model", row.state, row.status])).toEqual(expect.arrayContaining([["embedding", "settled", "ok"], ["model", "settled", "ok"]]));
    expect(await sideEffects(mail.caseId)).toEqual(NO_EFFECT);
    // Next run on the new revision: same queries, so the known vectors are reused; the stored proposal is re-validated, no new call.
    const again = wiring({ revision: () => "kb-syn-r2" });
    expect(await runCaseInvestigationRuntime(mail.caseId, again.deps)).toMatchObject({ status: "recorded", modelCalls: 1 });
    expect(again.counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
    const after = await stored(mail.caseId);
    expect(after.progress).toMatchObject({ modelCalls: 1, waiting: null });
    expect(after.record.decision).toMatchObject({ knowledgeRevision: "kb-syn-r2" });
    expect(await calls(mail.caseId)).toHaveLength(2);
  });

  it("an earlier wait keeps its start: a budget wait, then a knowledge change, shows the first « since »", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    await runCaseInvestigationRuntime(mail.caseId, wiring({ spend: "refused" }).deps);
    const before = await stored(mail.caseId);
    expect(before.progress.waiting).toMatchObject({ reason: "deferred_budget" });
    let revision = "kb-syn-r1";
    await runCaseInvestigationRuntime(mail.caseId, wiring({ revision: () => revision, onModel: async () => { revision = "kb-syn-r2"; } }).deps);
    const after = await stored(mail.caseId);
    expect(after.progress.waiting).toMatchObject({ reason: "knowledge_changed", since: before.progress.waiting!.since });
  });

  it("a revision that cannot be read at the last check is not « unchanged »: wait knowledge_changed / revision_unreadable, nothing recorded", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    let broken = false;
    const { deps } = wiring({ revision: () => { if (broken) throw Error("KB_UNREADABLE"); return "kb-syn-r1"; }, onModel: async () => { broken = true; } });
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "knowledge_requeue", currentRevision: null, modelCalls: 1 });
    expect((await stored(mail.caseId)).progress).toMatchObject({ recordedOn: null, waiting: { reason: "knowledge_changed", problem: "revision_unreadable" } });
  });

  it("while it waits: a person on the ticket, a claim held elsewhere or a full pause write nothing over the wait; a new mail opens its own input", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    let revision = "kb-syn-r1";
    await runCaseInvestigationRuntime(mail.caseId, wiring({ revision: () => revision, onModel: async () => { revision = "kb-syn-r2"; } }).deps);
    const waiting = await stored(mail.caseId), version = (await readCase(mail.caseId))!.version;
    const human = wiring({ revision: () => "kb-syn-r2", owners: ["human"] });
    expect(await runCaseInvestigationRuntime(mail.caseId, human.deps)).toMatchObject({ status: "skipped", reason: "ticket_owner_human", modelCalls: 0 });
    const paused = wiring({ revision: () => "kb-syn-r2", pause: ["fully_paused"] });
    expect(await runCaseInvestigationRuntime(mail.caseId, paused.deps)).toMatchObject({ status: "paused", modelCalls: 0 });
    const held = await claimCaseForDecision({ caseId: mail.caseId, expectedVersion: version, holder: "another-run", currentPolicyRevision: "policy-r1", ttlSeconds: 300, now: new Date(Date.now() + 6 * 60_000) });
    expect(held).toMatchObject({ claimed: true });
    const busy = wiring({ revision: () => "kb-syn-r2" });
    expect(await runCaseInvestigationRuntime(mail.caseId, busy.deps)).toMatchObject({ status: "claim_refused", reason: "busy", modelCalls: 0 });
    for (const run of [human, paused, busy]) expect(run.counts).toMatchObject({ embeddings: 0, spendReserve: 0, money: 0, model: 0 });
    expect(await stored(mail.caseId)).toEqual(waiting);
    expect(await readCase(mail.caseId)).toMatchObject({ version, owner: "agent" });
    expect(await calls(mail.caseId)).toHaveLength(2);
  });

  it("a decision already recorded is never overwritten by a later knowledge change", async () => {
    const mail = await v1Mail({ ownerEffect: true });
    expect(await runCaseInvestigationRuntime(mail.caseId, wiring().deps)).toMatchObject({ status: "recorded" });
    const recorded = await stored(mail.caseId);
    const later = wiring({ revision: () => "kb-syn-r9" });
    expect(await runCaseInvestigationRuntime(mail.caseId, later.deps)).toMatchObject({ status: "already_recorded" });
    expect(later.counts).toMatchObject({ embeddings: 0, model: 0 });
    expect(await stored(mail.caseId)).toEqual(recorded);
  });
});

describe("B7 (night 01/11): pole A6's typed qualification refusal, through A6's real qualify port and A6's guard and serializer, in the composition", () => {
  const RECORD = { policy: POLICY, validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2030-01-01T00:00:00.000Z" };
  /** A6's real `caseInvestigationQualify` on A's real V1 reader, counted; `patch` swaps one source for a SYN double. */
  function aQualify(patch: Partial<AdmissionInvestigationDeps> = {}) {
    let runs = 0;
    const qualify = caseInvestigationQualify({ readConfirmedContext: readConfirmedV1Context, adapterPolicy: async () => null, readPolicyRecord: async () => RECORD, now: () => new Date(), ...patch });
    return { qualify: async (snapshot: CaseSnapshot, events: Parameters<typeof qualify>[1]) => { runs++; return qualify(snapshot, events); }, runs: () => runs };
  }
  /** A qualify that throws `error` (a forged or raw one), counted. */
  const throwing = (make: (snapshot: CaseSnapshot, inputKey: string) => unknown) => {
    let runs = 0;
    return { qualify: async (snapshot: CaseSnapshot, events: Parameters<CaseInvestigationRuntimeDeps["qualify"] & object>[1]) => { runs++; throw make(snapshot, latestInvestigationInput(events)!); }, runs: () => runs };
  };
  /** A case decided once, then a second V1 mail relayed (exclusions only): its admission is stale, so the next run re-qualifies. */
  async function staleCase() {
    const first = await v1Mail({ ownerEffect: true });
    expect(await runCaseInvestigationRuntime(first.caseId, wiring().deps)).toMatchObject({ status: "recorded" });
    const second = await v1Mail({ ticketId: first.ticketId, threadId: first.threadId, ownerEffect: true });
    expect(second.caseId).toBe(first.caseId);
    return first;
  }
  /** Everything a refusal must leave as it was: the case row (version, claim, admission, owner), the journal, the call ledger. */
  async function frozen(caseId: string) {
    return { row: await f.db.select().from(savCases).where(eq(savCases.id, caseId)), events: (await listCaseEvents(caseId)).map(event => event.id), calls: await calls(caseId) };
  }
  const generic = (caseId: string, snapshot: CaseSnapshot, inputKey: string) =>
    ({ status: "qualification_unavailable", caseId, caseVersion: snapshot.version, admissionInputVersion: snapshot.admissionInputVersion, inputKey, persisted: false, modelCalls: 0, qualification: null });
  const NOTHING = { embeddings: 0, spendReserve: 0, money: 0, model: 0, vectorSearches: 0 };

  it("T1 V1 reader down (SYN_READER_DOWN): v1_context_unavailable / technical, no raw cause; nothing claimed, written, searched or called; replayed identically (T9)", async () => {
    const mail = await staleCase(), before = await frozen(mail.caseId), snapshot = (await readCase(mail.caseId))!, input = latestInvestigationInput(await listCaseEvents(mail.caseId))!;
    const a = aQualify({ readConfirmedContext: async () => { throw Error("SYN_READER_DOWN client-syn@example.invalid"); } });
    const { deps, counts } = wiring();
    const report = await runCaseInvestigationRuntime(mail.caseId, { ...deps, qualify: a.qualify });
    expect(report).toEqual({ ...generic(mail.caseId, snapshot, input),
      qualification: { code: "v1_context_unavailable", nature: "technical", inputKey: input, inputVersion: snapshot.admissionInputVersion, causeCode: null } });
    expect(JSON.stringify(report)).not.toMatch(/SYN_READER_DOWN|@/);
    expect(a.runs()).toBe(1);
    expect(counts).toMatchObject(NOTHING);
    expect(await frozen(mail.caseId)).toEqual(before);
    const again = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, { ...again.deps, qualify: a.qualify })).toEqual(report);
    expect(await frozen(mail.caseId)).toEqual(before);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("T1b a V1 reader refusal with an exact SAV_V1_CONTEXT code: carried as causeCode, nothing else", async () => {
    const mail = await staleCase();
    const a = aQualify({ readConfirmedContext: async () => { throw Error("SAV_V1_CONTEXT_RUN_MISSING"); } });
    expect(await runCaseInvestigationRuntime(mail.caseId, { ...wiring().deps, qualify: a.qualify }))
      .toMatchObject({ status: "qualification_unavailable", qualification: { code: "v1_context_unavailable", nature: "technical", causeCode: "SAV_V1_CONTEXT_RUN_MISSING" } });
  });

  it("T2 an acknowledgement relayed on the case thread: acknowledgement_input / contract_blocked, refused by A6's precheck before any V1 read", async () => {
    const first = await v1Mail({ ownerEffect: true });
    expect(await runCaseInvestigationRuntime(first.caseId, wiring().deps)).toMatchObject({ status: "recorded" });
    const messageId = randomUUID(), gmail = `gm-ack-${messageId}`;
    await openCaseEvent({ ticketId: first.ticketId, threadId: first.threadId, opens: [], admissionMode: "exclusions_only",
      admission: { policy: POLICY, qualification: { requests: [], identity: { status: "unknown" }, crmContext: "unknown", teamSignals: [] } },
      kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: new Date().toISOString(),
      detail: { messageId, relay: { kind: "acknowledgement_on_case_thread", messageId, intakeRunId: randomUUID(), intakeRunVersion: 1, sourceHash: "syn-ack-hash" } } });
    const before = await frozen(first.caseId);
    let reads = 0;
    const a = aQualify({ readConfirmedContext: async id => { reads++; return readConfirmedV1Context(id); } });
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(first.caseId, { ...deps, qualify: a.qualify }))
      .toMatchObject({ status: "qualification_unavailable", persisted: false, qualification: { code: "acknowledgement_input", nature: "contract_blocked", causeCode: null } });
    expect(reads).toBe(0);
    expect(counts).toMatchObject(NOTHING);
    expect(await frozen(first.caseId)).toEqual(before);
  });

  it("T3 the approved-rule port throws on a current V1 ticket decision: rule_unavailable / technical, its raw text never carried", async () => {
    const mail = await staleCase(), before = await frozen(mail.caseId);
    // A's real reader refuses this fixture's stored decision (SAV_V1_CONTEXT_DECISION_MESSAGE_MISMATCH, see T1c): a SYN
    // double of A's ConfirmedV1Context, built from the relay's own proof, stands for a current V1 ticket decision.
    const inbound = (await listCaseEvents(mail.caseId)).filter(event => event.kind === "inbound_confirmed").at(-1)!;
    const relay = inbound.detail!.relay as { executionId: string; intakeRunId: string; intakeRunVersion: number }, messageId = inbound.detail!.messageId as string;
    const current = async () => ({
      decision: { revision: SAV_INTAKE_CONTRACT_REVISION, messageId, classification: "support", requests: [{ id: "r0", kind: "support" }],
        disposition: { kind: "ticket", search: "complete", history: "complete", contactScope: { complete: true, contacts: [], primaryContactId: null }, identity: { kind: "unknown" } } },
      source: { messageId, gmailMessageId: inbound.sourceRef.id, executionId: relay.executionId, executionState: "confirmed", runId: relay.intakeRunId, runVersion: relay.intakeRunVersion, ticketId: mail.ticketId },
      freshness: { latestRunVersion: relay.intakeRunVersion, humanRefused: false },
    }) as never;
    const a = aQualify({ readConfirmedContext: current, adapterPolicy: async () => ({ revision: "syn-d-a", decidedBy: "syn-fixture", identity: "none" }),
      approvedRules: async () => { throw Error("SYN_RULES_DOWN client-syn@example.invalid"); } });
    const { deps, counts } = wiring();
    const report = await runCaseInvestigationRuntime(mail.caseId, { ...deps, qualify: a.qualify });
    expect(report).toMatchObject({ status: "qualification_unavailable", qualification: { code: "rule_unavailable", nature: "technical", causeCode: null } });
    expect(JSON.stringify(report)).not.toMatch(/SYN_RULES_DOWN|@/);
    expect(counts).toMatchObject(NOTHING);
    expect(await frozen(mail.caseId)).toEqual(before);
  });

  it.each([
    ["a raw error with a customer-like text", () => Error("SYN raw failure client-syn@example.invalid")],
    ["a raw error whose message is a known SAV code", () => Error("SAV_V1_CONTEXT_RUN_MISSING")],
    ["a plain object with A6's fields and message", (_s: CaseSnapshot, key: string) => ({ name: "CaseQualificationUnavailableError", code: "v1_context_unavailable", nature: "technical", inputKey: key, inputVersion: _s.admissionInputVersion, causeCode: null, message: "SAV_CASE_QUALIFICATION_UNAVAILABLE:v1_context_unavailable" })],
    ["an object made from A6's prototype", (s: CaseSnapshot, key: string) => Object.assign(Object.create(CaseQualificationUnavailableError.prototype), { code: "v1_context_unavailable", nature: "technical", inputKey: key, inputVersion: s.admissionInputVersion, causeCode: null })],
    ["a genuine A6 error changed afterwards", (s: CaseSnapshot, key: string) => Object.defineProperty(new CaseQualificationUnavailableError({ code: "v1_context_unavailable", inputKey: key, inputVersion: s.admissionInputVersion }), "code", { value: "rule_invalid" })],
  ])("T4 %s: the generic gap only, no field taken from it, nothing written", async (_name, make) => {
    const mail = await staleCase(), before = await frozen(mail.caseId), snapshot = (await readCase(mail.caseId))!, input = latestInvestigationInput(await listCaseEvents(mail.caseId))!;
    const q = throwing(make);
    const { deps, counts } = wiring();
    const report = await runCaseInvestigationRuntime(mail.caseId, { ...deps, qualify: q.qualify });
    expect(report).toEqual(generic(mail.caseId, snapshot, input));
    expect(JSON.stringify(report)).not.toMatch(/@|SYN raw|SAV_V1_CONTEXT/);
    expect(counts).toMatchObject(NOTHING);
    expect(await frozen(mail.caseId)).toEqual(before);
  });

  it.each([
    ["another input key", (s: CaseSnapshot) => new CaseQualificationUnavailableError({ code: "v1_context_unavailable", inputKey: "in:20000000-0000-4000-8000-0000000000ff", inputVersion: s.admissionInputVersion })],
    ["another input version", (s: CaseSnapshot, key: string) => new CaseQualificationUnavailableError({ code: "v1_context_unavailable", inputKey: key, inputVersion: s.admissionInputVersion + 1 })],
  ])("T5 a genuine A6 refusal about %s: generic (never two inputs mixed), nothing written", async (_name, make) => {
    const mail = await staleCase(), before = await frozen(mail.caseId), snapshot = (await readCase(mail.caseId))!, input = latestInvestigationInput(await listCaseEvents(mail.caseId))!;
    expect(await runCaseInvestigationRuntime(mail.caseId, { ...wiring().deps, qualify: throwing(make).qualify })).toEqual(generic(mail.caseId, snapshot, input));
    expect(await frozen(mail.caseId)).toEqual(before);
  });

  it.each([
    ["a person owns the ticket", { owners: ["human" as const] }, { status: "skipped", reason: "ticket_owner_human" }],
    ["the owner is unknown", { owners: ["unknown" as const] }, { status: "skipped", reason: "ticket_owner_unverified" }],
    ["V2 is fully paused", { pause: ["fully_paused" as const] }, { status: "paused" }],
    ["only actions are paused (no admission write then)", { pause: ["actions_paused" as const] }, { status: "skipped", reason: "admission_stale" }],
  ])("T6 %s: A6's qualify is never run, nothing called", async (_name, knobs, expected) => {
    const mail = await staleCase(), before = await frozen(mail.caseId);
    const a = aQualify({ readConfirmedContext: async () => { throw Error("MUST_NOT_RUN"); } });
    const { deps, counts } = wiring(knobs);
    expect(await runCaseInvestigationRuntime(mail.caseId, { ...deps, qualify: a.qualify })).toMatchObject({ ...expected, modelCalls: 0 });
    expect(a.runs()).toBe(0);
    expect(counts).toMatchObject(NOTHING);
    expect(await frozen(mail.caseId)).toEqual(before);
  });

  it("T7 A6 answers null (no V1 execution behind the relay): the business handoff to the team, never a technical gap", async () => {
    const mail = await staleCase();
    const a = aQualify({ readConfirmedContext: async () => null });
    const { deps, counts } = wiring();
    const report = await runCaseInvestigationRuntime(mail.caseId, { ...deps, qualify: a.qualify });
    expect(report.status).not.toBe("qualification_unavailable");
    expect(a.runs()).toBe(1);
    expect(await readCase(mail.caseId)).toMatchObject({ owner: "human" });
    expect(counts).toMatchObject(NOTHING);
  });

  it("T8 an unreadable journal at the re-evaluation read: the error stays visible, A6's qualify never runs, no typed or generic gap", async () => {
    const mail = await staleCase(), before = await frozen(mail.caseId);
    const a = aQualify();
    const { deps, counts } = wiring();
    // Between the runner's read and the re-evaluation's own journal read (only the owner is read in between), the next journal read fails.
    const report = runCaseInvestigationRuntime(mail.caseId, { ...deps, qualify: a.qualify, readTicketOwner: async () => { journal.failNext = true; return "v2"; } });
    await expect(report).rejects.toThrow("SAV_CASE_JOURNAL_UNREADABLE_SYN");
    expect(a.runs()).toBe(0);
    expect(counts).toMatchObject(NOTHING);
    expect(await frozen(mail.caseId)).toEqual(before);
  });

  it("T1c A's real V1 reader on this fixture: its own exact refusal code, typed by A6, carried as causeCode", async () => {
    const mail = await staleCase(), before = await frozen(mail.caseId);
    expect(await runCaseInvestigationRuntime(mail.caseId, { ...wiring().deps, qualify: aQualify().qualify }))
      .toMatchObject({ status: "qualification_unavailable", qualification: { code: "v1_context_unavailable", nature: "technical", causeCode: "SAV_V1_CONTEXT_DECISION_MESSAGE_MISMATCH" } });
    expect(await frozen(mail.caseId)).toEqual(before);
  });

  it("T8b B never reads the message of an error A6 did not issue", async () => {
    const mail = await staleCase();
    let reads = 0;
    const error = Error("placeholder");
    Object.defineProperty(error, "message", { get: () => { reads++; return "SYN secret client-syn@example.invalid"; } });
    expect(await runCaseInvestigationRuntime(mail.caseId, { ...wiring().deps, qualify: throwing(() => error).qualify })).toMatchObject({ status: "qualification_unavailable", persisted: false });
    expect(reads).toBe(0);
  });
});

/*
 * B (4/11, contract A-B / B-C-UX, LOCAL): a customer return V2 consumed before V1 is qualified again on its own words before anything answers
 * it, and the passage from a recorded decision to the send plan goes through C's normal store. Entry: the canonical runtime; doubles only
 * at the boundaries (CRM owner, rules, model, index). No execution is created in this base: C does not store an `automated` text yet.
 */
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

describe("customer return before V1: requalified on its own words, never on the copied admission", () => {
  it("the admission copied by the return (access before) does not let the agent answer: no rule, the team takes it, no model call", async () => {
    const mail = await answered();
    const back = await customerReturn(mail, "Toujours bloqué, et je veux aussi un remboursement.", true);
    // A policy alone proves nothing about this mail: `readmitted` needs `input.admission`, so the return stays stale until it is requalified, and with no return rule it never is.
    expect(back.record.admission).toBe("stale_requalification_required");
    const { deps, counts } = returnWiring();
    const report = await runCaseInvestigationRuntime(mail.caseId, deps);
    expect(report).toMatchObject({ status: "skipped", reason: "not_agent_owned", detail: "human", modelCalls: 0 });
    // Read back from the case, not from the report: the case is the team's, nothing was spent, nothing left.
    const after = (await readCase(mail.caseId))!;
    expect(after.owner).toBe("human");
    expect(after.phase).toBe("handoff_pending");
    expect(after.body.handoff).toMatchObject({ reason: "qualification_unproven" });
    expect(counts).toMatchObject({ embeddings: 0, vectorSearches: 0, spendReserve: 0, spendSettle: [], money: 0, model: 0 });
    expect(await sideEffects(mail.caseId)).toEqual(NO_EFFECT);
    expect((await listCaseEvents(mail.caseId)).map(event => event.kind).slice(-3)).toEqual(["inbound_confirmed", "admission_decided", "owner_changed"]);
  });
  it("the V1-only qualification cannot stand for the return either: the copied admission stays unusable, nothing is answered", async () => {
    const mail = await answered();
    await customerReturn(mail, "Toujours pas de code.", true);
    const { deps, counts } = wiring();
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "skipped", reason: "admission_not_current_input", modelCalls: 0 });
    expect(counts.model).toBe(0);
  });
  it("a simple access return requalified by an approved return rule continues to a recorded decision on the new mail", async () => {
    const mail = await answered();
    const back = await customerReturn(mail, "Je ne reçois toujours pas le code.", false);
    const { deps, counts } = returnWiring(rule("access"));
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "recorded", outcome: "accepted" });
    expect(counts.model).toBe(1);
    const progress = await progressOf(mail.caseId);
    expect(progress.read.state).toBe("found");
    const admission = (await readCase(mail.caseId))!.admission!;
    expect(admission.qualification.requests.every(row => row.provenance.kind === "qualified_rule" && Date.parse(row.provenance.at) >= Date.parse(admission.decidedAt) - 5_000)).toBe(true);
    expect((await listCaseEvents(mail.caseId)).some(event => event.sourceRef.type === "email" && event.sourceRef.id === back.gmail)).toBe(true);
  });
  it("a sensitive return (the rule reads finance) stops: withdrawn to the team, no model call, no proposal", async () => {
    const mail = await answered();
    await customerReturn(mail, "Je veux être remboursé.", false);
    const { deps, counts } = returnWiring(rule("finance"));
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "skipped", modelCalls: 0 });
    expect(counts.model).toBe(0);
    const after = (await readCase(mail.caseId))!;
    expect(after.owner).not.toBe("agent");
    expect((await sideEffects(mail.caseId)).validations).toBe(0);
  });
  it("a return rule that fails is a technical gap: nothing written, nothing answered, retried later", async () => {
    const mail = await answered();
    await customerReturn(mail, "Toujours rien.", false);
    const before = (await readCase(mail.caseId))!;
    const { deps, counts } = returnWiring(async () => { throw Error("RULE_DOWN_SYN"); });
    expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "qualification_unavailable", persisted: false, qualification: { code: "rule_unavailable" } });
    expect(counts.model).toBe(0);
    expect((await readCase(mail.caseId))!.version).toBe(before.version);
  });
  it("a rule result dated before the mail, or on a request the case does not have, is refused (never the old reading)", async () => {
    for (const bad of [
      (async ({ requests }) => requests.map(row => ({ requestId: row.requestId, family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: AT } }))) as CaseReturnRulePort,
      (async () => [{ requestId: "gm-other/r9", family: "access" as const, provenance: { kind: "qualified_rule" as const, ruleId: "rule-access", revision: "r1", at: later() } }]) as CaseReturnRulePort,
    ]) {
      const mail = await answered();
      await customerReturn(mail, "Toujours rien.", false);
      expect(await runCaseInvestigationRuntime(mail.caseId, returnWiring(bad).deps)).toMatchObject({ status: "qualification_unavailable", qualification: { code: "rule_invalid" } });
    }
  });
  it("the real content rule reads the return's own words: a plain continuation stays access, a sensitive or mixed one stops", async () => {
    const content = caseReturnContentRule({ ruleId: "rule-access", revision: "r1" }, () => new Date(Date.now() + 1_000));
    const simple = await answered();
    await customerReturn(simple, "Bonjour,\nJe ne reçois toujours pas le code.\n\nLe 3 nov. 2026, Support a écrit :\n> Voici le lien et un mot sur le remboursement.", true);
    expect(await runCaseInvestigationRuntime(simple.caseId, returnWiring(content).deps)).toMatchObject({ status: "recorded", outcome: "accepted" });
    for (const text of ["Toujours pas de code, et je veux être remboursé de ce mois.", "Je souhaite résilier mon abonnement.", "Merci, au revoir."]) {
      const mail = await answered();
      await customerReturn(mail, text, true);
      const { deps, counts } = returnWiring(content);
      expect(await runCaseInvestigationRuntime(mail.caseId, deps)).toMatchObject({ status: "skipped", modelCalls: 0 });
      expect(counts.model).toBe(0);
      expect((await readCase(mail.caseId))!.owner).not.toBe("agent");
    }
  });
});
