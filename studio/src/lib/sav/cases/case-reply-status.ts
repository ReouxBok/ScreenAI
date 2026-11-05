// SAV-10 (pole C): what the Studio may truthfully say about ONE prepared reply. Pure: it reads nothing, it only names the state from facts the caller read.
// The rule behind every value: a mail is never reported as sent unless the ledger holds a CONFIRMED receipt, and a possibly-sent mail is reported as
// `maybe`, never as `no` and never as `yes`. There is no "retry" or "resend" status because no such action exists.
import type { CaseEffectCancelCode, CaseEffectHoldCode, CaseEffectLedgerState, CaseEffectsMode } from "./case-effects";
import { SAV_CASE_EFFECT_CANCEL_CODES, SAV_CASE_EFFECT_HOLD_CODES } from "./case-effects";
import type { CaseReplyValidationState } from "./case-reply-validation";

export type CaseEffectExecutionState = "pending" | "running" | "waiting" | "uncertain" | "confirmed" | "refused";

export type CaseReplyStatusFacts = Readonly<{
  mode: CaseEffectsMode;
  validation: CaseReplyValidationState;
  /** The parent row of the effects, or null while the approved reply is not queued. */
  execution: Readonly<{ state: CaseEffectExecutionState; reason: string | null }> | null;
  /** `sav.intake_effects.state` of the `reply_send` row, `none` when it is not planned yet. */
  reply: CaseEffectLedgerState;
  /** The J2 timer attached to the question this reply asked, when there is one. */
  timer: Readonly<{ state: "scheduled" | "fired" | "cancelled"; dueAt: string }> | null;
}>;

export type CaseReplyStatusCode =
  | "awaiting_validation" | "declined" | "superseded" | "revoked"
  | "approved_not_queued" | "queued" | "held" | "sending" | "send_unconfirmed" | "sent_recording" | "sent_confirmed" | "cancelled";

export type CaseReplyStatus = Readonly<{
  code: CaseReplyStatusCode;
  /** `no`: nothing left toward the customer; `maybe`: a send was started and is not confirmed (verification only, never a resend); `yes`: confirmed receipt. */
  sent: "no" | "maybe" | "yes";
  /** Nothing will happen to this reply anymore. */
  terminal: boolean;
  hold: CaseEffectHoldCode | null;
  cancel: CaseEffectCancelCode | null;
  /** The raw machine code of an execution that ended for another reason, so that a refusal is never shown as a bare "cancelled". */
  endedBy: string | null;
  j2: Readonly<{ state: "none" | "scheduled" | "fired" | "cancelled"; dueAt: string | null }>;
}>;

const PREFIX_CANCEL = "SAV_CASE_EFFECT_CANCELLED_";
const PREFIX_HOLD = "SAV_CASE_EFFECT_HOLD_";
const cancelOf = (reason: string | null) => reason?.startsWith(PREFIX_CANCEL) ? SAV_CASE_EFFECT_CANCEL_CODES.find(code => code.toUpperCase() === reason.slice(PREFIX_CANCEL.length)) ?? null : null;
const holdOf = (reason: string | null) => reason?.startsWith(PREFIX_HOLD) ? SAV_CASE_EFFECT_HOLD_CODES.find(code => code.toUpperCase() === reason.slice(PREFIX_HOLD.length)) ?? null : null;
const machineCode = (reason: string | null) => reason && /^[A-Z0-9_]{3,120}$/.test(reason) ? reason : null;

export function deriveCaseReplyStatus(facts: CaseReplyStatusFacts): CaseReplyStatus {
  const j2 = facts.timer ? { state: facts.timer.state, dueAt: facts.timer.dueAt } : { state: "none" as const, dueAt: null };
  const base = { hold: null, cancel: null, endedBy: null, j2 };
  const out = (code: CaseReplyStatusCode, sent: CaseReplyStatus["sent"], terminal: boolean, extra: Partial<CaseReplyStatus> = {}): CaseReplyStatus => ({ ...base, code, sent, terminal, ...extra });
  if (facts.validation === "proposed") return out("awaiting_validation", "no", false);
  if (facts.validation === "declined") return out("declined", "no", true);
  if (facts.validation === "superseded") return out("superseded", "no", true);
  // The store refuses a revocation once a marker exists, so a revoked approval means nothing left toward the customer.
  if (facts.validation === "revoked" && (facts.reply === "none" || facts.reply === "planned")) return out("revoked", "no", true);
  // Approved from here on. The ledger decides what was done, whatever the parent row says.
  if (facts.reply === "confirmed") return facts.execution?.state === "confirmed" ? out("sent_confirmed", "yes", true) : out("sent_recording", "yes", false);
  if (facts.reply === "dispatched" || facts.reply === "acked" || facts.reply === "uncertain") return out(facts.reply === "uncertain" ? "send_unconfirmed" : "sending", "maybe", false);
  if (!facts.execution) return out("approved_not_queued", "no", false);
  if (facts.execution.state === "refused") return out("cancelled", "no", true, { cancel: cancelOf(facts.execution.reason), endedBy: machineCode(facts.execution.reason) });
  if (facts.mode !== "supervised") return out("held", "no", false, { hold: "effects_off" });
  const hold = holdOf(facts.execution.reason);
  if (hold) return out("held", "no", false, { hold });
  return out("queued", "no", false);
}
