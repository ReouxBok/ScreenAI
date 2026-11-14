import { sql, type SQL } from "drizzle-orm";
import { decryptSavPayload } from "../crypto";

/** Analysis attempts are bounded per configuration version AND per message for
 * its whole life. A deployment may re-analyse an open dossier once more, but it
 * can never revive a dossier that kept failing, nor loop forever. */
export const SAV_INTAKE_ATTEMPT_POLICY = Object.freeze({
  perVersion: 2,
  // Attempts that ended without any recorded analysis (plan), all versions together.
  failedPerMessage: 4,
  // Every attempt, successful or not, all versions together: survives deployments.
  totalPerMessage: 8,
});
/** Durable markers that remove a run from scheduling; the dossier stays visible as blocked. */
export const SAV_INTAKE_BLOCKING_JOURNAL_KINDS = ["source_invalid", "attempts_exhausted", "deterministic_block", "private_resource_unavailable", "forwarded_origin_unverified", "other_evidence_unavailable", "rescue_failed"] as const;
/** SAV-88 rescue: ONE extra, recorded analysis attempt per message, through the normal V1 claim, never a reset.
 * `granted` (journal of the current run) opens it, `claimed` consumes it with the claim, `failed` ends it for good:
 * the dossier is then "à traiter à la main". Only an `attempts_exhausted` caused by the lifetime caps is lifted,
 * and only on the run where the rescue was claimed; every other blocking marker keeps blocking. */
export const SAV_INTAKE_RESCUE_KINDS = { granted: "rescue_granted", claimed: "rescue_claimed", returned: "rescue_returned", failed: "rescue_failed" } as const;
/** A blocking marker of `runId` that still blocks: an attempts_exhausted followed by a rescue claim on the same run does not. */
export function intakeActiveBlockSql(runId: SQL, kinds: readonly string[] = SAV_INTAKE_BLOCKING_JOURNAL_KINDS) {
  return sql`exists(select 1 from sav.intake_journal bj where bj.run_id = ${runId} and bj.kind in (${sql.join(kinds.map(k => sql`${k}`), sql`, `)})
    and not (bj.kind = 'attempts_exhausted' and exists(select 1 from sav.intake_journal rj where rj.run_id = bj.run_id and rj.kind = 'rescue_claimed' and rj.created_at >= bj.created_at)))`;
}
const rescueCount = (messageId: SQL, kind: string, runId?: SQL) => sql`(select count(*) from sav.intake_journal c join sav.intake_runs cr on cr.id = c.run_id
  where cr.message_id = ${messageId} and c.kind = ${kind}${runId ? sql` and c.run_id = ${runId}` : sql``})`;
/** The rescue was used: claimed and not given back by an agent pause, or failed. Message-wide, or on one run with `runId`. */
export function intakeRescueConsumedSql(messageId: SQL, runId?: SQL) {
  return sql`(${rescueCount(messageId, "rescue_claimed", runId)} > ${rescueCount(messageId, "rescue_returned", runId)} or ${rescueCount(messageId, "rescue_failed", runId)} > 0)`;
}
/** A rescue granted on `runId` and not used for its message (one per message, whatever the version; a pause gives it back). */
export function intakeRescueOpenSql(runId: SQL, messageId: SQL) {
  return sql`(exists(select 1 from sav.intake_journal g where g.run_id = ${runId} and g.kind = 'rescue_granted') and not ${intakeRescueConsumedSql(messageId)})`;
}
/** A technical wait older than this is an incident handed to the team, never a silent state. */
export const SAV_INTAKE_BLOCKED_AFTER_MINUTES = 15;
/** Local, reproducible input errors: retrying the same input cannot succeed and must not burn attempts. */
export const SAV_INTAKE_DETERMINISTIC_ERRORS = new Set(["SAV_INTAKE_INPUT_INVALID", "SAV_INTAKE_LIMITS_INVALID"]);

/** `payloadCiphertext: null` means the payload is unavailable to this reader:
 * its analysis status is unknown, never inferred as a failure. */
/** Provider-side transient failures: the same input can succeed later. Each retry is a
 * distinct, separately reserved dispatch at a durable due time; bounded per run. */
export const SAV_INTAKE_TRANSIENT_RETRY = Object.freeze({ delaysMinutes: [2, 10, 30] as readonly number[] });
export function intakeTransientFailure(reason: string | undefined) {
  return typeof reason === "string" && (/^SAV_AI_HTTP_(?:429|5\d\d)$/.test(reason) || ["SAV_AI_TIMEOUT", "SAV_INTAKE_RUNTIME_PROVIDER_UNAVAILABLE"].includes(reason));
}
/** Model dispatches (new ledger rows; cache hits are free) allowed per run version and per
 * message for its whole life. Shared by preflight, reservation and the retry scheduler.
 * Approved by Ugo on 26/10 (Codex recommendation): room for the nominal calls, one format
 * repair and three transient retries; daily and rolling money caps are unchanged. */
export const SAV_INTAKE_CALL_POLICY = Object.freeze({ perVersion: 6, perMessage: 9 });
/** SAV-92 fix 1: wall-clock bounds of one automatic analysis, from the claim. The model gets the whole
 * shared AI allowance (SAV_AI_BUDGET.durationMs, 60 s), like the comparison campaign; CRM reads keep their
 * own 10 s per-read timeout. Every outer deadline is derived so that it can never cut that allowance:
 * - analysisMs: the run's abort signal (model 60 s + CRM reads, attachment preparation and DB checks);
 * - settlementMs: the drain of model settlements after the planner returned (unchanged, 15 s);
 * - leaseMs: the claim lease, which every live() check asserts: analysis + drain + final save;
 * - startMarginMs: the time a caller with a deadline must still have before it starts an analysis. */
/** SAV-92 fix 2: a model call left "dispatched" can only be settled by the process that sent it. Past this
 * horizon (longer than any Vercel function, 800 s at most) no settlement can ever arrive. */
export const SAV_INTAKE_CALL_SETTLEMENT_HORIZON_MS = 15 * 60_000;
/** Whether an unsettled model call still blocks a new dispatch for its mail (operational profile).
 * Only a call that may still settle does. A definitively uncertain call ("uncertain", or "dispatched"
 * past the horizon) stays in the ledger at its reserved price and keeps counting in every budget,
 * but no longer freezes the mail: the next attempt obeys the normal attempt, call and money limits. */
export function intakeCallBlocksDispatch(row: { state: string; createdAt: Date }, now: Date) {
  return row.state === "dispatched" && now.getTime() - row.createdAt.getTime() < SAV_INTAKE_CALL_SETTLEMENT_HORIZON_MS;
}
/** SQL twin of intakeCallBlocksDispatch for scheduling (coarse; the claim re-checks under its locks). */
export function intakeInFlightCallSql(messageId: SQL, now: Date) {
  return sql`exists(select 1 from sav.intake_model_calls c join sav.intake_runs cr on cr.id = c.run_id
    where cr.message_id = ${messageId} and c.state = 'dispatched' and c.created_at > ${new Date(now.getTime() - SAV_INTAKE_CALL_SETTLEMENT_HORIZON_MS).toISOString()}::timestamptz)`;
}
/** SAV-92 fix 4: catch-up after a pause. Two lanes: mails received in the last 6 h, newest first, then the
 * older stock, least recently examined first (unchanged rotation), with one slot always kept for that stock
 * so it is never starved. A normal pass schedules 4 runs; when more than 4 are eligible (a backlog, typically
 * after a pause) it schedules 10. The inline analyses of a pass are still each gated by the analysis start
 * margin, so the pass ends within its 270 s budget whatever the batch. */
export const SAV_INTAKE_DISPATCH_LANES = Object.freeze({ normalBatch: 4, catchUpBatch: 10, recentWindowMs: 6 * 3600_000, oldStockSlots: 1 });
export const SAV_INTAKE_ANALYSIS_TIMING = Object.freeze({ modelMs: 60_000, analysisMs: 120_000, settlementMs: 15_000, leaseMs: 150_000, startMarginMs: 140_000 });
export type IntakeAttemptRow = { id: string; attempts: number; payloadCiphertext: string | null };
export type IntakeAttemptBudget = { runAttempts: number; failed: number; unknown: number; total: number;
  exhausted: false | "per_version" | "failed_per_message" | "total_per_message" };

/** true: an analysis was recorded; false: none; null: payload unavailable or unreadable. */
export function intakeRunAnalysed(ciphertext: string | null): boolean | null {
  if (!ciphertext) return null;
  try { return Boolean(decryptSavPayload<{ plan?: unknown }>(ciphertext).plan); } catch { return null; }
}
export function intakeAttemptBudget(runId: string, siblings: IntakeAttemptRow[]): IntakeAttemptBudget {
  const run = siblings.find(s => s.id === runId);
  const runAttempts = run?.attempts ?? 0, total = siblings.reduce((sum, s) => sum + s.attempts, 0);
  let failed = 0, unknown = 0;
  for (const s of siblings) {
    if (!s.attempts) continue;
    const analysed = intakeRunAnalysed(s.payloadCiphertext);
    if (analysed === false) failed += s.attempts; else if (analysed === null) unknown += s.attempts;
  }
  return { runAttempts, failed, unknown, total, exhausted: intakeAttemptExhaustion({ runAttempts, failed, total }) };
}
/** Decided from known counts only. Unknown attempts still count in the lifetime total, which alone bounds relaunches. */
export function intakeAttemptExhaustion(c: { runAttempts: number; failed: number; total: number }): IntakeAttemptBudget["exhausted"] {
  const P = SAV_INTAKE_ATTEMPT_POLICY;
  return c.runAttempts >= P.perVersion ? "per_version" : c.failed >= P.failedPerMessage ? "failed_per_message"
    : c.total >= P.totalPerMessage ? "total_per_message" : false;
}
