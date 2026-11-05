import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
import { savCaseEffectExecutions, savCaseReplyValidations, savIntakeEffectJournal, savIntakeEffects, savIntakeExecutions, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { approveIntakeExecutionPolicy, intakeExecutionConfig, type ExecutionPolicy } from "../intake/execution-policy";
import { createIntakeExecutorAdapters, type GmailRequest } from "../intake/execution-adapters";
import { executeIntakePass, pendingIntakeEffectRecoveries } from "../intake/executor";
import { getExecutionEffects } from "../intake/execution-store";
import type { ExecutionOptions } from "../intake/execution-types";
import { listCaseEvents, listCaseTimers, openCaseEvent, readCase, transitionCaseOwner } from "./case-store";
import { caseDedupeKey } from "./case-types";
import { createCaseEffectDriver, pendingCaseEffectExecutions } from "./case-effect-driver";
import { caseReplyPayloadHash, inboundInteractionId, type CaseReplyProposal } from "./case-effects";
import { decideCaseReply, enqueueApprovedCaseReply, submitCaseReplyProposal, type CaseEffectNote } from "./case-reply-store";
import { CASE_REPLY_V2_MODE, prepareCaseReplyText } from "./case-reply-outbound";
import { renderSavOutboundReply, savReplyFooter } from "../reply-format";
import type { CaseReplyAuthorizer } from "./case-reply-validation";
import { nextJ2Slot } from "./j2-calendar";

// SAV-10 on the REAL executor: `executeIntakePass` with the case driver, the real ledger (sav.intake_effects), the real Gmail/HubSpot adapters on the
// synthetic provider (no socket), the real SAV-5 case store. Nothing here reaches a provider.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, policyHash: string, environment: Record<string, string | undefined>, options: ExecutionOptions;
let p: ReturnType<typeof executionProvider>, sends = 0, loseAck = false, ticketSeq = 9_300_000;
/** What really reached the (synthetic) provider: the request bodies of `messages/send`, to compare the MIME with the text a person approved. */
let sentBodies: string[] = [];
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
  sends = 0; loseAck = false; sentBodies = [];
  const gmail: GmailRequest = async <T>(mailbox: string, path: string, init?: RequestInit) => {
    if (path === "messages/send") { sends += 1; sentBodies.push(String(init?.body ?? "")); }
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

describe("a validated reply runs on the existing executor, once", () => {
  it("planned -> marker -> send -> verified -> confirmed; then the case holds the outbound mail, the question and ONE J2 timer; a second pass changes nothing", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    const result = await run(id);
    expect(result).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    const [reply] = await effectsOf(id);
    expect(reply).toMatchObject({ kind: "reply_send", permission: "send_case_reply", state: "confirmed", businessKey: `reply:${s.caseId}:${s.proposal.triggerEventId}` });
    expect((await execution(id)).state).toBe("confirmed");
    expect(await outbound(s.caseId)).toHaveLength(1);
    const snapshot = (await readCase(s.caseId))!;
    expect(snapshot.body.questions).toMatchObject([{ id: "q1", askedInEffect: reply!.id }]);
    const timers = await listCaseTimers(s.caseId);
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ state: "scheduled", questionEffectId: reply!.id, sentAt: expect.any(String), dueAt: nextJ2Slot(new Date(timers[0]!.sentAt)).toISOString() });
    expect(await run(id)).toEqual({ skipped: "occupied" });
    expect(sends).toBe(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    // The V1 execution table never sees a case effect.
    expect(await f.db.select({ n: sql<number>`count(*)::int` }).from(savIntakeExecutions)).toEqual([{ n: 0 }]);
  });

  it("an answer or a reminder sends and records the mail but plans no wait and no J2", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect((await readCase(s.caseId))!.body.questions).toEqual([]);
  });

  it("OFF by default: no mode, 'off', 'auto' or an unknown value stores and plans nothing", async () => {
    const s = await scenario("answer");
    for (const value of [undefined, "", "off", "auto", "yes"]) {
      expect(await submitCaseReplyProposal(s.proposal, storeDeps(() => ({ ...environment, SAV_CASE_EFFECTS: value })))).toEqual({ ok: false, code: "effects_off" });
    }
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, s.caseId))).toEqual([]);
    expect((await f.client.query<{ n: number }>("SELECT count(*)::int AS n FROM sav.case_reply_validations WHERE case_id = $1", [s.caseId])).rows[0]!.n).toBe(0);
    expect(sends).toBe(0);
  });

  it("nothing is planned for a payload a person did not validate as it stands: text, version or recipient; and a reply nobody approved cannot be queued", async () => {
    const s = await scenario("answer");
    const submitted = await submitCaseReplyProposal(s.proposal, storeDeps());
    if (!submitted.ok) throw Error("SUBMIT");
    const decide = (seen: ReturnType<typeof seenOf>) => decideCaseReply({ action: "approve", validationId: submitted.id, approverId: APPROVER, seen, authorizer: allow, deps: storeDeps() });
    expect(await decide(seenOf({ ...s.proposal, text: `${s.proposal.text} (edited)` }))).toEqual({ ok: false, code: "payload_changed" });
    expect(await decide({ ...seenOf(s.proposal), caseVersion: s.proposal.caseVersion + 1 })).toEqual({ ok: false, code: "version_changed" });
    expect(await decide({ ...seenOf(s.proposal), recipient: "other@example.invalid" })).toEqual({ ok: false, code: "recipient_changed" });
    expect(await queue(submitted.id)).toEqual({ ok: false, code: "not_approved", detail: "proposed" });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, s.caseId))).toEqual([]);
  });

  it("the same trigger is one execution; another payload for it never replaces the first", async () => {
    const s = await scenario("answer");
    const first = await admit(s);
    expect(await admit(s)).toMatchObject({ id: first.id, created: false });
    const edited = { ...s.proposal, text: finalReplyText("SYNTHETIC other text.") };
    expect(await submitCaseReplyProposal(edited, storeDeps())).toEqual({ ok: false, code: "trigger_already_approved" });
  });
});

describe("what moves before the marker cancels or holds, and nothing is sent", () => {
  it("a customer message that arrived after the approval cancels the reply for good (the key is never reused)", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    await openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`late-${randomUUID()}`), sourceRef: { type: "email", id: "late" }, occurredAt: "2026-10-28T07:30:00.000Z" });
    expect(await run(id)).toMatchObject({ state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT" });
    expect(await execution(id)).toMatchObject({ state: "refused", leaseToken: null });
    expect(await effectsOf(id)).toEqual([]);
    expect(sends).toBe(0);
    expect(await run(id)).toEqual({ skipped: "occupied" });
  });

  it("a person taking the case over cancels it", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    await transitionCaseOwner({ caseId: s.caseId, expectedVersion: (await readCase(s.caseId))!.version, transition: "human_takeover", actor: staff, commandKey: `cmd-${randomUUID()}`, reason: "fixture" });
    expect(await run(id)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED" });
    expect(sends).toBe(0);
    expect((await execution(id)).state).toBe("refused");
  });

  it("a recipient that is no longer the stored sender cancels it", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    await f.db.update(savMessages).set({ fromEmail: "someone-else@example.invalid" }).where(eq(savMessages.id, s.message.id));
    expect(await run(id)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_RECIPIENT_CHANGED" });
    expect(sends).toBe(0);
  });

  it("a V2 pause holds without cancelling: nothing is planned, the execution waits, and it sends once the pause is lifted", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    await setV2Pause("actions_paused");
    expect(await run(id)).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_AGENT_ACTIONS_PAUSED" });
    expect(await effectsOf(id)).toEqual([]);
    expect((await execution(id)).state).toBe("waiting");
    await setV2Pause(null);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
  });

  it("the mode switched off after the approval holds the reply; switched back on it goes out", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    environment = { ...environment, SAV_CASE_EFFECTS: "off" };
    expect(await run(id)).toMatchObject({ state: "waiting", reason: "SAV_CASE_EFFECT_HOLD_EFFECTS_OFF" });
    expect(sends).toBe(0);
    environment = { ...environment, SAV_CASE_EFFECTS: "supervised" };
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
  });

  it("an expired lease writes no marker and sends nothing; the next pass completes the same planned effect", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    const result = await run(id, { beforeMarker: async () => { await f.db.update(savCaseEffectExecutions).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(savCaseEffectExecutions.id, id)); } });
    expect(result).toMatchObject({ state: "waiting", reason: "SAV_CASE_EFFECT_LEASE_LOST" });
    expect(sends).toBe(0);
    expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toHaveLength(1);
  });

  it("a pause seen between the marker and the provider call gives the effect back to planned: nothing left", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    const result = await run(id, { afterMarker: async () => { await setV2Pause("fully_paused"); } });
    expect(result).toMatchObject({ state: "waiting" });
    expect(sends).toBe(0);
    expect(await effectsOf(id)).toMatchObject([{ state: "planned", dispatchedAt: null }]);
    await setV2Pause(null);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
  });
});

describe("crash and lost-ACK safety: a marker is verify-only, a confirmed receipt is immutable", () => {
  it("a crash right after the marker sends nothing and never resends: the next pass only verifies, and stays uncertain without a mail", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    expect(await run(id, { afterMarker: async () => { throw Error("SAV_TEST_CRASH"); } })).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(0);
    await letReconcile();
    // Owner, pause and a newer message all changed since: none of them makes a possibly sent mail a resend or a cancellation.
    await openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`after-${randomUUID()}`), sourceRef: { type: "email", id: "after" }, occurredAt: "2026-10-28T07:40:00.000Z" });
    await setV2Pause("fully_paused");
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect(await outbound(s.caseId)).toEqual([]);
  });

  it("a lost ACK is a verification only: the mail that did leave is found, confirmed once, and the question / J2 follow exactly once", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    loseAck = true;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(1);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    loseAck = false; await letReconcile();
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(Object.keys(p.sent)).toHaveLength(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("a crash after the send is confirmed (before the case records it) is completed by the next pass: no second mail, one event, one question, one timer", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    const crashing = { ...driver(), finish: async () => { throw Error("SAV_TEST_CRASH_AFTER_CONFIRMED"); } };
    expect(await run(id, {}, crashing)).toMatchObject({ state: "waiting" });
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    expect(await outbound(s.caseId)).toEqual([]);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    // The world moved on meanwhile; a confirmed receipt does not depend on it.
    await setV2Pause("actions_paused");
    await setV2Pause(null);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
    expect(await effectsOf(id)).toHaveLength(1);
  });

  it("an ACTIONS pause alone does not stop recording a confirmed reply (nothing leaves, the date of the mail is kept)", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    const crashing = { ...driver(), finish: async () => { throw Error("SAV_TEST_CRASH_AFTER_CONFIRMED"); } };
    await run(id, {}, crashing);
    await setV2Pause("actions_paused");
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  // C-ATOMIC-RECEIPT (decided by ROOT, replaces "a takeover does not stop the record"): the receipt is ONE transaction that reads the owner under the case lock. A person owning the case
  // when it runs means the agent writes NOTHING to it (no mail event, no question, no J2) and the execution ends for good; the ledger keeps the confirmed send and nothing is resent.
  it("a person who took the case before the receipt ends the execution with NO projection (no mail event, no question, no J2); the ledger keeps the confirmed send; nothing is resent", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    const crashing = { ...driver(), finish: async () => { throw Error("SAV_TEST_CRASH_AFTER_CONFIRMED"); } };
    await run(id, {}, crashing);
    await setV2Pause("actions_paused");
    await transitionCaseOwner({ caseId: s.caseId, expectedVersion: (await readCase(s.caseId))!.version, transition: "human_takeover", actor: staff, commandKey: `cmd-${randomUUID()}`, reason: "fixture" });
    expect(await run(id)).toEqual({ state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED", executionId: id });
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toEqual([]);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
  });

  it("a FULL pause that arrives after the mail left does not stop its verification, but holds its recording (no projection while paused); lifted, it is recorded once and nothing more leaves", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    expect(await run(id, { afterAck: async () => { await setV2Pause("fully_paused"); } })).toEqual({ state: "waiting", reason: "SAV_CASE_EFFECT_RECEIPT_HELD_BY_PAUSE", executionId: id });
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    await setV2Pause(null);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("a confirmed receipt is never reopened: the row, its intent and its confirmation stay as they were whatever is attempted", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    await run(id);
    const [before] = await effectsOf(id);
    expect(await run(id)).toEqual({ skipped: "occupied" });
    expect(await admit(s)).toMatchObject({ id, created: false });
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ id: before!.id, state: "confirmed", intentHash: before!.intentHash, confirmedAt: before!.confirmedAt }]);
  });
});

describe("what moves AFTER the marker: the marker's transaction is the last point where a reply can be cancelled", () => {
  const takeover = async (caseId: string) => transitionCaseOwner({ caseId, expectedVersion: (await readCase(caseId))!.version, transition: "human_takeover", actor: staff, commandKey: `cmd-${randomUUID()}`, reason: "fixture" });
  const customerWrites = (s: Awaited<ReturnType<typeof scenario>>, what: string) =>
    openCaseEvent({ ticketId: s.ticketId, threadId: s.thread.id, admission: ADMITTED, kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(`${what}-${randomUUID()}`), sourceRef: { type: "email", id: what }, occurredAt: "2026-10-28T07:45:00.000Z" });

  // C6 (ROOT GO C6-LOCAL-HUMAN-FENCE, a STRICTER specification than the one this test used to pin): a person taking the case over LOCALLY between the marker and the provider call
  // now stops the mail BEFORE the provider (the final look judges the local owner again). The old expectation (sends 1, effect confirmed) is replaced, not weakened: nothing leaves,
  // the effect goes back to planned by the proven no-send transition, and the agent still records NOTHING.
  it("a person taking the case over between the marker and the provider call stops the mail before the provider: nothing leaves, the effect goes back to planned; the agent records NOTHING (no mail event, no question, no J2)", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    expect(await run(id, { afterMarker: async () => { await takeover(s.caseId); } })).toEqual({ state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED", executionId: id });
    expect(sends).toBe(0);
    expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toEqual([]);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
  });

  // C7 (ROOT arbitration INPUT_NEWER, a STRICTER specification than the one this test used to pin): a customer message KNOWN before the provider is called makes the prepared reply
  // stale (it answered an older version). The old expectation (the marked mail leaves, 1 send, parent confirmed) is replaced, not weakened: nothing leaves, the effect goes back to
  // planned by the proven no-send transition, the parent is cancelled for good (its key is never reused), and the case records no mail event, no question, no J2.
  it("a new customer message between the marker and the provider call stops the mail before the provider: nothing leaves, the parent is cancelled, the case records nothing", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    expect(await run(id, { afterMarker: async () => { await customerWrites(s, "between-marker-and-send"); } })).toEqual({ state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT", executionId: id });
    expect(sends).toBe(0);
    expect(await effectsOf(id)).toMatchObject([{ state: "planned" }]);
    expect((await execution(id)).state).toBe("refused");
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
  });

  it("a lost ACK, then a person takes the case over: the verification still finds the one mail, confirms it once, never resends; the agent records NOTHING (no mail event, no question, no J2)", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    loseAck = true;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    loseAck = false;
    await takeover(s.caseId);
    await letReconcile();
    expect(await run(id)).toEqual({ state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED", executionId: id });
    expect(sends).toBe(1);
    expect(Object.keys(p.sent)).toHaveLength(1);
    expect(await outbound(s.caseId)).toHaveLength(0);
    expect((await readCase(s.caseId))!.body.questions).toEqual([]);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
  });

  it("a lost ACK, then a new customer message: the mail is confirmed once and journaled, never resent, and no J2 is planned for a question the customer has already moved past", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    loseAck = true;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    loseAck = false;
    await customerWrites(s, "while-uncertain");
    await letReconcile();
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    expect(await effectsOf(id)).toHaveLength(1);
  });

  it("an INTAKE pause stops the whole pass, verification included: a lost-ACK reply stays uncertain, nothing leaves and no provider is read; after the pause the mail is confirmed once", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    loseAck = true;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    loseAck = false; await letReconcile();
    await setPause("intake", "fully_paused");
    const callsBefore = p.calls.length;
    expect(await run(id)).toHaveProperty("skipped");
    expect(p.calls.length).toBe(callsBefore);
    expect(sends).toBe(1);
    expect(await effectsOf(id)).toMatchObject([{ state: "uncertain" }]);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
    await setPause("intake", null);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
    expect(await listCaseTimers(s.caseId)).toHaveLength(1);
  });

  it("the generic read-only recovery does not see an uncertain case reply: only the case driver's own pass can verify it (and nothing wires that pass yet)", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    loseAck = true;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    loseAck = false; await letReconcile();
    expect(await effectsOf(id)).toMatchObject([{ state: "uncertain" }]);
    expect((await pendingIntakeEffectRecoveries()).map(row => row.id)).not.toContain(id);
    expect((await pendingCaseEffectExecutions(20)).map(row => row.id)).toContain(id);
  });

  it("an uncertain effect waits for its schedule: a pass before `next_reconcile_at` reads nothing from any provider and sends nothing", async () => {
    const s = await scenario("question");
    const { id } = await admit(s);
    loseAck = true;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    loseAck = false;
    const callsBefore = p.calls.length;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    expect(p.calls.length).toBe(callsBefore);
    expect(sends).toBe(1);
    expect(await listCaseTimers(s.caseId)).toEqual([]);
  });
});

describe("one internal note per interaction", () => {
  it("after the confirmed reply: the note is created then associated, once; the same interaction asked again by another execution adds no second note", async () => {
    const s = await scenario("answer", { note: true });
    const { id } = await admit(s);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    const effects = await effectsOf(id);
    expect(effects.map(effect => [effect.kind, effect.permission, effect.state])).toEqual([
      ["reply_send", "send_case_reply", "confirmed"], ["note_create", "append_case_note", "confirmed"], ["note_associate", "append_case_note", "confirmed"],
    ]);
    expect(Object.keys(p.objects.notes)).toHaveLength(1);
    // A retry that took another key for the SAME mail is no trigger: the store refuses it, so no second reply and no second note can exist (the canonical identity
    // is derived from the stored mail; see `case-reply-trigger.ts` and the two-producers test of case-reply-durable.test.ts).
    expect(await submitCaseReplyProposal({ ...s.proposal, triggerEventId: `inbound:${s.gmailMessageId}:retry` }, storeDeps())).toMatchObject({ ok: false, code: "trigger_invalid" });
    expect(sends).toBe(1);
    expect(Object.keys(p.objects.notes)).toHaveLength(1);
  });

  it("without a note in the payload no HubSpot object is touched", async () => {
    const s = await scenario("answer");
    const { id } = await admit(s);
    await run(id);
    expect(Object.keys(p.objects.notes)).toHaveLength(0);
    expect(p.calls.filter(call => call.path.startsWith("/crm")).length).toBe(0);
  });

  // C6: a NEW note is new work. The reply already left and is settled; a LOCAL human takeover that comes after it now stops the note (it used to be sent once).
  it("a new note is stopped by a human takeover that came after the reply (the reply stays confirmed; no note is sent; the case records nothing)", async () => {
    const s = await scenario("answer", { note: true });
    const { id } = await admit(s);
    const base = driver();
    const wrapped = { ...base, nextIntent: async (...args: Parameters<typeof base.nextIntent>) => {
      const intent = await base.nextIntent(...args);
      if (intent?.kind === "note_create") await transitionCaseOwner({ caseId: s.caseId, expectedVersion: (await readCase(s.caseId))!.version, transition: "human_takeover", actor: staff, commandKey: `cmd-${randomUUID()}`, reason: "fixture" });
      return intent;
    } };
    expect(await run(id, {}, wrapped)).toEqual({ state: "waiting", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED", executionId: id });
    expect(Object.keys(p.objects.notes)).toHaveLength(0);
    expect(await effectsOf(id)).toMatchObject([{ state: "confirmed" }]);
    expect(await outbound(s.caseId)).toHaveLength(0);
  });

  it("a note is held by a pause like any effect, and a confirmed reply stays confirmed", async () => {
    const s = await scenario("answer", { note: true });
    const { id } = await admit(s);
    const base = driver();
    const wrapped = { ...base, nextIntent: async (...args: Parameters<typeof base.nextIntent>) => { const intent = await base.nextIntent(...args); if (intent?.kind === "note_create") await setV2Pause("actions_paused"); return intent; } };
    expect(await run(id, {}, wrapped)).toMatchObject({ state: "waiting", reason: "SAV_INTAKE_AGENT_ACTIONS_PAUSED" });
    expect(Object.keys(p.objects.notes)).toHaveLength(0);
    expect((await effectsOf(id)).map(effect => [effect.kind, effect.state])).toEqual([["reply_send", "confirmed"]]);
    await setV2Pause(null);
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(Object.keys(p.objects.notes)).toHaveLength(1);
    expect(sends).toBe(1);
  });
});

describe("recovery scan", () => {
  it("lists only open case executions whose lease is free, oldest first; V1 never lists them", async () => {
    const a = await scenario("answer"); const first = await admit(a);
    const b = await scenario("answer"); const second = await admit(b);
    await run(second.id);
    const pending = (await pendingCaseEffectExecutions(20)).map(row => row.id);
    expect(pending).toContain(first.id);
    expect(pending).not.toContain(second.id);
    const { pendingIntakeEffectRecoveries } = await import("../intake/executor");
    expect(await pendingIntakeEffectRecoveries()).toEqual([]);
    expect((await f.db.select({ n: sql<number>`count(*)::int` }).from(savIntakeEffectJournal))[0]!.n).toBeGreaterThan(0);
  });
});

describe("the final text (AI mention included) is ONE text, from the proposal to the MIME body", () => {
  const FOOTER = savReplyFooter("fr", CASE_REPLY_V2_MODE);
  const occurrences = (text: string) => text.split(FOOTER).length - 1;
  /** The text of the MIME body that really reached the provider (JSON body -> base64url raw -> MIME -> base64 body). */
  const mimeText = (body: string) => {
    const mime = Buffer.from((JSON.parse(body) as { raw: string }).raw, "base64url").toString("utf8");
    return Buffer.from(mime.slice(mime.indexOf("\r\n\r\n") + 4).replace(/\s+/g, ""), "base64").toString("utf8");
  };
  const validations = async (caseId: string) => f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.caseId, caseId));
  const replyEffect = async (id: string) => (await f.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, id))).find(effect => effect.kind === "reply_send")!;

  it("the stored text, the hashed payload, the approved payload, the planned intent and the MIME body sent are the same bytes; the mention appears once and nothing is added after the hash", async () => {
    const s = await scenario("answer", { text: "SYNTHETIC body, as the producer prepared it." });
    expect(occurrences(s.proposal.text)).toBe(1);
    const { id, validationId } = await admit(s);
    const [row] = await f.db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId));
    expect(decryptSavPayload<CaseReplyProposal>(row!.proposalCiphertext).text).toBe(s.proposal.text);
    expect(row!.payloadHash).toBe(caseReplyPayloadHash(s.proposal));
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    const intent = decryptSavPayload<{ text: string; raw: string; caseEffect: { payloadHash: string } }>((await replyEffect(id)).intentCiphertext);
    expect(intent.text).toBe(s.proposal.text);
    expect(intent.caseEffect.payloadHash).toBe(row!.payloadHash);
    expect(mimeText(sentBodies[0]!)).toBe(s.proposal.text);
    expect(mimeText(sentBodies[0]!)).toBe(mimeText(JSON.stringify({ raw: Buffer.from(intent.raw).toString("base64url") })));
    expect(occurrences(mimeText(sentBodies[0]!))).toBe(1);
    expect(caseReplyPayloadHash({ ...s.proposal, text: mimeText(sentBodies[0]!) })).toBe(row!.payloadHash);
  });

  it("refused closed BEFORE any row or hash exists: a raw text, a human-only signature, a stacked or contradictory mention", async () => {
    const s = await scenario("answer");
    const base = "SYNTHETIC body.";
    const cases: [string, string, string][] = [
      ["a raw text without mention", base, "ai_notice_missing"],
      ["a human signature only (manual_authored: claims a person wrote it)", renderSavOutboundReply(base, "fr", "manual_authored"), "ai_notice_missing"],
      ["the mention twice", `${prepareCaseReplyText(base, "fr", CASE_REPLY_V2_MODE)}\n\n${FOOTER}`, "ai_notice_missing"],
      ["a contradicting notice inside the body", prepareCaseReplyText(`${base}\n\n${savReplyFooter("en", "automated")}\n\nMore.`, "fr", CASE_REPLY_V2_MODE).replace(FOOTER, `${FOOTER}\n.`), "ai_notice_missing"],
      ["the mention not at the end", `${FOOTER}\n\n${base}`, "ai_notice_missing"],
    ];
    for (const [label, text, detail] of cases) expect(await submitCaseReplyProposal({ ...s.proposal, text }, storeDeps()), label).toEqual({ ok: false, code: "proposal_invalid", detail });
    expect(await validations(s.caseId)).toHaveLength(0);
    expect(sends).toBe(0);
    // The language is the caller's explicit choice: English is as valid as French, and preparing twice stacks nothing.
    const english = prepareCaseReplyText(prepareCaseReplyText(base, "en", CASE_REPLY_V2_MODE), "en", CASE_REPLY_V2_MODE);
    expect(english.split(savReplyFooter("en", CASE_REPLY_V2_MODE)).length - 1).toBe(1);
    expect(await submitCaseReplyProposal({ ...s.proposal, text: english }, storeDeps())).toMatchObject({ ok: true, created: true });
    // The automated mention is a FORMAT, stored like the other; the right to send under it is judged at the approval: a human basis never carries it (see case-v2-wake.flow.test.ts).
    const automated = { ...s.proposal, text: prepareCaseReplyText(base, "fr", "automated") };
    const stored = await submitCaseReplyProposal(automated, storeDeps());
    if (!stored.ok) throw Error("SUBMIT");
    expect(await decideCaseReply({ action: "approve", validationId: stored.id, approverId: APPROVER, seen: seenOf(automated), authorizer: allow, deps: storeDeps() })).toMatchObject({ ok: false });
    expect(sends).toBe(0);
  });

  /** Written around the store, the way a database from before the contract could hold it. */
  async function legacy(s: Awaited<ReturnType<typeof scenario>>, state: "proposed" | "approved") {
    const proposal = { ...s.proposal, text: "SYNTHETIC raw text stored before the contract." };
    const [row] = await f.db.insert(savCaseReplyValidations).values({ caseId: s.caseId, replyKey: `reply:${s.caseId}:${proposal.triggerEventId}`, payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion,
      recipient: proposal.recipient, proposalCiphertext: encryptSavPayload(proposal) }).returning();
    if (state === "approved") await f.db.update(savCaseReplyValidations).set({ state: "approved", decidedBy: APPROVER, decidedAt: new Date(), authorizationBasis: "legacy.fixture" }).where(eq(savCaseReplyValidations.id, row!.id));
    return { id: row!.id, proposal };
  }

  it("a text stored before the contract can be declined but never approved, and an approved one is never queued: nothing planned, hashed again or sent", async () => {
    const proposed = await scenario("answer"), stored = await legacy(proposed, "proposed");
    expect(await decideCaseReply({ action: "approve", validationId: stored.id, approverId: APPROVER, seen: seenOf(stored.proposal), authorizer: allow, deps: storeDeps() })).toEqual({ ok: false, code: "proposal_invalid", detail: "ai_notice_missing" });
    expect(await decideCaseReply({ action: "decline", validationId: stored.id, approverId: APPROVER, seen: seenOf(stored.proposal), authorizer: allow, deps: storeDeps() })).toMatchObject({ ok: true, state: "declined" });
    const approved = await scenario("answer"), already = await legacy(approved, "approved");
    expect(await queue(already.id)).toEqual({ ok: false, code: "proposal_invalid", detail: "ai_notice_missing" });
    expect(await f.db.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.caseId, approved.caseId))).toHaveLength(0);
    expect(sends).toBe(0);
  });

  /** Replaces what a reply row stored as its intent by the intent of a version from before the contract (the text has no mention). */
  const downgrade = async (id: string) => {
    const effect = await replyEffect(id), intent = decryptSavPayload<{ text: string; raw: string }>(effect.intentCiphertext);
    const old = { ...intent, text: "SYNTHETIC raw text planned before the contract." };
    await f.db.update(savIntakeEffects).set({ intentCiphertext: encryptSavPayload(old) }).where(eq(savIntakeEffects.id, effect.id));
  };

  it("an intent planned before the contract (no mention, no marker yet) is cancelled at the first pass, never sent and never rebuilt around the builder's check", async () => {
    const s = await scenario("answer"), { id } = await admit(s);
    expect(await run(id, { beforeMarker: async () => { throw Error("SAV_TEST_STOP_BEFORE_MARKER"); } })).not.toMatchObject({ state: "confirmed" });
    const planned = await replyEffect(id);
    expect(planned.state).toBe("planned");
    await downgrade(id);
    expect(await run(id)).toMatchObject({ reason: "SAV_CASE_EFFECT_CANCELLED_AI_NOTICE" });
    expect(sends).toBe(0);
    expect((await execution(id)).state).toBe("refused");
    expect(await replyEffect(id)).toMatchObject({ state: "planned", dispatchedAt: null });
  });

  it("an intent already past `planned` (a lost ACK) keeps verify-only: its old text is never judged, never resent, and the verification confirms the one mail that left", async () => {
    const s = await scenario("answer"), { id } = await admit(s);
    loseAck = true;
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(1);
    loseAck = false;
    const original = (await replyEffect(id)).intentCiphertext;
    await downgrade(id);
    await letReconcile();
    // The old text is not judged: the pass is a verification, it is not cancelled for the missing mention, and nothing is resent. (The mail that left says something else than the
    // downgraded text, so the verification cannot attribute it: it stays uncertain, the safe answer.)
    expect(await run(id)).toMatchObject({ state: "uncertain" });
    expect(sends).toBe(1);
    expect((await execution(id)).state).not.toBe("refused");
    await f.db.update(savIntakeEffects).set({ intentCiphertext: original }).where(eq(savIntakeEffects.executionId, id));
    await letReconcile();
    expect(await run(id)).toEqual({ state: "confirmed", executionId: id });
    expect(sends).toBe(1);
    expect(await outbound(s.caseId)).toHaveLength(1);
  });
});
