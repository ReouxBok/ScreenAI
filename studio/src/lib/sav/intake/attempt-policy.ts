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
