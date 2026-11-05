// SAV-10 (pole C), C9: the ONE statement of "this effect needs a person to look at it", shared by the scheduler's listing (`listCaseEffectsNeedingPerson`), the single-reply
// review (`describeCaseReplyForReview`) and the operational reader (`case-operational-read.ts`). Pure: nothing is read, written, decrypted or sent here.
// The limit is the backend's own: the verification driver stops listing an effect after this many reads (`case-effect-recovery.ts`, `dueForVerification`) and nothing resets it. A UI never
// repeats the number: the reader hands it over as `verificationLimit`.

/** Reads of an engaged effect after which the verification stops and a person must look. Identical to the literal the recovery listing and `dueForVerification` use (pinned by a test). */
export const CASE_VERIFICATION_READ_LIMIT = 5;

/** An effect whose marker was written: it may have left, so it is only ever verified (never resent, never cancelled). */
export const CASE_ENGAGED_EFFECT_STATES = ["dispatched", "acked", "uncertain"] as const;
/** A parent execution that nothing will process again. */
export const CASE_TERMINAL_EXECUTION_STATES = ["confirmed", "refused"] as const;
export const CASE_OPEN_EXECUTION_STATES = ["pending", "running", "waiting", "uncertain"] as const;
/** The states the ledger's CHECK allows (migration 0041). Anything else is read as unreadable, never as "nothing to do". */
export const CASE_EFFECT_LEDGER_STATES = ["planned", "dispatched", "acked", "uncertain", "confirmed"] as const;

export type CaseVerificationVerdict =
  /** Not engaged, or engaged and still being read: nothing for a person to do about verification. */
  | "none"
  /** Engaged, marker present, parent open, limit reached: a person must look. Same rule as the scheduler's listing. */
  | "needs_person"
  /** The rows contradict each other (an engaged effect under a finished parent, or engaged without a marker). Nothing here resolves it: it is reported for an audit, never "fixed". */
  | "needs_audit"
  /** A value outside the closed vocabulary or a count that is not a non-negative integer: reported as unreadable, never as "none". */
  | "unreadable";

const has = (list: readonly string[], value: unknown): boolean => typeof value === "string" && list.includes(value);

export function classifyEffectVerification(input: Readonly<{
  /** `sav.case_effect_executions.state` of the PARENT. */
  executionState: string | null | undefined;
  /** `sav.intake_effects.state` of the effect. */
  effectState: string | null | undefined;
  /** The marker: `dispatched_at`, a Date, an ISO string, or null when none was written. */
  dispatchedAt: Date | string | null | undefined;
  reconcileAttempts: number | null | undefined;
}>): CaseVerificationVerdict {
  const { executionState, effectState, dispatchedAt, reconcileAttempts } = input;
  if (!has([...CASE_OPEN_EXECUTION_STATES, ...CASE_TERMINAL_EXECUTION_STATES], executionState) || !has(CASE_EFFECT_LEDGER_STATES, effectState)) return "unreadable";
  if (typeof reconcileAttempts !== "number" || !Number.isInteger(reconcileAttempts) || reconcileAttempts < 0) return "unreadable";
  if (!has(CASE_ENGAGED_EFFECT_STATES, effectState)) return "none";
  if (has(CASE_TERMINAL_EXECUTION_STATES, executionState)) return "needs_audit";
  if (!dispatchedAt) return "needs_audit";
  return reconcileAttempts >= CASE_VERIFICATION_READ_LIMIT ? "needs_person" : "none";
}

/** The verification is still to come: engaged, marker present, parent open, under the limit. A date on any other effect is an orphan and is not shown as a schedule. */
export const verificationStillScheduled = (input: Parameters<typeof classifyEffectVerification>[0]): boolean =>
  has(CASE_ENGAGED_EFFECT_STATES, input.effectState) && has(CASE_OPEN_EXECUTION_STATES, input.executionState) && Boolean(input.dispatchedAt)
  && typeof input.reconcileAttempts === "number" && Number.isInteger(input.reconcileAttempts) && input.reconcileAttempts >= 0 && input.reconcileAttempts < CASE_VERIFICATION_READ_LIMIT;
