// Immediate send (11/11): the caller's time budget, in one place. A queued V2 reply is sent at once only when the CALLER says how long it may still run
// and enough of it is left; otherwise nothing is attempted and the reply waits, queued, for the effects catch-up (`/api/cron/sav-v2-effects`, every 10 min).
// Pure: no I/O, so every caller (continuation, J2) can apply it before loading anything.

/** At most this long for one immediate send (owner read, claim, preflight, Gmail send, read-back). */
export const CASE_REPLY_IMMEDIATE_BUDGET_MS = 45_000;
/** Left untouched before the caller's own deadline, for what the caller still has to do after the send (logs, pulse, response). */
export const CASE_REPLY_IMMEDIATE_SAFETY_MS = 15_000;
/** No immediate send unless the caller has at least this much left: the full send budget plus the safety margin. */
export const CASE_REPLY_IMMEDIATE_MIN_REMAINING_MS = CASE_REPLY_IMMEDIATE_BUDGET_MS + CASE_REPLY_IMMEDIATE_SAFETY_MS;

/** The deadline of an immediate send inside a caller that must finish by `callerDeadlineMs`, or null: not enough time, the catch-up sends. */
export function immediateSendDeadline(callerDeadlineMs: number | undefined, now = Date.now()): number | null {
  if (callerDeadlineMs === undefined || !Number.isFinite(callerDeadlineMs) || callerDeadlineMs - now < CASE_REPLY_IMMEDIATE_MIN_REMAINING_MS) return null;
  return Math.min(callerDeadlineMs - CASE_REPLY_IMMEDIATE_SAFETY_MS, now + CASE_REPLY_IMMEDIATE_BUDGET_MS);
}

export type ImmediateCaseReplyOutcome = { skipped: string } | { failed: string } | { pass: import("./case-runtime-effects").CaseRuntimePassResult };
/** Production signature: no transport, no runtime context, nothing that could bypass the configuration and the signed grant read by the pass. */
export type ImmediateCaseReplySend = (input: { env: Record<string, string | undefined>; executionId: string; callerDeadlineMs: number }) => Promise<ImmediateCaseReplyOutcome>;
