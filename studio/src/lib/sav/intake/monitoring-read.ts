import "server-only";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { requireIntakeConsoleStaff } from "./console-auth";
import { readSavAgentPause } from "./agent-pause";
import { intakeBudgetOwner } from "./budget-admin";
import { savIntakeRuntimeConfig } from "./runtime-contract";
import { SAV_INTAKE_BUDGET_OWNER_EMAIL } from "./budget-amount";

const WORKER = "sav-monitor:v1:worker", SNAPSHOT = "sav-monitor:v1:snapshot";
const timestamp = z.iso.datetime();
const pulseSchema = z.object({ startedAt: timestamp, lastFinishedAt: timestamp.optional(), lastSucceededAt: timestamp.optional(), failed: z.boolean().optional() });
const snapshotSchema = z.object({ observedAt: timestamp, complete: z.boolean() });
export type MonitoringActivity = { state: "missing" | "unavailable" | "stale" | "failed" | "observed"; startedAt: string | null; finishedAt: string | null; succeededAt: string | null; collection: "missing" | "partial" | "stale" | "complete" | "unavailable"; observedAt: string | null };
const emptyActivity = (): MonitoringActivity => ({ state: "missing", startedAt: null, finishedAt: null, succeededAt: null, collection: "missing", observedAt: null });
/** Persisted metadata only. No issue counts, delivery data, identifiers or arbitrary JSON leave this boundary. */
export function projectMonitoringActivity(rows: Array<{ key: string; cursor: string | null; status: string }>, now: Date): MonitoringActivity {
  const result = emptyActivity(), current = now.getTime();
  const fresh = (at: string) => current - Date.parse(at) <= 15 * 60_000;
  const worker = rows.find(row => row.key === WORKER), snapshot = rows.find(row => row.key === SNAPSHOT);
  if (worker) try {
    if (!worker.cursor || worker.cursor.length > 8192) throw Error();
    const pulse = pulseSchema.parse(JSON.parse(worker.cursor));
    if ([pulse.startedAt, pulse.lastFinishedAt, pulse.lastSucceededAt].some(at => at && Date.parse(at) > current)) throw Error();
    result.startedAt = pulse.startedAt; result.finishedAt = pulse.lastFinishedAt ?? null; result.succeededAt = pulse.lastSucceededAt ?? null;
    result.state = !fresh(pulse.startedAt) || !pulse.lastFinishedAt || !fresh(pulse.lastFinishedAt) ? "stale" : worker.status === "failed" || pulse.failed ? "failed" : "observed";
  } catch { result.state = "unavailable"; }
  if (snapshot) try {
    if (!snapshot.cursor || snapshot.cursor.length > 8192) throw Error();
    const data = snapshotSchema.parse(JSON.parse(snapshot.cursor));
    if (Date.parse(data.observedAt) > current) throw Error();
    result.observedAt = data.observedAt;
    result.collection = !fresh(data.observedAt) ? "stale" : data.complete && snapshot.status === "complete" ? "complete" : "partial";
  } catch { result.collection = "unavailable"; }
  return result;
}
export type IntakeMonitoring = { readAt: string; permission: "running" | "actions_paused" | "fully_paused" | "unknown"; configuration: "verified" | "unavailable" | "restricted"; activity: MonitoringActivity };
export async function readIntakeMonitoring(): Promise<IntakeMonitoring> {
  const staff = await requireIntakeConsoleStaff(); // Auth errors must not become an anonymous status panel.
  const now = new Date();
  const result: IntakeMonitoring = { readAt: now.toISOString(), permission: "unknown", configuration: "restricted", activity: emptyActivity() };
  try {
    result.activity = await requireDb().transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout','3s',true),set_config('lock_timeout','1s',true)`);
      const pause = await readSavAgentPause(tx);
      result.permission = pause.invalid ? "unknown" : pause.level;
      const rows = await tx.select({ key: savSyncState.key, status: savSyncState.status,
        cursor: sql<string | null>`case when octet_length(${savSyncState.cursor}) <= 8192 then ${savSyncState.cursor} else null end` })
        .from(savSyncState).where(inArray(savSyncState.key, [WORKER, SNAPSHOT])).limit(2);
      return projectMonitoringActivity(rows, now);
    }, { accessMode: "read only", isolationLevel: "repeatable read" });
  } catch { result.activity = { ...emptyActivity(), state: "unavailable", collection: "unavailable" }; }
  if (staff.email === SAV_INTAKE_BUDGET_OWNER_EMAIL) {
    result.configuration = "unavailable";
    try {
      // Keep canonical owner authorization. Do not scan the budget ledger merely
      // to render a health strip. This verifies pinned analysis configuration only.
      await intakeBudgetOwner();
      if (savIntakeRuntimeConfig()) result.configuration = "verified";
    } catch { /* No raw error or configuration goes to the console. */ }
  }
  return result;
}

/** Console PR-1: the worker pulse alone (no auth, no pause, no budget), for callers that already authenticated staff. Null when missing or unreadable. */
export async function readSchedulerPulse(now = new Date()): Promise<{ startedAt: string | null; finishedAt: string | null } | null> {
  try {
    const rows = await requireDb().select({ key: savSyncState.key, status: savSyncState.status,
      cursor: sql<string | null>`case when octet_length(${savSyncState.cursor}) <= 8192 then ${savSyncState.cursor} else null end` })
      .from(savSyncState).where(inArray(savSyncState.key, [WORKER])).limit(1);
    const activity = projectMonitoringActivity(rows, now);
    return activity.state === "missing" || activity.state === "unavailable" ? null : { startedAt: activity.startedAt, finishedAt: activity.finishedAt };
  } catch { return null; }
}
