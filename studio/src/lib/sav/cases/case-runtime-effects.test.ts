import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { savCaseEffectExecutions, savCaseReplyValidations, savIntakeEffects, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "../intake/execution-policy";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { executeIntakePass } from "../intake/executor";
import { getExecutionEffects } from "../intake/execution-store";
import type { ExecutionOptions, ExecutorAdapters } from "../intake/execution-types";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { createCaseEffectDriver } from "./case-effect-driver";
import { pendingCaseEffectRecoveries } from "./case-effect-recovery";
import { recordConfirmedCaseReply } from "./case-effect-outcomes";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { caseReplyFinalTextProblem, readCaseReplyDisclosure } from "./case-reply-outbound";
import type { CaseDecisionDraft } from "./investigation-intent";
import { decideCaseReply, type CaseEffectNote } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import {
  describeCaseReplyForReview, listCaseEffectsNeedingPerson, proposeCaseReplyFromDraft, queueValidatedCaseReply, resolveCaseReplyLanguage, runCaseEffectsPass,
  type CaseReplyDraftInput,
} from "./case-runtime-effects";
import { nextJ2Slot } from "./j2-calendar";
import * as timerStore from "./timer-store";
import * as caseStore from "./case-store";

// SAV-10 (pole C), C-NIGHT-REPLY-RECOVERY-RACCORD: the injectable entrypoints on the REAL executor, ledger, validation store and case store, with the synthetic provider
// (no socket: `fetch` is replaced by an error and its calls are counted). Nothing here reaches a provider, a model, Gmail, HubSpot or the network.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, policyHash: string, environment: Record<string, string | undefined>, options: ExecutionOptions;
let p: ReturnType<typeof executionProvider>, sends = 0, loseAck = false, ticketSeq = 9_600_000;
let counts: Record<string, number> = {};
const POLICY = "policy-r1";
const staff = { type: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000003" };
const AT = "2026-10-27T09:00:00.000Z";
const ADMITTED = {
  policy: { revision: POLICY, admittedFamilies: ["access", "usage"], qualifiedRules: [{ ruleId: "rule-access", revision: "r1", families: ["access"] }], approvedBy: staff.staffUserId, approvedAt: AT },
  qualification: { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: staff.staffUserId, at: AT } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] },
};
const driver = () => createCaseEffectDriver({ env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY });
const setPause = async (agent: "intake" | "v2", level: "actions_paused" | "fully_paused" | null) => {
  await f.db.delete(savSyncState).where(eq(savSyncState.key, `sav-agent-pause.v1:${agent}`));
  if (level) await f.db.insert(savSyncState).values({ key: `sav-agent-pause.v1:${agent}`, status: "installed",
    cursor: encryptSavPayload({ revision: "sav-agent-pause.v1", agent, level, setBy: "fixture@example.invalid", setAt: AT, reason: "release fictive" }) });
};

/** A stored customer mail in a stored thread, an admitted case on it, and the synthetic provider that knows it. The reply text is B's DRAFT: no mention yet. */
async function scenario(purpose: "question" | "answer" = "question") {
  const gmailThreadId = `gmail-thread-${randomUUID()}`, gmailMessageId = `gm-${randomUUID()}`, ticketId = String(++ticketSeq);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({
    threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "Customer@Example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic connection failure",
    bodyCiphertext: encryptSavPayload({ text: "The synthetic connection fails.", headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z"),
  }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  p = executionProvider(); p.setGmail(gmailMessageId, gmailThreadId); p.seedTicket({ id: ticketId });
  sends = 0; loseAck = false; counts = {};
  const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    if (path === "messages/send") sends += 1;
    const result = await p.gmail<T>(mailbox, path, init);
    if (path === "messages/send" && loseAck) throw Error("SAV_TEST_ACK_LOST");
    return result;
  };
  const real = createIntakeExecutorAdapters({ network: p.network, gmailRequest: gmail, gmailPermissions: async () => { }, env: () => environment });
  // Every adapter call is counted: "fully paused, zero provider" is a number, not a claim.
  options = { ...options, adapters: Object.fromEntries(Object.entries(real).map(([name, fn]) =>
    [name, (...args: unknown[]) => { counts[name] = (counts[name] ?? 0) + 1; return (fn as (...a: unknown[]) => unknown)(...args); }])) as unknown as ExecutorAdapters };
  const version = (await readCase(opened.caseId))!.version;
  const draft: CaseReplyDraftInput = {
    caseId: opened.caseId, triggerEventId: `inbound:${gmailMessageId}`, decidedOn: version, language: { code: "en", proven: true },
    reply: purpose === "question"
      ? { purpose: "question", text: "SYNTHETIC reply.\nSignature kept exactly.", question: { id: `in:${gmailMessageId}:q1`, text: "SYNTHETIC question?", factKeys: [] } }
      : { purpose: "answer", text: "SYNTHETIC reply.\nSignature kept exactly." },
  };
  return { caseId: opened.caseId, thread, message, ticketId, gmailMessageId, gmailThreadId, version, draft };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const APPROVER = "20000000-0000-4000-8000-000000000003";
/** The test's own authorizer: the stand-in for the real one that does not exist yet. The code under test never builds one. */
const allow: CaseReplyAuthorizer = () => ({ allowed: true, basis: "fixture.allow" });
const storeDeps = () => ({ env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY });
const policyArg = () => ({ id: policyId, hash: policyHash });

async function propose(s: Scenario, overrides: Partial<CaseReplyDraftInput> = {}) {
  const result = await proposeCaseReplyFromDraft({ ...s.draft, ...overrides }, storeDeps());
  if (!result.ok) throw Error(`PROPOSE_REFUSED:${result.code}`);
  return result;
}
const storedProposal = async (validationId: string) => decryptSavPayload<CaseReplyProposal>((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId)))[0]!.proposalCiphertext);
const seenOf = (proposal: CaseReplyProposal) => ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient });
async function approve(validationId: string) {
  const proposal = await storedProposal(validationId);
  const decided = await decideCaseReply({ action: "approve", validationId, approverId: APPROVER, seen: seenOf(proposal), authorizer: allow, deps: storeDeps() });
  if (!decided.ok) throw Error(`APPROVE_REFUSED:${decided.code}`);
}
/** proposal -> a person's decision -> queue, all through the entrypoints. */
async function admit(s: Scenario) {
  const proposed = await propose(s);
  await approve(proposed.validationId);
  const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), deps: storeDeps() });
  if (!queued.ok) throw Error(`QUEUE_REFUSED:${queued.code}`);
  return { id: queued.executionId, validationId: proposed.validationId };
}
const pass = (overrides: Partial<Parameters<typeof runCaseEffectsPass>[0]> = {}) => runCaseEffectsPass({
  env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY, adapters: options.adapters, deadlineMs: Date.now() + 60_000,
  context: { runtime: options.runtime, policy: options.policy }, ...overrides,
});
const run = (id: string, d = driver(), opts: ExecutionOptions = options) => executeIntakePass(id, opts, {}, d);
const execution = async (id: string) => (await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, id)))[0]!;
const effectsOf = (id: string) => getExecutionEffects(id);
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
const outbound = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed");
const providerCalls = () => Object.values(counts).reduce((a, b) => a + b, 0);
const takeover = (caseId: string) => readCase(caseId).then(snapshot => transitionCaseOwner({ caseId, expectedVersion: snapshot!.version, transition: "human_takeover", actor: staff, commandKey: `cmd-${randomUUID()}`, reason: "fixture" }));
const newCustomerMail = (s: Scenario) =>
  openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`runtime-${randomUUID()}`), sourceRef: { type: "email", id: "runtime" }, occurredAt: "2026-10-28T07:45:00.000Z" });
const expireLease = (id: string) => f.client.exec(`UPDATE sav.case_effect_executions SET lease_until = now() - interval '1 second' WHERE id = '${id}'`);
/** The ledger says confirmed, the case recorded nothing: a pass that died between the confirmation and its finish. */
async function crashBeforeFinish(s: Scenario) {
  const { id } = await admit(s);
  const crashing = { ...driver(), finish: async () => { throw Error("SAV_TEST_CRASH_AFTER_CONFIRMED"); } };
  expect(await run(id, crashing)).toMatchObject({ state: "waiting" });
  expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
  expect(await outbound(s.caseId)).toEqual([]);
  expect(await listCaseTimers(s.caseId)).toEqual([]);
  return id;
}
async function lostAck(s: Scenario) {
  const { id } = await admit(s);
  loseAck = true; expect(await run(id)).toMatchObject({ state: "uncertain" }); loseAck = false;
  expect(sends).toBe(1);
  return id;
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  vi.spyOn(console, "info").mockImplementation(() => { });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
  if (!policyId) {
    const [admin] = await f.db.insert(staffUsers).values({ clerkId: "synthetic-admin", email: "contact@limova.ai", name: "Synthetic Admin", role: "admin", active: true }).returning();
    state.user = { id: admin!.clerkId, primaryEmailAddress: { emailAddress: admin!.email, verification: { status: "verified" } } };
    mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
    const policy: ExecutionPolicy = {
      revision: "sav-intake-execution-2026-10-21.v1", mailboxId, codeRevision: "a".repeat(40), enginePolicyHash: "b".repeat(64), resourcesHash: "c".repeat(64),
      createdAfter: new Date(Date.now() - 10_000).toISOString(), receivedAfter: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      maxDossiers: 10, mutations: ["send_case_reply", "append_case_note"], admission: { kind: "automatic" },
    };
    const grant = await approveIntakeExecutionPolicy(policy);
    policyId = grant.id; policyHash = grant.policyHash;
    options = { runtime: {} as never, policy, config: { policyId, policyHash, codeRevision: "a".repeat(40) }, env: () => environment, signal: AbortSignal.timeout(60_000), adapters: undefined as never };
  }
  environment = { SAV_CASE_EFFECTS: "supervised", SAV_INTAKE_EXECUTION_MODE: "execute", SAV_INTAKE_EXECUTION_POLICY_ID: policyId, SAV_INTAKE_EXECUTION_POLICY_SHA256: policyHash, SAV_CODE_REVISION: "a".repeat(40), HUBSPOT_ACCESS_TOKEN: "fake" };
  expect(intakeExecutionConfig(environment)).not.toBeNull();
  // Each test starts from an empty queue: what earlier tests left open is closed (a refused execution is never listed nor claimed).
  await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused' WHERE state NOT IN ('confirmed','refused')");
});
afterEach(async () => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled(); // transport réseau = 0
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setPause("v2", null); await setPause("intake", null);
});

describe("draft -> final text -> durable validation -> one executor -> confirmation and follow-up", () => {
  it("the AI mention is in the text BEFORE the hash; the default authorizer refuses; nothing is queued without a real decision; then ONE pass sends once and records the mail, the question and ONE J2", async () => {
    const s = await scenario("question");
    const proposed = await propose(s);
    expect(proposed).toMatchObject({ ok: true, created: true, state: "proposed", recipient: "customer@example.invalid", language: { language: "en", proof: "proven" } });
    const stored = await storedProposal(proposed.validationId);
    expect(caseReplyFinalTextProblem(stored.text)).toBeNull();
    expect(readCaseReplyDisclosure(stored.text)).toMatchObject({ mode: "manual_reviewed", language: "en" });
    expect(stored.text.startsWith("SYNTHETIC reply.\nSignature kept exactly.")).toBe(true);
    expect(proposed.payloadHash).toBe(caseReplyPayloadHash(stored));
    // recipient and subject come from the stored message, not from the draft
    expect(stored).toMatchObject({ recipient: "customer@example.invalid", subject: "Synthetic connection failure", inboundMessageId: s.message.id, caseVersion: s.version });
    // no decision yet: the default (absent) authorizer refuses, and nothing can be queued
    expect(await decideCaseReply({ action: "approve", validationId: proposed.validationId, approverId: APPROVER, seen: seenOf(stored), authorizer: undefined, deps: storeDeps() })).toMatchObject({ ok: false });
    expect(await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), deps: storeDeps() })).toEqual({ ok: false, code: "not_validated", detail: "proposed" });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, s.caseId))).toHaveLength(0);
    expect(await pass()).toMatchObject({ skipped: null, supervised: [] });
    expect(sends).toBe(0);
    // a person's decision, then the queue
    await approve(proposed.validationId);
    const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), deps: storeDeps() });
    expect(queued).toMatchObject({ ok: true, created: true });
    const result = await pass();
    expect(result.supervised).toEqual([{ executionId: (queued as { executionId: string }).executionId, state: "confirmed", reason: null }]);
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
    const timers = await listCaseTimers(s.caseId);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.dueAt).toBe(nextJ2Slot(new Date(timers[0]!.sentAt)).toISOString());
    // a second pass and a third change nothing
    for (let n = 0; n < 2; n++) expect(await pass()).toMatchObject({ skipped: null, supervised: [] });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("a validation written around the store (approved, no decider / date / basis) is never queued; a legacy text without the mention is refused", async () => {
    const s = await scenario("answer");
    const proposal: CaseReplyProposal = { caseId: s.caseId, caseVersion: s.version, triggerEventId: `inbound:${s.gmailMessageId}`, inboundMessageId: s.message.id, purpose: "answer",
      recipient: "customer@example.invalid", subject: "Synthetic connection failure", text: "SYNTHETIC raw text stored before the contract." };
    const [row] = await f.db.insert(savCaseReplyValidations).values({ caseId: s.caseId, replyKey: `reply:${s.caseId}:${proposal.triggerEventId}`, payloadHash: caseReplyPayloadHash(proposal),
      caseVersion: proposal.caseVersion, recipient: proposal.recipient, proposalCiphertext: encryptSavPayload(proposal) }).returning();
    // approved without any decision data
    // the table's own CHECK refuses an approval without decider, date and basis (migration 0051): the queue's evidence test is a second fence, not the only one
    await expect(f.db.update(savCaseReplyValidations).set({ state: "approved" }).where(eq(savCaseReplyValidations.id, row!.id))).rejects.toThrow();
    expect(await queueValidatedCaseReply({ validationId: row!.id, policy: policyArg(), deps: storeDeps() })).toMatchObject({ ok: false, code: "not_validated" });
    // with decision data but an old text: the store's own fence refuses
    await f.db.update(savCaseReplyValidations).set({ state: "approved", decidedBy: APPROVER, decidedAt: new Date(), authorizationBasis: "legacy.fixture" }).where(eq(savCaseReplyValidations.id, row!.id));
    expect(await queueValidatedCaseReply({ validationId: row!.id, policy: policyArg(), deps: storeDeps() })).toEqual({ ok: false, code: "proposal_invalid", detail: "ai_notice_missing" });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, s.caseId))).toHaveLength(0);
    expect(await queueValidatedCaseReply({ validationId: randomUUID(), policy: policyArg(), deps: storeDeps() })).toEqual({ ok: false, code: "unknown" });
    expect(sends).toBe(0);
  });

  it("an intent planned before the contract (no mention, no marker) is cancelled by the pass, never sent", async () => {
    const s = await scenario("answer"), { id } = await admit(s);
    expect(await executeIntakePass(id, options, { beforeMarker: async () => { throw Error("SAV_TEST_STOP_BEFORE_MARKER"); } }, driver())).not.toMatchObject({ state: "confirmed" });
    const [planned] = await effectsOf(id);
    expect(planned!.state).toBe("planned");
    const intent = decryptSavPayload<{ text: string }>(planned!.intentCiphertext);
    await f.db.update(savIntakeEffects).set({ intentCiphertext: encryptSavPayload({ ...intent, text: "SYNTHETIC raw text planned before the contract." }) }).where(eq(savIntakeEffects.id, planned!.id));
    await f.client.exec(`UPDATE sav.case_effect_executions SET lease_until = NULL, state = 'waiting' WHERE id = '${id}'`);
    const result = await pass();
    expect(result.supervised).toEqual([{ executionId: id, state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_AI_NOTICE" }]);
    expect(sends).toBe(0);
    expect(await effectsOf(id)).toMatchObject([{ state: "planned", dispatchedAt: null }]);
  });
});

describe("the language is stated and proven by the caller, never guessed", () => {
  it("fr / en proven keep their language; unknown or unproven falls back to the shared format; any other language needs a person; nothing is stored for a refusal", async () => {
    expect(resolveCaseReplyLanguage({ code: "fr", proven: true })).toEqual({ language: "fr", proof: "proven" });
    expect(resolveCaseReplyLanguage({ code: "en", proven: true })).toEqual({ language: "en", proof: "proven" });
    expect(resolveCaseReplyLanguage({ code: "en", proven: false })).toEqual({ language: "unknown", proof: "fallback" });
    expect(resolveCaseReplyLanguage({ code: "unknown", proven: true })).toEqual({ language: "unknown", proof: "fallback" });
    expect(resolveCaseReplyLanguage(null)).toEqual({ language: "unknown", proof: "fallback" });
    for (const code of ["es", "de", "mixed", "unsupported", ""]) expect(resolveCaseReplyLanguage({ code, proven: true })).toBeNull();
    const s = await scenario("answer");
    const fallback = await propose(s, { language: { code: "en", proven: false } });
    expect(fallback.language).toEqual({ language: "unknown", proof: "fallback" });
    expect(readCaseReplyDisclosure((await storedProposal(fallback.validationId)).text)).toMatchObject({ language: "fr" }); // the existing fallback, not a detection
    const before = (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, s.caseId))).length;
    expect(await proposeCaseReplyFromDraft({ ...s.draft, language: { code: "es", proven: true } }, storeDeps())).toEqual({ ok: false, code: "language_human_required", detail: "es" });
    expect((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, s.caseId))).length).toBe(before);
  });

  it("the draft is completed from the STORED thread only: no reply, no stored mail, a mail of another case, a non-inbound trigger, or a mail whose sender is unreadable are all refused", async () => {
    const s = await scenario("answer"), other = await scenario("answer");
    expect(await proposeCaseReplyFromDraft({ ...s.draft, reply: null }, storeDeps())).toEqual({ ok: false, code: "no_reply" });
    expect(await proposeCaseReplyFromDraft({ ...s.draft, triggerEventId: null }, storeDeps())).toEqual({ ok: false, code: "inbound_unknown" });
    expect(await proposeCaseReplyFromDraft({ ...s.draft, triggerEventId: `back:${randomUUID()}` }, storeDeps())).toEqual({ ok: false, code: "trigger_not_inbound" });
    expect(await proposeCaseReplyFromDraft({ ...s.draft, triggerEventId: `inbound:${other.gmailMessageId}` }, storeDeps())).toEqual({ ok: false, code: "inbound_not_in_case" });
    expect(await proposeCaseReplyFromDraft({ ...s.draft, triggerEventId: "inbound:gm-does-not-exist" }, storeDeps())).toEqual({ ok: false, code: "inbound_not_in_case" });
    expect(await proposeCaseReplyFromDraft({ ...s.draft, caseId: randomUUID() }, storeDeps())).toEqual({ ok: false, code: "case_unknown" });
    expect(await proposeCaseReplyFromDraft(s.draft, { env: () => ({}), readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY })).toMatchObject({ ok: false, code: "effects_off" });
  });
});

describe("the answered mail is the case's own", () => {
  it("the same Gmail id stored in another mailbox's thread is never taken for the case's mail: recipient, message and subject are the case's", async () => {
    const s = await scenario("answer");
    const [otherMailbox] = await f.db.insert(savMailboxes).values({ email: `other-${randomUUID()}@example.invalid` }).returning();
    const [otherThread] = await f.db.insert(savThreads).values({ mailboxId: otherMailbox!.id, gmailThreadId: `gmail-thread-${randomUUID()}`, customerEmail: "decoy@example.invalid" }).returning();
    await f.db.insert(savMessages).values({
      threadId: otherThread!.id, mailboxId: otherMailbox!.id, direction: "inbound", gmailMessageId: s.gmailMessageId, fromEmail: "decoy@example.invalid", toEmails: ["other@example.invalid"], subject: "Decoy subject",
      bodyCiphertext: encryptSavPayload({ text: "decoy", headers: { "message-id": "<decoy@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z"),
    });
    const proposed = await propose(s);
    expect(await storedProposal(proposed.validationId)).toMatchObject({ inboundMessageId: s.message.id, recipient: "customer@example.invalid", subject: "Synthetic connection failure" });
  });
});

describe("B's draft goes in as it is", () => {
  it("a `CaseDecisionDraft` (B's own type) plus a stated language is the whole input; a draft B marks without a reply is refused as `no_reply`", async () => {
    const s = await scenario("question");
    const decision: CaseDecisionDraft = {
      caseId: s.caseId, inputKey: `in:${randomUUID()}`, triggerEventId: s.draft.triggerEventId, decidedOn: s.version, decisionContract: "fixture", reply: s.draft.reply, replyLimit: null,
      noteText: "Synthetic note.", citations: [], shownSources: [], decidedWhileActionsPaused: false,
    };
    const { caseId, triggerEventId, decidedOn, reply } = decision;
    expect(await proposeCaseReplyFromDraft({ caseId, triggerEventId, decidedOn, reply, language: { code: "fr", proven: true } }, storeDeps())).toMatchObject({ ok: true, state: "proposed", language: { language: "fr", proof: "proven" } });
    for (const replyLimit of ["no_reply", "several_questions", "purpose_not_supported", "inbound_unknown"] as const) {
      const limited: CaseDecisionDraft = { ...decision, reply: null, replyLimit };
      expect(await proposeCaseReplyFromDraft({ caseId: limited.caseId, triggerEventId: limited.triggerEventId, decidedOn: limited.decidedOn, reply: limited.reply, language: { code: "fr", proven: true } }, storeDeps()), replyLimit)
        .toEqual({ ok: false, code: "no_reply" });
    }
    // a reply with no stored mail to answer has nothing to be keyed or sent on
    expect(await proposeCaseReplyFromDraft({ caseId, triggerEventId: null, decidedOn, reply, language: { code: "fr", proven: true } }, storeDeps())).toEqual({ ok: false, code: "inbound_unknown" });
  });
});

describe("pauses, owners and the guards before any provider", () => {
  it("fully paused (V2, then intake): the pass reads and writes nothing, no provider is called (0), the queued execution is untouched; after the pause it sends once", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    await setPause("v2", "fully_paused");
    expect(await pass()).toMatchObject({ skipped: expect.any(String), recovery: [], supervised: [] });
    await setPause("v2", null); await setPause("intake", "fully_paused");
    expect(await pass()).toMatchObject({ skipped: expect.any(String), recovery: [], supervised: [] });
    await setPause("intake", "actions_paused");
    expect(await pass()).toMatchObject({ skipped: expect.any(String) });
    expect(providerCalls()).toBe(0);
    expect(sends).toBe(0);
    expect(await effectsOf(id)).toEqual([]);
    expect((await execution(id)).state).toBe("pending");
    await setPause("intake", null);
    expect((await pass()).supervised).toEqual([{ executionId: id, state: "confirmed", reason: null }]);
    expect(sends).toBe(1);
  });

  it("an actions pause of the V2 agent holds every planned send at the gate (no marker, no provider send) and keeps the execution open; the send happens once after the pause", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    await setPause("v2", "actions_paused");
    const held = await pass();
    expect(held.skipped).toBeNull();
    expect(held.supervised).toEqual([{ executionId: id, state: "waiting", reason: "SAV_INTAKE_AGENT_ACTIONS_PAUSED" }]);
    expect(sends).toBe(0);
    expect(counts.dispatch ?? 0).toBe(0);
    expect(await effectsOf(id)).toEqual([]);
    await setPause("v2", null);
    expect((await pass()).supervised).toEqual([{ executionId: id, state: "confirmed", reason: null }]);
    expect(sends).toBe(1);
  });

  it("mode off, or no execution config: skipped, nothing read or written", async () => {
    const s = await scenario("question"); await admit(s);
    environment = { ...environment, SAV_CASE_EFFECTS: "off" };
    expect(await pass()).toEqual({ skipped: "effects_off", recovery: [], supervised: [], needsPerson: [] });
    environment = { ...environment, SAV_CASE_EFFECTS: "auto" }; // "auto" does not exist
    expect(await pass()).toMatchObject({ skipped: "effects_off" });
    environment = { SAV_CASE_EFFECTS: "supervised" };
    expect(await pass()).toMatchObject({ skipped: "execution_off" });
    expect(providerCalls()).toBe(0);
    expect(sends).toBe(0);
  });

  it("a case owned by a person: no proposal, an execution already queued is cancelled before any provider call, no J2, and a new customer mail frees nothing", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    await takeover(s.caseId);
    const cancelled = await pass();
    expect(cancelled.supervised).toEqual([{ executionId: id, state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED" }]);
    expect(sends).toBe(0);
    expect(providerCalls()).toBe(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    await newCustomerMail(s);
    // a NEW text (a new payload) for the same mail: the identical draft would only answer with the row that already exists (the store is idempotent before it judges)
    expect(await proposeCaseReplyFromDraft({ ...s.draft, reply: { ...s.draft.reply!, text: "SYNTHETIC reply, changed." } }, storeDeps())).toMatchObject({ ok: false, code: "not_admitted" });
    expect(await pass()).toMatchObject({ skipped: null, supervised: [] });
    expect((await readCase(s.caseId))!.owner).toBe("human");
    expect(sends).toBe(0);
    expect(await outbound(s.caseId)).toEqual([]);
  });
});

describe("an uncertain result is verified, never resent; the 5-read ceiling is reported, never reset", () => {
  it("a lost ACK: the pass that sent ends uncertain; the next pass is NOT due (no read); once due, ONE verification confirms and records; nothing is ever resent", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    loseAck = true;
    expect((await pass()).supervised).toEqual([{ executionId: id, state: "uncertain", reason: expect.any(String) }]);
    loseAck = false;
    expect(sends).toBe(1);
    const verifiesBefore = counts.verify ?? 0;
    expect(await pass()).toMatchObject({ recovery: [{ skipped: "nothing_due" }], supervised: [] }); // the schedule (60 s) is not reached
    expect(counts.verify ?? 0).toBe(verifiesBefore);
    await letReconcile();
    const done = await pass();
    expect(done.recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    expect(done.supervised).toEqual([]);
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect((await pass()).recovery).toEqual([{ skipped: "nothing_due" }]);
    expect(sends).toBe(1);
  });

  it("at 5 reads the effect is no longer listed for verification, no provider is read, the count is never lowered, and a person is told", async () => {
    const s = await scenario("question"), id = await lostAck(s);
    await f.client.exec(`UPDATE sav.intake_effects SET reconcile_attempts = 5, next_reconcile_at = NULL WHERE execution_id = '${id}'`);
    const verifiesBefore = counts.verify ?? 0;
    const result = await pass();
    expect(result.recovery).toEqual([{ skipped: "nothing_due" }]);
    expect(result.supervised).toEqual([]);
    expect(result.needsPerson).toMatchObject([{ executionId: id, effectState: "uncertain", reconcileAttempts: 5 }]);
    expect(counts.verify ?? 0).toBe(verifiesBefore);
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "uncertain", reconcileAttempts: 5 }]);
    // the executor itself, asked directly, waits too: no read, no resend
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    expect(counts.verify ?? 0).toBe(verifiesBefore);
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "uncertain", reconcileAttempts: 5 }]);
    expect(await listCaseEffectsNeedingPerson()).toMatchObject([{ executionId: id }]);
  });
});

describe("work stuck at the ceiling never starves new work", () => {
  it("five executions waiting for a person do not hide a fresh queued reply from a pass that takes one execution at a time", async () => {
    for (let n = 0; n < 5; n++) {
      const stuck = await lostAck(await scenario("question"));
      await f.client.exec(`UPDATE sav.intake_effects SET reconcile_attempts = 5, next_reconcile_at = NULL WHERE execution_id = '${stuck}'`);
    }
    const fresh = await scenario("question"), { id } = await admit(fresh);
    sends = 0;
    const result = await pass({ limit: 1 });
    expect(result.supervised).toEqual([{ executionId: id, state: "confirmed", reason: null }]);
    expect(sends).toBe(1);
    expect(result.needsPerson).toHaveLength(5);
  });
});

describe("a reply confirmed in the ledger before its finish ran is completed once, without a second send", () => {
  it("crash between the confirmation and the finish: the pass (recovery) records ONE mail, ONE question, ONE J2 and closes the execution; replayed twice more it changes nothing", async () => {
    const s = await scenario("question"), id = await crashBeforeFinish(s);
    expect(sends).toBe(1);
    const result = await pass();
    expect(result.recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    expect(result.supervised).toEqual([]);
    for (let n = 0; n < 2; n++) expect((await pass()).recovery).toEqual([{ skipped: "nothing_due" }]);
    expect(sends).toBe(1);
    expect(counts.dispatch ?? 0).toBe(1); // the original send only
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(await effectsOf(id)).toHaveLength(1);
    expect((await execution(id)).state).toBe("confirmed");
  });

  it("the same, when the receipt was already recorded and only the execution never closed: still one mail, one question, one J2", async () => {
    const s = await scenario("question"), id = await crashBeforeFinish(s);
    const [reply] = await effectsOf(id), ack = decryptSavPayload<{ id: string; threadId: string; sentAt?: string }>(reply!.ackCiphertext!);
    const proposal = await storedProposal((await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.executionId, id)))[0]!.id);
    await recordConfirmedCaseReply({ proposal, effectId: reply!.id, gmailMessageId: ack.id, gmailThreadId: ack.threadId, sentAt: new Date(ack.sentAt ?? reply!.dispatchedAt!), currentPolicyRevision: POLICY });
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await pass()).recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(sends).toBe(1);
  });

  it("a human takeover between the crash and the recovery: the agent records NOTHING (decided by ROOT), the execution ends for good and is never listed again; nothing is resent", async () => {
    const s = await scenario("question"), id = await crashBeforeFinish(s);
    await takeover(s.caseId);
    expect((await pass()).recovery).toMatchObject([{ executionId: id, state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED" }]);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await pass()).recovery).not.toContainEqual(expect.objectContaining({ executionId: id }));
    expect(sends).toBe(1);
  });
  it("a FULL pause between the crash and the recovery skips the pass; once lifted the recovery records the mail once (no resend)", async () => {
    const s = await scenario("question"), id = await crashBeforeFinish(s);
    await setPause("v2", "fully_paused");
    expect(await pass()).toMatchObject({ skipped: expect.any(String) });
    expect(await outbound(s.caseId)).toHaveLength(0);
    await setPause("v2", null);
    expect((await pass()).recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(sends).toBe(1);
  });

  it("a reply confirmed whose NOTE still waits: the recovery records the mail and leaves the execution for a supervised pass, which adds the note once; the recovery never lists it again", async () => {
    const s = await scenario("question");
    const proposed = await propose(s); await approve(proposed.validationId);
    const note: CaseEffectNote = { interactionId: `inbound:${s.gmailMessageId}`, text: "Synthetic interaction note.", at: "2026-10-30T10:00:00.000Z" };
    const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), note, deps: storeDeps() });
    if (!queued.ok) throw Error("QUEUE_REFUSED");
    const id = queued.executionId;
    loseAck = true; expect(await run(id)).toMatchObject({ state: "uncertain" }); loseAck = false; await letReconcile();
    const first = await pass();
    expect(first.recovery).toMatchObject([{ executionId: id, state: "waiting", reason: "SAV_CASE_EFFECT_RECOVERY_NOTE_PENDING" }]);
    expect(first.supervised).toEqual([]);
    expect(await pendingCaseEffectRecoveries()).toEqual([]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    const second = await pass();
    expect(second.recovery).toEqual([{ skipped: "nothing_due" }]);
    expect(second.supervised).toEqual([{ executionId: id, state: "confirmed", reason: null }]);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }, { state: "confirmed" }, { state: "confirmed" }]);
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect((await pass()).recovery).toEqual([{ skipped: "nothing_due" }]);
  });
});

describe("races: a pass that no longer owns the execution or the attempt writes nothing", () => {
  it("an old POSITIVE proof read by the supervised pass never confirms a later attempt, and never consumes its retry", async () => {
    const s = await scenario("question"), id = await lostAck(s);
    await letReconcile();
    const newAttempt = randomUUID(), newLease = randomUUID();
    let reads = 0;
    const adapters = { ...options.adapters, verify: async (...args: Parameters<ExecutorAdapters["verify"]>) => {
      reads += 1;
      const proof = await options.adapters.verify(...args);
      expect(proof).toMatchObject({ confirmed: true, attributed: true });
      await f.db.update(savCaseEffectExecutions).set({ leaseToken: newLease, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(savCaseEffectExecutions.id, id));
      await f.db.update(savIntakeEffects).set({ attemptId: newAttempt, reconcileAttempts: 4, state: "uncertain" }).where(eq(savIntakeEffects.executionId, id));
      return proof;
    } };
    expect(await run(id, driver(), { ...options, adapters })).toEqual({ skipped: "SAV_INTAKE_EXECUTION_VERIFICATION_STALE", executionId: id });
    expect(reads).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ attemptId: newAttempt, state: "uncertain", reconcileAttempts: 4 }]);
    expect((await execution(id)).leaseToken).toBe(newLease);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toHaveLength(0);
    expect(sends).toBe(1);
  });

  it("an old NEGATIVE proof or a failed read never consumes a later attempt's retry", async () => {
    for (const kind of ["negative", "error"] as const) {
      const s = await scenario("question"), id = await lostAck(s);
      await letReconcile();
      const newAttempt = randomUUID(), newLease = randomUUID();
      const adapters = { ...options.adapters, verify: async () => {
        await f.db.update(savCaseEffectExecutions).set({ leaseToken: newLease, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(savCaseEffectExecutions.id, id));
        await f.db.update(savIntakeEffects).set({ attemptId: newAttempt, reconcileAttempts: 4, state: "uncertain" }).where(eq(savIntakeEffects.executionId, id));
        if (kind === "error") throw Error("SAV_TEST_PROVIDER_DOWN");
        return { confirmed: false, attributed: false } as Awaited<ReturnType<ExecutorAdapters["verify"]>>;
      } };
      expect(await run(id, driver(), { ...options, adapters }), kind).toEqual({ skipped: "SAV_INTAKE_EXECUTION_VERIFICATION_STALE", executionId: id });
      expect(await effectsOf(id), kind).toMatchObject([{ attemptId: newAttempt, state: "uncertain", reconcileAttempts: 4 }]);
      expect((await execution(id)).leaseToken, kind).toBe(newLease);
      expect(sends).toBe(1);
    }
  });

  it("a lease that expired before the finish: no mail event, no question, no J2, the execution is not confirmed; the next pass completes it once", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const real = driver();
    const late = { ...real, finish: async (lease: Parameters<typeof real.finish>[0], effects: Parameters<typeof real.finish>[1]) => { await expireLease(id); return real.finish(lease, effects); } };
    expect(await run(id, late)).toMatchObject({ state: "waiting", reason: expect.stringMatching(/LEASE_LOST/) });
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    expect(await outbound(s.caseId)).toEqual([]);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await execution(id)).state).not.toBe("confirmed");
    expect((await pass()).recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(sends).toBe(1);
  });

  it("a lease taken by ANOTHER pass before the finish is respected: the old pass writes nothing and leaves the other pass's lease alone", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const real = driver(), newLease = randomUUID();
    const stolen = { ...real, finish: async (lease: Parameters<typeof real.finish>[0], effects: Parameters<typeof real.finish>[1]) => {
      await f.db.update(savCaseEffectExecutions).set({ leaseToken: newLease, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(savCaseEffectExecutions.id, id));
      return real.finish(lease, effects);
    } };
    await run(id, stolen);
    expect(await outbound(s.caseId)).toEqual([]);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await execution(id)).leaseToken).toBe(newLease);
    expect((await execution(id)).state).toBe("running");
    expect(sends).toBe(1);
  });

  it("a lease that expires WHILE the receipt is written: the idempotent records stand once, but the old pass does not confirm the execution; the next pass closes it with no duplicate", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    // The lease is expired from `currentPolicyRevision`, which `finish` awaits between its two fences (outside any transaction); the gate also calls it, inside one, so it is armed only for `finish`.
    let armed = false, expired = false;
    const real = createCaseEffectDriver({ env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => { if (armed && !expired) { expired = true; await expireLease(id); } return POLICY; } });
    const late = { ...real, finish: async (lease: Parameters<typeof real.finish>[0], effects: Parameters<typeof real.finish>[1]) => { armed = true; try { return await real.finish(lease, effects); } finally { armed = false; } } };
    expect(await run(id, late)).toMatchObject({ state: "waiting", reason: expect.stringMatching(/LEASE_LOST/) });
    expect(sends).toBe(1);
    expect((await execution(id)).state).not.toBe("confirmed");
    expect((await pass()).recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(sends).toBe(1);
  });
});

describe("the J2 after a pause, a new mail and a takeover", () => {
  it("a pause keeps the J2 date; a new customer mail cancels the old J2; a takeover cancels it too", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    expect((await pass()).supervised).toEqual([{ executionId: id, state: "confirmed", reason: null }]);
    const [timer] = await listCaseTimers(s.caseId);
    expect(timer).toMatchObject({ state: "scheduled" });
    await setPause("v2", "fully_paused");
    expect(await pass()).toMatchObject({ skipped: expect.any(String) });
    await setPause("v2", null);
    expect(await listCaseTimers(s.caseId)).toMatchObject([{ id: timer!.id, state: "scheduled", dueAt: timer!.dueAt, sentAt: timer!.sentAt }]);
    await newCustomerMail(s);
    expect(await listCaseTimers(s.caseId)).toMatchObject([{ id: timer!.id, state: "cancelled", cancelReason: expect.any(String) }]);

    const t = await scenario("question"), second = await admit(t);
    await pass();
    expect((await effectsOf(second.id))).toMatchObject([{ state: "confirmed" }]);
    expect(await listCaseTimers(t.caseId)).toMatchObject([{ state: "scheduled" }]);
    await takeover(t.caseId);
    expect(await listCaseTimers(t.caseId)).toMatchObject([{ state: "cancelled", cancelReason: expect.any(String) }]);
    expect(sends).toBe(1);
  });
});

describe("the review read model asks for access BEFORE anything is decrypted", () => {
  it("absent, refused or failing access: the reader is never called; granted access returns the view with its hash, validation, mention and ceiling flag", async () => {
    const s = await scenario("question"), { validationId, id } = await admit(s);
    const read = vi.fn(async () => null);
    const base = { validationId, env: () => environment, read: read as never };
    expect(await describeCaseReplyForReview({ ...base })).toEqual({ ok: false, code: "access_denied" });
    expect(await describeCaseReplyForReview({ ...base, access: () => false })).toEqual({ ok: false, code: "access_denied" });
    expect(await describeCaseReplyForReview({ ...base, access: () => { throw Error("SAV_TEST_AUTH_DOWN"); } })).toEqual({ ok: false, code: "access_denied" });
    expect(await describeCaseReplyForReview({ ...base, access: (async () => undefined) as never })).toEqual({ ok: false, code: "access_denied" });
    expect(read).not.toHaveBeenCalled();
    const granted = await describeCaseReplyForReview({ validationId, env: () => environment, access: async () => true });
    expect(granted).toMatchObject({ ok: true, view: { id: validationId, validation: "approved", disclosure: { mode: "manual_reviewed", language: "en" }, needsPerson: false } });
    if (granted.ok) expect(granted.view.payloadHash).toBe(caseReplyPayloadHash(await storedProposal(validationId)));
    expect(await describeCaseReplyForReview({ validationId: randomUUID(), env: () => environment, access: () => true })).toEqual({ ok: false, code: "unknown" });
    // after a lost ACK at the ceiling the view says a person must look
    loseAck = true; await run(id); loseAck = false;
    await f.client.exec(`UPDATE sav.intake_effects SET reconcile_attempts = 5 WHERE execution_id = '${id}'`);
    expect(await describeCaseReplyForReview({ validationId, env: () => environment, access: () => true })).toMatchObject({ ok: true, view: { needsPerson: true } });
  });
});

describe("an error past the marker: the optional `deferEffect` hook of the shared executor (ROOT-authorised, C's driver provides it)", () => {
  const failing = (before: (id: string) => Promise<unknown>) => (id: string) => ({ ...options.adapters, dispatch: async () => { await before(id); throw Error("SAV_TEST_PROVIDER_DOWN"); } });
  const runWith = (id: string, adapters: typeof options.adapters, d = driver()) => run(id, d, { ...options, adapters });
  it("witness: the pass still owns the execution and marked this attempt: ONE more read is scheduled, the effect stays engaged, nothing is sent again", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    await runWith(id, failing(async () => {})(id));
    expect(await effectsOf(id)).toMatchObject([{ state: expect.stringMatching(/dispatched|uncertain/), reconcileAttempts: 1 }]);
    expect((await effectsOf(id))[0]!.nextReconcileAt).not.toBeNull();
  });
  it("the lease expired while the provider call ran: the late error consumes nothing", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    await runWith(id, failing(expireLease)(id));
    expect(await effectsOf(id)).toMatchObject([{ reconcileAttempts: 0 }]);
  });
  it("another pass took the execution (new lease token) during the provider call: the late error consumes nothing", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const other = randomUUID();
    await runWith(id, failing(() => f.db.update(savCaseEffectExecutions).set({ leaseToken: other, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(savCaseEffectExecutions.id, id)).then(() => {}))(id));
    expect(await effectsOf(id)).toMatchObject([{ reconcileAttempts: 0 }]);
    expect((await execution(id)).leaseToken).toBe(other);
  });
  it("the effect was confirmed by someone else during the call: it stays confirmed and is not deferred", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    await runWith(id, failing(() => f.client.exec(`UPDATE sav.intake_effects SET state = 'confirmed' WHERE execution_id = '${id}'`).then(() => {}))(id));
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed", reconcileAttempts: 0 }]);
  });
  it("a LATER attempt (new attempt id, 4 reads already) keeps its reads and its schedule: the old result never consumes another attempt", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const newAttempt = randomUUID(), newLease = randomUUID();
    await runWith(id, failing(async () => {
      await f.db.update(savCaseEffectExecutions).set({ leaseToken: newLease, leaseUntil: new Date(Date.now() + 60_000) }).where(eq(savCaseEffectExecutions.id, id));
      await f.db.update(savIntakeEffects).set({ attemptId: newAttempt, reconcileAttempts: 4, state: "uncertain" }).where(eq(savIntakeEffects.executionId, id));
    })(id));
    expect(await effectsOf(id)).toMatchObject([{ attemptId: newAttempt, state: "uncertain", reconcileAttempts: 4 }]);
  });
  it("same lease, but the attempt id changed under it (a retry by the same token is impossible; the attempt id is the second key): nothing is consumed", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const newAttempt = randomUUID();
    await runWith(id, failing(() => f.db.update(savIntakeEffects).set({ attemptId: newAttempt }).where(eq(savIntakeEffects.executionId, id)).then(() => {}))(id));
    expect(await effectsOf(id)).toMatchObject([{ attemptId: newAttempt, reconcileAttempts: 0 }]);
  });
  // The executor reads the effect, then calls the hook: these two wrap the hook to change the effect IN that window, so the hook's own checks (not the executor's) are what holds.
  const inWindow = (change: (id: string) => Promise<unknown>) => (base: ReturnType<typeof driver>, id: string) =>
    ({ ...base, deferEffect: async (lease: Parameters<NonNullable<typeof base.deferEffect>>[0], seen: Parameters<NonNullable<typeof base.deferEffect>>[1], reason: string) => { await change(id); return base.deferEffect!(lease, seen, reason); } });
  it("the effect is confirmed between the executor's read and the hook: the hook leaves it confirmed (its own state check)", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    await runWith(id, failing(async () => {})(id), inWindow(i => f.client.exec(`UPDATE sav.intake_effects SET state = 'confirmed' WHERE execution_id = '${i}'`))(driver(), id));
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed", reconcileAttempts: 0 }]);
  });
  it("the marker belongs to another pass's token between the executor's read and the hook: nothing is consumed (its own token check)", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    await runWith(id, failing(async () => {})(id), inWindow(i => f.client.exec(`UPDATE sav.intake_effects SET dispatch_token = '${randomUUID()}' WHERE execution_id = '${i}'`))(driver(), id));
    expect(await effectsOf(id)).toMatchObject([{ reconcileAttempts: 0 }]);
  });
  it("the hook itself fails (database error): the pass throws, records no mail event / question / J2, confirms nothing, sends nothing again; the recovery then verifies only", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const base = driver();
    const broken = { ...base, deferEffect: async () => { throw Error("SAV_TEST_DEFER_DOWN"); } };
    await expect(runWith(id, failing(async () => {})(id), broken)).rejects.toThrow(/SAV_TEST_DEFER_DOWN/);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await execution(id)).state).not.toBe("confirmed");
    await expireLease(id);
    expect((await pass()).supervised).not.toContainEqual(expect.objectContaining({ executionId: id }));
    expect(sends).toBe(0);
  });
  it("without the hook (the V1 intake driver shape) the executor keeps its old rule: the effect is deferred as before", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const { deferEffect: _omitted, ...withoutHook } = driver();
    await runWith(id, failing(async () => {})(id), withoutHook as ReturnType<typeof driver>);
    expect(await effectsOf(id)).toMatchObject([{ reconcileAttempts: 1 }]);
  });
});

// C-ATOMIC-RECEIPT. At e35cba2/2160ea3 this block was a pinned KNOWN RACE (a pass that lost its authority between the first fence and the three case writes still wrote the event, the question
// and the J2). The receipt is now ONE transaction (execution -> case -> effect, authority judged again after the last lock wait, any loss throws and rolls everything back): these are the
// same counter-examples, now asserting ZERO projection. They are red on the old head and green on this one.
describe("the receipt is ONE transaction: authority lost in the window leaves no projection", () => {
  const lose = {
    expire: (id: string) => expireLease(id),
    stolen: (id: string) => f.db.update(savCaseEffectExecutions).set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) }).where(eq(savCaseEffectExecutions.id, id)),
    human: (_id: string, caseId: string) => takeover(caseId),
    pause: () => setPause("v2", "fully_paused"),
  } as const;
  const snapshotMarkers = async () => (await f.db.select().from(savSyncState).orderBy(savSyncState.key)).map(row => `${row.key}|${row.status}`);
  it.each(["expire", "stolen", "human", "pause"] as const)("%s while the policy is awaited, after the first read: no mail event, no question, no J2, the parent is not confirmed, nothing is resent", async kind => {
    const s = await scenario("question"), { id } = await admit(s);
    let armed = false, changed = false;
    const real = createCaseEffectDriver({ env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => { if (armed && !changed) { changed = true; await lose[kind](id, s.caseId); } return POLICY; } });
    const wrapped = { ...real, finish: async (lease: Parameters<typeof real.finish>[0], effects: Parameters<typeof real.finish>[1]) => { armed = true; try { return await real.finish(lease, effects); } finally { armed = false; } } };
    expect(await run(id, wrapped)).toMatchObject({ state: "waiting" });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await execution(id)).state).not.toBe("confirmed");
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
  });
  it("nominal: exactly one mail event, one question, one J2 and the parent confirmed, in the one transaction", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(sends).toBe(1);
  });
  it("an error AFTER the event and the question rolls the whole receipt back (no half record, foreign markers untouched); the next pass records the three once, with no resend", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const markers = await snapshotMarkers(), before = (await readCase(s.caseId))!.version;
    const spy = vi.spyOn(timerStore, "scheduleJ2ForConfirmedQuestion").mockRejectedValueOnce(Error("SAV_TEST_J2_WRITE_FAILED"));
    expect(await run(id)).toMatchObject({ state: "waiting", reason: expect.stringMatching(/J2_WRITE_FAILED/) });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await readCase(s.caseId))!.version).toBe(before);
    expect(await snapshotMarkers()).toEqual(markers);
    expect((await execution(id)).state).not.toBe("confirmed");
    spy.mockRestore();
    expect((await pass()).recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(sends).toBe(1);
  });
  it("two recoveries after a crash before the finish: one event, one question, one J2, zero extra send (the second finds nothing to do)", async () => {
    const s = await scenario("question"), id = await crashBeforeFinish(s);
    expect((await pass()).recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    await pass();
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(sends).toBe(1);
  });
  it("the receipt written by another pass in the meantime (same mail already journaled) is a dedupe, not an error: the parent still confirms, nothing is duplicated", async () => {
    const s = await scenario("question"), id = await crashBeforeFinish(s);
    await pass();
    await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'waiting', lease_token = NULL, lease_until = NULL, reason = NULL WHERE id = '${id}'`);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(sends).toBe(1);
  });
  // C7 (ROOT arbitration INPUT_NEWER): a customer message known BEFORE the provider call is no longer "crossed"; the prepared question is stale, nothing leaves, the parent is cancelled.
  // (A message that arrives AFTER the mail left is still the "crossed the question" case of the receipt: `inbound_after_question`, covered by the receipt tests.)
  it("a customer message recorded between the marker and the provider call stops the question before the provider: nothing leaves, the parent is cancelled, no question, no J2", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    expect(await executeIntakePass(id, options, { afterMarker: async () => { await newCustomerMail(s); } }, driver())).toEqual({ state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT", executionId: id });
    expect(sends).toBe(0);
    expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
  });
});

describe("what the receipt transaction refuses, and how (each refusal rolls back the whole receipt)", () => {
  const armedDriver = (change: (id: string, caseId: string) => Promise<unknown>, id: string, caseId: string, revision = POLICY) => {
    let armed = false, changed = false;
    const real = createCaseEffectDriver({ env: () => environment, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => { if (armed && !changed) { changed = true; await change(id, caseId); return revision; } return POLICY; } });
    return { ...real, finish: async (lease: Parameters<typeof real.finish>[0], effects: Parameters<typeof real.finish>[1]) => { armed = true; try { return await real.finish(lease, effects); } finally { armed = false; } } };
  };
  it("a person owning the case with an ANSWER (no question): the owner is judged on its own, the mail event is not written either", async () => {
    const s = await scenario("answer"), { id } = await admit(s);
    expect(await run(id, armedDriver(async (_i, caseId) => { await takeover(caseId); }, id, s.caseId))).toMatchObject({ state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED" });
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect(sends).toBe(1);
  });
  it("the reply's ledger row changed between the executor's read and the transaction: RECEIPT_CHANGED, nothing recorded, the parent not confirmed", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const real = driver();
    const wrapped = { ...real, finish: async (lease: Parameters<typeof real.finish>[0], effects: Parameters<typeof real.finish>[1]) => {
      await f.db.update(savIntakeEffects).set({ ackCiphertext: encryptSavPayload({ id: `gm-other-${randomUUID()}`, threadId: "thread-other" }) }).where(eq(savIntakeEffects.executionId, id));
      return real.finish(lease, effects);
    } };
    expect(await run(id, wrapped)).toMatchObject({ state: "waiting", reason: "SAV_CASE_EFFECT_RECEIPT_CHANGED" });
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await execution(id)).state).not.toBe("confirmed");
  });
  it("a J2 refusal that is not a dedupe and not a crossed question (the admission revision moved) holds the WHOLE receipt: no event, no question; the next pass completes it", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const result = await run(id, armedDriver(async () => {}, id, s.caseId, "policy-rotated"));
    expect(result).toMatchObject({ state: "waiting", reason: expect.stringMatching(/^SAV_CASE_EFFECT_RECEIPT_J2_/) });
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await pass()).recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(sends).toBe(1);
  });
  it("a stale case version INSIDE the transaction is never retried (a retry would commit a record judged on a version nobody checked): everything rolls back, the next pass completes it", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const spy = vi.spyOn(caseStore, "updateCaseRecord").mockRejectedValueOnce(new caseStore.CaseVersionStaleError(1));
    expect(await run(id)).toMatchObject({ state: "waiting" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await outbound(s.caseId)).toHaveLength(0);
    spy.mockRestore();
    expect((await pass()).recovery).toMatchObject([{ executionId: id, state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
  });
});

describe("the clock is judged again after the LAST wait and before the commit (fake clock, real database)", () => {
  afterEach(() => { vi.useRealTimers(); });
  const frozen = () => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  const jump = () => vi.setSystemTime(Date.now() + 10 * 60_000);
  it("the lease expires while waiting for the case lock: nothing is written, the parent is not confirmed, nothing is resent", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const original = caseStore.lockCaseForWrite;
    vi.spyOn(caseStore, "lockCaseForWrite").mockImplementation(async (...args) => { const locked = await original(...args); jump(); return locked; });
    frozen();
    expect(await run(id)).toMatchObject({ state: "waiting", reason: expect.stringMatching(/LEASE_LOST/) });
    vi.useRealTimers(); vi.restoreAllMocks();
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await execution(id)).state).not.toBe("confirmed");
    expect(sends).toBe(1);
  });
  it("the lease expires after the three writers, before the conclusion: everything is rolled back, the parent is not confirmed", async () => {
    const s = await scenario("question"), { id } = await admit(s);
    const original = timerStore.scheduleJ2ForConfirmedQuestion;
    vi.spyOn(timerStore, "scheduleJ2ForConfirmedQuestion").mockImplementation(async (...args) => { const scheduled = await original(...args); jump(); return scheduled; });
    frozen();
    expect(await run(id)).toMatchObject({ state: "waiting", reason: expect.stringMatching(/LEASE_LOST/) });
    vi.useRealTimers(); vi.restoreAllMocks();
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await execution(id)).state).not.toBe("confirmed");
    expect(sends).toBe(1);
  });
});

describe("the receipt transaction, read as code", () => {
  const source = readFileSync(fileURLToPath(new URL("./case-effect-driver.ts", import.meta.url)), "utf8");
  const body = source.slice(source.indexOf("async function commitReceipt("), source.indexOf("/** The reason a verification-only pass leaves"));
  it("lock order: the execution row, then the case (ticket advisory lock, then the row), then the effect; the case is never locked directly", () => {
    const [execution, caseLock, effect] = [body.indexOf("ownedExecution(tx, lease)"), body.indexOf("lockCaseForWrite(tx, proposal.caseId)"), body.indexOf('.for("share")')];
    expect(execution).toBeGreaterThan(-1);
    expect(caseLock).toBeGreaterThan(execution);
    expect(effect).toBeGreaterThan(caseLock);
    expect(body).not.toMatch(/savCases\b/);
  });
  it("nothing injected or provider-side is awaited inside the transaction: the policy is resolved before it opens; the three writers get the same `tx`", () => {
    const inside = body.slice(body.indexOf("transaction(async tx"));
    expect(body.indexOf("deps.currentPolicyRevision()")).toBeLessThan(body.indexOf("transaction(async tx"));
    expect(inside).not.toMatch(/deps\.|adapters|fetch\(|\.transaction\(/);
    expect(inside).toMatch(/recordConfirmedCaseReply\([^)]*\{ tx \}\)/);
  });
});

describe("one executor, no transport of its own", () => {
  it("the entrypoint file reaches the provider only through `executeIntakePass` / `recoverCaseEffects`: no adapter dispatch, no marker, no ledger write, no network import", () => {
    const source = readFileSync(fileURLToPath(new URL("./case-runtime-effects.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/import \{ executeIntakePass \} from "\.\.\/intake\/executor"/);
    for (const forbidden of [/adapters\.dispatch/, /markEffectDispatched/, /ensureExecutionEffect/, /recordEffectAck/, /\bfetch\(/, /createIntakeExecutorAdapters/, /gmailRequest/, /\.insert\(/, /\.update\(/, /\.delete\(/]) {
      expect(source, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
