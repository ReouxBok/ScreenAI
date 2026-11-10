import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { executionAdministrator } from "./intake/execution-policy";
import { monitorCodes } from "./monitor-contract";
import { buildDailyReview, type DailyReviewInput, type DailyReview } from "./daily-review";

const DAY = 86400000, STALE = 15 * 60000;
const instant = z.iso.datetime();
const rowSchema = z.object({ id: z.uuid(), requestedAt: instant, paused: z.boolean(), uncertain: z.boolean(), effectAt: instant.nullable() }).strict();
const monitorSchema = z.object({ observedAt: instant, complete: z.boolean(), issues: z.array(z.object({
  code: z.enum(monitorCodes), count: z.number().int().min(0).max(2147483647), severity: z.enum(["warning", "critical"]),
}).strict()).max(monitorCodes.length) });
type Window = { from: string; to: string };
type Engine = "v1" | "v2";
export type DailyReviewReadPorts = {
  authorize(): Promise<unknown>;
  now(): Date;
  dossiers(engine: Engine, window: Window, limit: number): Promise<unknown[]>;
  monitor(): Promise<unknown>;
};
export type DailyReviewSnapshot = {
  revision: "sav-daily-review-read.v1"; observedAt: string; window: Window;
  coverage: { state: "partial" | "unknown"; limitPerEngine: number; truncated: boolean; humanHolds: number; uncertainEffects: number;
    monitorObservedAt: string | null; monitorAgeSeconds: number | null;
    sources: { v1: "available" | "unavailable"; v2: "available" | "unavailable"; monitor: "fresh" | "stale" | "missing" | "unavailable" } };
  missing: string[]; report: DailyReview;
};

async function selectRows(statement: SQL): Promise<Record<string, unknown>[]> {
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout','3s',true), set_config('lock_timeout','1s',true)`);
    const result = await tx.execute(statement);
    return (Array.isArray(result) ? result : (result as unknown as { rows: Record<string, unknown>[] }).rows) as Record<string, unknown>[];
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return value;
}

/** Reads stored monitor output, never collectSavMonitorSnapshot/runSavServerMonitor (which owns writes/delivery). */
export const dailyReviewDatabasePorts: DailyReviewReadPorts = {
  authorize: async () => { try { return await executionAdministrator(); } catch { throw Error("DAILY_REVIEW_UNAUTHORIZED"); } }, now: () => new Date(),
  async dossiers(engine, window, limit) {
    // Current dossiers created inside this window, not an exhaustive backlog nor request/worker history.
    // No ciphertext, customer identity, provider text, or inferred worker timestamps is selected.
    const rows = engine === "v1" ? await selectRows(sql`select r.thread_id as id, r.created_at as "requestedAt", t.ai_paused as paused,
      exists(select 1 from sav.intake_executions x join sav.intake_effects e on e.execution_id=x.id
        where x.run_id=r.id and e.state in ('uncertain','dispatched','acked')) as uncertain,
      (select max(e.confirmed_at) from sav.intake_executions x join sav.intake_effects e on e.execution_id=x.id
        where x.run_id=r.id and e.state='confirmed' and e.kind in ('reply_send','identity_send','forward_send')) as "effectAt"
      from sav.intake_runs r join sav.threads t on t.id=r.thread_id
      where r.is_current and r.created_at >= ${window.from}::timestamptz and r.created_at <= ${window.to}::timestamptz
      order by r.created_at desc, r.thread_id limit ${limit}`)
      : await selectRows(sql`select c.id, c.created_at as "requestedAt",
      (c.owner='human' or exists(select 1 from sav.threads t where t.id=any(c.thread_ids) and t.ai_paused)) as paused,
      exists(select 1 from sav.case_effect_executions x join sav.intake_effects e on e.execution_id=x.id
        where x.case_id=c.id and e.state in ('uncertain','dispatched','acked')) as uncertain,
      (select max(e.confirmed_at) from sav.case_effect_executions x join sav.intake_effects e on e.execution_id=x.id
        where x.case_id=c.id and e.state='confirmed' and e.kind in ('reply_send','identity_send','forward_send')) as "effectAt"
      from sav.cases c where c.created_at >= ${window.from}::timestamptz and c.created_at <= ${window.to}::timestamptz
      order by c.created_at desc, c.id limit ${limit}`);
    return rows.map(row => ({ ...row, requestedAt: iso(row.requestedAt), effectAt: iso(row.effectAt) }));
  },
  async monitor() {
    const rows = await selectRows(sql`select cursor from sav.sync_state where key='sav-monitor:v1:snapshot' limit 1`);
    return rows[0]?.cursor ? JSON.parse(String(rows[0].cursor)) : null;
  },
};

/** Staff read model. Authentication precedes validation/DB access. Missing telemetry remains explicit. */
export async function readDailyReviewSnapshot(raw: unknown = {}, ports: DailyReviewReadPorts = dailyReviewDatabasePorts): Promise<DailyReviewSnapshot> {
  await ports.authorize();
  const now = ports.now(), observedAt = now.toISOString();
  const options = z.object({ from: instant.optional(), to: instant.optional(), limit: z.number().int().min(1).max(500).optional() }).strict().parse(raw);
  const window = { from: options.from ?? new Date(now.getTime() - DAY).toISOString(), to: options.to ?? observedAt };
  const from = Date.parse(window.from), to = Date.parse(window.to);
  if (from > to || to > now.getTime() || to - from > 7 * DAY) throw Error("DAILY_REVIEW_WINDOW_INVALID");
  const limit = options.limit ?? 100, missing = new Set<string>(["worker_start_telemetry", "worker_finish_telemetry", "effect_expectation_telemetry", "current_dossiers_created_in_window_only", "sources_read_in_separate_transactions"]);
  const coverage: DailyReviewSnapshot["coverage"] = { state: "partial", limitPerEngine: limit, truncated: false, humanHolds: 0, uncertainEffects: 0,
    monitorObservedAt: null, monitorAgeSeconds: null, sources: { v1: "unavailable", v2: "unavailable", monitor: "missing" } };
  const dossiers: DailyReviewInput["dossiers"] = [];
  for (const engine of ["v1", "v2"] as const) {
    try {
      const rows = await ports.dossiers(engine, window, limit + 1);
      if (!Array.isArray(rows) || rows.length > limit + 1) throw Error("BOUNDED_SOURCE_REQUIRED");
      coverage.sources[engine] = "available";
      if (rows.length > limit) { coverage.truncated = true; missing.add(`${engine}_truncated`); }
      const seen = new Set<string>();
      for (const raw of rows.slice(0, limit)) {
        const parsed = rowSchema.safeParse(raw);
        if (!parsed.success || Date.parse(parsed.data.requestedAt) < from || Date.parse(parsed.data.requestedAt) > to) { missing.add(`${engine}_invalid_row`); continue; }
        const row = parsed.data;
        if (seen.has(row.id)) { missing.add(`${engine}_duplicate_row`); continue; }
        seen.add(row.id);
        if (row.effectAt && (Date.parse(row.effectAt) < Date.parse(row.requestedAt) || Date.parse(row.effectAt) > now.getTime())) {
          missing.add(`${engine}_invalid_row`); continue;
        }
        if (row.paused) coverage.humanHolds++;
        if (row.uncertain) coverage.uncertainEffects++;
        dossiers.push({ id: row.id, engine, stage: { requestedAt: row.requestedAt, workerStartedAt: null, workerFinishedAt: null,
          effectAt: row.effectAt, workerTelemetryComplete: false, effectExpected: null,
          outcome: row.uncertain ? "uncertain" : row.paused ? "paused_by_human" : "pending", errorCode: null } });
      }
    } catch { missing.add(`${engine}_source_unavailable`); }
  }
  let monitor: DailyReviewInput["monitor"] = null;
  try {
    const rawMonitor = await ports.monitor();
    if (rawMonitor === null) missing.add("monitor_snapshot_missing");
    else {
      const value = monitorSchema.parse(rawMonitor), age = now.getTime() - Date.parse(value.observedAt);
      coverage.monitorObservedAt = value.observedAt;
      coverage.monitorAgeSeconds = age >= 0 ? Math.floor(age / 1000) : null;
      if (age < 0 || age > STALE) { coverage.sources.monitor = "stale"; missing.add("monitor_snapshot_stale"); }
      else coverage.sources.monitor = "fresh";
      monitor = { ...value, complete: value.complete && age >= 0 && age <= STALE };
      if (!value.complete) missing.add("monitor_collection_partial");
    }
  } catch { coverage.sources.monitor = "unavailable"; missing.add("monitor_snapshot_unavailable"); }
  if (coverage.sources.v1 === "unavailable" && coverage.sources.v2 === "unavailable") coverage.state = "unknown";
  return { revision: "sav-daily-review-read.v1", observedAt, window, coverage, missing: [...missing].sort(), report: buildDailyReview({ window, monitor, dossiers }) };
}

/** UI adapter is deliberately separate from counts and missing technical evidence. */
export function dailyReviewConsoleSummary(snapshot: DailyReviewSnapshot) {
  return { state: snapshot.coverage.state === "unknown" ? "unavailable" as const : "available" as const,
    observedAt: snapshot.observedAt, coverage: snapshot.coverage.state,
    causes: snapshot.report.groups.map(group => ({ label: `${group.cause} (${group.count})`, nextAction: group.nextAction })) };
}
