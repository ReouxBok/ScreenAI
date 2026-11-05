import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { finalReplyText } from "../../../../test/sav-case-reply-text";
import { executionProvider } from "../../../../test/sav-intake-execution-provider";
const state = vi.hoisted(() => ({ db: null as unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot-transport", async importOriginal => {
  const { virtualSavHubspotTransportModule } = await import("../../../../test/sav-virtual-hubspot-transport");
  return virtualSavHubspotTransportModule(await importOriginal<typeof import("../hubspot-transport")>());
});
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { savCaseEffectExecutions, savIntakeEffects, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "../intake/execution-policy";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { executeIntakePass } from "../intake/executor";
import { ensureExecutionEffect, getExecutionEffects, markEffectDispatched } from "../intake/execution-store";
import type { ExecutionOptions } from "../intake/execution-types";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { createCaseEffectDriver, createCaseEffectRecoveryDriver } from "./case-effect-driver";
import { caseEffectSchemaInstalled, CASE_RECOVERY_LIST_LIMIT, pendingCaseEffectRecoveries, recoverCaseEffects } from "./case-effect-recovery";
import { caseReplyPayloadHash, inboundInteractionId, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply, enqueueApprovedCaseReply, submitCaseReplyProposal, type CaseEffectNote } from "./case-reply-store";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { nextJ2Slot } from "./j2-calendar";

// SAV-10 on the REAL executor: `executeIntakePass` with the case driver, the real ledger (sav.intake_effects), the real Gmail/HubSpot adapters on the
// synthetic provider (no socket), the real SAV-5 case store. Nothing here reaches a provider.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, policyHash: string, environment: Record<string, string | undefined>, options: ExecutionOptions;
let p: ReturnType<typeof executionProvider>, sends = 0, loseAck = false, ticketSeq = 9_400_000;
let gmailPaths: string[] = [], forbidden: string[] = [];
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
const setV2Pause = (level: "actions_paused" | "fully_paused" | null) => setPause("v2", level);

async function scenario(purpose: CaseReplyProposal["purpose"] = "question", extra: { note?: boolean; text?: string } = {}) {
  const gmailThreadId = `gmail-thread-${randomUUID()}`, gmailMessageId = `gm-${randomUUID()}`, ticketId = String(++ticketSeq);
  const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId, customerEmail: "customer@example.invalid" }).returning())[0]!;
  const message = (await f.db.insert(savMessages).values({
    threadId: thread.id, mailboxId, direction: "inbound", gmailMessageId, fromEmail: "customer@example.invalid", toEmails: ["support@example.invalid"], subject: "Synthetic connection failure",
    bodyCiphertext: encryptSavPayload({ text: "The synthetic connection fails.", headers: { "message-id": "<incoming@example.invalid>" }, attachments: [] }), receivedAt: new Date("2026-10-28T07:00:00.000Z"),
  }).returning())[0]!;
  const { case: opened } = await openCaseEvent({ ticketId, threadId: thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmailMessageId), sourceRef: { type: "email", id: gmailMessageId }, occurredAt: "2026-10-28T07:00:00.000Z" });
  p = executionProvider(); p.setGmail(gmailMessageId, gmailThreadId); p.seedTicket({ id: ticketId });
  sends = 0; loseAck = false; gmailPaths = [];
  const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    gmailPaths.push(path);
    if (path === "messages/send") sends += 1;
    const result = await p.gmail<T>(mailbox, path, init);
    if (path === "messages/send" && loseAck) throw Error("SAV_TEST_ACK_LOST");
    return result;
  };
  options = { ...options, adapters: createIntakeExecutorAdapters({ network: p.network, gmailRequest: gmail, gmailPermissions: async () => { }, env: () => environment }) };
  const snapshot = (await readCase(opened.caseId))!;
  const proposal: CaseReplyProposal = {
    caseId: opened.caseId, caseVersion: snapshot.version, triggerEventId: `inbound:${gmailMessageId}`, inboundMessageId: message.id, purpose, recipient: "customer@example.invalid",
    subject: "Synthetic connection failure", text: finalReplyText(extra.text ?? "SYNTHETIC reply.\nSignature kept exactly."),
    ...(purpose === "question" ? { question: { id: "q1", text: "SYNTHETIC question?", factKeys: [] } } : {}),
  };
  const note: CaseEffectNote | undefined = extra.note ? { interactionId: inboundInteractionId(gmailMessageId), text: "Synthetic interaction note.", at: "2026-10-30T10:00:00.000Z" } : undefined;
  return { caseId: opened.caseId, thread, message, ticketId, gmailMessageId, gmailThreadId, proposal, note };
}
const APPROVER = "20000000-0000-4000-8000-000000000003";
const allow: CaseReplyAuthorizer = () => ({ allowed: true, basis: "fixture.allow" });
const storeDeps = (env: () => Record<string, string | undefined> = () => environment) => ({ env, readTicketOwner: async () => "v2" as const, currentPolicyRevision: async () => POLICY });
const seenOf = (proposal: CaseReplyProposal) => ({ payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient });
/** The whole durable path: the proposal is stored, a person approves what they saw, the execution is queued from the stored validation. */
async function validate(proposal: CaseReplyProposal) {
  const submitted = await submitCaseReplyProposal(proposal, storeDeps());
  if (!submitted.ok) throw Error(`SUBMIT_REFUSED:${submitted.code}`);
  const decided = await decideCaseReply({ action: "approve", validationId: submitted.id, approverId: APPROVER, seen: seenOf(proposal), authorizer: allow, deps: storeDeps() });
  if (!decided.ok) throw Error(`APPROVE_REFUSED:${decided.code}`);
  return submitted.id;
}
const queue = (validationId: string, note?: CaseEffectNote) => enqueueApprovedCaseReply({ validationId, policy: { id: policyId, hash: policyHash }, ...(note ? { note } : {}), deps: storeDeps() });
async function admit(s: { proposal: CaseReplyProposal; note?: CaseEffectNote }) {
  const validationId = await validate(s.proposal), queued = await queue(validationId, s.note);
  if (!queued.ok) throw Error(`ENQUEUE_REFUSED:${queued.code}`);
  return { id: queued.executionId, created: queued.created, validationId };
}
const run = (id: string, hooks: Parameters<typeof executeIntakePass>[2] = {}, d = driver()) => executeIntakePass(id, options, hooks, d);
const execution = async (id: string) => (await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, id)))[0]!;
const effectsOf = (id: string) => getExecutionEffects(id);
const letReconcile = () => f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL");
const outbound = async (caseId: string) => (await listCaseEvents(caseId)).filter(event => event.kind === "outbound_observed");

beforeAll(async () => {
  f = await createSavTestDb(); state.db = f.db;
}, 60_000);
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
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await setV2Pause(null); await setPause("intake", null); });

// ---------------------------------------------------------------------------------------------------------------------------------
// SAV-10 recovery: the verification-only pass over case effects whose send may have left. Everything runs on the REAL executor, ledger and case store with
// the synthetic provider (no socket). EVERY test also asserts, in afterEach, that no forbidden port (dispatch / readCrm / gmailCurrent / scope) was called.
// ---------------------------------------------------------------------------------------------------------------------------------
afterEach(() => { expect(forbidden).toEqual([]); forbidden = []; });
// Each test starts from an empty recovery queue: what earlier tests left open is closed (refused executions are never listed nor claimed).
beforeEach(async () => { await f.client.exec("UPDATE sav.case_effect_executions SET state = 'refused' WHERE state NOT IN ('confirmed','refused')"); });
const recover = (overrides: Partial<Parameters<typeof recoverCaseEffects>[0]> = {}) => recoverCaseEffects({
  env: () => environment, currentPolicyRevision: async () => POLICY, deadlineMs: Date.now() + 60_000, adapters: options.adapters,
  context: { runtime: options.runtime, policy: options.policy }, onForbiddenPort: port => forbidden.push(port), ...overrides,
});
/** A write at a provider: a Gmail send, or any HubSpot call that is not a read (a search is a POST that reads). */
const hubspotWrites = () => p.calls.filter(call => ["PATCH", "PUT", "DELETE"].includes(call.method) || call.method === "POST" && !call.path.endsWith("/search")).length;
const traced = () => ({ sends, writes: hubspotWrites(), calls: p.calls.length, gmail: gmailPaths.length });
const sentinelOptions = (): ExecutionOptions => ({ ...options, adapters: { ...options.adapters, dispatch: async () => { forbidden.push("dispatch"); throw Error("SENTINEL_DISPATCH"); } } });
const crashAfterMarker = async (purpose: CaseReplyProposal["purpose"] = "question", extra: { note?: boolean } = {}) => {
  const s = await scenario(purpose, extra), { id } = await admit(s);
  expect(await run(id, { afterMarker: async () => { throw Error("SAV_TEST_CRASH"); } })).toMatchObject({ state: "uncertain" });
  // the crashed pass itself already counted one read and scheduled the next one 60 s later: let the schedule be reached, like the executor tests do
  await f.client.exec(`UPDATE sav.intake_effects SET next_reconcile_at = NULL WHERE execution_id = '${id}'`);
  return { s, id };
};
const lostAckSend = async (purpose: CaseReplyProposal["purpose"] = "question", extra: { note?: boolean } = {}) => {
  const s = await scenario(purpose, extra), { id } = await admit(s);
  loseAck = true; expect(await run(id)).toMatchObject({ state: "uncertain" }); loseAck = false; await letReconcile();
  expect(sends).toBe(1);
  return { s, id };
};
const takeover = (caseId: string) => readCase(caseId).then(snapshot => transitionCaseOwner({ caseId, expectedVersion: snapshot!.version, transition: "human_takeover", actor: staff, commandKey: `cmd-${randomUUID()}`, reason: "fixture" }));
const customerWrites = (s: Awaited<ReturnType<typeof scenario>>) =>
  openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`recovery-${randomUUID()}`), sourceRef: { type: "email", id: "recovery" }, occurredAt: "2026-10-28T07:45:00.000Z" });

describe("a lost ACK is found, confirmed and recorded by the recovery pass: once, with the real send date, and nothing is written at a provider", () => {
  it("verifies the mail that left, confirms the effect, records the mail / question / ONE J2 from the Gmail date, and a second tick finds nothing due", async () => {
    const { s, id } = await lostAckSend("question");
    const before = traced();
    expect(await pendingCaseEffectRecoveries()).toMatchObject([{ id }]);
    const result = await recover();
    expect(result).toMatchObject({ executionId: id, listed: 1, state: "confirmed" });
    expect(traced().sends).toBe(before.sends); expect(traced().writes).toBe(before.writes);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
    const timers = await listCaseTimers(s.caseId), [effect] = await effectsOf(id), ack = decryptSavPayload<{ sentAt?: string }>(effect!.ackCiphertext!);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.sentAt).toBe(new Date(ack.sentAt ?? effect!.dispatchedAt!).toISOString());
    expect(timers[0]!.dueAt).toBe(nextJ2Slot(new Date(timers[0]!.sentAt)).toISOString());
    const after = traced();
    expect(await recover()).toEqual({ skipped: "nothing_due" });
    expect(traced()).toEqual(after);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("a crash after the marker with no mail stays uncertain: one more read counted, the next one scheduled 60 s later, no mail, no question, no J2", async () => {
    const { s, id } = await crashAfterMarker("question");
    const before = traced(), at = Date.now();
    expect(await recover()).toMatchObject({ executionId: id, state: "uncertain", effects: [{ state: "uncertain", reconcileAttempts: 2 }] });
    expect(traced().sends).toBe(before.sends); expect(traced().writes).toBe(before.writes);
    const [effect] = await effectsOf(id);
    expect(effect!.nextReconcileAt!.getTime()).toBeGreaterThan(at + 50_000);
    expect(effect!.nextReconcileAt!.getTime()).toBeLessThan(Date.now() + 70_000);
    expect(await outbound(s.caseId)).toEqual([]);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
  });

  it("a customer who wrote again before the tick: the mail is confirmed and journaled with its question, never cancelled, never resent; no J2 (the customer already moved past the question)", async () => {
    const { s, id } = await lostAckSend("question");
    await customerWrites(s);
    expect(await recover()).toMatchObject({ executionId: id, state: "confirmed" });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect(await effectsOf(id)).toHaveLength(1);
  });

  // C-ATOMIC-RECEIPT (decided by ROOT, replaces "a takeover does not stop the record"): the receipt reads the owner under the case lock, in the one transaction that writes it.
  it("a person who took the case over before the tick: the mail is confirmed in the ledger, never cancelled, never resent; the case records NOTHING (no mail event, no question, no J2)", async () => {
    const { s, id } = await lostAckSend("question");
    await takeover(s.caseId);
    expect(await recover()).toMatchObject({ executionId: id, state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED" });
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await pendingCaseEffectRecoveries()).map(row => row.id)).not.toContain(id);
  });

  it("a V2 FULL pause does not stop the verification but holds the recording; the V2 pause is lifted afterwards and the next tick records it once", async () => {
    const { s, id } = await lostAckSend("question");
    await setV2Pause("fully_paused");
    expect(await recover()).toMatchObject({ executionId: id, state: "waiting", reason: "SAV_CASE_EFFECT_RECEIPT_HELD_BY_PAUSE" });
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(0);
    await setV2Pause(null);
    expect(await recover()).toMatchObject({ executionId: id, state: "confirmed" });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("an INTAKE pause (any level) reads nothing from any provider and changes nothing; after it the mail is confirmed once", async () => {
    const { s, id } = await lostAckSend("question");
    const before = traced(), [effectBefore] = await effectsOf(id);
    for (const level of ["actions_paused", "fully_paused"] as const) {
      await setPause("intake", level);
      expect(await recover()).toMatchObject({ skipped: expect.stringMatching(/PAUSE/i) });
      expect(traced()).toEqual(before);
      const [effect] = await effectsOf(id);
      expect(effect).toMatchObject({ state: "uncertain", reconcileAttempts: effectBefore!.reconcileAttempts });
    }
    await setPause("intake", null);
    expect(await recover()).toMatchObject({ executionId: id, state: "confirmed" });
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("an effect whose schedule is not reached is not listed and nothing is read; with an explicit later clock it is listed again", async () => {
    const { id } = await crashAfterMarker("answer");
    await recover();
    const after = traced();
    expect(await pendingCaseEffectRecoveries()).toEqual([]);
    expect(await recover()).toEqual({ skipped: "nothing_due" });
    expect(traced()).toEqual(after);
    expect((await pendingCaseEffectRecoveries(CASE_RECOVERY_LIST_LIMIT, new Date(Date.now() + 61_000))).map(row => row.id)).toEqual([id]);
  });

  it("an effect read 5 times is never listed again, never read again, stays uncertain (the monitor's critical alert is its only voice)", async () => {
    const { id } = await crashAfterMarker("answer");
    await f.client.exec("UPDATE sav.intake_effects SET reconcile_attempts = 5, next_reconcile_at = NULL");
    const before = traced();
    expect(await pendingCaseEffectRecoveries(CASE_RECOVERY_LIST_LIMIT, new Date(Date.now() + 3_600_000))).toEqual([]);
    expect(await recover()).toEqual({ skipped: "nothing_due" });
    expect(traced()).toEqual(before);
    expect(await effectsOf(id)).toMatchObject([{ state: "uncertain", reconcileAttempts: 5 }]);
  });

  it("with SAV_CASE_EFFECTS off a possibly sent mail is still verified (an engaged effect is verify-only before the mode is even read); nothing is sent", async () => {
    const { s, id } = await lostAckSend("answer");
    environment = { ...environment, SAV_CASE_EFFECTS: "off" };
    expect(await recover()).toMatchObject({ executionId: id, state: "confirmed" });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
  });
});

describe("the recovery pass never takes the place of the supervised pass", () => {
  it("a reply whose receipt was lost AND whose note is still to do: the mail is confirmed and recorded, no note marker and no HubSpot write is made; the supervised pass then adds the note once", async () => {
    const { s, id } = await lostAckSend("question", { note: true });
    const writesBefore = hubspotWrites();
    expect(await recover()).toMatchObject({ executionId: id, state: "waiting", reason: "SAV_CASE_EFFECT_RECOVERY_NOTE_PENDING" });
    expect(hubspotWrites()).toBe(writesBefore);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(await recover()).toEqual({ skipped: "nothing_due" });
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }, { state: "confirmed" }, { state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("an execution nobody started (pending) and an effect given back to planned are neither listed nor processed: nothing is planned, marked or sent", async () => {
    const never = await admit(await scenario("question"));
    const s = await scenario("answer"), { id } = await admit(s);
    expect(await run(id, { afterMarker: async () => { await setV2Pause("fully_paused"); } })).toMatchObject({ state: "waiting" });
    await setV2Pause(null);
    const before = traced();
    expect(await effectsOf(id)).toMatchObject([{ state: "planned", dispatchedAt: null }]);
    expect(await effectsOf(never.id)).toEqual([]);
    expect(await pendingCaseEffectRecoveries(CASE_RECOVERY_LIST_LIMIT, new Date(Date.now() + 3_600_000))).toEqual([]);
    expect(await recover()).toEqual({ skipped: "nothing_due" });
    expect(traced()).toEqual(before);
    expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
    expect(await effectsOf(never.id)).toEqual([]);
    expect((await execution(never.id)).state).toBe("pending");
  });

  it("the recovery lease cannot plan or mark, its preflight / live refuse any intent or permission, and it finds nothing to verify on a planned effect", async () => {
    const s = await scenario("answer"), { id } = await admit(s);
    await run(id, { afterMarker: async () => { await setV2Pause("fully_paused"); } });
    await setV2Pause(null);
    const [planned] = await effectsOf(id);
    expect(planned).toMatchObject({ state: "planned" });
    const intent = decryptSavPayload<Parameters<typeof ensureExecutionEffect>[1]>(planned!.intentCiphertext);
    const rec = createCaseEffectRecoveryDriver({ env: () => environment, currentPolicyRevision: async () => POLICY });
    const claim = await rec.claim(id);
    if ("blocked" in claim) throw Error("CLAIM_BLOCKED");
    const { lease } = claim, o = sentinelOptions();
    await expect(markEffectDispatched(lease, planned!)).rejects.toThrow(/RECOVERY_NO_WRITE/);
    await expect(ensureExecutionEffect(lease, intent)).rejects.toThrow(/RECOVERY_NO_WRITE/);
    await expect(rec.preflight(lease, o, intent)).rejects.toThrow(/RECOVERY_NO_DISPATCH/);
    await expect(rec.live(lease, o, "send_case_reply")).rejects.toThrow(/RECOVERY_NO_DISPATCH/);
    await expect(rec.preflight(lease, o)).resolves.toBeUndefined();
    await expect(rec.live(lease, o)).resolves.toBeUndefined();
    expect(await rec.nextIntent(lease, await effectsOf(id), o)).toBeNull();
    await rec.end(lease, "waiting", "SAV_TEST_RELEASED");
    expect(await effectsOf(id)).toMatchObject([{ state: "planned", dispatchedAt: null, dispatchToken: null }]);
    expect(sends).toBe(0);
  });
});

describe("the state read before the claim, or before the verification, is not the state under the lease", () => {
  /** Runs the pass with the real recovery driver, changing the ledger / the execution at one precise point. `before` is "claim" (right after the lease is taken)
   * or "intent" (between the executor's own read of the effects and the driver's locked read). */
  async function raced(id: string, before: "claim" | "intent", change: () => Promise<unknown>) {
    const rec = createCaseEffectRecoveryDriver({ env: () => environment, currentPolicyRevision: async () => POLICY });
    const wrapped = before === "claim"
      ? { ...rec, claim: async (executionId: string) => { const claim = await rec.claim(executionId); await change(); return claim; } }
      : { ...rec, nextIntent: async (lease: Parameters<typeof rec.nextIntent>[0], effects: Parameters<typeof rec.nextIntent>[1], o: ExecutionOptions) => { await change(); return rec.nextIntent(lease, effects, o); } };
    return executeIntakePass(id, sentinelOptions(), {}, wrapped);
  }
  const setEffect = (assignments: string) => f.client.exec(`UPDATE sav.intake_effects SET ${assignments}`);

  // After the claim the executor reads the effects itself, so a change of attempt or retry count made BEFORE that read is simply the current state (still due: it is
  // verified); only a change made between the executor's read and the driver's locked read, or a change of state, can disagree with what the pass saw.
  for (const [name, assignments, points] of [
    ["given back to planned", "state = 'planned', dispatched_at = NULL, dispatch_token = NULL", ["claim", "intent"]],
    ["confirmed by another actor", "state = 'confirmed', confirmed_at = now()", ["intent"]],
    ["a new attempt", "attempt_id = gen_random_uuid()", ["intent"]],
    ["one more read counted", "reconcile_attempts = reconcile_attempts + 1", ["intent"]],
  ] as const) for (const point of points) {
    it(`the effect is ${name} right after ${point === "claim" ? "the claim" : "the executor's read"}: nothing is verified, deferred, planned, marked or sent, and the execution is never reported confirmed`, async () => {
      const { id } = await crashAfterMarker("question");
      await letReconcile();
      const before = traced();
      // The executor's own return value says "confirmed" whenever the driver has nothing left to verify; only the ledger is believed.
      await raced(id, point, () => setEffect(assignments));
      expect(traced()).toEqual(before);
      const [effect] = await effectsOf(id);
      if (name === "given back to planned") expect(effect).toMatchObject({ state: "planned", dispatchedAt: null, reconcileAttempts: 1 });
      if (name === "confirmed by another actor") expect(effect).toMatchObject({ state: "confirmed" });
      expect((await execution(id)).state).not.toBe("confirmed");
    });
  }

  it("a lease that expired after the claim ends the pass without a read or a write on the ledger", async () => {
    const { id } = await crashAfterMarker("answer");
    const before = traced();
    const result = await raced(id, "intent", () => f.client.exec(`UPDATE sav.case_effect_executions SET lease_until = now() - interval '1 second' WHERE id = '${id}'`));
    expect(result).toMatchObject({ reason: expect.stringMatching(/LEASE_LOST/) });
    expect(traced()).toEqual(before);
    expect(await effectsOf(id)).toMatchObject([{ state: "uncertain", reconcileAttempts: 1 }]);
  });

  it("an execution refused after it was listed is not claimed", async () => {
    const { id } = await crashAfterMarker("answer");
    expect(await pendingCaseEffectRecoveries()).toMatchObject([{ id }]);
    await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'refused' WHERE id = '${id}'`);
    const before = traced();
    expect(await executeIntakePass(id, sentinelOptions(), {}, createCaseEffectRecoveryDriver({ env: () => environment, currentPolicyRevision: async () => POLICY }))).toEqual({ skipped: "occupied" });
    expect(traced()).toEqual(before);
    expect(await pendingCaseEffectRecoveries()).toEqual([]);
  });
});

describe("bounded, fair, and nothing at all before the existing guards say yes", () => {
  it("lists at most 20; one execution per tick; exhausted effects take no place; each eligible execution is visited exactly once before the clock moves, then in the same order", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 24; n++) ids.push((await crashAfterMarker("answer")).id);
    const exhausted = new Set([ids[3]!, ids[10]!, ids[17]!]), eligible = ids.filter(id => !exhausted.has(id));
    for (const id of exhausted) await f.client.exec(`UPDATE sav.intake_effects SET reconcile_attempts = 5 WHERE execution_id = '${id}'`);
    await f.client.exec("UPDATE sav.intake_effects SET next_reconcile_at = NULL WHERE reconcile_attempts < 5");
    const listing = await pendingCaseEffectRecoveries(500);
    expect(listing).toHaveLength(CASE_RECOVERY_LIST_LIMIT);
    expect(listing.map(row => row.id)).toEqual(eligible.slice(0, CASE_RECOVERY_LIST_LIMIT));
    const visited: string[] = [];
    for (let tick = 0; tick < eligible.length; tick++) {
      const result = await recover();
      if (!("executionId" in result)) throw Error(`TICK_${tick}_${JSON.stringify(result)}`);
      expect(result.listed).toBeLessThanOrEqual(CASE_RECOVERY_LIST_LIMIT);
      visited.push(result.executionId);
    }
    expect(visited).toEqual(eligible);
    expect(await recover()).toEqual({ skipped: "nothing_due" });
    for (const id of exhausted) expect(await effectsOf(id)).toMatchObject([{ state: "uncertain", reconcileAttempts: 5 }]);
    const later = await pendingCaseEffectRecoveries(CASE_RECOVERY_LIST_LIMIT, new Date(Date.now() + 61_000));
    expect(later.map(row => row.id)).toEqual(visited.slice(0, CASE_RECOVERY_LIST_LIMIT));
  }, 120_000);

  it("two ticks at the same instant: one confirmation, one mail, one J2 (PGlite serialises its statements: the native race is not claimed here)", async () => {
    const { s, id } = await lostAckSend("question");
    const results = await Promise.all([recover(), recover()]);
    expect(results.filter(result => "state" in result && result.state === "confirmed")).toHaveLength(1);
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(await effectsOf(id)).toHaveLength(1);
  });

  it("nothing is read before the guards: off / unset mode, a kill switch, a missing policy, an absent schema, no runtime pins", async () => {
    state.db = null;
    try {
      expect(await recover({ env: () => ({ ...environment, SAV_INTAKE_EXECUTION_MODE: undefined }) })).toEqual({ skipped: "off" });
      expect(await recover({ env: () => ({ ...environment, SAV_INTAKE_EXECUTION_MODE: "off" }) })).toEqual({ skipped: "off" });
      expect(await recover({ env: () => ({ ...environment, SAV_WRITES_DISABLED: "true" }) })).toEqual({ skipped: "SAV_INTAKE_EXECUTION_DISABLED" });
      expect(await recover({ env: () => ({ ...environment, SAV_INTAKE_EXECUTION_KILL_SWITCH: "1" }) })).toEqual({ skipped: "SAV_INTAKE_EXECUTION_DISABLED" });
      expect(await recover({ env: () => ({ ...environment, SAV_INTAKE_EXECUTION_POLICY_ID: undefined }) })).toEqual({ skipped: "SAV_INTAKE_EXECUTION_CONFIGURATION_REQUIRED" });
      expect(await recover({ schemaInstalled: async () => false })).toEqual({ skipped: "schema_absent" });
    } finally { state.db = f.db; }
    const before = traced();
    expect(await recover({ context: undefined })).toEqual({ skipped: "observation_required" });
    expect(traced()).toEqual(before);
    expect(await caseEffectSchemaInstalled()).toBe(true);
  });
});

// Independent review: the provider read yields, and ownership/attempt changes BEFORE the old read returns.
// No author assertion is changed. This synthetic interleaving exercises the after-provider CAS gap, not native concurrency.
describe("REVIEW stale verification after lease/attempt moved", () => {
  it("REVIEW old positive proof cannot confirm a later attempt after the lease moved during verify", async () => {
    const { s, id } = await lostAckSend("question");
    const newAttempt = randomUUID(), newLease = randomUUID();
    let reads = 0;
    await recover({ adapters: { verify: async (...args) => {
      reads += 1;
      const proof = await options.adapters.verify(...args);
      expect(proof).toMatchObject({ confirmed: true, attributed: true });
      await f.db.update(savCaseEffectExecutions).set({ leaseToken: newLease, leaseUntil: new Date(Date.now()+60_000) }).where(eq(savCaseEffectExecutions.id, id));
      await f.db.update(savIntakeEffects).set({ attemptId: newAttempt, reconcileAttempts: 4, state: "uncertain" }).where(eq(savIntakeEffects.executionId, id));
      return proof;
    } } });
    expect(reads).toBe(1);
    const [effect] = await effectsOf(id);
    expect(effect).toMatchObject({ attemptId: newAttempt, state: "uncertain", reconcileAttempts: 4 });
    expect((await execution(id)).leaseToken).toBe(newLease);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect(sends).toBe(1);
  });
  it("REVIEW old negative proof cannot consume a later attempt's retry after the lease moved during verify", async () => {
    const { id } = await crashAfterMarker("answer");
    const newAttempt = randomUUID(), newLease = randomUUID();
    let reads = 0;
    await recover({ adapters: { verify: async () => {
      reads += 1;
      await f.db.update(savCaseEffectExecutions).set({ leaseToken: newLease, leaseUntil: new Date(Date.now()+60_000) }).where(eq(savCaseEffectExecutions.id, id));
      await f.db.update(savIntakeEffects).set({ attemptId: newAttempt, reconcileAttempts: 4, state: "uncertain" }).where(eq(savIntakeEffects.executionId, id));
      return { confirmed: false, attributed: false };
    } } });
    expect(reads).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ attemptId: newAttempt, state: "uncertain", reconcileAttempts: 4 }]);
    expect((await execution(id)).leaseToken).toBe(newLease);
    expect(sends).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// R1 (review of 998d318): the provider read yields; the lease or the effect can move before its answer is applied. The answer is applied only by
// `applyVerification`, in ONE transaction that locks the execution then the exact effect and re-checks every component. The two REVIEW tests above are
// immutable; the matrix below changes ONE component at a time, DURING the read, for a positive, a negative and a failed read. PGlite has one connection:
// this is a deterministic interleaving of awaits, not native concurrency (see the report).
// ---------------------------------------------------------------------------------------------------------------------------------
const STALE = "SAV_INTAKE_EXECUTION_VERIFICATION_STALE";
type ReadKind = "positive" | "negative" | "error";
const effectById = async (effectId: string) => (await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, effectId)))[0]!;
const journalKinds = async (id: string) => Object.fromEntries((await f.client.query<{ kind: string; n: number }>(`SELECT kind, count(*)::int AS n FROM sav.intake_effect_journal WHERE execution_id = '${id}' GROUP BY kind`)).rows.map(r => [r.kind, r.n]));
const setupFor = (kind: ReadKind) => kind === "positive" ? lostAckSend("question") : crashAfterMarker("answer");

/** Runs one recovery tick whose provider read, once it has its answer and before returning it, lets `mutate` change the ledger. Nothing is asserted inside the read (the executor would absorb it). */
async function tickWithMutation(kind: ReadKind, mutate: (id: string, other: string) => Promise<void>) {
  const other = (await admit(await scenario())).id;
  const { s, id } = await setupFor(kind);
  const before = traced();
  const effectId = (await effectsOf(id))[0]!.id;
  const seen = { reads: 0, proof: undefined as unknown, changed: false, refused: undefined as string | undefined, effect: undefined as unknown, exec: undefined as unknown, journal: undefined as unknown };
  const result = await recover({ adapters: { verify: async (...args) => {
    seen.reads += 1;
    seen.proof = kind === "positive" ? await options.adapters.verify(...args) : undefined;
    const [effectBefore, execBefore] = [await effectById(effectId), await execution(id)];
    // a change the schema itself refuses is recorded, not swallowed: its test asserts the refusal
    try { await mutate(id, other); } catch (error) { seen.refused = error instanceof Error ? error.message : String(error); }
    seen.effect = await effectById(effectId); seen.exec = await execution(id); seen.journal = await journalKinds(id);
    seen.changed = JSON.stringify([effectBefore, execBefore]) !== JSON.stringify([seen.effect, seen.exec]);
    if (kind === "error") throw Error("SAV_TEST_PROVIDER_DOWN");
    return (seen.proof as { confirmed: boolean; attributed: boolean } | undefined) ?? { confirmed: false, attributed: false };
  } } });
  return { s, id, other, effectId, before, seen, result };
}

const MUTATIONS: readonly (readonly [string, (id: string, other: string) => Promise<void>])[] = [
  ["lease token (another owner took the execution)", async id => { await f.client.exec(`UPDATE sav.case_effect_executions SET lease_token = '${randomUUID()}' WHERE id = '${id}'`); }],
  ["lease expiry (the lease ran out)", async id => { await f.client.exec(`UPDATE sav.case_effect_executions SET lease_until = now() - interval '5 seconds' WHERE id = '${id}'`); }],
  ["execution state: waiting", async id => { await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'waiting' WHERE id = '${id}'`); }],
  ["execution state: uncertain", async id => { await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'uncertain' WHERE id = '${id}'`); }],
  ["execution state: confirmed", async id => { await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'confirmed' WHERE id = '${id}'`); }],
  ["execution state: refused", async id => { await f.client.exec(`UPDATE sav.case_effect_executions SET state = 'refused' WHERE id = '${id}'`); }],
  ["effect attempt id (a new attempt)", async id => { await f.client.exec(`UPDATE sav.intake_effects SET attempt_id = '${randomUUID()}' WHERE execution_id = '${id}'`); }],
  ["effect retry counter", async id => { await f.client.exec(`UPDATE sav.intake_effects SET reconcile_attempts = reconcile_attempts + 1 WHERE execution_id = '${id}'`); }],
  ["effect state: acked", async id => { await f.client.exec(`UPDATE sav.intake_effects SET state = 'acked' WHERE execution_id = '${id}'`); }],
  ["effect state: confirmed (another owner confirmed it)", async id => { await f.client.exec(`UPDATE sav.intake_effects SET state = 'confirmed', confirmed_at = now() WHERE execution_id = '${id}'`); }],
  ["effect state: planned (withdrawn)", async id => { await f.client.exec(`UPDATE sav.intake_effects SET state = 'planned', dispatch_token = NULL, dispatched_at = NULL WHERE execution_id = '${id}'`); }],
  ["effect kind", async id => { await f.client.exec(`UPDATE sav.intake_effects SET kind = 'note_create' WHERE execution_id = '${id}'`); }],
  ["effect business key", async id => { await f.client.exec(`UPDATE sav.intake_effects SET business_key = business_key || ':moved' WHERE execution_id = '${id}'`); }],
  ["effect permission", async id => { await f.client.exec(`UPDATE sav.intake_effects SET permission = 'append_case_note' WHERE execution_id = '${id}'`); }],
  ["effect intent hash", async id => { await f.client.exec(`UPDATE sav.intake_effects SET intent_hash = repeat('f', 64) WHERE execution_id = '${id}'`); }],
  ["effect marker (dispatched at)", async id => { await f.client.exec(`UPDATE sav.intake_effects SET dispatched_at = dispatched_at + interval '1 second' WHERE execution_id = '${id}'`); }],
  ["effect dispatch token", async id => { await f.client.exec(`UPDATE sav.intake_effects SET dispatch_token = '${randomUUID()}' WHERE execution_id = '${id}'`); }],
  ["effect next read schedule", async id => { await f.client.exec(`UPDATE sav.intake_effects SET next_reconcile_at = now() - interval '1 second' WHERE execution_id = '${id}'`); }],
  ["effect receipt (ack)", async id => { await f.db.update(savIntakeEffects).set({ ackCiphertext: encryptSavPayload({ id: "gm-other", threadId: "thread-other" }) }).where(eq(savIntakeEffects.executionId, id)); }],
  ["effect moved to another execution", async (id, other) => { await f.client.exec(`UPDATE sav.intake_effects SET execution_id = '${other}' WHERE execution_id = '${id}'`); }],
];

describe("R1: a verification read that outlived its lease, or whose effect moved, is discarded: no confirmation, no retry consumed, no finish, no J2, no mail", () => {
  for (const kind of ["positive", "negative", "error"] as const) {
    describe(`${kind} read`, () => {
      it.each(MUTATIONS)("%s changes during the read -> stale", async (_name, mutate) => {
        const { s, id, effectId, before, seen, result } = await tickWithMutation(kind, mutate);
        // the mutation really changed the ledger, the read really happened once, and a positive read really was a positive proof
        expect(seen.refused).toBeUndefined();
        expect(seen.changed).toBe(true);
        expect(seen.reads).toBe(1);
        if (kind === "positive") expect(seen.proof).toMatchObject({ confirmed: true, attributed: true });
        expect(result).toMatchObject({ executionId: id, skipped: STALE });
        // nothing was written after the mutation: effect, execution and journal are exactly what the mutation left
        expect(await effectById(effectId)).toEqual(seen.effect);
        expect(await execution(id)).toEqual(seen.exec);
        expect(await journalKinds(id)).toEqual(seen.journal);
        // and nothing left the building, nothing was recorded about the case
        expect(traced().sends).toBe(before.sends); expect(traced().writes).toBe(before.writes);
        expect(await outbound(s.caseId)).toEqual([]);
        expect(await listCaseTimers(s.caseId)).toEqual([]);
        expect((await readCase(s.caseId))!.body.questions).toHaveLength(0);
      });
    });
  }

  it("a kind that cannot belong to a case execution cannot be written at all: the schema refuses it, so the matrix does not need (and cannot have) that change", async () => {
    const { id } = await crashAfterMarker("answer");
    await expect(f.client.exec(`UPDATE sav.intake_effects SET kind = 'case_note' WHERE execution_id = '${id}'`)).rejects.toThrow(/cannot belong to a case execution/);
    expect(await effectsOf(id)).toMatchObject([{ kind: "reply_send" }]);
  });

  it("positive witness: with nothing moved, the same positive read confirms the effect ONCE and records the mail / question / ONE J2", async () => {
    const { s, id, before, seen, result } = await tickWithMutation("positive", async () => { });
    expect(seen.reads).toBe(1);
    expect(result).toMatchObject({ executionId: id, state: "confirmed", effects: [{ state: "confirmed" }] });
    expect((await journalKinds(id)).confirmed).toBe(1);
    expect(traced().sends).toBe(before.sends); expect(traced().writes).toBe(before.writes);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("negative witness: with nothing moved, a negative read consumes exactly ONE retry, schedules the next one 60 s later and ends the pass uncertain", async () => {
    const { id } = await crashAfterMarker("answer");
    const [effectBefore] = await effectsOf(id), journalBefore = await journalKinds(id), at = Date.now();
    expect(await recover({ adapters: { verify: async () => ({ confirmed: false, attributed: false }) } })).toMatchObject({ executionId: id, state: "uncertain", reason: "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED" });
    const [effect] = await effectsOf(id);
    expect(effect!.reconcileAttempts).toBe(effectBefore!.reconcileAttempts + 1);
    expect(effect!.nextReconcileAt!.getTime()).toBeGreaterThan(at + 50_000);
    expect((await journalKinds(id)).uncertain).toBe((journalBefore.uncertain ?? 0) + 1);
    expect(sends).toBe(0);
  });

  it("a failed provider read is ONE deferred read under the lease (never an unfenced defer, never two), with its own reason", async () => {
    const { id } = await crashAfterMarker("answer");
    const [effectBefore] = await effectsOf(id), journalBefore = await journalKinds(id);
    expect(await recover({ adapters: { verify: async () => { throw Error("SAV_TEST_PROVIDER_DOWN"); } } }))
      .toMatchObject({ executionId: id, state: "uncertain", reason: "SAV_INTAKE_EXECUTION_RECONCILIATION_UNAVAILABLE" });
    const [effect] = await effectsOf(id);
    expect(effect!.reconcileAttempts).toBe(effectBefore!.reconcileAttempts + 1);
    expect((await journalKinds(id)).uncertain).toBe((journalBefore.uncertain ?? 0) + 1);
    expect((await execution(id)).leaseToken).toBeNull();
  });

  it("the settlement itself failing rolls back: the effect is neither confirmed nor deferred (not even by the generic catch), the pass ends uncertain, nothing is recorded", async () => {
    const { s, id } = await lostAckSend("question");
    const [effectBefore] = await effectsOf(id), journalBefore = await journalKinds(id);
    // a proof that cannot be sealed (a BigInt) makes the confirmation throw INSIDE the transaction, after its first statements
    const result = await recover({ adapters: { verify: async () => ({ confirmed: true, attributed: true, ack: { id: "gm-x", threadId: "t-x" }, boom: BigInt(1) }) as never } });
    expect(result).toMatchObject({ executionId: id, state: "uncertain" });
    expect(await effectsOf(id)).toEqual([effectBefore]);
    expect(await journalKinds(id)).toEqual({ ...journalBefore, pass_waiting: (journalBefore.pass_waiting ?? 0) + 1 });
    expect((await execution(id)).leaseToken).toBeNull();
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toEqual([]);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
  });

  it("a discarded read is not lost for good: once the other owner is gone, the next tick verifies the effect with its OWN read, once", async () => {
    const { s, id } = await lostAckSend("question");
    expect(await recover({ adapters: { verify: async (...args) => {
      const proof = await options.adapters.verify(...args);
      await f.client.exec(`UPDATE sav.case_effect_executions SET lease_token = '${randomUUID()}' WHERE id = '${id}'`);
      return proof;
    } } })).toMatchObject({ skipped: STALE });
    expect(await outbound(s.caseId)).toEqual([]);
    await f.client.exec(`UPDATE sav.case_effect_executions SET lease_token = NULL, lease_until = NULL, state = 'waiting' WHERE id = '${id}'`);
    expect(await recover()).toMatchObject({ executionId: id, state: "confirmed" });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("the check and the write are ONE transaction (execution locked, then the effect); the recovery driver has the hook, and since C-NIGHT the supervised driver has the SAME one (it was the unfenced legacy path)", async () => {
    const { id } = await lostAckSend("question");
    const d = createCaseEffectRecoveryDriver(storeDeps());
    expect(typeof createCaseEffectDriver(storeDeps()).applyVerification).toBe("function");
    expect(typeof d.applyVerification).toBe("function");
    const claim = await d.claim(id);
    if (!("lease" in claim)) throw Error("CLAIM_BLOCKED");
    const [observed] = await effectsOf(id), spy = vi.spyOn(f.db, "transaction");
    expect(await d.applyVerification!(claim.lease, observed!, { error: "SAV_TEST_PROVIDER_DOWN" })).toBe("deferred");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    // the deferral scheduled the next read 60 s later: the effect read now is not due, so a settlement of it is stale and writes nothing
    const [notDue] = await effectsOf(id);
    expect(await d.applyVerification!(claim.lease, notDue!, { proof: { confirmed: true, attributed: true, ack: { id: "gm-x", threadId: "t-x" } } })).toBe("stale");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    await letReconcile();
    const [due] = await effectsOf(id);
    expect(await d.applyVerification!(claim.lease, due!, { proof: { confirmed: true, attributed: true, ack: { id: "gm-x", threadId: "t-x" } } })).toBe("confirmed");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
  });
});

describe("R1: the end of a recovery pass writes only while the pass still owns an unexpired lease", () => {
  const claimed = async () => {
    const { id } = await admit(await scenario());
    const d = createCaseEffectRecoveryDriver(storeDeps()), claim = await d.claim(id);
    if (!("lease" in claim)) throw Error("CLAIM_BLOCKED");
    return { id, d, lease: claim.lease };
  };
  it("witness: an owned, unexpired lease is ended and released, once", async () => {
    const { id, d, lease } = await claimed();
    await d.end(lease, "uncertain", "SAV_CASE_EFFECT_RECOVERY_NOT_DUE");
    expect(await execution(id)).toMatchObject({ state: "uncertain", reason: "SAV_CASE_EFFECT_RECOVERY_NOT_DUE", leaseToken: null, leaseUntil: null });
    expect((await journalKinds(id)).pass_waiting).toBe(1);
  });
  it.each([
    ["another owner took the execution", (id: string) => `UPDATE sav.case_effect_executions SET lease_token = '${randomUUID()}' WHERE id = '${id}'`],
    ["the lease expired", (id: string) => `UPDATE sav.case_effect_executions SET lease_until = now() - interval '5 seconds' WHERE id = '${id}'`],
    ["the execution is no longer running", (id: string) => `UPDATE sav.case_effect_executions SET state = 'waiting' WHERE id = '${id}'`],
  ])("%s: no write at all, not even an obsolete-pass journal", async (_name, sqlFor) => {
    const { id, d, lease } = await claimed();
    await f.client.exec(sqlFor(id));
    const [row, journal] = [await execution(id), await journalKinds(id)];
    await d.end(lease, "uncertain", "SAV_CASE_EFFECT_RECOVERY_NOT_DUE");
    expect(await execution(id)).toEqual(row);
    expect(await journalKinds(id)).toEqual(journal);
  });
});

// Independent native review: overlapping dedicated PostgreSQL connections, no provider writes.
import postgres from "postgres";
import { validateSavNativeTestTarget } from "../../../../test/sav-native-db";
import { openNativeObserver, openNativeHandle, blockedBehind, finishNativeHandle } from "../../../../test/sav-native-locks";

it.skipIf(!process.env.SAV_TEST_POSTGRES_URL).each(["token", "attempt", "expiry"])("INDEPENDENT_NATIVE settlement rechecks %s after a real row-lock wait", async mode => {
  const url = process.env.SAV_TEST_POSTGRES_URL!, token = process.env.SAV_TEST_POSTGRES_TOKEN;
  validateSavNativeTestTarget(url, token);
  const { id } = await crashAfterMarker("answer");
  const d = createCaseEffectRecoveryDriver(storeDeps()), claim = await d.claim(id);
  if (!("lease" in claim)) throw Error("REVIEW_CLAIM_BLOCKED");
  const [observed] = await effectsOf(id), beforeEffect = { ...observed! };
  const expires = new Date(Date.now() + 1000);
  if (mode === "expiry") await f.db.update(savCaseEffectExecutions).set({ leaseUntil: expires }).where(eq(savCaseEffectExecutions.id, id));
  const pool = postgres(url, { max: 1, prepare: false, connection: { application_name: "review_holder", statement_timeout: 5000 } });
  const observer = openNativeObserver(url), holder = await openNativeHandle(pool);
  let pending: Promise<unknown> | undefined;
  try {
    await holder.conn.unsafe("BEGIN");
    const table = mode === "attempt" ? "sav.intake_effects" : "sav.case_effect_executions";
    const key = mode === "attempt" ? observed!.id : id;
    await holder.conn.unsafe(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [key]);
    pending = d.applyVerification!(claim.lease, observed!, { error: "SAV_REVIEW_READ_FAILED" });
    await blockedBehind(observer, holder.pid, 1);
    console.log("INDEPENDENT_NATIVE_REAL_BLOCK", mode, holder.pid);
    if (mode === "token") await holder.conn.unsafe("UPDATE sav.case_effect_executions SET lease_token=$1 WHERE id=$2", [randomUUID(), id]);
    if (mode === "attempt") await holder.conn.unsafe("UPDATE sav.intake_effects SET attempt_id=$1 WHERE id=$2", [randomUUID(), observed!.id]);
    if (mode === "expiry") while (Date.now() <= expires.getTime() + 30) await new Promise(resolve => setTimeout(resolve, 20));
    await holder.conn.unsafe("COMMIT");
    const result = await pending, [after] = await effectsOf(id);
    console.log("INDEPENDENT_NATIVE_SETTLED", mode, result, JSON.stringify({ before: beforeEffect.reconcileAttempts, after: after!.reconcileAttempts, leaseExpiredNow: (await execution(id)).leaseUntil! <= new Date() }));
    expect(result).toBe("stale");
    expect(after!.state).toBe(beforeEffect.state);
    expect(after!.reconcileAttempts).toBe(beforeEffect.reconcileAttempts);
    expect(sends).toBe(0);
  } finally {
    await finishNativeHandle(observer, holder);
    await pending?.catch(() => {});
    await observer.end({ timeout: 2 }); await pool.end({ timeout: 2 });
  }
}, 15000);

// ---------------------------------------------------------------------------------------------------------------------------------
// R2 (review of 576512e): the lease is judged when the lock is HELD, not before waiting for it. A lock wait can cross the expiry without any change of token /
// state / effect; the instant taken before the wait must not decide. Native only (two real connections, the second one observed waiting): skipped under PGlite.
// The three INDEPENDENT_NATIVE tests above are the reviewer's, unchanged but for the native-only gate; these add the end of the pass, the wait on the effect's
// lock, and the witness that a wait which does not cross the expiry still settles.
// ---------------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!process.env.SAV_TEST_POSTGRES_URL)("R2 native: the lease is judged with a fresh clock once the lock is held", () => {
  /** `call` starts while a second connection holds `key` of `table` FOR UPDATE; it is observed waiting; `whileHeld` runs on the holder; then the holder commits. */
  async function overlap<T>(table: string, key: string, call: () => Promise<T>, whileHeld: (conn: Awaited<ReturnType<typeof openNativeHandle>>["conn"]) => Promise<void>) {
    const url = process.env.SAV_TEST_POSTGRES_URL!;
    validateSavNativeTestTarget(url, process.env.SAV_TEST_POSTGRES_TOKEN);
    const pool = postgres(url, { max: 1, prepare: false, connection: { application_name: "r2_holder", statement_timeout: 5000 } });
    const observer = openNativeObserver(url), holder = await openNativeHandle(pool);
    let pending: Promise<T> | undefined;
    try {
      await holder.conn.unsafe("BEGIN");
      await holder.conn.unsafe(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [key]);
      pending = call();
      await blockedBehind(observer, holder.pid, 1);
      await whileHeld(holder.conn);
      await holder.conn.unsafe("COMMIT");
      return await pending;
    } finally {
      await finishNativeHandle(observer, holder);
      await pending?.catch(() => { });
      await observer.end({ timeout: 2 }); await pool.end({ timeout: 2 });
    }
  }
  const pastExpiry = async (expires: Date) => { while (Date.now() <= expires.getTime() + 30) await new Promise(resolve => setTimeout(resolve, 20)); };
  async function claimed(leaseMs: number) {
    const { id } = await crashAfterMarker("answer");
    const d = createCaseEffectRecoveryDriver(storeDeps()), claim = await d.claim(id);
    if (!("lease" in claim)) throw Error("CLAIM_BLOCKED");
    const expires = new Date(Date.now() + leaseMs);
    await f.db.update(savCaseEffectExecutions).set({ leaseUntil: expires }).where(eq(savCaseEffectExecutions.id, id));
    const [observed] = await effectsOf(id);
    return { id, d, lease: claim.lease, expires, observed: observed! };
  }

  it("witness: a wait on the execution row that does NOT cross the expiry, with nothing changed, still settles (one deferred read)", async () => {
    const { id, d, lease, observed } = await claimed(60_000);
    const result = await overlap("sav.case_effect_executions", id, () => d.applyVerification!(lease, observed, { error: "SAV_R2_READ_FAILED" }), async () => { });
    expect(result).toBe("deferred");
    expect((await effectsOf(id))[0]!.reconcileAttempts).toBe(observed.reconcileAttempts + 1);
  });

  it("a wait on the EFFECT's lock (the execution row was free) that crosses the expiry: stale, nothing consumed", async () => {
    const { id, d, lease, expires, observed } = await claimed(1000);
    const result = await overlap("sav.intake_effects", observed.id, () => d.applyVerification!(lease, observed, { error: "SAV_R2_READ_FAILED" }), () => pastExpiry(expires));
    expect(result).toBe("stale");
    expect(await effectsOf(id)).toEqual([observed]);
  });

  it.each(["expiry", "token"] as const)("the end of a pass whose %s moved while it waited for the execution's lock writes nothing, not even a journal entry", async mode => {
    const { id, d, lease, expires } = await claimed(mode === "expiry" ? 1000 : 60_000);
    const [row, journal] = [await execution(id), await journalKinds(id)];
    await overlap("sav.case_effect_executions", id, () => d.end(lease, "uncertain", "SAV_R2_END"), async conn => {
      if (mode === "token") await conn.unsafe("UPDATE sav.case_effect_executions SET lease_token=$1 WHERE id=$2", [randomUUID(), id]);
      else await pastExpiry(expires);
    });
    const after = await execution(id);
    expect(after).toEqual(mode === "token" ? { ...row, leaseToken: after.leaseToken } : row);
    expect(after.state).toBe("running");
    expect(await journalKinds(id)).toEqual(journal);
  });

  it("witness: the end of a pass that waited without the lease moving is written and releases the lease, once", async () => {
    const { id, d, lease } = await claimed(60_000);
    const journal = await journalKinds(id);
    await overlap("sav.case_effect_executions", id, () => d.end(lease, "uncertain", "SAV_R2_END"), async () => { });
    expect(await execution(id)).toMatchObject({ state: "uncertain", reason: "SAV_R2_END", leaseToken: null, leaseUntil: null });
    expect((await journalKinds(id)).pass_waiting).toBe((journal.pass_waiting ?? 0) + 1);
  });
});
