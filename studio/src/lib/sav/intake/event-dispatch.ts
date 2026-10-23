import "server-only";
import { start } from "workflow/api";
import { and, asc, eq, inArray, notExists, or, lte, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savIntakeExecutions, savIntakeRuns } from "@/db/schema";
import { savIntakeRuntimeConfig } from "./runtime-contract";
import { intakeExecutionConfig } from "./execution-policy";
import { pendingSavIntakeRuns } from "./runtime-store";
import { listSavExternalCompletionMessageIds } from "../external-completion";
import { processSavIntakeWakeWorkflow } from "@/workflows/sav-intake";

/** A wake is only a hint. Claims, leases, ledgers and occupations stay the
 * authority, so a duplicate or lost wake can never double a provider effect.
 * Its dispatch bound is separate from the run's model attempts: a wake never
 * resets them and never starts a second analysis (cron keeps the retries). */
export const SAV_INTAKE_WAKE_REVISION = "sav-intake-wake.v2";
export const SAV_INTAKE_WAKE_MAX_DISPATCHES = 3;
const REDISPATCH_AFTER_MS = 120_000;
const TERMINAL = ["completed", "abandoned"];
type WakeState = "dispatching" | "running" | "waiting" | "completed" | "abandoned";
type Env = Record<string, string | undefined>;
type Start = (runId: string) => Promise<unknown>;
type Reader = Pick<ReturnType<typeof requireDb>, "select">;
const defaultStart: Start = runId => start(processSavIntakeWakeWorkflow, [runId]);

/** Explicit opt-in. Absent or any other value keeps the cron-only behaviour. */
export function savIntakeEventDispatchEnabled(env: Env = process.env) { return env.SAV_INTAKE_EVENT_DISPATCH === "on"; }

export type SavIntakeWakeStage = "analysis" | "admission" | "execution";
/** Durable stage of one run, read from the run/execution tables only.
 * - no execution, first analysis not attempted yet: analysis;
 * - observed, no execution: admission then execution, never the model;
 * - execution not terminal: resume that execution, never a new admission;
 * - confirmed/refused execution, superseded, uncertain or retried analysis: none. */
export async function savIntakeWakeStage(runId: string, db: Reader = requireDb()): Promise<SavIntakeWakeStage | null> {
  const [run] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
  if (!run?.isCurrent) return null;
  const [execution] = await db.select({ state: savIntakeExecutions.state }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, run.messageId));
  if (execution) return ["confirmed", "refused"].includes(execution.state) ? null : "execution";
  if (run.state === "observed") return "admission";
  // A run already claimed once belongs to the cron's bounded retry, not to a wake.
  return ["pending", "waiting"].includes(run.state) && run.attempts === 0 ? "analysis" : null;
}

const wakeRow = (runId: string) => and(eq(auditLogs.entityType, "sav_intake_wake"), eq(auditLogs.entityId, runId), eq(auditLogs.action, "sav_intake_wake_requested"));
export async function readSavIntakeWake(runId: string) {
  const [row] = await requireDb().select().from(auditLogs).where(wakeRow(runId));
  return row ?? null;
}

/** Call only after the run's transaction committed. Never throws: a failed
 * dispatch leaves a durable run that cron recovery re-dispatches or analyses. */
export async function requestSavIntakeWake(runId: string, options: { env?: Env; start?: Start; now?: Date } = {}) {
  const env = options.env ?? process.env;
  if (!savIntakeEventDispatchEnabled(env)) return { dispatched: false as const, reason: "event_dispatch_off" };
  let claim: { dispatched: false; reason: string } | { dispatched: true; attempt: number; stage: SavIntakeWakeStage };
  try {
    claim = await requireDb().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sav-intake-wake:${runId}`}))`);
      const stage = await savIntakeWakeStage(runId, tx);
      if (!stage) return { dispatched: false as const, reason: "no_durable_work" };
      const [run] = await tx.select({ messageId: savIntakeRuns.messageId, threadId: savIntakeRuns.threadId }).from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
      const now = options.now ?? new Date();
      const [marker] = await tx.select().from(auditLogs).where(wakeRow(runId)).for("update");
      const meta = marker?.technicalMetadata ?? {};
      // A completed hint may have skipped a transient configuration or lost its
      // next step. Durable work wins; the original total dispatch cap still holds.
      if ((Number(meta.dispatches) || 0) >= SAV_INTAKE_WAKE_MAX_DISPATCHES) {
        if (marker && meta.state !== "abandoned") await tx.update(auditLogs).set({ technicalMetadata: { ...meta, state: "abandoned" } }).where(eq(auditLogs.id, marker.id));
        return { dispatched: false as const, reason: "dispatches_exhausted" };
      }
      const last = typeof meta.lastDispatchedAt === "string" ? Date.parse(meta.lastDispatchedAt) : 0;
      if (now.getTime() - last < REDISPATCH_AFTER_MS) return { dispatched: false as const, reason: "recently_dispatched" };
      const attempt = (Number(meta.dispatches) || 0) + 1;
      const technicalMetadata = { ...meta, revision: SAV_INTAKE_WAKE_REVISION, runId, messageId: run.messageId, threadId: run.threadId, stage,
        state: "dispatching", dispatches: attempt, lastDispatchedAt: now.toISOString(), firstDispatchedAt: typeof meta.firstDispatchedAt === "string" ? meta.firstDispatchedAt : now.toISOString() };
      if (marker) await tx.update(auditLogs).set({ technicalMetadata }).where(eq(auditLogs.id, marker.id));
      else await tx.insert(auditLogs).values({ actorEmail: "system", action: "sav_intake_wake_requested", entityType: "sav_intake_wake", entityId: runId, technicalMetadata });
      return { dispatched: true as const, attempt, stage };
    });
  } catch {
    console.error("sav_intake_wake_deferred", { runId, stage: "marker" });
    return { dispatched: false as const, reason: "marker_unavailable" };
  }
  if (!claim.dispatched) return claim;
  try { await (options.start ?? defaultStart)(runId); }
  catch {
    // The marker is committed: cron redispatches it after the window, bounded.
    console.error("sav_intake_wake_deferred", { runId, stage: "start", attempt: claim.attempt });
    return { dispatched: false as const, reason: "start_failed" };
  }
  console.info("sav_intake_wake_dispatched", { runId, attempt: claim.attempt, stage: claim.stage });
  return claim;
}

/** Workflow progress on the marker; the run/execution tables stay the truth. */
export async function markSavIntakeWake(runId: string, state: WakeState, fields: Record<string, string | number | null> = {}) {
  await requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sav-intake-wake:${runId}`}))`);
    const [marker] = await tx.select().from(auditLogs).where(wakeRow(runId)).for("update");
    if (!marker || TERMINAL.includes(String(marker.technicalMetadata.state))) return;
    await tx.update(auditLogs).set({ technicalMetadata: { ...marker.technicalMetadata, ...fields, state } }).where(eq(auditLogs.id, marker.id));
  });
}

/** Cron recovery for work interrupted after commit, after analysis or after
 * admission. Same targeted path and bound; the cron's own inline analysis and
 * executor still run independently as the last fallback. */
export async function dispatchPendingSavIntakeWakes(options: { env?: Env; start?: Start; limit?: number; now?: Date } = {}) {
  const env = options.env ?? process.env;
  if (!savIntakeEventDispatchEnabled(env)) return { skipped: "event_dispatch_off" as const };
  let config: ReturnType<typeof savIntakeRuntimeConfig>;
  try { config = savIntakeRuntimeConfig(env); } catch { return { skipped: "configuration_invalid" as const }; }
  if (!config) return { skipped: "off" as const };
  const limit = Math.max(1, Math.min(8, options.limit ?? 4)), db = requireDb();
  let execution: ReturnType<typeof intakeExecutionConfig> = null;
  try { execution = intakeExecutionConfig(env); } catch { execution = null; }
  const now = options.now ?? new Date();
  const handled = await listSavExternalCompletionMessageIds(db, false, config.mailboxId);
  const notHandled = handled.length ? sql`${savIntakeRuns.messageId} not in (${sql.join(handled.map(id => sql`${id}::uuid`), sql`, `)})` : undefined;
  // Filter before LIMIT: blocked older dossiers must not consume every page.
  // The marker is only scheduling metadata. A terminal state alone cannot
  // hide work left in the durable run/execution tables.
  const ready = and(eq(savIntakeRuns.isCurrent, true), eq(savIntakeRuns.configHash, config.configHash), notHandled,
    or(sql`${savIntakeRuns.leaseUntil} is null`, lte(savIntakeRuns.leaseUntil, now)),
    sql`exists(select 1 from sav.threads t where t.id=${savIntakeRuns.threadId} and not t.ai_paused)`,
    sql`exists(select 1 from sav.messages m where m.id=${savIntakeRuns.messageId} and m.thread_id=${savIntakeRuns.threadId}
      and m.mailbox_id=${config.mailboxId}::uuid and m.direction='inbound' and m.created_at>${config.createdAfter}::timestamptz and m.received_at>${config.receivedAfter}::timestamptz
      and not exists(select 1 from sav.messages newer where newer.thread_id=m.thread_id and newer.direction='inbound' and (newer.received_at,newer.created_at,newer.id)>(m.received_at,m.created_at,m.id)))`,
    sql`not exists(select 1 from public.audit_logs w where w.entity_type='sav_intake_wake' and w.entity_id=${savIntakeRuns.id}::text and w.action='sav_intake_wake_requested'
      and (case when jsonb_typeof(w.technical_metadata->'dispatches')='number' then (w.technical_metadata->>'dispatches')::numeric>=${SAV_INTAKE_WAKE_MAX_DISPATCHES} else false end
        or w.technical_metadata->>'lastDispatchedAt'>${new Date(now.getTime() - REDISPATCH_AFTER_MS).toISOString()}))`);
  const ids = new Set((await pendingSavIntakeRuns(config, now, and(ready,
    eq(savIntakeRuns.attempts, 0), inArray(savIntakeRuns.state, ["pending", "waiting"])))).map(run => run.id));
  if (execution) {
    const observed = await db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(and(ready,
      eq(savIntakeRuns.state, "observed"), notExists(db.select({ id: savIntakeExecutions.id }).from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, savIntakeRuns.messageId)))))
      .orderBy(asc(savIntakeRuns.updatedAt), asc(savIntakeRuns.id)).limit(limit);
    const admitted = await db.select({ id: savIntakeRuns.id }).from(savIntakeExecutions)
      .innerJoin(savIntakeRuns, and(eq(savIntakeRuns.id, savIntakeExecutions.runId), eq(savIntakeRuns.messageId, savIntakeExecutions.messageId), eq(savIntakeRuns.version, savIntakeExecutions.runVersion)))
      .where(and(ready, eq(savIntakeExecutions.policyId, execution.policyId), inArray(savIntakeExecutions.state, ["pending", "waiting", "running", "uncertain"]),
        or(sql`${savIntakeExecutions.leaseUntil} is null`, lte(savIntakeExecutions.leaseUntil, now))))
      .orderBy(asc(savIntakeExecutions.updatedAt), asc(savIntakeExecutions.id)).limit(limit);
    for (const row of [...observed, ...admitted]) ids.add(row.id);
  }
  let dispatched = 0;
  for (const id of [...ids].slice(0, limit * 3)) if ((await requestSavIntakeWake(id, options)).dispatched) dispatched++;
  return { dispatched };
}
