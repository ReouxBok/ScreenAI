// Pure J2 timer lifecycle (SAV V2). No clock, no I/O, no table, no send: the caller passes `now`, ids and every fact.
// A timer is scheduled only for a question whose send is confirmed, is cancelled by any signal that makes it obsolete,
// and when due only produces a `timer_fired` event. Revalidation answers "are the timer's own conditions still met?",
// never "may we send": admission (SAV-44), the decision validator (SAV-6) and the case CAS stay mandatory and separate.
// A technical pause is not such a signal (decision Ugo, 2026-10-27): it suspends the follow-up, keeps the timer and its original
// due date, and the follow-up resumes at the first business slot at or after the end of the pause, with no new 24 h.
import { firstJ2SlotAtOrAfter, isWithinJ2Slot, nextJ2Slot } from "./j2-calendar";
import { caseTimerKey, type CaseTimer, type CaseTimerCancelReason, type CaseTimerState } from "./case-types";

// The timer record, its states and its cancellation reasons ARE the SAV-5 storage types (contract v6, case-types.ts): no second definition.
export type J2TimerState = CaseTimerState;
export type J2CancelReason = CaseTimerCancelReason;
export type J2Timer = Readonly<CaseTimer>;

export type J2Cancellation = Readonly<{ timerId: string; key: string; reason: J2CancelReason }>;

export type J2QuestionSend =
  | Readonly<{ status: "confirmed"; sentAt: Date }>
  | Readonly<{ status: "pending" | "dispatched" | "uncertain" | "failed" }>;

export type J2ScheduleInput = Readonly<{
  timerId: string;
  caseId: string;
  questionEffectId: string;
  caseVersion: number;
  send: J2QuestionSend;
  lastCustomerInboundAt: Date | null;
  existing: readonly J2Timer[];
  now: Date;
}>;

export type J2ScheduleResult = Readonly<{
  timers: readonly J2Timer[];
  cancelled: readonly J2Cancellation[];
  scheduled: J2Timer | null;
  skipped: "send_not_confirmed" | "already_exists" | "inbound_after_question" | null;
}>;

export type J2Signal =
  | Readonly<{ kind: "customer_inbound"; caseId: string }>
  | Readonly<{ kind: "owner_changed"; caseId: string }>
  | Readonly<{ kind: "human_outbound"; caseId: string }>
  | Readonly<{ kind: "admission_withdrawn"; caseId: string }>
  | Readonly<{ kind: "new_question"; caseId: string; questionEffectId: string }>
  // Q9: an organisational hold (owner "system_hold") is NOT a cancellation. Explicit so a caller cannot confuse it with owner_changed.
  | Readonly<{ kind: "organizational_hold"; caseId: string }>;

export type J2SignalResult = Readonly<{ timers: readonly J2Timer[]; cancelled: readonly J2Cancellation[] }>;

// Same shape as the SAV-5 `timer_fired` event; type "timer" is a SAV-5 SourceRef type. Emitting it is the only effect of a due timer.
export type J2TimerFiredEvent = Readonly<{
  kind: "timer_fired";
  caseId: string;
  dedupeKey: string; // timer:<timer.id>
  sourceRef: Readonly<{ type: "timer"; id: string }>;
  detail: Readonly<{ timerKey: string; questionEffectId: string; dueAt: string }>;
}>;

export type J2DueResult = Readonly<{ timers: readonly J2Timer[]; emitted: readonly J2TimerFiredEvent[] }>;

// Structural supertypes of the SAV-5 CaseSnapshot and CaseEvent (case-types.ts): same field names, nothing added, values widened to string so an
// unknown value fails closed. Every real CaseSnapshot / CaseEvent is assignable to them (checked by tsc in timer-store.test.ts).
export type J2CaseView = Readonly<{
  caseId: string;
  version: number;
  owner: string;
  phase: string;
  sensitivity: string;
  body: Readonly<{
    questions: ReadonlyArray<Readonly<{ id: string; askedAt: string; askedInEffect: string; answeredBy?: unknown }>>;
    waiting: Readonly<{ kind: string; timerId?: string }> | null;
  }>;
}>;
// `detail` is read only for owner_changed (its `transition`). An unreadable or unknown transition fails closed: it makes the follow-up obsolete.
export type J2CaseEventView = Readonly<{ kind: string; direction: string; occurredAt: string; detail?: Readonly<{ transition?: unknown }> | null }>;

// Q9 (Ugo, 2026-10-28): a technical or organisational hold keeps J2; a person taking the case over cancels it. Only these two transitions are
// organisational (they never mean "a person took it"). A hold release that hands the case to a human ends in owner "human" and is obsolete by owner.
// Contract v7 (Q9) names the two holds; `admin_hold` is retired as a command but stays readable in older journals. `hold_release` is neutral
// here: released to a person it ends the follow-up through the owner (owner_not_agent), released to the agent it lets the follow-up resume (A restores the waiting phase).
const ORGANIZATIONAL_TRANSITIONS: ReadonlySet<string> = new Set(["technical_hold", "organisational_hold", "admin_hold", "hold_release"]);
const isOrganizationalTransition = (event: J2CaseEventView) => typeof event.detail?.transition === "string" && ORGANIZATIONAL_TRANSITIONS.has(event.detail.transition);
// Contract v8 (pole A cfa2c37): a case released from a technical or organisational hold goes back to its wait (`awaiting_customer`) while the J2 its
// waiting block points to is still scheduled or fired. C therefore needs no special case for the phase after a release.

// Reasons to stop that no case field carries. A withdrawn admission is final; an admission check that could not run, or a budget that
// is not available now, only postpones: a technical failure of the check must not manufacture a business cancellation. Never a grant.
export type J2ActiveHold = "admission_withdrawn" | "admission_unavailable" | "budget_unavailable";

/** One suspension of the agent, as a half-open interval [from, to). `to: null` is a pause that has not ended. */
export type J2PauseWindow = Readonly<{ from: string; to: string | null; cause: string }>;
/** Only "technical" is a known cause. Anything else, or a window that cannot be read, blocks as "unknown": the work is kept, nothing is sent. */
export type J2PauseCause = "technical" | "unknown";

/** State of the reminder effect for this timer, read from the effect ledger. Engaged or unknown outcomes are verify-only. */
export type J2ReminderEffect = "none" | "planned" | "dispatched" | "uncertain" | "failed" | "confirmed";

// Permanent: the follow-up is over, whatever happens next.
export type J2ObsoleteReason =
  | "timer_not_fired" | "timer_cancelled" | "case_mismatch" | "owner_not_agent" | "phase_changed"
  | "sensitive_case" | "question_missing" | "question_answered" | "question_superseded" | "not_waiting_for_customer"
  | "timer_not_linked" | "inbound_after_question" | "owner_changed_since" | "human_outbound_since"
  | "newer_agent_message" | "invalid_time" | "admission_withdrawn" | "reminder_already_sent";
// Temporary: nothing is lost, look again later.
export type J2DeferReason =
  | "not_due" | "technical_pause" | "pause_cause_unknown" | "outside_business_slot" | "case_phase_transient"
  | "organizational_hold" | "admission_unavailable" | "budget_unavailable" | "unknown_hold";

// Deliberately not named "allowed" or "eligible": it grants nothing and carries the version a decision must be prepared on.
export type J2Revalidation =
  | Readonly<{ status: "timer_conditions_met"; caseVersion: number }>
  | Readonly<{ status: "obsolete"; reasons: readonly [J2ObsoleteReason, ...J2ObsoleteReason[]] }>
  | Readonly<{ status: "deferred"; reasons: readonly [J2DeferReason, ...J2DeferReason[]]; notBefore: string | null }>
  | Readonly<{ status: "verify_only"; effect: "dispatched" | "uncertain" | "failed"; alsoObsolete: readonly J2ObsoleteReason[] }>;

// What an operator or a diagnostic shows. "suspended_technically" and "cancelled" are different things with different next steps.
export type J2TimerDiagnostic = Readonly<{
  status: "following" | "suspended_technically" | "fired" | "cancelled";
  reason: J2PauseCause | J2CancelReason | null;
  nextStep: "wait_for_due_date" | "collect_due_timer" | "resume_at_next_slot" | "wait_for_pause_end" | "identify_pause_cause" | "revalidate_before_effect" | "none";
  resumesAt: string | null;
}>;

export type J2ResumeAt =
  | Readonly<{ status: "free"; at: Date; delayedBy: J2PauseCause | null }>
  | Readonly<{ status: "blocked"; cause: J2PauseCause }>;

const SIGNAL_REASON = {
  customer_inbound: "customer_inbound", owner_changed: "owner_changed",
  human_outbound: "human_outbound", admission_withdrawn: "admission_withdrawn",
} as const satisfies Record<Exclude<J2Signal["kind"], "new_question" | "organizational_hold">, J2CancelReason>;

// Phases a technical incident can park a case in. They say "not now", not "this follow-up is obsolete".
const TRANSIENT_PHASES: ReadonlySet<string> = new Set([
  "technical_wait", "deferred_budget", "reconciling", "blocked_technical", "blocked_reconcile", "needs_review",
]);

type NormalizedPause = Readonly<{ fromMs: number; toMs: number | null; cause: J2PauseCause }>;

// A window that cannot be read is an open pause of unknown cause: it blocks, it never vanishes and never throws the work away.
function normalizePauses(pauses: readonly J2PauseWindow[]): NormalizedPause[] {
  if (!Array.isArray(pauses)) throw new TypeError("pauses must be an array");
  return pauses.map((window): NormalizedPause => {
    const fromMs = typeof window?.from === "string" ? Date.parse(window.from) : Number.NaN;
    const toMs = window?.to === null ? null : typeof window?.to === "string" ? Date.parse(window.to) : Number.NaN;
    const readable = Number.isFinite(fromMs) && (toMs === null || (Number.isFinite(toMs) && toMs >= fromMs));
    if (!readable) return { fromMs: Number.NEGATIVE_INFINITY, toMs: null, cause: "unknown" };
    return { fromMs, toMs, cause: window.cause === "technical" ? "technical" : "unknown" };
  });
}
const covers = (window: NormalizedPause, atMs: number) => window.fromMs <= atMs && (window.toMs === null || atMs < window.toMs);

function requireId(value: string, name: string, allowColon: boolean) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty trimmed string without control characters`);
  }
  if (!allowColon && value.includes(":")) throw new TypeError(`${name} must not contain ":"`);
}

function requireDate(value: Date, name: string) {
  if (Object.prototype.toString.call(value) !== "[object Date]") throw new TypeError(`${name} must be a Date`);
  if (!Number.isFinite(value.getTime())) throw new RangeError(`${name} is an invalid Date`);
}

/** `timer:j2:<caseId>:<questionEffectId>`. caseId has no ":" so the key reads back unambiguously. */
export function j2TimerKey(caseId: string, questionEffectId: string): string {
  requireId(caseId, "caseId", false);
  requireId(questionEffectId, "questionEffectId", true);
  return caseTimerKey(caseId, questionEffectId);
}

function cancelTimer(timer: J2Timer, reason: J2CancelReason, at: Date): J2Timer {
  return { ...timer, state: "cancelled", cancelReason: reason, cancelledAt: at.toISOString() };
}

/**
 * A confirmed question schedules one timer at nextJ2Slot(sentAt). Anything not confirmed (pending, dispatched, uncertain, failed)
 * schedules nothing and changes nothing: an uncertain send is verify-only. A key that already exists, in any state, is never recreated.
 * A confirmed new question makes the case's other scheduled timers obsolete. A customer message at or after the send time schedules no J2.
 */
export function scheduleJ2Timer(input: J2ScheduleInput): J2ScheduleResult {
  requireId(input.timerId, "timerId", true);
  const key = j2TimerKey(input.caseId, input.questionEffectId);
  if (!Number.isInteger(input.caseVersion) || input.caseVersion < 1) throw new RangeError("caseVersion must be a positive integer");
  requireDate(input.now, "now");
  if (input.lastCustomerInboundAt !== null) requireDate(input.lastCustomerInboundAt, "lastCustomerInboundAt");
  const unchanged = (skipped: NonNullable<J2ScheduleResult["skipped"]>): J2ScheduleResult =>
    ({ timers: input.existing, cancelled: [], scheduled: null, skipped });

  if (input.send.status !== "confirmed") return unchanged("send_not_confirmed");
  const { sentAt } = input.send;
  requireDate(sentAt, "sentAt");
  if (input.existing.some((timer) => timer.key === key)) return unchanged("already_exists");

  const cancelled: J2Cancellation[] = [];
  const timers = input.existing.map((timer) => {
    if (timer.caseId !== input.caseId || timer.state !== "scheduled") return timer;
    cancelled.push({ timerId: timer.id, key: timer.key, reason: "new_question" });
    return cancelTimer(timer, "new_question", input.now);
  });
  if (input.lastCustomerInboundAt !== null && input.lastCustomerInboundAt.getTime() >= sentAt.getTime()) {
    return { timers, cancelled, scheduled: null, skipped: "inbound_after_question" };
  }
  const scheduled: J2Timer = {
    id: input.timerId, key, caseId: input.caseId, questionEffectId: input.questionEffectId,
    sentAt: sentAt.toISOString(), dueAt: nextJ2Slot(sentAt).toISOString(), state: "scheduled",
    scheduledAtCaseVersion: input.caseVersion, firedAt: null, cancelledAt: null, cancelReason: null,
  };
  return { timers: [...timers, scheduled], cancelled, scheduled, skipped: null };
}

/**
 * Cancels the case's scheduled timers. Only `scheduled` timers move: fired and cancelled are terminal, a cancelled timer is never revived
 * (a later hand-back does not resurrect it; a new question gets a new timer). Applying the same signal twice cancels nothing the second time.
 * A customer message cancels whatever its own timestamp: a late-processed older message only costs a missed reminder.
 */
export function applyJ2Signal(timers: readonly J2Timer[], signal: J2Signal, at: Date): J2SignalResult {
  requireId(signal.caseId, "caseId", false);
  requireDate(at, "at");
  // An unknown kind (an old caller still sending "pause") must fail loudly: silently cancelling or ignoring would both be wrong.
  if (signal.kind === "organizational_hold") return { timers, cancelled: [] };
  if (signal.kind !== "new_question" && !Object.hasOwn(SIGNAL_REASON, signal.kind)) throw new TypeError(`unknown J2 signal "${String(signal.kind)}"`);
  if (signal.kind === "new_question") requireId(signal.questionEffectId, "questionEffectId", true);
  const reason: J2CancelReason = signal.kind === "new_question" ? "new_question" : SIGNAL_REASON[signal.kind];
  const cancelled: J2Cancellation[] = [];
  const next = timers.map((timer) => {
    if (timer.caseId !== signal.caseId || timer.state !== "scheduled") return timer;
    if (signal.kind === "new_question" && timer.questionEffectId === signal.questionEffectId) return timer;
    cancelled.push({ timerId: timer.id, key: timer.key, reason });
    return cancelTimer(timer, reason, at);
  });
  return { timers: cancelled.length ? next : timers, cancelled };
}

/**
 * First instant a timer due at `dueAt` may fire once the pauses are taken into account: the due date itself when no pause covers it,
 * else the first business slot at or after the end of the covering pause, chained through nested or adjacent pauses. The original due
 * date is never recomputed and no 24 h is added. A pause that has not ended, or cannot be read, blocks.
 */
export function j2ResumeAt(dueAt: string, pauses: readonly J2PauseWindow[]): J2ResumeAt {
  const windows = normalizePauses(pauses);
  let atMs = Date.parse(dueAt);
  if (Number.isNaN(atMs)) throw new RangeError("dueAt is not a date");
  let delayedBy: J2PauseCause | null = null;
  // Each window can cover the moving instant at most once, because the instant never goes back before the end of a window it left.
  for (let guard = 0; guard <= windows.length; guard += 1) {
    const hit = windows.find((window) => covers(window, atMs));
    if (!hit) return { status: "free", at: new Date(atMs), delayedBy };
    if (hit.toMs === null) return { status: "blocked", cause: hit.cause };
    delayedBy = delayedBy === "unknown" || hit.cause === "unknown" ? "unknown" : "technical";
    try { atMs = firstJ2SlotAtOrAfter(new Date(hit.toMs)).getTime(); } catch { return { status: "blocked", cause: "unknown" }; }
  }
  return { status: "blocked", cause: "unknown" };
}

function pausedNow(windows: readonly NormalizedPause[], nowMs: number) {
  return windows.filter((window) => covers(window, nowMs));
}

function requireCollectOptions(options: unknown): { pauses: readonly J2PauseWindow[]; maxEvents: number } {
  if (options === null || typeof options !== "object") throw new TypeError("collectDueJ2Events needs { pauses, maxEvents }");
  const { pauses, maxEvents } = options as { pauses?: unknown; maxEvents?: unknown };
  if (!Array.isArray(pauses)) throw new TypeError("pauses must be an array: the caller states the pauses, it cannot omit them");
  if (typeof maxEvents !== "number" || !Number.isInteger(maxEvents) || maxEvents < 1) throw new RangeError("maxEvents must be a positive integer");
  return { pauses, maxEvents };
}

/**
 * Scheduled timers whose dueAt has been reached, that no pause covers now, and that the pauses did not push beyond now, become `fired`
 * and yield one `timer_fired` event each, ordered by dueAt then key, at most `maxEvents` per call (a backlog released after a pause
 * leaves the rest scheduled with their own dates: no burst). Nothing fires outside a business slot. Nothing else happens here:
 * no revalidation, no decision, no send. A pause never cancels a timer; a timer found late fires once and keeps its original dueAt.
 */
export function collectDueJ2Events(
  timers: readonly J2Timer[], now: Date, options: Readonly<{ pauses: readonly J2PauseWindow[]; maxEvents: number }>,
): J2DueResult {
  requireDate(now, "now");
  const { pauses, maxEvents } = requireCollectOptions(options);
  const nowMs = now.getTime();
  if (pausedNow(normalizePauses(pauses), nowMs).length || !isWithinJ2Slot(now)) return { timers, emitted: [] };
  // Not paused now and inside a slot is exactly "j2ResumeAt(dueAt) <= now": the resume instant is the end of the last covering pause moved
  // to a slot, and a pause that is still open, or unreadable, covers now. timer-pause.test.ts checks the two readings against each other.
  const due = timers.filter((timer) => timer.state === "scheduled" && Date.parse(timer.dueAt) <= nowMs).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, maxEvents);
  if (!due.length) return { timers, emitted: [] };
  const firedIds = new Set(due.map((timer) => timer.id));
  const next = timers.map((timer) => (firedIds.has(timer.id) ? { ...timer, state: "fired" as const, firedAt: now.toISOString() } : timer));
  const emitted = due.map((timer): J2TimerFiredEvent => ({
    kind: "timer_fired", caseId: timer.caseId, dedupeKey: `timer:${timer.id}`, sourceRef: { type: "timer", id: timer.id },
    detail: { timerKey: timer.key, questionEffectId: timer.questionEffectId, dueAt: timer.dueAt },
  }));
  return { timers: next, emitted };
}

/**
 * What to show for a timer: following, suspended technically (with the cause, and when it resumes if known), fired, or cancelled
 * (with its business reason). A suspension is never reported as a cancellation, and an unknown pause cause asks for a human look.
 */
export function describeJ2Timer(input: Readonly<{ timer: J2Timer; pauses: readonly J2PauseWindow[]; now: Date }>): J2TimerDiagnostic {
  requireDate(input.now, "now");
  const { timer } = input;
  if (timer.state === "cancelled") return { status: "cancelled", reason: timer.cancelReason, nextStep: "none", resumesAt: null };
  if (timer.state === "fired") return { status: "fired", reason: null, nextStep: "revalidate_before_effect", resumesAt: null };
  const nowMs = input.now.getTime();
  const dueMs = Date.parse(timer.dueAt);
  const base = j2ResumeAt(timer.dueAt, input.pauses);
  const lateNow = dueMs <= nowMs;
  const fromNow = lateNow && pausedNow(normalizePauses(input.pauses), nowMs).length ? j2ResumeAt(input.now.toISOString(), input.pauses) : null;
  const blocked = base.status === "blocked" ? base : fromNow?.status === "blocked" ? fromNow : null;
  if (blocked) {
    return {
      status: "suspended_technically", reason: blocked.cause, resumesAt: null,
      nextStep: blocked.cause === "unknown" ? "identify_pause_cause" : "wait_for_pause_end",
    };
  }
  const baseAt = (base as Extract<J2ResumeAt, { status: "free" }>).at.getTime();
  const nowAt = fromNow ? (fromNow as Extract<J2ResumeAt, { status: "free" }>).at.getTime() : baseAt;
  const atMs = Math.max(baseAt, nowAt, lateNow ? firstJ2SlotAtOrAfter(input.now).getTime() : baseAt);
  const delayedBy = (base as Extract<J2ResumeAt, { status: "free" }>).delayedBy
    ?? (fromNow ? (fromNow as Extract<J2ResumeAt, { status: "free" }>).delayedBy : null);
  if (atMs > dueMs && delayedBy !== null && atMs > nowMs) {
    return { status: "suspended_technically", reason: delayedBy, nextStep: "resume_at_next_slot", resumesAt: new Date(atMs).toISOString() };
  }
  return { status: "following", reason: null, nextStep: lateNow ? "collect_due_timer" : "wait_for_due_date", resumesAt: new Date(atMs).toISOString() };
}

const OBSOLETE_ORDER: readonly J2ObsoleteReason[] = [
  "timer_not_fired", "timer_cancelled", "case_mismatch", "owner_not_agent", "phase_changed", "sensitive_case", "question_missing",
  "question_answered", "question_superseded", "not_waiting_for_customer", "timer_not_linked", "inbound_after_question",
  "owner_changed_since", "human_outbound_since", "newer_agent_message", "invalid_time", "admission_withdrawn", "reminder_already_sent",
];
const DEFER_ORDER: readonly J2DeferReason[] = [
  "not_due", "technical_pause", "pause_cause_unknown", "outside_business_slot", "case_phase_transient", "organizational_hold",
  "admission_unavailable", "budget_unavailable", "unknown_hold",
];
// Reasons whose end is a known instant: only these may carry a `notBefore`.
const TIMED_DEFERRALS: ReadonlySet<J2DeferReason> = new Set(["not_due", "technical_pause", "pause_cause_unknown", "outside_business_slot"]);

/**
 * Called by whoever consumes a `timer_fired` event, before any decision is prepared. It re-reads facts the caller passes in (the case as it is now,
 * the case events recorded since the question was sent, the pauses, the state of the reminder effect, and the holds that no case field carries).
 * Four outcomes, none of them an authorisation: `obsolete` (permanent business reasons, all listed), `deferred` (nothing lost: pause, outside a
 * slot, transient phase, admission or budget not available now; look again at `notBefore` when known), `verify_only` (the reminder effect is
 * engaged or its outcome unknown: check it, never act again) and `timer_conditions_met`. The caller must still obtain a fresh admission, validate
 * the decision, and write with `caseVersion` as the CAS token; a message arriving after this read bumps that version and is refused there.
 * The timer_fired event itself raised the case version, so equality with `scheduledAtCaseVersion` is not tested.
 */
export function revalidateFiredJ2(input: Readonly<{
  timer: J2Timer; view: J2CaseView; events: readonly J2CaseEventView[]; activeHolds: readonly J2ActiveHold[];
  pauses: readonly J2PauseWindow[]; reminderEffect: J2ReminderEffect; now: Date;
}>): J2Revalidation {
  requireDate(input.now, "now");
  const { timer, view } = input;
  const nowMs = input.now.getTime();
  const windows = normalizePauses(input.pauses);
  const obsolete = new Set<J2ObsoleteReason>();
  const deferred = new Set<J2DeferReason>();
  const sentMs = Date.parse(timer.sentAt);
  const dueMs = Date.parse(timer.dueAt);

  if (timer.state === "scheduled") obsolete.add("timer_not_fired");
  else if (timer.state === "cancelled") obsolete.add("timer_cancelled");
  if (timer.state === "fired" && dueMs > nowMs) deferred.add("not_due");
  if (view.caseId !== timer.caseId) obsolete.add("case_mismatch");
  if (view.owner === "system_hold") deferred.add("organizational_hold");
  else if (view.owner !== "agent") obsolete.add("owner_not_agent");
  if (TRANSIENT_PHASES.has(view.phase)) deferred.add("case_phase_transient");
  else if (view.phase !== "awaiting_customer") obsolete.add("phase_changed");
  if (view.sensitivity !== "none") obsolete.add("sensitive_case");

  const question = view.body.questions.find((candidate) => candidate.askedInEffect === timer.questionEffectId);
  if (!question) obsolete.add("question_missing");
  else {
    if (question.answeredBy !== undefined && question.answeredBy !== null) obsolete.add("question_answered");
    const askedMs = Date.parse(question.askedAt);
    if (Number.isNaN(askedMs)) obsolete.add("invalid_time");
    else if (view.body.questions.some((other) => Date.parse(other.askedAt) > askedMs)) obsolete.add("question_superseded");
  }
  if (view.body.waiting === null || view.body.waiting.kind !== "customer") obsolete.add("not_waiting_for_customer");
  else if (view.body.waiting.timerId !== timer.id) obsolete.add("timer_not_linked");

  if (Number.isNaN(sentMs)) obsolete.add("invalid_time");
  else for (const event of input.events) {
    const occurredMs = Date.parse(event.occurredAt);
    if (Number.isNaN(occurredMs)) { obsolete.add("invalid_time"); continue; }
    if (event.kind === "inbound_confirmed" && event.direction === "customer_inbound" && occurredMs >= sentMs) obsolete.add("inbound_after_question");
    else if (event.kind === "owner_changed" && occurredMs >= sentMs && !isOrganizationalTransition(event)) obsolete.add("owner_changed_since");
    else if (event.kind === "outbound_observed" && event.direction === "human_outbound" && occurredMs >= sentMs) obsolete.add("human_outbound_since");
    // The question's own outbound event sits at sentAt: only a strictly later agent message makes it obsolete.
    else if (event.kind === "outbound_observed" && event.direction === "agent_outbound" && occurredMs > sentMs) obsolete.add("newer_agent_message");
  }

  for (const window of pausedNow(windows, nowMs)) deferred.add(window.cause === "technical" ? "technical_pause" : "pause_cause_unknown");
  if (timer.state === "fired" && dueMs <= nowMs && !isWithinJ2Slot(input.now)) deferred.add("outside_business_slot");
  for (const hold of input.activeHolds) {
    if (hold === "admission_withdrawn") obsolete.add("admission_withdrawn");
    else if (hold === "admission_unavailable" || hold === "budget_unavailable") deferred.add(hold);
    else deferred.add("unknown_hold");
  }

  // An unknown effect state is treated as uncertain, never as "no effect".
  const effect: J2ReminderEffect = (["none", "planned", "dispatched", "uncertain", "failed", "confirmed"] as const).includes(input.reminderEffect)
    ? input.reminderEffect : "uncertain";
  if (effect === "confirmed") obsolete.add("reminder_already_sent");
  const orderedObsolete = OBSOLETE_ORDER.filter((reason) => obsolete.has(reason));
  if (effect === "dispatched" || effect === "uncertain" || effect === "failed") {
    return { status: "verify_only", effect, alsoObsolete: orderedObsolete };
  }
  const [firstObsolete, ...restObsolete] = orderedObsolete;
  if (firstObsolete !== undefined) return { status: "obsolete", reasons: [firstObsolete, ...restObsolete] };
  const orderedDeferred = DEFER_ORDER.filter((reason) => deferred.has(reason));
  const [firstDeferred, ...restDeferred] = orderedDeferred;
  if (firstDeferred !== undefined) {
    let notBefore: string | null = null;
    if (orderedDeferred.every((reason) => TIMED_DEFERRALS.has(reason)) && !Number.isNaN(dueMs)) {
      const resume = j2ResumeAt(firstJ2SlotAtOrAfter(new Date(Math.max(dueMs, nowMs))).toISOString(), input.pauses);
      notBefore = resume.status === "free" ? resume.at.toISOString() : null;
    }
    return { status: "deferred", reasons: [firstDeferred, ...restDeferred], notBefore };
  }
  return { status: "timer_conditions_met", caseVersion: view.version };
}
