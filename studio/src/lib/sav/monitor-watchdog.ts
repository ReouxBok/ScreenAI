import "server-only";
import { inArray, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { SAV_V2_EFFECTS_STALE_MS, SAV_V2_EFFECTS_WORKER, savV2EffectsExpected } from "./monitor-contract";

/*
 * Watchdog « catch-up absent for 15 minutes » (11/11), independent of the scheduler: the scheduled jobs stopped on 09/11 and the monitor, itself
 * scheduled, stopped with them. Traffic that does not depend on the scheduler (the Gmail push webhook) calls `watchSavReconcilePulse` after its
 * acknowledgement. It reads ONE row (the `sav-reconcile` pulse), at most once per minute per instance; when the pulse is older than 15 minutes it
 * runs the existing monitor, whose state row dedups the Slack alert (`worker_stalled` is sent once when opened, never again while it lasts, and
 * « recovered » once the pulse is back). The monitor runs at most once per 5 minutes from here (its own `observedAt`). Never throws, never awaits Slack
 * inside the webhook's acknowledgement, writes nothing of its own: no new key, no migration.
 * The V2 effects worker (`sav-v2-effects`, every 10 min) is watched the same way on its own pulse, stale after 25 minutes, when V2 runs. Its absence
 * (never ran) is reported by the monitor itself (`v2_effects_missing`), not from here.
 */

const WORKER = "sav-monitor:v1:worker", STATE = "sav-monitor:v1:state";
export const WATCHDOG_STALE_MS = 15 * 60_000, WATCHDOG_CHECK_EVERY_MS = 60_000, WATCHDOG_MONITOR_EVERY_MS = 5 * 60_000;

type Pulse = { startedAt?: string; lastFinishedAt?: string; monitoringSince?: string };
export type WatchdogOutcome =
  | { checked: false; reason: "throttled" }
  | { checked: true; stale: false }
  | { checked: true; stale: true; monitor: "ran" | "recent" | "failed" }
  | { checked: false; reason: "error" };

let lastCheckAt = 0;
/** Tests only: forget the per-instance throttle. */
export function resetSavReconcileWatchdogThrottle() { lastCheckAt = 0; }

/** The monitor's own rule (`worker_stalled`): started or finished more than 15 minutes (or `staleMs`) ago; an absent or unreadable pulse counts as stale. */
export function savReconcilePulseStale(cursor: string | null | undefined, now: number, staleMs = WATCHDOG_STALE_MS) {
  let pulse: Pulse | null = null;
  try { pulse = cursor ? JSON.parse(cursor) as Pulse : null; } catch { pulse = null; }
  const started = Date.parse(pulse?.startedAt ?? ""), finished = Date.parse(pulse?.lastFinishedAt ?? pulse?.monitoringSince ?? pulse?.startedAt ?? "");
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return true;
  return now - started > staleMs || now - finished > staleMs;
}

export async function watchSavReconcilePulse(input: { now?: () => number; runMonitor?: () => Promise<unknown> } = {}): Promise<WatchdogOutcome> {
  const now = (input.now ?? Date.now)();
  if (now - lastCheckAt < WATCHDOG_CHECK_EVERY_MS) return { checked: false, reason: "throttled" };
  lastCheckAt = now;
  try {
    const rows = await requireDb().transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout','2s',true),set_config('lock_timeout','1s',true)`);
      return tx.select({ key: savSyncState.key, cursor: savSyncState.cursor }).from(savSyncState).where(inArray(savSyncState.key, [WORKER, SAV_V2_EFFECTS_WORKER, STATE]));
    });
    const worker = rows.find(row => row.key === WORKER), v2 = rows.find(row => row.key === SAV_V2_EFFECTS_WORKER);
    const reconcileStale = savReconcilePulseStale(worker?.cursor, now);
    const v2Stale = Boolean(v2) && savV2EffectsExpected() && savReconcilePulseStale(v2?.cursor, now, SAV_V2_EFFECTS_STALE_MS);
    if (!reconcileStale && !v2Stale) return { checked: true, stale: false };
    let observedAt = NaN;
    try { observedAt = Date.parse((JSON.parse(rows.find(row => row.key === STATE)?.cursor ?? "null") as { observedAt?: string } | null)?.observedAt ?? ""); } catch { observedAt = NaN; }
    if (Number.isFinite(observedAt) && now - observedAt < WATCHDOG_MONITOR_EVERY_MS) return { checked: true, stale: true, monitor: "recent" };
    console.error("sav_reconcile_watchdog_stale", { pulse: !reconcileStale ? "fresh" : worker ? "stale" : "missing", v2Effects: v2Stale ? "stale" : "fresh" });
    try {
      await (input.runMonitor ?? (async () => (await import("./monitor")).runSavServerMonitor()))();
      return { checked: true, stale: true, monitor: "ran" };
    } catch { console.error("sav_reconcile_watchdog_monitor_failed"); return { checked: true, stale: true, monitor: "failed" }; }
  } catch {
    console.error("sav_reconcile_watchdog_failed");
    return { checked: false, reason: "error" };
  }
}
