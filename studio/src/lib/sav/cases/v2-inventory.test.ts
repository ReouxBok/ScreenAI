import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { savCases, savCaseEvents, savCaseCalls, savCaseEffectExecutions, savIntakeEffects, savIntakeExecutionPolicies, savMailboxes, savMessages, savThreads, savSyncState, staffUsers } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION } from "./case-types";
import { listV2Cases, v2InventoryInput } from "./v2-inventory";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, sequence = 10000;
const network = vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); });
const at = new Date("2026-11-16T10:00:00.000Z");
const run = (input: Record<string, unknown> = {}) => listV2Cases(v2InventoryInput.parse(input));
async function fixture(options: { id?: string; phase?: string; owner?: string; received?: Date; handoff?: string } = {}) {
  const gmailId = randomUUID();
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "private@example.invalid" }).returning();
  const [message] = await f.db.insert(savMessages).values({ threadId: thread!.id, mailboxId, gmailMessageId: gmailId, direction: "inbound", fromEmail: "private@example.invalid", toEmails: [], subject: "PRIVATE_SUBJECT", bodyCiphertext: encryptSavPayload({ text: "PRIVATE_BODY" }), receivedAt: options.received ?? at }).returning();
  const [row] = await f.db.insert(savCases).values({ id: options.id, ticketId: String(++sequence), threadIds: [thread!.id], owner: options.owner ?? "agent", phase: options.phase ?? "queued", admissionTarget: "agent", contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload({ ...emptyCaseBody(), handoff: options.handoff ? { reason: options.handoff } : null }) }).returning();
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
beforeEach(async () => { await f.client.exec("TRUNCATE sav.cases CASCADE"); });
afterAll(async () => { state.db = null; await f?.client.close(); expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("keyset survives backdated inserts on both sides and state changes without gaps or duplicates", async () => {
  const originals = [];
  for (let n = 1; n <= 5; n++) originals.push(await fixture({ id: `40000000-0000-4000-8000-${String(n * 2).padStart(12, "0")}` }));
  const first = await run({ limit: 2, state: "processing" });
  await fixture({ id: "40000000-0000-4000-8000-000000000001", received: new Date("2026-11-15") });
  await fixture({ id: "40000000-0000-4000-8000-000000000007", received: new Date("2026-11-15") });
  await f.db.update(savCases).set({ phase: "awaiting_customer", updatedAt: new Date() }).where(eq(savCases.id, originals[3]!.caseId));
  const seen = first.rows.map(r => r.caseId); let cursor = first.nextCursor;
  while (cursor) { const next = await run({ limit: 2, state: "processing", cursor }); expect(next.attendus).toBe(5); seen.push(...next.rows.map(r => r.caseId)); cursor = next.nextCursor; }
  expect(seen).toEqual(originals.map(c => c.caseId)); expect(new Set(seen).size).toBe(5); expect((await run()).attendus).toBe(7);
});
it("defaults to 25, caps at 100, validates dates and binds encrypted cursors to filters", async () => {
  expect(v2InventoryInput.parse({}).limit).toBe(25);
  for (const limit of [0, 101, 2.5]) expect(v2InventoryInput.safeParse({ limit }).success).toBe(false);
  await fixture(); await fixture(); const first = await run({ limit: 1 });
  await expect(run({ cursor: first.nextCursor, state: "failed" })).rejects.toThrow("CURSOR_INVALID");
  await expect(run({ cursor: `${first.nextCursor}x` })).rejects.toThrow("CURSOR_INVALID");
  await expect(run({ from: "2026-11-17T00:00:00Z", until: "2026-11-16T00:00:00Z" })).rejects.toThrow("WINDOW_INVALID");
});
it("filters by inclusive first customer date and state, not case creation date", async () => {
  const c = await fixture({ phase: "awaiting_customer" }); await fixture({ received: new Date("2026-11-15") });
  const page = await run({ from: at.toISOString(), until: at.toISOString(), state: "awaiting_customer" });
  expect(page.attendus).toBe(1); expect(page.rows[0]).toMatchObject({ ...c, receivedAt: at.toISOString(), replyDelaySeconds: null });
});
it("calculates delay from confirmed reply, never ack; note requires association", async () => {
  const c = await fixture({ phase: "resolved" });
  await effect(c, "reply_send", "acked"); expect((await run()).rows[0]!.replyConfirmedAt).toBeNull();
  await effect(c, "reply_send", "confirmed", new Date(at.getTime() + 123456));
  const parent = await effect(c, "note_create", "confirmed", at); await effect(c, "ticket_stage", "planned");
  expect((await run()).rows[0]).toMatchObject({ state: "reply_sent", replyDelaySeconds: 123.456, hubspot: { note: "queued", status: "queued" } });
  await effect(c, "note_associate", "confirmed", at, parent); expect((await run()).rows[0]!.hubspot.note).toBe("confirmed");
});
it("exposes closed fields and sanitized handoff codes without customer content", async () => {
  const c = await fixture({ owner: "human", phase: "human_owned", handoff: "private@example.invalid" }); const page = await run();
  expect(page.rows[0]).toMatchObject({ ...c, state: "handed_to_team", handoffReason: "other_internal_reason", validatorRefusals: 0, cost: { confirmedMicroUsd: null, reservedMicroUsd: null, reason: "no_recorded_call" } });
  expect(Object.keys(page.rows[0]!).sort()).toEqual(["caseId", "threadId", "messageId", "state", "phase", "receivedAt", "replyConfirmedAt", "replyDelaySeconds", "hubspot", "handoffReason", "validatorRefusals", "cost"].sort());
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE|private@|subject|recipient|customerEmail|body|Ciphertext/);
});
it("deduplicates cumulative validator refusals per input and call", async () => {
  const c = await fixture();
  for (let n = 1; n <= 2; n++) await f.db.insert(savCaseEvents).values({ caseId: c.caseId, kind: "observation_recorded", direction: "internal", dedupeKey: `obs:${n}`, caseVersion: n + 1, occurredAt: at, payloadCiphertext: encryptSavPayload({ detail: { record: { kind: "sav-case-investigation.v1", inputKey: "input-1", progress: { attempts: Array.from({ length: n }, (_, index) => ({ call: index + 1, result: "validated", outcome: "needs_review" })) } } } }) });
  expect((await run()).rows[0]!.validatorRefusals).toBe(2);
});
it("separates verified usage from held or conservatively settled costs", async () => {
  const c = await fixture(); const keys = [randomUUID(), randomUUID(), randomUUID()].map(id => `${id}:call1`);
  for (const key of keys) await f.db.insert(savCaseCalls).values({ callKey: key, subjectKey: key.split(":call")[0]!, caseId: c.caseId, caseVersion: 1, purpose: "decision", state: "reserved", token: randomUUID(), holder: "fixture", leaseUntil: new Date(at.getTime() + 60000) });
  await f.db.insert(savSyncState).values({ key: `sav-v2-spend.v1:model:${randomUUID()}`, cursor: JSON.stringify({ open: { [keys[0]!]: { amount: 100 } }, done: { [keys[1]!]: 40, [keys[2]!]: 80 }, verifiedUsage: [keys[1]!] }) });
  expect((await run()).rows[0]!.cost).toEqual({ confirmedMicroUsd: 40, reservedMicroUsd: 180, reason: null });
});
it("covers pause/failure and cases without V1 link", async () => {
  await fixture({ owner: "system_hold" }); await fixture({ phase: "blocked_technical" });
  expect((await run({ state: "paused" })).attendus).toBe(1); expect((await run({ state: "failed" })).attendus).toBe(1);
  await f.db.insert(savCases).values({ ticketId: String(++sequence), owner: "agent", phase: "queued", admissionTarget: "agent", contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()) });
  expect((await run()).rows.find(r => r.receivedAt === null)).toMatchObject({ threadId: null, messageId: null, replyDelaySeconds: null });
});
it("returns 25 rows by default and at most 100 with a stable expected count", async () => {
  await f.db.insert(savCases).values(Array.from({ length: 101 }, () => ({ ticketId: String(++sequence), owner: "agent", phase: "queued", admissionTarget: "agent", contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()) })));
  const first = await run(); expect(first.rows).toHaveLength(25); expect(first.attendus).toBe(101); expect(first.nextCursor).not.toBeNull();
  const hundred = await run({ limit: 100 }); expect(hundred.rows).toHaveLength(100);
  const last = await run({ limit: 100, cursor: hundred.nextCursor }); expect(last.rows).toHaveLength(1); expect(last.attendus).toBe(101); expect(last.nextCursor).toBeNull();
});
it("reports HubSpot parents queued before their ledger effects exist", async () => {
  const c = await fixture();
  for (const key of [`case-stage:${c.caseId}:fixture`, `reply:${c.caseId}:fixture`]) await f.db.insert(savCaseEffectExecutions).values({ caseId: c.caseId, threadId: c.threadId, replyKey: key, policyId, policyHash: "fixture", payloadCiphertext: encryptSavPayload(key.startsWith("reply:") ? { note: { text: "PRIVATE_NOTE" } } : {}) });
  expect((await run()).rows[0]!.hubspot).toEqual({ note: "queued", status: "queued" });
});
it("does not borrow another case's entry date, reply, or effects", async () => {
  await fixture({ received: new Date("2026-11-15"), phase: "resolved" });
  const c = await fixture({ received: at, phase: "resolved" }); await effect(c, "reply_send", "confirmed", new Date(at.getTime() + 1000));
  const rows = (await run()).rows;
  expect(rows.find(r => r.caseId === c.caseId)).toMatchObject({ state: "reply_sent", receivedAt: at.toISOString(), replyDelaySeconds: 1 });
  expect(rows.find(r => r.caseId !== c.caseId)).toMatchObject({ state: "processing", receivedAt: "2026-11-15T00:00:00.000Z", replyConfirmedAt: null, replyDelaySeconds: null });
});
it("refuses a deleted member rather than silently completing a partial audit", async () => {
  const firstCase = { caseId: "40000000-0000-4000-8000-000000000001" };
  const second = { caseId: "40000000-0000-4000-8000-000000000002" };
  await f.db.insert(savCases).values([firstCase, second].map(c => ({ id: c.caseId, ticketId: String(++sequence), owner: "agent", phase: "queued", admissionTarget: "agent", contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()) })));
  const first = await run({ limit: 1 }); expect(first.rows[0]!.caseId).toBe(firstCase.caseId);
  await f.db.delete(savCases).where(eq(savCases.id, second.caseId));
  await expect(run({ cursor: first.nextCursor })).rejects.toThrow("MEMBERSHIP_CHANGED");
});

it("keeps inventory available with explicit null costs for missing or unreadable receipts", async () => {
  const c = await fixture(), subject = randomUUID();
  await f.db.insert(savCaseCalls).values({ callKey: `${subject}:call1`, subjectKey: subject, caseId: c.caseId, caseVersion: 1, purpose: "decision", state: "reserved", token: randomUUID(), holder: "fixture", leaseUntil: new Date() });
  expect((await run()).rows[0]!.cost).toEqual({ confirmedMicroUsd: null, reservedMicroUsd: null, reason: "receipt_missing" });
  await f.db.insert(savSyncState).values({ key: `sav-v2-spend.v1:model:${randomUUID()}`, cursor: "malformed fixture" });
  expect((await run()).rows[0]!.cost).toEqual({ confirmedMicroUsd: null, reservedMicroUsd: null, reason: "receipt_unreadable" });
});
