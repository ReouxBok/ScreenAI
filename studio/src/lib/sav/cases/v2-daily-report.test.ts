import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { savCaseReplyValidations, savCaseTimers, savCases, savCaseEvents, savCaseCalls, savCaseEffectExecutions, savIntakeEffects, savIntakeExecutionPolicies, savMailboxes, savMessages, savThreads, savSyncState, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION } from "./case-types";
import { v2DailyReport, v2DailyReportInput, reportDistribution } from "./v2-daily-report";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, sequence = 10000;
const network = vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); });
const at = new Date("2026-11-16T10:00:00.000Z");
const run = (input: Record<string, unknown> = {}) => v2DailyReport({ from: "2026-11-16T00:00:00Z", until: "2026-11-17T00:00:00Z", ...input });
async function fixture(options: { id?: string; phase?: string; owner?: string; received?: Date; createdAt?: Date; handoff?: string } = {}) {
  const gmailId = randomUUID();
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "private@example.invalid" }).returning();
  const [message] = await f.db.insert(savMessages).values({ threadId: thread!.id, mailboxId, gmailMessageId: gmailId, direction: "inbound", fromEmail: "private@example.invalid", toEmails: [], subject: "PRIVATE_SUBJECT", bodyCiphertext: encryptSavPayload({ text: "PRIVATE_BODY" }), receivedAt: options.received ?? at }).returning();
  const [row] = await f.db.insert(savCases).values({ id: options.id, createdAt: options.createdAt ?? at, ticketId: String(++sequence), threadIds: [thread!.id], owner: options.owner ?? "agent", phase: options.phase ?? "queued", admissionTarget: "agent", contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload({ ...emptyCaseBody(), handoff: options.handoff ? { reason: options.handoff } : null }) }).returning();
  await f.db.insert(savCaseEvents).values({ caseId: row!.id, kind: "inbound_confirmed", direction: "customer_inbound", dedupeKey: `inbound:${gmailId}`, caseVersion: 1, occurredAt: options.received ?? at, payloadCiphertext: encryptSavPayload({ sourceRef: { type: "email", id: gmailId }, detail: null }) });
  return { caseId: row!.id, threadId: thread!.id, messageId: message!.id };
}
async function effect(c: Awaited<ReturnType<typeof fixture>>, kind: string, status: string, when: Date | null = null, executionId?: string) {
  const id = executionId ?? (await f.db.insert(savCaseEffectExecutions).values({ caseId: c.caseId, threadId: c.threadId, replyKey: randomUUID(), policyId, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning())[0]!.id;
  await f.db.insert(savIntakeEffects).values({ executionId: id, businessKey: randomUUID(), kind, permission: "fixture", state: status, confirmedAt: when, intentHash: "fixture", intentCiphertext: encryptSavPayload({ text: "PRIVATE_NOTE" }), ...(status !== "planned" ? { dispatchedAt: at, dispatchToken: randomUUID() } : {}) });
  return id;
}
beforeAll(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "inventory-synthetic-key-only-32-characters");
  vi.stubGlobal("fetch", network);
  f = await createSavTestDb(); state.db = f.db;
  const [admin] = await f.db.insert(staffUsers).values({ clerkId: "inventory-fixture", email: "admin@example.invalid", role: "admin" }).returning();
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0]!.id;
  policyId = (await f.db.insert(savIntakeExecutionPolicies).values({ revision: "fixture", state: "approved", administratorId: admin!.id, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning())[0]!.id;
}, 60000);
beforeEach(async () => { await f.client.exec("TRUNCATE sav.cases, sav.sync_state CASCADE"); });
afterAll(async () => { state.db = null; await f?.client.close(); expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("requires dates and rejects empty, reversed and over-seven-day windows", async () => {
  expect(v2DailyReportInput.safeParse({}).success).toBe(false);
  for (const until of ['2026-11-16T00:00:00Z', '2026-11-15T00:00:00Z', '2026-11-23T00:00:00.001Z']) await expect(run({ until })).rejects.toThrow('WINDOW_INVALID');
  expect((await run({ until: '2026-11-23T00:00:00Z' })).coverage.complete).toBe(true);
});
it("empty cohort preserves unknowns and null percentiles", async () => {
  expect(await run()).toMatchObject({ admitted: 0, repliesSent: 0, coverage: { expected: 0, checked: 0, complete: true }, mailToSend: { samples: 0, medianSeconds: null, p90Seconds: null }, anomalies: [], stillBlockedReturns: { exhaustiveCount: null } });
});
it("calculates median and nearest-rank p90", () => {
  expect(reportDistribution([30, 10, 40, 20])).toEqual({ samples: 4, medianSeconds: 25, p90Seconds: 40 });
});
it("counts confirmed sends only and detects duplicate cycles", async () => {
  const c = await fixture(); await effect(c, 'reply_send', 'acked');
  for (const seconds of [30, 90]) {
    const id = await effect(c, 'reply_send', 'confirmed', new Date(at.getTime() + seconds * 1000));
    await f.db.update(savCaseEffectExecutions).set({ payloadCiphertext: encryptSavPayload({ proposal: { caseVersion: 2 } }) }).where(eq(savCaseEffectExecutions.id, id));
  }
  expect(await run()).toMatchObject({ admitted: 1, repliesSent: 2, duplicateCycles: 1, mailToSend: { samples: 2, medianSeconds: 60, p90Seconds: 90 }, validationToSend: { samples: 0, unverified: 2 }, anomalies: [c.caseId] });
});
it("uses exclusive creation boundaries and sanitizes all returned fields", async () => {
  await fixture({ createdAt: new Date('2026-11-15T23:59:59.999Z') });
  await fixture({ createdAt: new Date('2026-11-17T00:00:00Z') });
  const c = await fixture({ owner: 'human', phase: 'human_owned', received: new Date('2026-11-01T00:00:00Z') });
  await f.db.update(savCases).set({ admissionTarget: 'team', admissionReason: 'PRIVATE_REASON' }).where(eq(savCases.id, c.caseId));
  const report = await run();
  expect(report).toMatchObject({ coverage: { expected: 1, checked: 1, complete: true }, handedToTeam: 1, refusedByReason: { other_internal_reason: 1 } });
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE|private@|Ciphertext|recipient|subject|gmail/);
});
it("flags an overdue wait without a timer and preserves unknown costs", async () => {
  const c = await fixture();
  await f.db.update(savCases).set({ payloadCiphertext: encryptSavPayload({ ...emptyCaseBody(), waiting: { kind: 'technical', since: '2026-11-01T00:00:00Z', dueAt: '2026-11-01T00:10:00Z', reasonCode: 'synthetic_wait' } }) }).where(eq(savCases.id, c.caseId));
  expect(await run()).toMatchObject({ overdueWithoutWake: 1, anomalies: [c.caseId], perCase: [{ caseId: c.caseId, recordedCalls: 0, estimatedMicroUsd: null, reason: 'no_recorded_call' }] });
});
it("requires a confirmed closed stage and proven trigger for closure", async () => {
  const c = await fixture({ phase: 'resolved' }); const id = await effect(c, 'ticket_stage', 'confirmed', at);
  expect((await run()).provenClosures).toBe(0);
  await f.db.update(savCaseEffectExecutions).set({ payloadCiphertext: encryptSavPayload({ intent: { target: 'closed' }, trigger: { kind: 'resolution_recorded', cycle: 1 } }) }).where(eq(savCaseEffectExecutions.id, id));
  expect((await run()).provenClosures).toBe(1);
});
it("distinguishes uncertain CRM and requires note association", async () => {
  const c = await fixture(); const id = await effect(c, 'note_create', 'confirmed', at); await effect(c, 'ticket_stage', 'uncertain');
  expect((await run()).crm).toMatchObject({ notes: { pending: 1 }, statuses: { uncertain: 1 } });
  await effect(c, 'note_associate', 'confirmed', at, id);
  expect((await run()).crm.notes.confirmed).toBe(1);
});
it("counts a first CRM execution without materialized effects as pending", async () => {
  const c = await fixture();
  await f.db.insert(savCaseEffectExecutions).values({ caseId: c.caseId, threadId: c.threadId, replyKey: `case-stage:${randomUUID()}`, policyId, policyHash: 'fixture', payloadCiphertext: encryptSavPayload({ intent: { target: 'closed' } }) });
  expect((await run()).crm.statuses).toEqual({ confirmed: 0, uncertain: 0, refused: 0, absent: 0, pending: 1 });
});
it("counts an old confirmed status with a new queued execution as pending", async () => {
  const c = await fixture();
  await effect(c, 'ticket_stage', 'confirmed', at);
  await f.db.insert(savCaseEffectExecutions).values({ caseId: c.caseId, threadId: c.threadId, replyKey: `case-stage:${randomUUID()}`, policyId, policyHash: 'fixture', payloadCiphertext: encryptSavPayload({ intent: { target: 'closed' } }) });
  expect((await run()).crm.statuses).toEqual({ confirmed: 0, uncertain: 0, refused: 0, absent: 0, pending: 1 });
});
it("refuses oversized cohorts", async () => {
  await f.db.insert(savCases).values(Array.from({ length: 1001 }, () => ({ ticketId: String(++sequence), createdAt: at, owner: 'agent', phase: 'queued', admissionTarget: 'agent', contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()) })));
  await expect(run()).rejects.toThrow('CASE_LIMIT');
});
it("measures approval to confirmed send from the exact execution receipt", async () => {
  const c = await fixture(), approved = new Date(at.getTime() + 10000), sent = new Date(at.getTime() + 30000);
  const executionId = await effect(c, 'reply_send', 'confirmed', sent);
  const [admin] = await f.db.select().from(staffUsers).limit(1);
  const [validation] = await f.db.insert(savCaseReplyValidations).values({ caseId: c.caseId, replyKey: randomUUID(), payloadHash: 'a'.repeat(64), caseVersion: 1, recipient: 'synthetic@example.invalid', proposalCiphertext: encryptSavPayload({}) }).returning();
  await f.db.update(savCaseReplyValidations).set({ state: 'approved', decidedBy: admin!.id, decidedAt: approved, authorizationBasis: 'fixture', executionId }).where(eq(savCaseReplyValidations.id, validation!.id));
  expect((await run()).validationToSend).toEqual({ samples: 1, medianSeconds: 20, p90Seconds: 20, unverified: 0 });
});
it("does not conflate replies across reopened cycles", async () => {
  const c = await fixture();
  await f.db.insert(savCaseEvents).values({ caseId: c.caseId, kind: 'inbound_confirmed', direction: 'customer_inbound', dedupeKey: 'inbound:synthetic-second', caseVersion: 3, occurredAt: new Date(at.getTime() + 50000), payloadCiphertext: encryptSavPayload({ detail: { relay: { route: 'reopen' } } }) });
  for (const version of [2, 4]) {
    const id = await effect(c, 'reply_send', 'confirmed', new Date(at.getTime() + version * 30000));
    await f.db.update(savCaseEffectExecutions).set({ payloadCiphertext: encryptSavPayload({ proposal: { caseVersion: version, triggerEventId: version === 4 ? 'inbound:synthetic-second' : 'unknown' } }) }).where(eq(savCaseEffectExecutions.id, id));
  }
  expect(await run()).toMatchObject({ reopenedSameIncident: 1, duplicateCycles: 0, mailToSend: { samples: 1, medianSeconds: 70, unverified: 1 } });
});
it("recognizes the associated scheduled wake and refused CRM execution", async () => {
  const c = await fixture(), timerId = randomUUID();
  const since = new Date('2026-11-01T00:00:00Z'), due = new Date('2026-11-01T00:10:00Z');
  await f.db.insert(savCaseTimers).values({ id: timerId, key: `synthetic:${timerId}`, caseId: c.caseId, questionEffectId: 'synthetic-question', sentAt: since, dueAt: due, scheduledAtCaseVersion: 1 });
  await f.db.update(savCases).set({ payloadCiphertext: encryptSavPayload({ ...emptyCaseBody(), waiting: { kind: 'customer', since: since.toISOString(), dueAt: due.toISOString(), timerId, reasonCode: 'fixture' } }) }).where(eq(savCases.id, c.caseId));
  await f.db.insert(savCaseEffectExecutions).values({ caseId: c.caseId, threadId: c.threadId, replyKey: randomUUID(), policyId, policyHash: 'fixture', state: 'refused', payloadCiphertext: encryptSavPayload({ note: { text: 'PRIVATE_NOTE' } }) });
  expect(await run()).toMatchObject({ overdueWithoutWake: 0, overdueScheduledWakes: 1, crm: { notes: { refused: 1 } } });
});
it("reads multiple inventory pages in one read-only snapshot", async () => {
  await f.db.insert(savCases).values(Array.from({ length: 101 }, () => ({ ticketId: String(++sequence), createdAt: at, owner: 'agent', phase: 'queued', admissionTarget: 'agent', contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()) })));
  const transaction = vi.spyOn(f.db, 'transaction');
  try {
    expect((await run()).coverage).toEqual({ expected: 101, checked: 101, complete: true });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![1]).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
  } finally { transaction.mockRestore(); }
});
