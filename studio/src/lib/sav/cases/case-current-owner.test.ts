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
import { savCaseEffectExecutions, savCaseReplyValidations, savIntakeEffectJournal, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "../intake/execution-policy";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { executeIntakePass } from "../intake/executor";
import { ensureExecutionEffect, markEffectDispatched } from "../intake/execution-store";
import { getExecutionEffects } from "../intake/execution-store";
import type { ExecutionOptions, ExecutorAdapters } from "../intake/execution-types";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { createCaseEffectDriver, ownerBeforeClaim } from "./case-effect-driver";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { proposeCaseReplyFromDraft, queueValidatedCaseReply, runCaseEffectsPass, type CaseReplyDraftInput } from "./case-runtime-effects";

// SAV-10 (pole C), C5-CURRENT-OWNER-FENCE: NEW reply work needs the current CRM owner of the ticket, read through a required server port; the scaffold below is the one of the reviewer's probes
// (`case-current-owner.review.test.ts`), the port is a controllable fake instead of the synthetic provider's ticket. First scaffold comment follows.
// C-NIGHT-REPLY-RECOVERY-RACCORD: the injectable entrypoints on the REAL executor, ledger, validation store and case store, with the synthetic provider
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
// The injectable reader of the CURRENT owner of the ticket (the port under test). `reading` is what the synthetic CRM answers; `asked` records every ticket id it was asked about.
type Reading = "v2" | "human" | "none" | "unknown" | "throw" | "garbage";
let reading: Reading = "v2", asked: string[] = [], onAsk: ((n: number) => Promise<void> | void) | null = null;
const synOwner = async ({ ticketId }: { ticketId: string }) => {
  asked.push(ticketId);
  await onAsk?.(asked.length);
  if (reading === "throw") throw Error("SYN_OWNER_DOWN");
  return reading as never;
};
const driver = () => createCaseEffectDriver({ env: () => environment, readTicketOwner: synOwner, currentPolicyRevision: async () => POLICY });
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
const storeDeps = () => ({ env: () => environment, readTicketOwner: synOwner, currentPolicyRevision: async () => POLICY });
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
  env: () => environment, readTicketOwner: synOwner, currentPolicyRevision: async () => POLICY, adapters: options.adapters, deadlineMs: Date.now() + 60_000,
  context: { runtime: options.runtime, policy: options.policy }, ...overrides,
});
const run = (id: string, d = driver(), opts: ExecutionOptions = options) => executeIntakePass(id, opts, {}, d);
const execution = async (id: string) => (await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, id)))[0]!;
const effectsOf = (id: string) => getExecutionEffects(id);
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
const outbound = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed");
const providerCalls = () => Object.values(counts).reduce((a, b) => a + b, 0);
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
  reading = "v2"; asked = []; onAsk = null;
  // Each test starts from an empty queue: what earlier tests left open is closed (a refused execution is never listed nor claimed).
  await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused' WHERE state NOT IN ('confirmed','refused')");
});
afterEach(async () => {
  expect(vi.mocked(fetch)).not.toHaveBeenCalled(); // transport réseau = 0
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setPause("v2", null); await setPause("intake", null);
});



// ---------------------------------------------------------------------------------------------------------------------------------
const validationsOf = async (caseId: string) => (await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, caseId))).length;
const executionsOf = async (caseId: string) => (await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, caseId))).length;
/** The same dependencies, minus the owner port: the type forbids it, this proves the runtime closes anyway. */
const withoutPort = <T extends object>(deps: T): never => { const rest: Record<string, unknown> = { ...(deps as Record<string, unknown>) }; delete rest.readTicketOwner; return rest as never; };
const NOT_V2 = ["human", "none", "unknown", "throw", "garbage"] as const;
const STORE_CODE: Record<(typeof NOT_V2)[number], string> = { human: "owner_human", none: "owner_none", unknown: "owner_unknown", throw: "owner_read_failed", garbage: "owner_unknown" };
const PASS_REASON: Record<(typeof NOT_V2)[number], string> = {
  human: "SAV_CASE_EFFECT_CANCELLED_OWNER_HUMAN", none: "SAV_CASE_EFFECT_HOLD_OWNER_NONE", unknown: "SAV_CASE_EFFECT_HOLD_OWNER_UNKNOWN",
  throw: "SAV_CASE_EFFECT_HOLD_OWNER_READ_FAILED", garbage: "SAV_CASE_EFFECT_HOLD_OWNER_UNKNOWN",
};

describe("C5: the current CRM owner before NEW reply work", () => {
  describe("a proposal and a queue entry", () => {
    it.each(NOT_V2)("%s: the proposal is refused, nothing is stored, and the port was asked about THIS case's ticket only", async kind => {
      const s = await scenario("answer"); reading = kind;
      expect(await proposeCaseReplyFromDraft(s.draft, storeDeps())).toMatchObject({ ok: false, code: STORE_CODE[kind] });
      expect(await validationsOf(s.caseId)).toBe(0);
      expect(asked).toEqual([s.ticketId]);
    });
    it("v2: the proposal is stored (the port is asked once, about the ticket read from the case row)", async () => {
      const s = await scenario("answer");
      expect(await proposeCaseReplyFromDraft(s.draft, storeDeps())).toMatchObject({ ok: true, created: true });
      expect(asked).toEqual([s.ticketId]);
    });
    it("no port at all: refused, nothing stored (the type forbids it; the runtime closes anyway)", async () => {
      const s = await scenario("answer");
      expect(await proposeCaseReplyFromDraft(s.draft, withoutPort(storeDeps()))).toMatchObject({ ok: false, code: "owner_port_absent" });
      expect(await validationsOf(s.caseId)).toBe(0);
      expect(asked).toEqual([]);
    });
    it.each(NOT_V2)("%s: an APPROVED reply is not queued, no execution row exists", async kind => {
      const s = await scenario("answer"); const proposed = await propose(s); await approve(proposed.validationId);
      reading = kind; asked = [];
      expect(await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), deps: storeDeps() })).toMatchObject({ ok: false, code: STORE_CODE[kind] });
      expect(await executionsOf(s.caseId)).toBe(0);
      expect(asked).toEqual([s.ticketId]);
    });
    it("no port at all: an approved reply is not queued", async () => {
      const s = await scenario("answer"); const proposed = await propose(s); await approve(proposed.validationId);
      expect(await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), deps: withoutPort(storeDeps()) })).toMatchObject({ ok: false, code: "owner_port_absent" });
      expect(await executionsOf(s.caseId)).toBe(0);
    });
    it("the human decision itself (approve / reject) does not need the port: it is not reply work", async () => {
      const s = await scenario("answer"); const proposed = await propose(s); reading = "human";
      const proposal = await storedProposal(proposed.validationId);
      expect(await decideCaseReply({ action: "approve", validationId: proposed.validationId, approverId: APPROVER, seen: seenOf(proposal), authorizer: allow, deps: storeDeps() })).toMatchObject({ ok: true });
    });
  });

  describe("a plan, a marker and the last look before the provider", () => {
    it("v2: ONE send; the port was asked 3 times (plan, marker, last look), always about this case's ticket", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); asked = [];
      expect(await run(id)).toMatchObject({ state: "confirmed" });
      expect(sends).toBe(1);
      expect(asked).toEqual([s.ticketId, s.ticketId, s.ticketId]);
    });
    it.each(NOT_V2)("%s before the pass: no plan, no marker, no provider call; a person on the ticket ends the execution for good, any other answer only holds it", async kind => {
      const s = await scenario("answer"); const { id } = await admit(s); reading = kind; asked = [];
      const result = await run(id);
      expect(result).toMatchObject({ state: "waiting", reason: PASS_REASON[kind] });
      expect(await effectsOf(id)).toEqual([]);
      expect(providerCalls()).toBe(0); expect(sends).toBe(0);
      expect((await execution(id)).state).toBe(kind === "human" ? "refused" : "waiting");
      expect(await outbound(s.caseId)).toEqual([]);
    });
    it("no port at all on the driver: the pass holds, nothing is planned or sent", async () => {
      const s = await scenario("answer"); const { id } = await admit(s);
      const bare = createCaseEffectDriver({ env: () => environment, currentPolicyRevision: async () => POLICY } as never);
      expect(await run(id, bare)).toMatchObject({ state: "waiting", reason: "SAV_CASE_EFFECT_HOLD_OWNER_PORT_ABSENT" });
      expect(await effectsOf(id)).toEqual([]); expect(providerCalls()).toBe(0);
      expect((await execution(id)).state).toBe("waiting");
    });
    it("the owner changes to a person BETWEEN the plan and the marker: the plan stays, no marker is written, nothing is sent", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); let markers = 0; asked = [];
      onAsk = n => { if (n === 2) reading = "human"; };
      const result = await executeIntakePass(id, options, { beforeMarker: async () => { markers += 1; } }, driver());
      expect(result).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_HUMAN" });
      expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
      expect(markers).toBe(1); expect(sends).toBe(0); expect(providerCalls()).toBe(0);
    });
    it("the owner changes to a person AFTER the marker and before the provider call: nothing leaves, the effect goes back to planned by the proven no-send transition", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); let marker = 0;
      const result = await executeIntakePass(id, options, { afterMarker: async () => { marker += 1; reading = "human"; } }, driver());
      expect(result).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_HUMAN" });
      expect({ marker, sends, send: counts.send ?? 0 }).toMatchObject({ marker: 1, sends: 0 });
      expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
      expect((await execution(id)).state).toBe("refused");
      const journal = (await f.db.select({ kind: savIntakeEffectJournal.kind }).from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, id))).map(r => r.kind);
      expect(journal).toContain("dispatch_withdrawn");
    });
    it("an ANSWER that is not v2 after the marker is a hold, not a cancel: the effect is back to planned and the next pass with a v2 reading sends ONCE (nothing was reset)", async () => {
      const s = await scenario("answer"); const { id } = await admit(s);
      const first = await executeIntakePass(id, options, { afterMarker: async () => { reading = "unknown"; } }, driver());
      expect(first).toMatchObject({ state: "waiting", reason: "SAV_CASE_EFFECT_HOLD_OWNER_UNKNOWN" });
      expect(sends).toBe(0); expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
      reading = "v2";
      expect(await run(id)).toMatchObject({ state: "confirmed" });
      expect(sends).toBe(1); expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    });
    it("the lease is lost WHILE the owner is being read (last look): nothing leaves, whatever the answer", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); asked = [];
      onAsk = async n => { if (n === 3) await expireLease(id); };
      const result = await run(id);
      // The marker is written and the lease is gone: nothing left, and the engaged state is the conservative one (verified later, never resent blindly).
      expect({ result: result.state, reason: result.reason, effects: (await effectsOf(id)).map(e => e.state), exec: (await execution(id)).state })
        .toEqual({ result: "uncertain", reason: "SAV_CASE_EFFECT_LEASE_LOST", effects: ["dispatched"], exec: "uncertain" });
      expect(sends).toBe(0); expect(providerCalls()).toBe(0);
    });
    it("a pause set WHILE the owner is being read (last look): the pause is judged after the read, nothing leaves, the effect goes back to planned", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); asked = [];
      onAsk = async n => { if (n === 3) await setPause("v2", "actions_paused"); };
      await run(id);
      expect(sends).toBe(0); expect(providerCalls()).toBe(0);
      expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
    });
    it("the case is read for its ticket from the case row: an execution whose sealed payload names another case is refused (no read of a ticket that is not the case's)", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); const other = await scenario("answer");
      await f.db.update(savCaseEffectExecutions).set({ caseId: other.caseId }).where(eq(savCaseEffectExecutions.id, id));
      asked = [];
      await run(id);
      expect(sends).toBe(0);
      expect(asked.every(t => t === other.ticketId)).toBe(true);
    });
  });

  describe("what already left is only verified and settled, whoever owns the ticket now", () => {
    it.each(["human", "none", "unknown", "throw", "garbage"] as const)("a lost ACK, then the owner reads %s: the supervised pass verifies, confirms ONCE, never resends, and never asks the port", async kind => {
      const s = await scenario("answer"); const id = await lostAck(s); reading = kind; asked = []; await letReconcile();
      expect(await run(id)).toMatchObject({ state: "confirmed" });
      expect({ sends, effects: (await effectsOf(id)).map(e => e.state), asked }).toEqual({ sends: 1, effects: ["confirmed"], asked: [] });
    });
    it("a lost ACK with NO port at all: the same verification, the same single mail", async () => {
      const s = await scenario("answer"); const id = await lostAck(s); await letReconcile();
      const bare = createCaseEffectDriver({ env: () => environment, currentPolicyRevision: async () => POLICY } as never);
      expect(await run(id, bare)).toMatchObject({ state: "confirmed" });
      expect(sends).toBe(1);
    });
    it("the runtime pass: with NO port, nothing new starts (supervisedSkipped) but the verification of an uncertain send still runs and confirms it", async () => {
      const s = await scenario("answer"); const id = await lostAck(s); await letReconcile();
      const result = await pass({ readTicketOwner: undefined as never });
      expect(result.supervisedSkipped).toBe("owner_port_absent");
      expect(result.recovery.length).toBeGreaterThan(0);
      expect((await effectsOf(id)).map(e => e.state)).toEqual(["confirmed"]);
      expect(sends).toBe(1);
    });
    it("the runtime pass: a port that throws is never consulted by the verification, which confirms the one mail", async () => {
      const s = await scenario("answer"); const id = await lostAck(s); await letReconcile(); reading = "throw"; asked = [];
      await pass({ readTicketOwner: synOwner });
      expect((await effectsOf(id)).map(e => e.state)).toEqual(["confirmed"]);
      expect(sends).toBe(1);
      expect(asked).toEqual([]);
    });
    it("a ledger row already confirmed is SETTLED (finish runs) although the ticket is owned by a person now; the case records nothing (a person owns it); no resend", async () => {
      const s = await scenario("question"); const id = await crashBeforeFinish(s); reading = "human"; asked = [];
      await run(id);
      expect(sends).toBe(1); expect(asked).toEqual([]);
      expect((await execution(id)).state).toBe("confirmed");
    });
  });

  describe("the driver's own gate", () => {
    it("a plan or a marker that did not come through the guard is held: each ledger write consumes ONE reading granted by the preflight", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); const d = driver();
      const claimed = await d.claim(id);
      if (!("lease" in claimed)) throw Error("SYN_NOT_CLAIMED");
      const intent = (await d.nextIntent(claimed.lease, [], options))!;
      await expect(ensureExecutionEffect(claimed.lease, intent)).rejects.toThrow("SAV_CASE_EFFECT_HOLD_OWNER_UNCHECKED");
      expect(await effectsOf(id)).toEqual([]);
      await d.preflight(claimed.lease, options, intent);
      const planned = await ensureExecutionEffect(claimed.lease, intent);
      await expect(markEffectDispatched(claimed.lease, planned)).rejects.toThrow("SAV_CASE_EFFECT_HOLD_OWNER_UNCHECKED");
      expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]); expect(sends).toBe(0);
    });
  });

  describe("before the claim (the minimal identifiers)", () => {
    it.each(NOT_V2)("%s: the runtime pass does not claim the execution; a person on the ticket ends it, any other answer skips it for now", async kind => {
      const s = await scenario("answer"); const { id } = await admit(s); reading = kind; asked = [];
      const result = await pass({ readTicketOwner: synOwner });
      expect(result.supervised).toEqual([{ executionId: id, state: kind === "human" ? "refused" : "skipped", reason: kind === "human" ? PASS_REASON.human : PASS_REASON[kind] }]);
      const row = await execution(id);
      expect({ token: row.leaseToken, until: row.leaseUntil, state: row.state }).toEqual({ token: null, until: null, state: kind === "human" ? "refused" : "pending" });
      expect(asked).toEqual([s.ticketId]); expect(providerCalls()).toBe(0); expect(sends).toBe(0);
    });
    it("the pre-claim cancellation never touches an execution that has a send in flight or past (it is verified, not cancelled)", async () => {
      const s = await scenario("answer"); const id = await lostAck(s); reading = "human"; asked = [];
      await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'waiting', lease_token = NULL, lease_until = NULL WHERE id = '${id}'`);
      expect(await ownerBeforeClaim(id, synOwner)).toMatchObject({ ok: false, code: "owner_human", ended: false });
      expect((await execution(id)).state).toBe("waiting");
    });
    it("a leased execution is never cancelled by the pre-claim read (the owner of the lease decides)", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); reading = "human";
      await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'running', lease_token = gen_random_uuid(), lease_until = now() + interval '5 minutes' WHERE id = '${id}'`);
      expect(await ownerBeforeClaim(id, synOwner)).toMatchObject({ ok: false, code: "owner_human", ended: false });
      expect((await execution(id)).state).toBe("running");
    });
    it("v2: the pass claims and sends once (the pre-claim read, then plan, marker and last look: 4 reads)", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); asked = [];
      const result = await pass({ readTicketOwner: synOwner });
      expect(result.supervised).toMatchObject([{ executionId: id, state: "confirmed" }]);
      expect(sends).toBe(1); expect(asked).toEqual([s.ticketId, s.ticketId, s.ticketId, s.ticketId]);
    });
  });
});
