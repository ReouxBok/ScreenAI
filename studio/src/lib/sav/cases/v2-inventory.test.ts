import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { drizzle as postgresDrizzle } from "drizzle-orm/postgres-js";
import * as dbSchema from "@/db/schema";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { savCases, savCaseEvents, savCaseCalls, savCaseEffectExecutions, savIntakeEffects, savIntakeEffectJournal, savIntakeExecutionPolicies, savMailboxes, savMessages, savThreads, savSyncState, staffUsers } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { emptyCaseBody, SAV_CASE_CONTRACT_REVISION } from "./case-types";
import { listV2Cases, v2InventoryInput } from "./v2-inventory";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, policyId: string, sequence = 10000;
const network = vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); });
const at = new Date("2026-11-16T10:00:00.000Z");
const run = (input: Record<string, unknown> = {}) => listV2Cases(v2InventoryInput.parse(input));
async function fixture(options: { id?: string; phase?: string; owner?: string; received?: Date; createdAt?: Date; handoff?: string } = {}) {
  const gmailId = randomUUID();
  const [thread] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "private@example.invalid" }).returning();
  const [message] = await f.db.insert(savMessages).values({ threadId: thread!.id, mailboxId, gmailMessageId: gmailId, direction: "inbound", fromEmail: "private@example.invalid", toEmails: [], subject: "PRIVATE_SUBJECT", bodyCiphertext: encryptSavPayload({ text: "PRIVATE_BODY" }), receivedAt: options.received ?? at }).returning();
  const [row] = await f.db.insert(savCases).values({ id: options.id, createdAt: options.createdAt, ticketId: String(++sequence), threadIds: [thread!.id], owner: options.owner ?? "agent", phase: options.phase ?? "queued", admissionTarget: "agent", contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload({ ...emptyCaseBody(), handoff: options.handoff ? { reason: options.handoff } : null }) }).returning();
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
it("compact keyset excludes later inserts with backdated customer dates without gaps or duplicates", async () => {
  const originals = [];
  for (let n = 1; n <= 5; n++) originals.push(await fixture({ id: `40000000-0000-4000-8000-${String(n * 2).padStart(12, "0")}` }));
  const first = await run({ limit: 2, state: "processing" });
  await fixture({ id: "40000000-0000-4000-8000-000000000001", received: new Date("2026-11-15") });
  await fixture({ id: "40000000-0000-4000-8000-000000000007", received: new Date("2026-11-15") });
  expect(Buffer.byteLength(first.nextCursor!)).toBeLessThan(1024);
  expect(decryptSavPayload(first.nextCursor!)).not.toHaveProperty("ids");
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
it("scopes by inclusive immutable creation date, independently of customer dates and state", async () => {
  const c = await fixture({ phase: "awaiting_customer", createdAt: at, received: new Date("2099-01-01") });
  await fixture({ createdAt: at, received: new Date("2026-11-15") });
  await fixture({ createdAt: new Date(at.getTime() - 1) });
  await fixture({ createdAt: new Date(at.getTime() + 1) });
  const page = await run({ from: at.toISOString(), until: at.toISOString(), state: "awaiting_customer" });
  expect(page).toMatchObject({ attendus: 2, statesFilterApplied: true, filteredOut: 1, nextCursor: null });
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]).toMatchObject({ ...c, receivedAt: "2099-01-01T00:00:00.000Z", replyDelaySeconds: null });
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
  expect(Object.keys(page.rows[0]!).sort()).toEqual(["caseId", "threadId", "messageId", "state", "phase", "receivedAt", "replyConfirmedAt", "replyDelaySeconds", "hubspot", "outcomes", "handoffReason", "validatorRefusals", "cost", "questions"].sort());
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
  for (const state of ["paused", "failed"]) {
    const page = await run({ state });
    expect(page).toMatchObject({ attendus: 2, filteredOut: 1, statesFilterApplied: true });
    expect(page.rows).toHaveLength(1); expect(page.rows[0]!.state).toBe(state);
  }
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

it("refuses a newly committed member below snapshotAt and allows restarting the traversal", async () => {
  await fixture(); await fixture();
  const first = await run({ limit: 1 });
  const snapshot = decryptSavPayload(first.nextCursor!) as { snapshotAt: string };
  await f.db.transaction(async tx => {
    await tx.insert(savCases).values({ createdAt: new Date(Date.parse(snapshot.snapshotAt) - 1000), ticketId: String(++sequence), owner: "agent", phase: "queued", admissionTarget: "agent", contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()) });
  });
  await expect(run({ cursor: first.nextCursor })).rejects.toThrow("SAV_V2_INVENTORY_MEMBERSHIP_CHANGED");
  const restarted = await run();
  expect(restarted.attendus).toBe(3);
  expect(restarted.rows).toHaveLength(3);
  expect(restarted.nextCursor).toBeNull();
});

// PGlite serializes transactions; only native PostgreSQL can exercise the overlapping commit.
it.skipIf(!process.env.SAV_TEST_POSTGRES_URL)("refuses a transaction started before snapshotAt but committed between pages", async () => {
  await fixture(); await fixture();
  let release!: () => void, inserted!: (value: string) => void;
  const commit = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<string>(resolve => { inserted = resolve; });
  const writer = f.db.transaction(async tx => {
    const [row] = await tx.insert(savCases).values({ ticketId: String(++sequence), owner: "agent", phase: "queued", admissionTarget: "agent", contractRevision: SAV_CASE_CONTRACT_REVISION, payloadCiphertext: encryptSavPayload(emptyCaseBody()) }).returning({ id: savCases.id, createdAt: savCases.createdAt });
    inserted(row!.createdAt.toISOString());
    await commit;
    return row!.id;
  });
  // Propagate setup failures instead of leaving the reader waiting on the barrier.
  const createdAt = await Promise.race([ready, writer.then(() => { throw Error("WRITER_COMMITTED_BEFORE_PAGE"); })]);
  try {
    const first = await run({ limit: 1 });
    expect(first.attendus).toBe(2);
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const snapshot = decryptSavPayload(first.nextCursor!) as { snapshotAt: string };
    expect(Date.parse(createdAt)).toBeLessThanOrEqual(Date.parse(snapshot.snapshotAt));
    release();
    const addedId = await writer;
    await expect(run({ cursor: first.nextCursor })).rejects.toThrow("SAV_V2_INVENTORY_MEMBERSHIP_CHANGED");
    const restarted = await run();
    expect(restarted.attendus).toBe(3);
    expect(restarted.rows.map(row => row.caseId)).toContain(addedId);
    expect(restarted.nextCursor).toBeNull();
  } finally { release(); await writer; }
});

it("keeps inventory available with explicit null costs for missing or unreadable receipts", async () => {
  const c = await fixture(), subject = randomUUID();
  await f.db.insert(savCaseCalls).values({ callKey: `${subject}:call1`, subjectKey: subject, caseId: c.caseId, caseVersion: 1, purpose: "decision", state: "reserved", token: randomUUID(), holder: "fixture", leaseUntil: new Date() });
  expect((await run()).rows[0]!.cost).toEqual({ confirmedMicroUsd: null, reservedMicroUsd: null, reason: "receipt_missing" });
  await f.db.insert(savSyncState).values({ key: `sav-v2-spend.v1:model:${randomUUID()}`, cursor: "malformed fixture" });
  expect((await run()).rows[0]!.cost).toEqual({ confirmedMicroUsd: null, reservedMicroUsd: null, reason: "receipt_unreadable" });
});

it.each([["refused", true], ["reason", true], ["refused", false], ["reason", false]] as const)("ignores %s HubSpot parents (effect=%s), then reports a subsequent confirmation", async (state, withEffect) => {
  const c = await fixture();
  const parent = withEffect ? await effect(c, "ticket_stage", "planned") :
    (await f.db.insert(savCaseEffectExecutions).values({ caseId: c.caseId, threadId: c.threadId, replyKey: `case-stage:${c.caseId}:cancelled`, policyId, policyHash: "fixture", payloadCiphertext: encryptSavPayload({}) }).returning())[0]!.id;
  await f.db.update(savCaseEffectExecutions).set({ state: state === "reason" ? "pending" : state, reason: "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT" }).where(eq(savCaseEffectExecutions.id, parent));
  expect((await run()).rows[0]!.hubspot.status).toBe("absent");
  await effect(c, "ticket_stage", "confirmed", at);
  expect((await run()).rows[0]!.hubspot.status).toBe("confirmed");
});
it("uses at most 15 queries for 100 cases with histories and keeps cursor below 1 KiB", async () => {
  const cases = [];
  for (let n = 0; n < 101; n++) cases.push(await fixture());
  for (const c of cases.slice(0, 100)) {
    await effect(c, "ticket_stage", "planned");
    const key = randomUUID();
    await f.db.insert(savCaseCalls).values({ callKey: `${key}:call1`, subjectKey: key, caseId: c.caseId, caseVersion: 1, purpose: "decision", state: "reserved", token: randomUUID(), holder: "fixture", leaseUntil: new Date(at.getTime() + 60000) });
  }
  const statements: string[] = [];
  const options = { schema: dbSchema, logger: { logQuery: (query: string) => statements.push(query) } };
  state.db = process.env.SAV_TEST_POSTGRES_URL
    ? postgresDrizzle((f.db as unknown as { $client: never }).$client, options)
    : pgliteDrizzle(f.client as never, options);
  try {
    const page = await run({ limit: 100 });

    console.info(`inventory 100 cases: ${statements.length} SQL queries; cursor: ${Buffer.byteLength(page.nextCursor!)} bytes`);
    expect(statements.length).toBeLessThanOrEqual(15);
    expect(statements.filter(query => /^\s*(select|with)\b/i.test(query))).toHaveLength(10);
    expect(page.rows).toHaveLength(100);
    expect(Buffer.byteLength(page.nextCursor!)).toBeLessThan(1024);
  } finally { state.db = f.db; }
});
it("preserves microsecond keysets and bounds creation dates by snapshotAt", async () => {
  const a = await fixture({ received: new Date("2099-01-01") });
  const b = await fixture(), c = await fixture();
  await f.client.query("update sav.cases set created_at='2026-11-01T00:00:00.000001Z' where id=$1", [b.caseId]);
  await f.client.query("update sav.cases set created_at='2026-11-01T00:00:00.000002Z' where id=$1", [c.caseId]);
  const first = await run({ limit: 1, until: "2099-01-02T00:00:00Z" });
  const next = await run({ limit: 1, until: "2099-01-02T00:00:00Z", cursor: first.nextCursor });
  expect(first.attendus).toBe(3); expect(first.rows[0]!.caseId).toBe(b.caseId); expect(next.rows[0]!.caseId).toBe(c.caseId);
  const last = await run({ limit: 1, until: "2099-01-02T00:00:00Z", cursor: next.nextCursor });
  expect(last.rows[0]!.caseId).toBe(a.caseId); expect(last.nextCursor).toBeNull();
  await fixture({ createdAt: new Date("2099-01-01") });
  expect((await run({ until: "2099-01-02T00:00:00Z" })).attendus).toBe(3);
});
it("fails explicitly instead of decrypting an unbounded observation history", async () => {
  const c = await fixture();
  await f.db.insert(savCaseEvents).values(Array.from({ length: 1001 }, (_, n) => ({ caseId: c.caseId, kind: "observation_recorded", direction: "internal", dedupeKey: `bound:${n}`, caseVersion: n+1, occurredAt: at, payloadCiphertext: "not decrypted" })));
  await expect(run()).rejects.toThrow("HISTORY_LIMIT");
});

it.each(["count", "bytes"])("keeps costs unknown when spend registry %s exceeds its bound", async bound => {
  const c = await fixture(), subject = randomUUID(), key = `${subject}:call1`;
  await f.db.insert(savCaseCalls).values({ callKey: key, subjectKey: subject, caseId: c.caseId, caseVersion: 1, purpose: "decision", state: "reserved", token: randomUUID(), holder: "fixture", leaseUntil: new Date() });
  const cursor = JSON.stringify({ open: { [key]: { amount: 12 } }, done: {}, ...(bound === "bytes" ? { padding: "x".repeat(1048576) } : {}) });
  await f.db.insert(savSyncState).values(Array.from({ length: bound === "count" ? 1001 : 1 }, (_, n) => ({ key: `sav-v2-spend.v1:model:bound-${n}`, cursor })));
  expect((await run()).rows[0]!.cost).toEqual({ confirmedMicroUsd: null, reservedMicroUsd: null, reason: "receipt_unreadable" });
});

it.each([undefined, "processing"])("keeps Astra's B < A < C scope exhaustive across state swaps (filter=%s)", async state => {
  const b = await fixture({ phase: "awaiting_customer", createdAt: new Date("2026-11-01T00:00:00Z") });
  const a = await fixture({ createdAt: new Date("2026-11-02T00:00:00Z") });
  const c = await fixture({ createdAt: new Date("2026-11-03T00:00:00Z") });
  const first = await run({ limit: 2, state });
  expect(first.attendus).toBe(3);
  expect(first.rows.map(row => row.caseId)).toEqual(state ? [a.caseId] : [b.caseId, a.caseId]);
  expect(first.filteredOut).toBe(state ? 1 : 0);
  await f.db.update(savCases).set({ phase: "queued" }).where(eq(savCases.id, b.caseId));
  await f.db.update(savCases).set({ phase: "awaiting_customer" }).where(eq(savCases.id, c.caseId));
  const second = await run({ limit: 2, state, cursor: first.nextCursor });
  expect(second).toMatchObject({ attendus: 3, statesFilterApplied: !!state, filteredOut: state ? 1 : 0, nextCursor: null });
  expect(second.rows.map(row => row.caseId)).toEqual(state ? [] : [c.caseId]);
  const controlled = first.rows.length + first.filteredOut + second.rows.length + second.filteredOut;
  expect(controlled).toBe(first.attendus);
  expect(controlled).toBe(second.attendus);
});

it("advances through a fully filtered page even when no rows are displayed", async () => {
  await fixture({ phase: "awaiting_customer" }); await fixture();
  const first = await run({ state: "processing", limit: 1 });
  expect(first).toMatchObject({ attendus: 2, filteredOut: 1, statesFilterApplied: true, rows: [] });
  expect(first.nextCursor).not.toBeNull();
  const second = await run({ state: "processing", limit: 1, cursor: first.nextCursor });
  expect(second.rows).toHaveLength(1); expect(second.filteredOut).toBe(0); expect(second.nextCursor).toBeNull();
});

it("accepts postgres-js array results as well as PGlite row envelopes", async () => {
  const c = await fixture();
  await effect(c, "ticket_stage", "confirmed", at);
  const subject = randomUUID();
  await f.db.insert(savCaseCalls).values({ callKey: `${subject}:call1`, subjectKey: subject, caseId: c.caseId, caseVersion: 1, purpose: "decision", state: "reserved", token: randomUUID(), holder: "fixture", leaseUntil: new Date() });
  state.db = {
    transaction: (callback: (tx: unknown) => Promise<unknown>) => f.db.transaction(tx => callback(new Proxy(tx, {
      get(target, key, receiver) {
        if (key === "execute") return async (statement: Parameters<typeof tx.execute>[0]) => {
          const result = await tx.execute(statement);
          return Array.isArray(result) ? result : (result as unknown as { rows: unknown[] }).rows;
        };
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }))),
  };
  try { expect((await run()).rows[0]).toMatchObject({ caseId: c.caseId, hubspot: { status: "confirmed" }, cost: { reason: "receipt_missing" } }); }
  finally { state.db = f.db; }
});

it("keeps a confirmed mail visible when its note is refused after an owner change", async () => {
  const c = await fixture(); const id = await effect(c, "reply_send", "confirmed", at);
  await f.db.update(savCaseEffectExecutions).set({ state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED", payloadCiphertext: encryptSavPayload({ note: { text: "PRIVATE_NOTE" } }) }).where(eq(savCaseEffectExecutions.id, id));
  expect((await run()).rows[0]!.outcomes).toMatchObject([{ executionId: id, mail: { state: "confirmed", reason: null }, note: { state: "blocked", reason: "owner_changed" }, status: { state: "blocked", reason: "owner_changed" } }]);
});
it("exposes a rejected stage mapping even when the mail parent is confirmed", async () => {
  const c = await fixture(); const id = await effect(c, "reply_send", "confirmed", at);
  await f.db.update(savCaseEffectExecutions).set({ state: "confirmed" }).where(eq(savCaseEffectExecutions.id, id));
  await f.db.insert(savIntakeEffectJournal).values({ executionId: id, kind: "case_component_status", payloadCiphertext: encryptSavPayload({ state: "blocked", reason: "stages_stage_invalid" }) });
  expect((await run()).rows[0]!.outcomes).toMatchObject([{ mail: { state: "confirmed" }, status: { state: "blocked", reason: "mapping_invalid" } }]);
});
it("resolves a queued stage to its confirmed ledger and keeps an uncertain note unconfirmed", async () => {
  const c = await fixture(); const reply = await effect(c, "reply_send", "confirmed", at); const stage = await effect(c, "ticket_stage", "confirmed", at);
  await f.db.update(savCaseEffectExecutions).set({ replyKey: `case-stage:${c.caseId}:waiting_customer:fixture` }).where(eq(savCaseEffectExecutions.id, stage));
  await effect(c, "note_create", "uncertain", null, reply);
  await f.db.insert(savIntakeEffectJournal).values({ executionId: reply, kind: "case_component_status", payloadCiphertext: encryptSavPayload({ state: "queued", executionId: stage }) });
  expect((await run()).rows[0]!.outcomes.find(o => o.executionId === reply)).toMatchObject({ mail: { state: "confirmed" }, note: { state: "uncertain", reason: "result_uncertain" }, status: { state: "confirmed" } });
});
it("projects separate question counts for MCP inventory without leaking their contents", async () => {
  const c = await fixture();
  const body = { ...emptyCaseBody(), questions: [1, 2, 3].map(i => ({ id: `q${i}`, text: "PRIVATE_QUESTION", factKeys: [], askedAt: at.toISOString(), askedInEffect: "mail", ...(i === 1 ? { answeredBy: { type: "email", id: "private-answer" } } : {}) })) };
  await f.db.update(savCases).set({ payloadCiphertext: encryptSavPayload(body) }).where(eq(savCases.id, c.caseId));
  const page = await run();
  expect(page.rows.find(row => row.caseId === c.caseId)?.questions).toEqual({ asked: 3, answered: 1, open: 2 });
  expect(JSON.stringify(page)).not.toContain("PRIVATE_QUESTION");
});
