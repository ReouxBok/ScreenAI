import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savMailboxes, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
import { abandonSavHeartbeatStart, beatSavHeartbeat, claimSelfSchedulerJob, finishSelfSchedulerJob, handOffSavHeartbeat, readSelfSchedulerState,
  requestSavHeartbeatStart, setSelfSchedulerSwitch } from "./self-scheduler-store";
import { decideCatchUp, decideV2Effects, decideWatchRenewal } from "./self-scheduler";

// The real store on the migrated schema (PGlite, or native Postgres when SAV_TEST_POSTGRES_URL is set). Only the keys this
// store owns, the worker pulse/snapshot keys, its audit rows and the synthetic mailboxes are written; migrator markers stay.
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 60_000);
afterAll(async () => fixture?.client.close());
beforeEach(async () => {
  await fixture.client.exec("DELETE FROM sav.sync_state WHERE key LIKE 'sav-self-scheduler:v1:%' OR key IN ('sav-monitor:v1:worker','sav-monitor:v1:worker:sav-v2-effects','sav-monitor:v1:snapshot'); DELETE FROM sav.mailboxes WHERE email LIKE '%@example.invalid'; DELETE FROM audit_logs WHERE entity_type = 'sav_self_scheduler'");
});
const NOW = new Date("2026-11-11T12:00:00.000Z"), MIN = 60_000;
const pulse = (id: string, startedAt: Date) => fixture.db.insert(savSyncState).values({ key: "sav-monitor:v1:worker", status: "finished", cursor: JSON.stringify({ id, startedAt: startedAt.toISOString() }) });
const enable = (enabled = true) => setSelfSchedulerSwitch({ enabled, actor: "admin@example.invalid", reason: "synthetic test", now: NOW });
const hb = (owner: string, minutes: number, revision: string | null = "dpl_a") => ({ owner, revision, now: new Date(NOW.getTime() + minutes * MIN), staleMs: 15 * MIN });

it("opt-in: with no switch row (default) or the switch OFF, nothing is claimed, started or beaten, whatever the signals", async () => {
  await pulse("cron-pass", new Date(NOW.getTime() - 60 * MIN));
  const claim = () => claimSelfSchedulerJob({ job: "sav-reconcile", owner: "a", trigger: "t", now: NOW, leaseMs: 60_000, decide: decideCatchUp });
  expect(await claim()).toEqual({ run: false, reason: "switch_off" });
  expect(await requestSavHeartbeatStart(hb("h1", 0))).toEqual({ start: false, reason: "switch_off" });
  expect(await beatSavHeartbeat(hb("h1", 0))).toEqual({ alive: false, reason: "switch_off" });
  expect(await readSelfSchedulerState()).toEqual({ switch: { enabled: false, actor: null, reason: null, at: null } });
  await enable(false);
  expect(await claim()).toEqual({ run: false, reason: "switch_off" });
  await enable(true);
  expect(await claim()).toEqual({ run: true });
});

it("records actor and reason of each switch change, on the row and in the audit log", async () => {
  await enable(true); await enable(false);
  expect((await readSelfSchedulerState()).switch).toEqual({ enabled: false, actor: "admin@example.invalid", reason: "synthetic test", at: NOW.toISOString() });
  const audit = await fixture.db.select({ action: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.entityType, "sav_self_scheduler"), eq(auditLogs.entityId, "switch")));
  expect(audit.map(row => row.action).sort()).toEqual(["sav_self_scheduler_disabled", "sav_self_scheduler_enabled"]);
});

it("reads the worker pulse written by the cron and stays idle while it is fresh", async () => {
  await enable();
  await pulse("cron-pass", new Date(NOW.getTime() - 4 * MIN));
  expect(await claimSelfSchedulerJob({ job: "sav-reconcile", owner: "a", trigger: "gmail_webhook", now: NOW, leaseMs: 300_000, decide: decideCatchUp })).toEqual({ run: false, reason: "fresh" });
});

it("single-flight: two concurrent claims on a stale pulse give one run; the release records the end and keeps the pulse id", async () => {
  await enable();
  await pulse("cron-pass", new Date(NOW.getTime() - 30 * MIN));
  const claim = (owner: string, now = NOW) => claimSelfSchedulerJob({ job: "sav-reconcile", owner, trigger: owner, now, leaseMs: 300_000, pulseId: `pulse-${owner}`, decide: decideCatchUp });
  const results = await Promise.all([claim("first"), claim("second")]);
  expect(results.filter(result => result.run)).toHaveLength(1);
  expect(results.find(result => !result.run)).toEqual({ run: false, reason: "leased" });
  const winner = results[0].run ? "first" : "second";
  await finishSelfSchedulerJob({ job: "sav-reconcile", owner: "intruder", status: "ok", now: new Date(NOW.getTime() + MIN) });
  expect((await readSelfSchedulerState())["sav-reconcile"]).toMatchObject({ owner: winner, lastStatus: "running", leaseUntil: new Date(NOW.getTime() + 300_000).toISOString() });
  await finishSelfSchedulerJob({ job: "sav-reconcile", owner: winner, status: "ok", now: new Date(NOW.getTime() + 2 * MIN) });
  expect((await readSelfSchedulerState())["sav-reconcile"]).toMatchObject({ status: "ok", lastStatus: "ok", lastPulseId: `pulse-${winner}`, lastStartedAt: NOW.toISOString(), leaseUntil: new Date(NOW.getTime() + 2 * MIN).toISOString() });
  // Released, its own pass started 3 min ago: still fresh; 4 min after the start (one heartbeat tick) it is due again (12/11: about every 5 min).
  expect(await claim("third", new Date(NOW.getTime() + 3 * MIN))).toEqual({ run: false, reason: "fresh" });
  expect(await claim("fourth", new Date(NOW.getTime() + 4 * MIN))).toEqual({ run: true });
});

it("reads active mailboxes' watch expirations (unknown included)", async () => {
  await enable();
  await fixture.db.insert(savMailboxes).values([{ email: "watch-a@example.invalid", watchExpiration: new Date(NOW.getTime() + 6 * 24 * 60 * MIN) }, { email: "watch-b@example.invalid", active: false }]);
  expect(await claimSelfSchedulerJob({ job: "gmail-watch", owner: "a", trigger: "t", now: NOW, leaseMs: 60_000, decide: decideWatchRenewal })).toEqual({ run: false, reason: "watch_valid" });
  await fixture.db.insert(savMailboxes).values({ email: "watch-c@example.invalid" });
  expect(await claimSelfSchedulerJob({ job: "gmail-watch", owner: "a", trigger: "t", now: NOW, leaseMs: 60_000, decide: decideWatchRenewal })).toEqual({ run: true });
});

it("heartbeat singleton: one start while alive, a stale or other-code heartbeat is replaced, the old owner stops", async () => {
  await enable();
  const starts = await Promise.all([requestSavHeartbeatStart(hb("h1", 0)), requestSavHeartbeatStart(hb("h2", 0))]);
  expect(starts.filter(start => start.start)).toHaveLength(1);
  const owner = starts[0].start ? "h1" : "h2", other = owner === "h1" ? "h2" : "h1";
  expect(await beatSavHeartbeat(hb(owner, 1))).toEqual({ alive: true });
  expect(await beatSavHeartbeat(hb(other, 1))).toEqual({ alive: false, reason: "superseded" });
  expect(await requestSavHeartbeatStart(hb("h3", 10))).toEqual({ start: false, reason: "alive" });
  expect(await requestSavHeartbeatStart(hb("h3", 17))).toEqual({ start: true, reason: "stale" });
  expect(await beatSavHeartbeat(hb(owner, 18))).toEqual({ alive: false, reason: "superseded" });
  expect(await requestSavHeartbeatStart(hb("h4", 19, "dpl_b"))).toEqual({ start: true, reason: "other_revision" });
  expect(await beatSavHeartbeat(hb("h3", 20))).toEqual({ alive: false, reason: "superseded" });
  await abandonSavHeartbeatStart("h4");
  expect(await requestSavHeartbeatStart(hb("h5", 20, "dpl_b"))).toEqual({ start: true, reason: "stale" });
});

it("kill switch latency: disable stops the live heartbeat (any deployment) at its very next beat, with no continuation", async () => {
  await enable();
  expect(await requestSavHeartbeatStart(hb("root#0", 0, "dpl_old"))).toMatchObject({ start: true });
  expect(await beatSavHeartbeat(hb("root#0", 5, "dpl_old"))).toEqual({ alive: true });
  await enable(false);
  expect(await beatSavHeartbeat(hb("root#0", 10, "dpl_old"))).toEqual({ alive: false, reason: "switch_off" });
  expect(await handOffSavHeartbeat({ from: "root#0", to: "root#1", revision: "dpl_old", now: NOW })).toEqual({ handedOff: false, reason: "switch_off" });
});

it("same-owner duplicates are impossible: a generation is handed off once, and the next owner's first beat is its own", async () => {
  await enable();
  await requestSavHeartbeatStart(hb("root#0", 0));
  const handOffs = await Promise.all([1, 2].map(() => handOffSavHeartbeat({ from: "root#0", to: "root#1", revision: "dpl_a", now: new Date(NOW.getTime() + 60 * MIN) })));
  expect(handOffs.filter(result => result.handedOff)).toHaveLength(1);
  expect(handOffs.find(result => !result.handedOff)).toEqual({ handedOff: false, reason: "not_owner" });
  expect(await beatSavHeartbeat(hb("root#0", 61))).toEqual({ alive: false, reason: "superseded" });
  expect(await beatSavHeartbeat(hb("root#1", 61))).toEqual({ alive: true });
});

it("sav-v2-effects: reads its own pulse (not sav-reconcile's), honors the switch, stays idle while fresh, and a stale pulse gives one run under concurrency", async () => {
  const v2Pulse = (id: string, startedAt: Date) => fixture.db.insert(savSyncState).values({ key: "sav-monitor:v1:worker:sav-v2-effects", status: "finished", cursor: JSON.stringify({ id, startedAt: startedAt.toISOString() }) })
    .onConflictDoUpdate({ target: savSyncState.key, set: { cursor: JSON.stringify({ id, startedAt: startedAt.toISOString() }) } });
  const claim = (owner: string) => claimSelfSchedulerJob({ job: "sav-v2-effects", owner, trigger: owner, now: NOW, leaseMs: 300_000, pulseId: `pulse-${owner}`, decide: decideV2Effects });
  await v2Pulse("cron-v2", new Date(NOW.getTime() - 60 * MIN));
  expect(await claim("off")).toEqual({ run: false, reason: "switch_off" });
  await enable();
  await pulse("cron-pass", new Date(NOW.getTime() - 60 * MIN)); // a stale sav-reconcile pulse does not move the V2 decision
  await v2Pulse("cron-v2", new Date(NOW.getTime() - 5 * MIN));
  expect(await claim("fresh")).toEqual({ run: false, reason: "fresh" });
  await v2Pulse("cron-v2", new Date(NOW.getTime() - 13 * MIN));
  const results = await Promise.all([claim("first"), claim("second")]);
  expect(results.filter(result => result.run)).toHaveLength(1);
  expect(results.find(result => !result.run)).toEqual({ run: false, reason: "leased" });
  const winner = results[0].run ? "first" : "second";
  expect((await readSelfSchedulerState())["sav-v2-effects"]).toMatchObject({ owner: winner, lastStatus: "running", lastPulseId: `pulse-${winner}` });
});
