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
import { getExecutionEffects } from "../intake/execution-store";
import type { ExecutionOptions, ExecutorAdapters } from "../intake/execution-types";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { createCaseEffectDriver } from "./case-effect-driver";
import { caseReplyPayloadHash, inboundInteractionId, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply, type CaseEffectNote } from "./case-reply-store";
import * as replyFacts from "./case-reply-facts";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { proposeCaseReplyFromDraft, queueValidatedCaseReply, type CaseReplyDraftInput } from "./case-runtime-effects";

// SAV-10 (pole C), C7-LAST-LOOK-LEASE-INPUT (the lease is judged after the last wait; a customer message known before the provider makes the reply stale; the scaffold is the one of C5/C6): NEW reply work needs the current CRM owner of the ticket, read through a required server port; the scaffold below is the one of the reviewer's probes
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
const run = (id: string, d = driver(), opts: ExecutionOptions = options) => executeIntakePass(id, opts, {}, d);
const execution = async (id: string) => (await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, id)))[0]!;
const effectsOf = (id: string) => getExecutionEffects(id);
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
const outbound = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed");
const providerCalls = () => Object.values(counts).reduce((a, b) => a + b, 0);
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

const noteOf = (s: Scenario): CaseEffectNote => ({ interactionId: inboundInteractionId(s.gmailMessageId), text: "Synthetic interaction note.", at: "2026-10-30T10:00:00.000Z" });
async function admitWithNote(s: Scenario) {
  const proposed = await propose(s); await approve(proposed.validationId);
  const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), note: noteOf(s), deps: storeDeps() });
  if (!queued.ok) throw Error(`QUEUE_REFUSED:${queued.code}`);
  return { id: queued.executionId, validationId: proposed.validationId };
}
const journalOf = async (id: string) => (await f.db.select({ kind: savIntakeEffectJournal.kind }).from(savIntakeEffectJournal).where(eq(savIntakeEffectJournal.executionId, id))).map(r => r.kind);
const NEW_INPUT = "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT";
/** A SECOND real customer mail of the same case: a stored message in the same thread, and its confirmed case event. Returns what a reply to it needs. */
async function secondInbound(s: Scenario) {
  const gmailMessageId = `gm-${randomUUID()}`;
  await f.db.insert(savMessages).values({
    threadId: s.thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "Customer@Example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic follow-up",
    bodyCiphertext: encryptSavPayload({ text: "The synthetic follow-up.", headers: { "message-id": `<${gmailMessageId}@example.invalid>` }, attachments: [] }), receivedAt: new Date("2026-10-28T07:45:00.000Z"),
  });
  p.setGmail(gmailMessageId, s.gmailThreadId);
  const { case: opened } = await openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:45:00.000Z" });
  return { gmailMessageId, version: (await readCase(opened.caseId))!.version };
}

describe("C7: the lease is judged after the LAST wait, and a customer message known before the provider makes the reply stale", () => {
  describe("the lease clock", () => {
    /** The clock jumps right after the `nth` case-facts read made once `armedBy()` is true (1 = the next read, 2 = the one after it). */
    const jumpOn = (name: "readCaseReplyFacts", armedBy: () => boolean, nth = 1) => {
      const original = replyFacts[name]; let seen = 0;
      vi.spyOn(replyFacts, name).mockImplementation(async (...args) => { const facts = await original(...args); if (armedBy() && ++seen === nth) vi.setSystemTime(Date.now() + 100_000); return facts; });
    };
    it("the MARKER's gate waits on the case lock and the lease runs out during it: no marker is written, nothing leaves", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); let armed = false;
      jumpOn("readCaseReplyFacts", () => armed, 2); // the 1st read after beforeMarker is the preflight's final look, the 2nd is the marker's own gate
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date());
      try { await executeIntakePass(id, options, { beforeMarker: async () => { armed = true; } }, driver()); } finally { vi.useRealTimers(); }
      expect(sends).toBe(0); expect(providerCalls()).toBe(0);
      expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
    });
    it("the FINAL look: the lease runs out during the last case/validation reads: nothing leaves, the marked effect stays engaged (no withdrawal without a lease)", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); let armed = false;
      jumpOn("readCaseReplyFacts", () => armed);
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date());
      try { await executeIntakePass(id, options, { afterMarker: async () => { armed = true; } }, driver()); } finally { vi.useRealTimers(); }
      expect(sends).toBe(0); expect(providerCalls()).toBe(0);
      expect((await effectsOf(id)).map(e => e.state)).toEqual(["dispatched"]);
    });
    it("the lease still valid after the last wait: the mail leaves ONCE (nominal)", async () => {
      const s = await scenario("answer"); const { id } = await admit(s);
      expect(await run(id)).toMatchObject({ state: "confirmed" }); expect(sends).toBe(1);
    });
  });

  describe("a customer message known before the provider call", () => {
    it.each(["answer", "question"] as const)("%s: the marked reply is stale: nothing leaves, the effect goes back to planned, the parent is cancelled, the case records nothing", async purpose => {
      const s = await scenario(purpose); const { id } = await admit(s);
      const result = await executeIntakePass(id, options, { afterMarker: async () => { await secondInbound(s); } }, driver());
      expect(result).toEqual({ state: "waiting", reason: NEW_INPUT, executionId: id });
      expect({ sends, providerCalls: providerCalls() }).toEqual({ sends: 0, providerCalls: 0 });
      expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
      expect((await execution(id)).state).toBe("refused");
      expect(await journalOf(id)).toContain("dispatch_withdrawn");
      expect(await outbound(s.caseId)).toEqual([]); expect((await readCase(s.caseId))!.body.questions).toEqual([]); expect(await listCaseTimers(s.caseId)).toEqual([]);
    });
    it("before the marker too (plan / marker gate): the cancelled parent never plans a new mail", async () => {
      const s = await scenario("answer"); const { id } = await admit(s); await secondInbound(s);
      expect(await run(id)).toMatchObject({ reason: NEW_INPUT });
      expect(sends).toBe(0); expect(await effectsOf(id)).toEqual([]);
    });
    it("the cancelled attempt spent nothing: the NEW mail gets its own proposal, approval and execution (a new key) and exactly ONE mail leaves in all", async () => {
      const s = await scenario("answer"); const old = await admit(s); let next: Awaited<ReturnType<typeof secondInbound>> | null = null;
      await executeIntakePass(old.id, options, { afterMarker: async () => { next = await secondInbound(s); } }, driver());
      expect(sends).toBe(0); expect((await execution(old.id)).state).toBe("refused");
      const proposed = await propose(s, { triggerEventId: `inbound:${next!.gmailMessageId}`, decidedOn: next!.version });
      await approve(proposed.validationId);
      const queued = await queueValidatedCaseReply({ validationId: proposed.validationId, policy: policyArg(), deps: storeDeps() });
      if (!queued.ok) throw Error(`QUEUE_REFUSED:${queued.code}`);
      expect(queued.executionId).not.toBe(old.id);
      expect(await run(queued.executionId)).toMatchObject({ state: "confirmed" });
      expect(sends).toBe(1);
      expect((await execution(old.id)).state).toBe("refused");
      expect((await effectsOf(old.id)).map(e => e.state)).toEqual(["planned"]);
      expect((await effectsOf(queued.executionId)).map(e => e.state)).toEqual(["confirmed"]);
    });
    it("a send that ALREADY left is only verified: a customer message after it cancels nothing and never resends", async () => {
      const s = await scenario("answer"); const id = await lostAck(s); await secondInbound(s); asked = []; await letReconcile();
      expect(await run(id)).toMatchObject({ state: "confirmed" });
      expect({ sends, effects: (await effectsOf(id)).map(e => e.state), exec: (await execution(id)).state }).toEqual({ sends: 1, effects: ["confirmed"], exec: "confirmed" });
      expect(asked).toEqual([]);
    });
    it("a NOTE is not recalled by a customer message (it describes an interaction that already happened)", async () => {
      const s = await scenario("answer"); const { id } = await admitWithNote(s); let markers = 0;
      const result = await executeIntakePass(id, options, { afterMarker: async () => { markers += 1; if (markers === 2) await secondInbound(s); } }, driver());
      expect(result).toMatchObject({ state: "confirmed" });
      expect({ sends, notes: Object.keys(p.objects.notes).length }).toEqual({ sends: 1, notes: 1 });
    });
  });
});
