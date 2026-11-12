import "server-only";
import { randomUUID } from "node:crypto";
import { renewActiveGmailWatches } from "@/lib/sav/gmail";
import { runSavServerMonitor } from "@/lib/sav/monitor";
import { purgeExpiredMemory } from "@/memory/service";
import { runSavReconcilePass } from "@/lib/sav/reconcile-pass";
import { runSavV2EffectsPass } from "@/lib/sav/v2-effects-pass";
import { beatSavHeartbeat, claimSelfSchedulerJob, finishSelfSchedulerJob, type SelfSchedulerDecision, type SelfSchedulerJob,
  type SelfSchedulerJobRecord, type SelfSchedulerSignals } from "@/lib/sav/self-scheduler-store";

/** Fallback for the Vercel schedules (the four of #244 and sav-v2-effects) (vercel.json, kept as the primary path). OPT-IN: nothing runs unless an
 * administrator turned the database switch ON (sav-self-scheduler:v1:switch, /api/internal/sav/self-scheduler); an absent
 * row means OFF, and the switch is re-read at every lease claim and every heartbeat tick. SAV_SELF_SCHEDULER_DISABLED=1 is
 * an extra hard stop, and nothing runs outside VERCEL_ENV=production. When ON, each job still runs only when the scheduled
 * path visibly did not (a stale pulse or snapshot, a watch near expiry), single-flight (lease in sav.sync_state, see
 * self-scheduler-store.ts), through the same function as its cron route, and never throws. */
const MINUTE = 60_000, HOUR = 60 * MINUTE;
export const SELF_SCHEDULER_TIMING = {
  /** sav-reconcile runs every 5 min: a pass started more than 12 min ago means at least two missed runs. */
  catchUpStaleMs: 12 * MINUTE,
  /** sav-v2-effects runs every 10 min: a pass started more than 12 min ago means its last run was missed. */
  v2EffectsStaleMs: 12 * MINUTE,
  /** sav-monitor runs every 5 min (2-59/5). */
  monitorStaleMs: 10 * MINUTE,
  /** The daily cron renews the 7-day watch; the fallback renews when less than 48 h remain, or when unknown. */
  watchRenewBeforeMs: 48 * HOUR,
  watchMinIntervalMs: HOUR,
  /** memory-retention is daily. */
  retentionIntervalMs: 24 * HOUR,
  /** The heartbeat beats every 5 min plus its steps; without a beat for 15 min it is considered gone. */
  heartbeatStaleMs: 15 * MINUTE,
} as const;
export type SelfSchedulerTrigger = "gmail_webhook" | "heartbeat_workflow";
type Env = Record<string, string | undefined>;
export type SelfSchedulerResult = { job: SelfSchedulerJob; status: "disabled" | "not_production" | "skipped" | "ran" | "error"; reason?: string };

export function savSelfSchedulerDisabled(env: Env = process.env) {
  return ["1", "true", "on", "yes"].includes((env.SAV_SELF_SCHEDULER_DISABLED ?? "").trim().toLowerCase());
}
/** The fallback acts on shared production data only from a production deployment, never from a preview or a local server. */
export function savSelfSchedulerProduction(env: Env = process.env) {
  return env.VERCEL_ENV === "production";
}
export function savCodeRevision(env: Env = process.env) {
  return env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || null;
}

const at = (iso: string | null | undefined) => { const value = iso ? Date.parse(iso) : NaN; return Number.isFinite(value) ? value : null; };
const latest = (...values: (string | null | undefined)[]) => values.map(at).reduce<number | null>((a, b) => b === null ? a : a === null ? b : Math.max(a, b), null);
const leased = (record: SelfSchedulerJobRecord | null, now: number) => (at(record?.leaseUntil) ?? 0) > now;
const skip = (reason: string): SelfSchedulerDecision => ({ run: false, reason });
const RUN: SelfSchedulerDecision = { run: true };

export function decideCatchUp(record: SelfSchedulerJobRecord | null, signals: SelfSchedulerSignals, now: number): SelfSchedulerDecision {
  if (leased(record, now)) return skip("leased");
  const last = latest(signals.pulse?.startedAt, record?.lastStartedAt);
  return last !== null && now - last < SELF_SCHEDULER_TIMING.catchUpStaleMs ? skip("fresh") : RUN;
}
export function decideV2Effects(record: SelfSchedulerJobRecord | null, signals: SelfSchedulerSignals, now: number): SelfSchedulerDecision {
  if (leased(record, now)) return skip("leased");
  const last = latest(signals.v2EffectsPulse?.startedAt, record?.lastStartedAt);
  return last !== null && now - last < SELF_SCHEDULER_TIMING.v2EffectsStaleMs ? skip("fresh") : RUN;
}
export function decideMonitor(record: SelfSchedulerJobRecord | null, signals: SelfSchedulerSignals, now: number): SelfSchedulerDecision {
  if (leased(record, now)) return skip("leased");
  const last = latest(signals.monitorObservedAt, record?.lastStartedAt);
  return last !== null && now - last < SELF_SCHEDULER_TIMING.monitorStaleMs ? skip("fresh") : RUN;
}
export function decideWatchRenewal(record: SelfSchedulerJobRecord | null, signals: SelfSchedulerSignals, now: number): SelfSchedulerDecision {
  if (leased(record, now)) return skip("leased");
  const attempted = at(record?.lastStartedAt);
  if (attempted !== null && now - attempted < SELF_SCHEDULER_TIMING.watchMinIntervalMs) return skip("attempted_within_hour");
  const expirations = signals.watchExpirations.map(at);
  if (expirations.length && expirations.every(value => value !== null && value - now > SELF_SCHEDULER_TIMING.watchRenewBeforeMs)) return skip("watch_valid");
  return RUN;
}
/** Retention has no pulse of its own: it runs only while the scheduler is visibly down (the current pulse is stale,
 * or is the fallback's own), at most once a day. */
export function decideRetention(record: SelfSchedulerJobRecord | null, signals: SelfSchedulerSignals, now: number): SelfSchedulerDecision {
  if (leased(record, now)) return skip("leased");
  const pulseAt = at(signals.pulse?.startedAt);
  const schedulerDown = pulseAt === null || now - pulseAt >= SELF_SCHEDULER_TIMING.catchUpStaleMs || signals.pulse?.id === signals.catchUpPulseId;
  if (!schedulerDown) return skip("scheduler_healthy");
  const last = at(record?.lastStartedAt);
  return last !== null && now - last < SELF_SCHEDULER_TIMING.retentionIntervalMs ? skip("fresh") : RUN;
}

function errorCode(error: unknown) {
  return (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160);
}

async function runJob(input: {
  job: SelfSchedulerJob; trigger: SelfSchedulerTrigger; leaseMs: number; env?: Env; pulseId?: string;
  decide: (record: SelfSchedulerJobRecord | null, signals: SelfSchedulerSignals, now: number) => SelfSchedulerDecision;
  work: () => Promise<string>;
}): Promise<SelfSchedulerResult> {
  const { job, trigger } = input;
  if (savSelfSchedulerDisabled(input.env)) return { job, status: "disabled" };
  if (!savSelfSchedulerProduction(input.env ?? process.env)) return { job, status: "not_production" };
  const owner = randomUUID();
  try {
    const claim = await claimSelfSchedulerJob({ job, owner, trigger, now: new Date(), leaseMs: input.leaseMs, pulseId: input.pulseId, decide: input.decide });
    if (!claim.run) return { job, status: "skipped", reason: claim.reason };
  } catch (error) {
    console.error("sav_self_scheduler_job", { job, trigger, status: "claim_failed", errorCode: errorCode(error) });
    return { job, status: "error", reason: "claim_failed" };
  }
  const startedAt = Date.now();
  console.info("sav_self_scheduler_job", { job, trigger, status: "started" });
  let status: string, result: SelfSchedulerResult;
  try {
    status = await input.work();
    result = { job, status: "ran", reason: status };
    console.info("sav_self_scheduler_job", { job, trigger, status, durationMs: Date.now() - startedAt });
  } catch (error) {
    status = "error";
    result = { job, status: "error", reason: errorCode(error) };
    console.error("sav_self_scheduler_job", { job, trigger, status, durationMs: Date.now() - startedAt, errorCode: errorCode(error) });
  }
  await finishSelfSchedulerJob({ job, owner, status, now: new Date() })
    .catch(error => console.error("sav_self_scheduler_job", { job, trigger, status: "release_failed", errorCode: errorCode(error) }));
  return result;
}

/** One sav-reconcile pass when the last one started more than 12 min ago. The heartbeat's pass has the cron's 270 s;
 * the webhook's pass ends by the webhook's own deadline (computed from the request start, 50 s before its 300 s), and is
 * not started with less than a minute left. */
export const WEBHOOK_PASS_DEADLINE_MS = 250_000;
export function maybeRunCatchUp(trigger: SelfSchedulerTrigger, options: { env?: Env; requestStartedAt?: number } = {}) {
  const budgetMs = trigger === "gmail_webhook" ? (options.requestStartedAt ?? Date.now()) + WEBHOOK_PASS_DEADLINE_MS - Date.now() : 270_000, pulseId = randomUUID();
  if (budgetMs < 60_000) return Promise.resolve<SelfSchedulerResult>({ job: "sav-reconcile", status: "skipped", reason: "insufficient_budget" });
  return runJob({ job: "sav-reconcile", trigger, env: options.env, pulseId, leaseMs: budgetMs + 60_000, decide: decideCatchUp,
    work: async () => (await runSavReconcilePass({ trigger, pulseId, budgetMs })).hasStepFailure ? "step_failure" : "ok" });
}
/** One sav-v2-effects pass (the cron route's runSavV2EffectsPass, same pulse) when the last one started more than 12 min ago.
 * Same budgets as the catch-up: 270 s from the heartbeat, the webhook's own deadline from the webhook, none under a minute. */
export function maybeRunV2Effects(trigger: SelfSchedulerTrigger, options: { env?: Env; requestStartedAt?: number } = {}) {
  const budgetMs = trigger === "gmail_webhook" ? (options.requestStartedAt ?? Date.now()) + WEBHOOK_PASS_DEADLINE_MS - Date.now() : 270_000, pulseId = randomUUID();
  if (budgetMs < 60_000) return Promise.resolve<SelfSchedulerResult>({ job: "sav-v2-effects", status: "skipped", reason: "insufficient_budget" });
  return runJob({ job: "sav-v2-effects", trigger, env: options.env, pulseId, leaseMs: budgetMs + 60_000, decide: decideV2Effects,
    work: async () => (await runSavV2EffectsPass({ trigger, pulseId, budgetMs })).hasStepFailure ? "step_failure" : "ok" });
}
export function maybeRenewGmailWatch(trigger: SelfSchedulerTrigger, options: { env?: Env } = {}) {
  return runJob({ job: "gmail-watch", trigger, env: options.env, leaseMs: 120_000, decide: decideWatchRenewal,
    work: async () => `renewed_${(await renewActiveGmailWatches()).length}` });
}
export function maybeRunMonitor(trigger: SelfSchedulerTrigger, options: { env?: Env } = {}) {
  return runJob({ job: "sav-monitor", trigger, env: options.env, leaseMs: 120_000, decide: decideMonitor,
    work: async () => { const result = await runSavServerMonitor(); return "skipped" in result ? "already_running" : result.complete ? "complete" : "partial"; } });
}
export function maybeRunMemoryRetention(trigger: SelfSchedulerTrigger, options: { env?: Env } = {}) {
  return runJob({ job: "memory-retention", trigger, env: options.env, leaseMs: 300_000, decide: decideRetention,
    work: async () => { await purgeExpiredMemory(); return "ok"; } });
}

/** Gmail webhook, after its 204: never throws, never changes the acknowledgement or the receipt's processing.
 * Production only; each job below still needs the database switch ON at its claim. */
export async function runSavSelfSchedulerFromWebhook(options: { env?: Env; requestStartedAt?: number; ensureHeartbeat?: () => Promise<unknown> } = {}) {
  if (savSelfSchedulerDisabled(options.env)) return { status: "disabled" as const };
  if (!savSelfSchedulerProduction(options.env ?? process.env)) return { status: "not_production" as const };
  try {
    if (options.ensureHeartbeat) await options.ensureHeartbeat().catch(error => console.error("sav_self_scheduler_heartbeat", { status: "ensure_failed", errorCode: errorCode(error) }));
    const watch = await maybeRenewGmailWatch("gmail_webhook", options);
    const [catchUp, v2Effects, monitor, retention] = await Promise.all([maybeRunCatchUp("gmail_webhook", options), maybeRunV2Effects("gmail_webhook", options),
      maybeRunMonitor("gmail_webhook", options), maybeRunMemoryRetention("gmail_webhook", options)]);
    return { status: "checked" as const, results: [watch, catchUp, v2Effects, monitor, retention] };
  } catch (error) {
    console.error("sav_self_scheduler_webhook", { status: "failed", errorCode: errorCode(error) });
    return { status: "error" as const };
  }
}

/** One heartbeat tick (workflow step): a beat, which re-reads the switch, then the light checks. The catch-up pass is its
 * own step. Disabled, outside production, superseded or switched OFF: the run stops at this tick, without continuation. */
export async function runSavHeartbeatTick(owner: string, options: { env?: Env } = {}) {
  if (savSelfSchedulerDisabled(options.env)) return { alive: false as const, reason: "disabled" };
  if (!savSelfSchedulerProduction(options.env ?? process.env)) return { alive: false as const, reason: "not_production" };
  try {
    const beat = await beatSavHeartbeat({ owner, revision: savCodeRevision(options.env), now: new Date(), staleMs: SELF_SCHEDULER_TIMING.heartbeatStaleMs });
    if (!beat.alive) { console.info("sav_self_scheduler_heartbeat", { status: "stopped", reason: beat.reason }); return beat; }
  } catch (error) {
    // Without a readable beat the tick still runs: every job below keeps its own lease.
    console.error("sav_self_scheduler_heartbeat", { status: "beat_failed", errorCode: errorCode(error) });
  }
  const results = [await maybeRenewGmailWatch("heartbeat_workflow", options), await maybeRunMonitor("heartbeat_workflow", options), await maybeRunMemoryRetention("heartbeat_workflow", options)];
  return { alive: true as const, results: results.map(result => ({ job: result.job, status: result.status, reason: result.reason ?? null })) };
}
