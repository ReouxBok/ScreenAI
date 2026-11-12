import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { like } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, savSyncState } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, broken: false }));
vi.mock("@/db", () => ({ requireDb: () => { if (state.broken) throw Error("SYNTHETIC_DB_DOWN"); return state.db; } }));
import { resetSavReconcileWatchdogThrottle, savReconcilePulseStale, watchSavReconcilePulse, WATCHDOG_STALE_MS } from "./monitor-watchdog";

// Watchdog of the scheduled catch-up (11/11): one row read from webhook traffic, throttled, the existing monitor as the only alert path. Synthetic Slack only.
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const WORKER = "sav-monitor:v1:worker", SLACK = "https://hooks.slack.com/services/T123/B456/synthetic";
const clearMonitorKeys = () => f.db.delete(savSyncState).where(like(savSyncState.key, "sav-monitor:v1:%"));
const pulseAt = (startedAt: number, finishedAt = startedAt) => f.db.insert(savSyncState).values({ key: WORKER, status: "finished",
  cursor: JSON.stringify({ id: "00000000-0000-4000-8000-000000000001", startedAt: new Date(startedAt).toISOString(), lastFinishedAt: new Date(finishedAt).toISOString(), monitoringSince: new Date(startedAt).toISOString() }) });

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await clearMonitorKeys(); await f.client.close(); });
beforeEach(async () => {
  state.broken = false; resetSavReconcileWatchdogThrottle(); await clearMonitorKeys(); await f.client.exec("TRUNCATE sav.mailboxes, audit_logs CASCADE");
  for (const [key, value] of Object.entries({ SAV_INTAKE_RUNTIME_MODE: "off", SAV_INTAKE_EXECUTION_MODE: "off", SAV_MONITOR_SLACK_WEBHOOK_URL: "", SAV_INTAKE_OTHER_RULES_JSON: "" })) vi.stubEnv(key, value);
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-monitor-encryption-key-123456789");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NO_REAL_NETWORK"); }));
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("the monitor's own rule: started or finished more than 15 minutes ago, or absent / unreadable, is stale", () => {
  const now = Date.parse("2026-11-11T12:00:00.000Z"), at = (ms: number) => new Date(now - ms).toISOString();
  expect(savReconcilePulseStale(JSON.stringify({ startedAt: at(60_000), lastFinishedAt: at(30_000) }), now)).toBe(false);
  expect(savReconcilePulseStale(JSON.stringify({ startedAt: at(WATCHDOG_STALE_MS + 1000), lastFinishedAt: at(WATCHDOG_STALE_MS + 500) }), now)).toBe(true);
  // A worker that keeps starting but never finishes (killed every time) is stale too.
  expect(savReconcilePulseStale(JSON.stringify({ startedAt: at(60_000), lastFinishedAt: at(WATCHDOG_STALE_MS + 1000) }), now)).toBe(true);
  expect(savReconcilePulseStale(null, now)).toBe(true);
  expect(savReconcilePulseStale("{not json", now)).toBe(true);
});

it("a fresh pulse: one read, no monitor; a second call within the minute is throttled (no read at all)", async () => {
  const now = Date.now(), runMonitor = vi.fn(async () => ({}));
  await pulseAt(now - 60_000);
  expect(await watchSavReconcilePulse({ now: () => now, runMonitor })).toEqual({ checked: true, stale: false });
  state.broken = true; // a read now would throw: the throttle must answer before any read
  expect(await watchSavReconcilePulse({ now: () => now + 30_000, runMonitor })).toEqual({ checked: false, reason: "throttled" });
  expect(runMonitor).not.toHaveBeenCalled();
});

it("a pulse older than 15 minutes (or none) runs the monitor; it is not run again while its last observation is under 5 minutes old", async () => {
  const now = Date.now(), runMonitor = vi.fn(async () => ({}));
  await pulseAt(now - WATCHDOG_STALE_MS - 60_000);
  expect(await watchSavReconcilePulse({ now: () => now, runMonitor })).toEqual({ checked: true, stale: true, monitor: "ran" });
  await f.db.insert(savSyncState).values({ key: "sav-monitor:v1:state", status: "observed", cursor: JSON.stringify({ observedAt: new Date(now).toISOString() }) });
  expect(await watchSavReconcilePulse({ now: () => now + 61_000, runMonitor })).toEqual({ checked: true, stale: true, monitor: "recent" });
  expect(runMonitor).toHaveBeenCalledTimes(1);
  await clearMonitorKeys(); resetSavReconcileWatchdogThrottle();
  expect(await watchSavReconcilePulse({ now: () => now, runMonitor })).toEqual({ checked: true, stale: true, monitor: "ran" });
  expect(runMonitor).toHaveBeenCalledTimes(2);
});

it("never throws: a database failure or a failing monitor is a result, not an exception", async () => {
  state.broken = true;
  await expect(watchSavReconcilePulse({ runMonitor: async () => ({}) })).resolves.toEqual({ checked: false, reason: "error" });
  state.broken = false; resetSavReconcileWatchdogThrottle();
  await expect(watchSavReconcilePulse({ runMonitor: async () => { throw Error("SYNTHETIC_MONITOR_DOWN"); } })).resolves.toEqual({ checked: true, stale: true, monitor: "failed" });
});

it("end to end on the real monitor: the scheduler stops, webhook traffic raises ONE durable worker_stalled alert on Slack, never repeated while it lasts", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  vi.stubEnv("SAV_MONITOR_SLACK_WEBHOOK_URL", SLACK);
  vi.mocked(fetch).mockImplementation(async () => new Response("ok", { status: 200 }));
  await pulseAt(start - 60_000);
  // The scheduler is alive: webhook traffic reads the pulse and does nothing else.
  expect(await watchSavReconcilePulse()).toEqual({ checked: true, stale: false });
  expect(fetch).not.toHaveBeenCalled();
  // The scheduler stopped (no new pulse). Webhook traffic every minute for an hour.
  const outcomes: string[] = [];
  for (let minute = 1; minute <= 60; minute++) {
    vi.setSystemTime(start + minute * 60_000);
    const outcome = await watchSavReconcilePulse();
    outcomes.push("monitor" in outcome ? outcome.monitor : "stale" in outcome ? "fresh" : outcome.reason);
  }
  expect(outcomes.slice(0, 14).every(o => o === "fresh")).toBe(true);
  expect(outcomes.filter(o => o === "ran").length).toBeGreaterThanOrEqual(2); // re-observed every 5 minutes at most
  const slack = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === SLACK);
  expect(slack).toHaveLength(1);
  expect(String(JSON.parse(String((slack[0]![1] as RequestInit).body)).text)).toContain("worker_stalled");
  expect((await f.db.select().from(auditLogs)).filter(row => row.action === "sav_monitor_observed").length).toBe(outcomes.filter(o => o === "ran").length);
});

it("11/11: the V2 effects pulse is watched the same way (stale after 25 min) when V2 runs; absent or V2 off, it does not trigger from here", async () => {
  const now = Date.now(), runMonitor = vi.fn(async () => ({}));
  const V2 = "sav-monitor:v1:worker:sav-v2-effects";
  await pulseAt(now - 60_000);
  const v2At = (at: number) => f.db.insert(savSyncState).values({ key: V2, status: "finished",
    cursor: JSON.stringify({ id: "00000000-0000-4000-8000-000000000002", startedAt: new Date(at).toISOString(), lastFinishedAt: new Date(at).toISOString(), monitoringSince: new Date(at).toISOString() }) });
  vi.stubEnv("SAV_V2_ENTRY", "on"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  expect(await watchSavReconcilePulse({ now: () => now, runMonitor })).toEqual({ checked: true, stale: false }); // absent: the monitor reports it
  await v2At(now - 20 * 60_000); resetSavReconcileWatchdogThrottle();
  expect(await watchSavReconcilePulse({ now: () => now, runMonitor })).toEqual({ checked: true, stale: false }); // 20 min: within two periods and a half
  await f.db.delete(savSyncState).where(like(savSyncState.key, V2)); await v2At(now - 26 * 60_000); resetSavReconcileWatchdogThrottle();
  expect(await watchSavReconcilePulse({ now: () => now, runMonitor })).toEqual({ checked: true, stale: true, monitor: "ran" });
  vi.stubEnv("SAV_V2_ENTRY", ""); resetSavReconcileWatchdogThrottle();
  expect(await watchSavReconcilePulse({ now: () => now + 61_000, runMonitor })).toEqual({ checked: true, stale: false }); // V2 off: not expected
  expect(runMonitor).toHaveBeenCalledTimes(1);
});
