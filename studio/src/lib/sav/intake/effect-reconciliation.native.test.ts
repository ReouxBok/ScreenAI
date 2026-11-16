import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavNativeTestDb, validateSavNativeTestTarget } from "../../../../test/sav-native-db";
import { blockedBehind, finishNativeHandle, openNativeHandle, openNativeObserver, waitingOnLock } from "../../../../test/sav-native-locks";

const state = vi.hoisted(() => ({ db: (() => { throw Error("NO_DB_ALLOWED"); }) as () => unknown, user: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db() }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: async () => state.user }));
import { auditLogs, savIntakeEffects, savIntakeExecutionPolicies, savIntakeExecutions, savIntakeRuns, savMailboxes, savMessages, savSyncState, savThreads, staffUsers } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { savAgentPauseKey } from "./agent-pause";
import { setSavAgentPause } from "./agent-pause-admin";
import { reconcileIntakeUncertainEffect } from "./effect-reconciliation";
import { intakeRuntimeHash } from "./runtime-contract";
import type { EffectIntent, ExecutorAdapters } from "./execution-types";

const URL_ = process.env.SAV_TEST_POSTGRES_URL, TOKEN = process.env.SAV_TEST_POSTGRES_TOKEN;
type Store = Awaited<ReturnType<typeof createSavNativeTestDb>>;
const context = new AsyncLocalStorage<Store["db"]>();
const gate = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };
// Capture every rejection immediately, including SQLSTATE nested by Drizzle. Unexpected errors (40P01 included) fail the assertions.
const settled = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
const reached = (signal: Promise<void>, operation: Promise<unknown>) => Promise.race([signal, operation.then(value => { throw Error(`OPERATION_ENDED_BEFORE_VERIFICATION:${JSON.stringify(value)}`); })]);
const proof = { confirmed: true, attributed: true, ack: { id: "301" } };

// Native only: two independent single-connection application pools, plus a lock holder and observer.
// Only Clerk and the external read-only verification are replaced; auth, pause, leases, transactions and confirmation are real.
// Fresh synthetic records, no truncation of the shared CI database. No DATABASE_URL fallback.
describe.skipIf(!URL_)("SAV-92 native effect reconciliation concurrency", () => {
  let a: Store, b: Store, observer: postgres.Sql, holders: postgres.Sql, mailboxId: string, adminId: string, pidA: number, pidB: number;
  // The shared intake pause row is written here with this file's encryption key: any later file in the same native job
  // (other key) would read it as unreadable, i.e. fully_paused (fail closed). It is restored exactly as found.
  let pauseBefore: (typeof savSyncState.$inferSelect) | undefined, pauseCaptured = false;
  const on = <T>(store: Store, work: () => Promise<T>) => context.run(store.db, work);
  const pause = (level: "running" | "actions_paused") => on(b, () => setSavAgentPause({ agent: "intake", level, reason: "Synthetic native concurrency fixture" }));
  const reconcile = (store: Store, input: { threadId: string; messageId: string }, verify: ExecutorAdapters["verify"]) =>
    on(store, () => reconcileIntakeUncertainEffect({ threadId: input.threadId, messageId: input.messageId }, undefined, { verify }));

  beforeAll(async () => {
    validateSavNativeTestTarget(URL_!, TOKEN);
    vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-native-reconcile-key-32-characters");
    vi.stubGlobal("fetch", vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); }));
    a = await createSavNativeTestDb(URL_!, TOKEN, { poolMax: 1 });
    b = await createSavNativeTestDb(URL_!, TOKEN, { poolMax: 1 });
    state.db = () => context.getStore() ?? a.db;
    observer = openNativeObserver(URL_!);
    holders = postgres(URL_!, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {}, connection: { statement_timeout: 10000, lock_timeout: 5000 } });
    [pauseBefore] = await a.db.select().from(savSyncState).where(eq(savSyncState.key, savAgentPauseKey("intake"))); pauseCaptured = true;
    pidA = (await a.client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    pidB = (await b.client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    expect(pidA).not.toBe(pidB);
    // A fixed allowlisted address is required by real SAV authorization; all identity data is synthetic.
    const clerkId = `native-reconcile-${randomUUID()}`;
    const [admin] = await a.db.insert(staffUsers).values({ clerkId, email: "ugo@limova.ai", name: "Synthetic Native", role: "admin", active: true })
      .onConflictDoUpdate({ target: staffUsers.email, set: { clerkId, role: "admin", active: true } }).returning();
    adminId = admin.id;
    state.user = { id: clerkId, primaryEmailAddress: { emailAddress: admin.email, verification: { status: "verified" } } };
    mailboxId = (await a.db.insert(savMailboxes).values({ email: `native-reconcile-${randomUUID()}@example.invalid` }).returning())[0].id;
  }, 60000);
  beforeEach(async () => { await pause("running"); });
  afterEach(async () => { if (b) await pause("running"); });
  afterAll(async () => {
    state.user = null;
    if (a && pauseCaptured) {
      await a.db.delete(savSyncState).where(eq(savSyncState.key, savAgentPauseKey("intake")));
      if (pauseBefore) await a.db.insert(savSyncState).values(pauseBefore);
    }
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await a?.client.close(); await b?.client.close(); await holders?.end({ timeout: 2 }); await observer?.end({ timeout: 2 });
  });

  async function scenario() {
    const threadId = (await a.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "customer@example.invalid" }).returning())[0].id;
    const at = new Date("2026-11-15T10:00:00Z");
    const messageId = (await a.db.insert(savMessages).values({ threadId, mailboxId, direction: "inbound", gmailMessageId: randomUUID(), fromEmail: "customer@example.invalid",
      toEmails: ["support@example.invalid"], subject: "Synthetic native", bodyCiphertext: encryptSavPayload({ text: "Synthetic.", attachments: [] }), receivedAt: at }).returning())[0].id;
    const runId = (await a.db.insert(savIntakeRuns).values({ threadId, messageId, version: 1, state: "observed", configHash: "c", policyHash: "p", sourceHash: "s".repeat(64), payloadCiphertext: encryptSavPayload({}) }).returning())[0].id;
    const policyId = (await a.db.insert(savIntakeExecutionPolicies).values({ revision: `native-${randomUUID()}`, state: "approved", administratorId: adminId, policyHash: "p", payloadCiphertext: encryptSavPayload({}) }).returning())[0].id;
    const executionId = (await a.db.insert(savIntakeExecutions).values({ threadId, messageId, runId, runVersion: 1, policyId, policyHash: "p", state: "uncertain", ticketId: "201", payloadCiphertext: encryptSavPayload({}) }).returning())[0].id;
    const intent: EffectIntent = { kind: "note_create", permission: "append_ticket_note", key: `note:${messageId}:201`, ticketId: "201", sourceMessageId: messageId,
      text: "Synthetic.", marker: "a".repeat(64), properties: { hs_note_body: "Synthetic." } };
    const effectId = (await a.db.insert(savIntakeEffects).values({ executionId, businessKey: intent.key, kind: intent.kind, permission: intent.permission, state: "uncertain",
      intentHash: intakeRuntimeHash(intent), intentCiphertext: encryptSavPayload(intent), dispatchedAt: at, ackCiphertext: encryptSavPayload({ id: "301" }), reconcileAttempts: 5 }).returning())[0].id;
    return { threadId, messageId, executionId, effectId };
  }
  async function assertStored(run: Awaited<ReturnType<typeof scenario>>, confirmed: boolean) {
    const [effect] = await a.db.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, run.effectId));
    expect(effect.state).toBe(confirmed ? "confirmed" : "uncertain");
    expect(effect.confirmedAt !== null).toBe(confirmed);
    expect(effect.reconcileAttempts).toBe(5);
    const [execution] = await a.db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, run.executionId));
    expect({ state: execution.state, token: execution.leaseToken, until: execution.leaseUntil }).toEqual({ state: "uncertain", token: null, until: null });
    const audits = await a.db.select().from(auditLogs).where(eq(auditLogs.entityId, run.threadId));
    expect(audits.filter(row => row.action === "sav_intake_effect_reconciled_from_receipt")).toHaveLength(confirmed ? 1 : 0);
    const journal = await a.client.query<{ n: number }>("select count(*)::int as n from sav.intake_effect_journal where effect_id = $1 and kind = 'confirmed'", [run.effectId]);
    expect(journal.rows[0].n).toBe(confirmed ? 1 : 0);
  }

  it("a pause queued first commits before the confirmation fence: no effect can be confirmed", async () => {
    const run = await scenario(), entered = gate(), resume = gate(), holder = await openNativeHandle(holders);
    const verifying = vi.fn(async () => { entered.open(); await resume.promise; return proof; });
    const result = settled(reconcile(a, run, verifying));
    let paused: ReturnType<typeof settled> | undefined;
    try {
      await reached(entered.promise, result);
      await holder.conn.unsafe("BEGIN");
      await holder.conn.unsafe("select pg_advisory_xact_lock(hashtext('sav-intake-runtime-model-budget-v1'))");
      paused = settled(pause("actions_paused"));
      await waitingOnLock(observer, pidB); // Pause is first in the real advisory-lock queue.
      resume.open();
      await waitingOnLock(observer, pidA); // Confirmation is now in flight, before its commit.
      await blockedBehind(observer, holder.pid, 2);
      await holder.conn.unsafe("COMMIT");
      expect(await paused).toMatchObject({ value: { level: "actions_paused" }, error: undefined });
      expect((await result).error).toBeInstanceOf(Error);
      expect(String((await result).error)).toContain("SAV_INTAKE_EFFECT_RECONCILIATION_LOCKED");
      expect(verifying).toHaveBeenCalledTimes(1);
      await assertStored(run, false);
    } finally { resume.open(); await finishNativeHandle(observer, holder); await Promise.all([result, paused]); }
  }, 30000);

  it("confirmation holding the pause fence makes a concurrent pause wait until confirmation commits", async () => {
    const run = await scenario(), entered = gate(), resume = gate(), holder = await openNativeHandle(holders);
    const result = settled(reconcile(a, run, async () => { entered.open(); await resume.promise; return proof; }));
    let paused: ReturnType<typeof settled> | undefined;
    try {
      await reached(entered.promise, result);
      await holder.conn.unsafe("BEGIN");
      await holder.conn.unsafe("select id from sav.intake_effects where id = $1 for update", [run.effectId]);
      resume.open();
      await waitingOnLock(observer, pidA); // Confirmation has read running and is blocked on the effect row.
      await blockedBehind(observer, holder.pid, 1);
      paused = settled(pause("actions_paused"));
      await waitingOnLock(observer, pidB); // Cannot record a pause between the read and confirmation commit.
      await blockedBehind(observer, holder.pid, 2);
      await holder.conn.unsafe("COMMIT");
      expect(await result).toMatchObject({ value: { reconciled: true }, error: undefined });
      expect(await paused).toMatchObject({ value: { level: "actions_paused" }, error: undefined });
      await assertStored(run, true);
    } finally { resume.open(); await finishNativeHandle(observer, holder); await Promise.all([result, paused]); }
  }, 30000);

  it("two calls by the same administrator overlap pre-check and confirmation without 40P01; exactly one confirms", async () => {
    const run = await scenario(), entered = gate(), resume = gate(), holder = await openNativeHandle(holders);
    const verify = vi.fn(async () => { entered.open(); await resume.promise; return proof; });
    const first = settled(reconcile(a, run, verify));
    let second: ReturnType<typeof settled> | undefined;
    try {
      await reached(entered.promise, first); // First call owns its recovery lease and is reading the provider.
      await holder.conn.unsafe("BEGIN");
      await holder.conn.unsafe("select id from sav.threads where id = $1 for update", [run.threadId]);
      second = settled(reconcile(b, run, verify));
      await waitingOnLock(observer, pidB); // Second pre-check holds earlier locks and waits on the thread.
      await blockedBehind(observer, holder.pid, 1);
      resume.open(); // First confirmation now overlaps that pre-check, using the SAME administrator.
      await waitingOnLock(observer, pidA);
      await blockedBehind(observer, holder.pid, 2);
      await holder.conn.unsafe("COMMIT");
      expect(await first).toMatchObject({ value: { reconciled: true }, error: undefined });
      // The second call sees the first recovery lease and refuses cleanly; a deadlock or timeout is not accepted.
      expect(String((await second).error)).toBe("Error: SAV_INTAKE_EFFECT_RECONCILIATION_LOCKED");
      expect(verify).toHaveBeenCalledTimes(1);
      await assertStored(run, true);
      expect(await reconcile(b, run, verify)).toEqual({ reconciled: false, alreadyConfirmed: true });
    } finally { resume.open(); await finishNativeHandle(observer, holder); await Promise.all([first, second]); }
  }, 30000);
});
