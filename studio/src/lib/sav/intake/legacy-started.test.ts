import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savActions, savMailboxes, savMessages, savSyncState, savThreads } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { collectSavMonitorSnapshot } from "../monitor";
import { describeLegacyCommandState, describeLegacyStartedCause, legacyCommandStates, legacyStartedCauses, readLegacyStartedInventory } from "./legacy-started";

// SAV-9 backlog: the mails the retired V0 engine had started, and the human V0 commands still open, are READABLE (cause, age, handoff, read-only
// checks) and COUNTED by the monitor with the same predicate. Looking resumes, resets, cancels and sends nothing. Synthetic rows only.
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, fetchSpy: ReturnType<typeof vi.fn>;
const minutes = (n: number) => new Date(Date.now() - n * 60_000);
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
  await f.client.exec("TRUNCATE sav.actions, sav.mailboxes, sav.sync_state CASCADE");
  [{ id: mailboxId }] = await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning();
  for (const key of ["sav-intake-console-schema-v1", "sav-intake-execution-schema-v1"]) await f.db.insert(savSyncState).values({ key, status: "installed" });
  await f.db.insert(savSyncState).values({ key: `sav-intake-launch:${mailboxId}`, status: "intake_launch_v1", cursor: JSON.stringify({ receivedAfter: minutes(600).toISOString(), createdAfter: minutes(600).toISOString() }) });
});
afterEach(() => { vi.unstubAllGlobals(); });

type MessagePatch = Partial<typeof savMessages.$inferInsert>;
async function mail(patch: MessagePatch = {}, ageMinutes = 20, thread: { aiPaused?: boolean } = {}) {
  const [t] = await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid", ...thread }).returning();
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId: t.id, direction: "inbound", fromEmail: "synthetic@example.invalid", subject: "Sujet fictif",
    gmailMessageId: randomUUID(), bodyCiphertext: "not-read", receivedAt: minutes(ageMinutes), createdAt: minutes(ageMinutes), analysisStatus: "pending", ...patch }).returning();
  return { threadId: t.id, messageId: m.id };
}
type ActionPatch = Partial<typeof savActions.$inferInsert>;
async function command(threadId: string, patch: ActionPatch = {}, ageMinutes = 60) {
  const [a] = await f.db.insert(savActions).values({ threadId, kind: "send_reply", status: "pending", actorType: "human", actorEmail: "staff@example.invalid", payload: {}, idempotencyKey: randomUUID(),
    createdAt: minutes(ageMinutes), ...patch }).returning();
  return a;
}
const counts = async () => Object.fromEntries(await Promise.all(["messages", "actions", "threads", "audit_logs", "sync_state"].map(async table => {
  const result = await f.client.query<{ n: number }>(`select count(*)::int as n from ${table === "audit_logs" ? "public.audit_logs" : "sav." + table}`);
  return [table, result.rows[0]!.n] as const;
})));
const snapshotRows = async () => (await f.client.query<{ m: string | null; a: string | null }>(`select (select string_agg(id::text||analysis_status||analysis_attempts::text||coalesce(analysis_started_at::text,'')||coalesce(processed_at::text,''), ',' order by id) from sav.messages) as m,
  (select string_agg(id::text||status||attempt_count::text||updated_at::text||payload::text, ',' order by id) from sav.actions) as a`)).rows[0];

it("names each V0 cause, orders oldest first, and hands every mail to the team by hand", async () => {
  const processing = await mail({ analysisStatus: "processing", analysisStartedAt: minutes(30) }, 50);
  const failed = await mail({ analysisStatus: "failed", analysisAttempts: 3 }, 40);
  const attempted = await mail({ analysisAttempts: 1 }, 30);
  const started = await mail({ analysisStartedAt: minutes(25) }, 28);
  const marked = await mail({ processedAt: minutes(22) }, 25);
  const traced = await mail({}, 21); await command(traced.threadId, { messageId: traced.messageId, kind: "log_email", actorType: "system", status: "succeeded" });
  await mail({}, 20); // untouched pending: intake owns it
  await mail({ analysisStatus: "done", processedAt: minutes(30) }, 35); // terminal
  const inventory = await readLegacyStartedInventory();
  expect(inventory.startedMails.items.map(i => [i.messageId, i.cause])).toEqual([
    [processing.messageId, "v0_processing"], [failed.messageId, "v0_failed"], [attempted.messageId, "v0_pending_after_attempt"], [started.messageId, "v0_pending_after_attempt"],
    [marked.messageId, "v0_pending_after_attempt"], [traced.messageId, "v0_pending_with_traces"]]);
  expect(inventory.startedMails).toMatchObject({ total: 6, truncated: false, byCause: { v0_processing: 1, v0_failed: 1, v0_pending_after_attempt: 3, v0_pending_with_traces: 1 } });
  expect(inventory.startedMails.items[5]).toMatchObject({ traces: { actions: 1, decisions: 0, agentRuns: 0, pilotItems: 0, reviews: 0 } });
  expect(inventory.startedMails.items[0]!.ageSeconds).toBeGreaterThanOrEqual(50 * 60 - 5);
  for (const item of inventory.startedMails.items) {
    expect(item.handoff).toEqual({ owner: "team", state: "manual_follow_up", automaticRecovery: false });
    expect(item.readOnlyChecks).toEqual(["open_archived_dossier", "check_gmail_thread_for_a_reply", "check_crm_ticket"]);
    expect(item.label.length).toBeGreaterThan(20);
  }
});

it("uses the monitor's scope: grace period, paused thread, superseded mail and unlaunched mailbox are not listed", async () => {
  await mail({ analysisStatus: "failed" }, 5);                                  // under the 10 min grace
  await mail({ analysisStatus: "failed" }, 20, { aiPaused: true });             // a person owns the thread
  const older = await mail({ analysisStatus: "failed" }, 40);
  await mail({}, 20).then(async newer => { await f.db.update(savMessages).set({ threadId: older.threadId }).where(eq(savMessages.id, newer.messageId)); }); // a newer inbound on the same thread
  const [other] = await f.db.insert(savMailboxes).values({ email: "other@example.invalid" }).returning();
  const [t] = await f.db.insert(savThreads).values({ mailboxId: other.id, gmailThreadId: randomUUID(), customerEmail: "synthetic@example.invalid" }).returning();
  await f.db.insert(savMessages).values({ mailboxId: other.id, threadId: t.id, direction: "inbound", fromEmail: "synthetic@example.invalid", gmailMessageId: randomUUID(), bodyCiphertext: "not-read",
    receivedAt: minutes(60), createdAt: minutes(60), analysisStatus: "failed" });                                  // mailbox never launched on V1
  expect((await readLegacyStartedInventory()).startedMails).toMatchObject({ total: 0, items: [] });
});

it("looking changes nothing: no row written, no attempt reset, no provider call, no model call", async () => {
  const failed = await mail({ analysisStatus: "failed", analysisAttempts: 3 }, 40);
  await command(failed.threadId, { messageId: failed.messageId, status: "failed", payload: { replySendDispatchedAt: minutes(90).toISOString() } });
  await command(failed.threadId, { kind: "create_ticket" });
  const before = { counts: await counts(), rows: await snapshotRows() };
  const inventory = await readLegacyStartedInventory();
  expect(inventory).toMatchObject({ readOnly: true, providerCalls: 0, modelCalls: 0, startedMails: { total: 1 }, queuedHumanCommands: { total: 2 } });
  expect({ counts: await counts(), rows: await snapshotRows() }).toEqual(before);
  expect(fetchSpy).not.toHaveBeenCalled();
  // The transaction itself is read-only: a write inside it is refused by the database.
  await expect(f.db.transaction(async tx => {
    await tx.execute((await import("drizzle-orm")).sql`set transaction isolation level repeatable read read only`);
    await tx.update(savMessages).set({ analysisAttempts: 0 });
  })).rejects.toThrow();
  expect((await snapshotRows()).m).toBe(before.rows.m);
});

it("the inventory runs in a read-only repeatable-read transaction, before any other statement", async () => {
  await mail({ analysisStatus: "failed" }, 40);
  const executed: string[] = [];
  const db = { transaction: <T>(work: (tx: never) => Promise<T>) => f.db.transaction(tx => work({ execute: (q: { queryChunks: unknown[] }) => { executed.push(JSON.stringify(q.queryChunks)); return tx.execute(q as never); } } as never)) };
  await readLegacyStartedInventory({ db: db as never });
  expect(executed[0]).toContain("read only");
  expect(executed.filter(text => /\b(insert|update|delete|truncate)\b/i.test(text))).toEqual([]);
});

it("lists the human V0 commands still open by state, and never lists what is finished, unrelated or not human", async () => {
  const { threadId } = await mail({}, 90);
  const queued = await command(threadId, { kind: "send_reply", status: "pending" }, 120);
  const running = await command(threadId, { kind: "create_ticket", status: "running" }, 100);
  const sentUnconfirmed = await command(threadId, { kind: "send_reply", status: "failed", payload: { replySendDispatchedAt: minutes(70).toISOString() } }, 80);
  const ticketUnconfirmed = await command(threadId, { kind: "link_ticket", status: "pending", payload: { ticketReturnDispatchedAt: minutes(70).toISOString() } }, 70);
  await command(threadId, { status: "succeeded" });                                                    // finished
  await command(threadId, { kind: "send_reply", status: "succeeded", payload: { replySendDispatchedAt: minutes(90).toISOString() } }); // finished send: the trace stays, the row is done
  await command(threadId, { status: "failed" });                                                       // failed with no dispatch trace: not queued
  await command(threadId, { status: "cancelled" });                                                    // cancelled with no trace
  await command(threadId, { kind: "draft_reply", status: "pending" });                                 // not a legacy-conflict kind
  await command(threadId, { actorType: "system", status: "pending" });                                 // machine row: counted apart
  await command(threadId, { actorType: "ai", kind: "log_email", status: "running", payload: { forwardDispatchedAt: minutes(5).toISOString() } });
  const { queuedHumanCommands, machineRowsOpen } = await readLegacyStartedInventory();
  expect(queuedHumanCommands.items.map(i => [i.actionId, i.state])).toEqual([[queued.id, "queued_not_dispatched"], [running.id, "running_not_dispatched"],
    [sentUnconfirmed.id, "dispatch_started_unconfirmed"], [ticketUnconfirmed.id, "dispatch_started_unconfirmed"]]);
  expect(queuedHumanCommands).toMatchObject({ total: 4, truncated: false, byState: { queued_not_dispatched: 1, running_not_dispatched: 1, dispatch_started_unconfirmed: 2 } });
  expect(queuedHumanCommands.oldestAgeSeconds).toBeGreaterThanOrEqual(120 * 60 - 5);
  expect(machineRowsOpen).toBe(2);
  expect(queuedHumanCommands.items.map(i => [i.state, i.cronMayStillExecute])).toEqual([["queued_not_dispatched", true], ["running_not_dispatched", true], ["dispatch_started_unconfirmed", false], ["dispatch_started_unconfirmed", false]]);
  for (const item of queuedHumanCommands.items) expect(item).toMatchObject({ automaticAction: false, handoff: { owner: "team", decision: "ugo_pending_C2" } });
});

it("the monitor counts exactly what the inventory lists, by cause, with the same predicate", async () => {
  await mail({ analysisStatus: "processing", analysisStartedAt: minutes(20) }, 28);
  await mail({ analysisStatus: "failed" }, 26);
  await mail({ analysisAttempts: 2 }, 24);
  const traced = await mail({}, 22); await command(traced.threadId, { messageId: traced.messageId, kind: "log_email", actorType: "system", status: "succeeded" });
  await command(traced.threadId, { status: "pending" }, 25);
  await command(traced.threadId, { kind: "link_ticket", status: "failed", payload: { ticketReturnDispatchedAt: minutes(20).toISOString() } }, 24);
  const [inventory, snapshot] = [await readLegacyStartedInventory(), await collectSavMonitorSnapshot()];
  expect(snapshot.issues.find(i => i.code === "legacy_unclaimed")).toEqual({ code: "legacy_unclaimed", count: inventory.startedMails.total, severity: "warning" });
  expect(snapshot.issues.find(i => i.code === "legacy_human_queued")).toEqual({ code: "legacy_human_queued", count: inventory.queuedHumanCommands.total, severity: "warning" });
  expect(snapshot.metrics).toMatchObject({ legacyStartedProcessing: 1, legacyStartedFailed: 1, legacyStartedPendingAfterAttempt: 1, legacyStartedPendingWithTraces: 1,
    legacyHumanQueuedNotDispatched: 1, legacyHumanRunningNotDispatched: 0, legacyHumanDispatchUnconfirmed: 1, legacyMachineRowsOpen: 0 });
  // Older than 30 minutes is critical for both, like analysis_delayed.
  await f.client.exec("update sav.actions set created_at = now() - interval '2 hours'; update sav.messages set created_at = now() - interval '50 minutes', received_at = now() - interval '50 minutes'");
  const old = await collectSavMonitorSnapshot();
  expect(old.issues.find(i => i.code === "legacy_unclaimed")?.severity).toBe("critical");
  expect(old.issues.find(i => i.code === "legacy_human_queued")?.severity).toBe("critical");
});

it("returns identifiers, counts and fixed codes only: no mail text, subject or address", async () => {
  const failed = await mail({ analysisStatus: "failed" }, 40);
  await command(failed.threadId, { messageId: failed.messageId, payload: { text: "Contenu client fictif", to: "synthetic@example.invalid" } });
  const text = JSON.stringify(await readLegacyStartedInventory());
  for (const secret of ["synthetic@example.invalid", "Sujet fictif", "Contenu client fictif", "staff@example.invalid", "support@example.invalid"]) expect(text, secret).not.toContain(secret);
});

it("is bounded: limit 1..100, truncated when more exist, totals stay complete", async () => {
  for (let i = 0; i < 3; i += 1) await mail({ analysisStatus: "failed" }, 40 + i);
  const page = await readLegacyStartedInventory({ limit: 2 });
  expect(page.startedMails).toMatchObject({ total: 3, truncated: true }); expect(page.startedMails.items).toHaveLength(2);
  await expect(readLegacyStartedInventory({ limit: 0 })).rejects.toThrow(RangeError);
  await expect(readLegacyStartedInventory({ limit: 101 })).rejects.toThrow(RangeError);
});

it("every cause and state has a French label, a team handoff and no automatic recovery or action", () => {
  for (const cause of legacyStartedCauses) expect(describeLegacyStartedCause(cause)).toMatchObject({ cause, handoff: { owner: "team", automaticRecovery: false } });
  for (const state of legacyCommandStates) expect(describeLegacyCommandState(state)).toMatchObject({ state, automaticAction: false });
  expect(new Set(legacyStartedCauses.map(c => describeLegacyStartedCause(c).label)).size).toBe(legacyStartedCauses.length);
});
