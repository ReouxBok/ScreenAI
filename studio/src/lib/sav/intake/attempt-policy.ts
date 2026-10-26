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
export const SAV_INTAKE_BLOCKING_JOURNAL_KINDS = ["source_invalid", "attempts_exhausted", "deterministic_block"] as const;
/** A technical wait older than this is an incident handed to the team, never a silent state. */
export const SAV_INTAKE_BLOCKED_AFTER_MINUTES = 15;
/** Local, reproducible input errors: retrying the same input cannot succeed and must not burn attempts. */
export const SAV_INTAKE_DETERMINISTIC_ERRORS = new Set(["SAV_INTAKE_INPUT_INVALID", "SAV_INTAKE_LIMITS_INVALID"]);

export type IntakeAttemptRow = { id: string; attempts: number; payloadCiphertext: string };
export type IntakeAttemptBudget = { runAttempts: number; failed: number; total: number;
  exhausted: false | "per_version" | "failed_per_message" | "total_per_message" };

function analysed(ciphertext: string) {
  try { return Boolean(decryptSavPayload<{ plan?: unknown }>(ciphertext).plan); } catch { return false; }
}
export function intakeAttemptBudget(runId: string, siblings: IntakeAttemptRow[]): IntakeAttemptBudget {
  const run = siblings.find(s => s.id === runId), P = SAV_INTAKE_ATTEMPT_POLICY;
  const runAttempts = run?.attempts ?? 0, total = siblings.reduce((sum, s) => sum + s.attempts, 0);
  const failed = siblings.reduce((sum, s) => sum + (s.attempts && !analysed(s.payloadCiphertext) ? s.attempts : 0), 0);
  const exhausted = runAttempts >= P.perVersion ? "per_version" : failed >= P.failedPerMessage ? "failed_per_message"
    : total >= P.totalPerMessage ? "total_per_message" : false;
  return { runAttempts, failed, total, exhausted };
}
