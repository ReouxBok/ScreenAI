// SAV-8 J2 coupling to the SAV-5 case store (contract v8). LOCAL AND UNWIRED: no cron, no wake, no flag, no send, no HubSpot, no Gmail.
// The pure modules (j2-calendar, timer-lifecycle) decide WHEN and WHETHER; the SAV-5 store (case-store.ts) is the only place a timer
// is written. Nothing here recomputes what the store owns (cancellation on a signal, the fired event, the CAS): it calls it.
// A reminder is never produced here. `revalidateJ2Timer` answers "are the timer's own conditions still met?" and hands that answer, with
// the case version a decision must be prepared on, to a caller port; admission (SAV-44), the decision validator (SAV-6) and the effect
// ledger (SAV-10) stay mandatory and separate. Firing is an event, never a permission to send.
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseTimers } from "@/db/schema";
import { readSavAgentPause, type SavAgentPauseState } from "../intake/agent-pause";
import { caseAdmissionStatus } from "./admission-policy";
import { fireCaseTimer, listCaseEvents, listCaseTimers, listDueCaseTimers, readCase, scheduleCaseTimer, type CaseTx } from "./case-store";
import type { CaseTimer } from "./case-types";
import { nextJ2Slot } from "./j2-calendar";
import {
  collectDueJ2Events, revalidateFiredJ2,
  type J2ActiveHold, type J2PauseWindow, type J2ReminderEffect, type J2Revalidation, type J2Timer,
} from "./timer-lifecycle";

/** Stored with the case's `waiting` block; a reason code, not free text. */
export const J2_WAITING_REASON_CODE = "j2_question";

/** Events read for one revalidation: 10 full pages. A longer journal is not guessed at: the follow-up waits (`unknown_hold`). */
const EVENT_PAGE = 500, EVENT_PAGES_MAX = 10;

/**
 * A confirmed question schedules ONE timer at `nextJ2Slot(sentAt)` (24 h, then the first business slot, Europe/Paris). The store never
 * recomputes the due date. Only a question whose send is confirmed may call this; an uncertain send is verify-only and schedules nothing.
 * With `tx` (the receipt's single transaction) it writes inside the caller's transaction, with no retry of its own: a stale version throws and rolls everything back.
 */
export function scheduleJ2ForConfirmedQuestion(input: Readonly<{
  caseId: string; expectedVersion: number; currentPolicyRevision: string | null; questionEffectId: string; timerId: string; sentAt: Date; answeredVersion?: number;
}>, tx?: CaseTx) {
  return scheduleCaseTimer({
    caseId: input.caseId, expectedVersion: input.expectedVersion, currentPolicyRevision: input.currentPolicyRevision, reasonCode: J2_WAITING_REASON_CODE,
    ...(input.answeredVersion === undefined ? {} : { answeredVersion: input.answeredVersion }),
    timer: { id: input.timerId, questionEffectId: input.questionEffectId, sentAt: input.sentAt.toISOString(), dueAt: nextJ2Slot(input.sentAt).toISOString() },
  }, tx);
}

/**
 * The V2 pause as pause windows. Only the CURRENT state exists (`sav-agent-pause.v1:v2`, no history): while the agent is not `running`
 * every overdue timer is suspended, and the first pass after `running` returns finds them due, so they resume at the first business slot
 * at or after that instant (see timer-pause.test.ts for the equivalence with `j2ResumeAt`). A pause state that cannot be read is an open
 * pause of UNKNOWN cause: the work is kept and nothing is released. A pause is never a cancellation.
 */
export function j2PausesFromAgentPause(state: Pick<SavAgentPauseState, "level" | "invalid">): J2PauseWindow[] {
  if (state.level === "running" && !state.invalid) return [];
  return [{ from: new Date(0).toISOString(), to: null, cause: state.invalid ? "unknown" : "technical" }];
}

/**
 * Scheduled timers already due at `now`, oldest first. Read-only. The cross-case query is pole A's `listDueCaseTimers` (contract v8): a held
 * case (owner `system_hold`, Q9) is left out there, so a long queue of held cases cannot fill the bounded batch and starve the due timers of
 * cases that can fire; their timers stay scheduled with their own due dates. C no longer reads the timer table itself.
 */
export async function listDueScheduledJ2Timers(now: Date, limit: number): Promise<CaseTimer[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError("limit must be an integer from 1 to 500");
  return listDueCaseTimers({ now, limit });
}

export type J2Ports = Readonly<{
  /** Effect ledger state of THIS timer's reminder (SAV-10). Simulated in tests; unknown values are treated as uncertain by the revalidation. */
  reminderEffect: (timer: J2Timer) => Promise<J2ReminderEffect>;
  /** The budget gate (SAV-6/coordinator). False defers, it never cancels. */
  budgetAvailable: () => Promise<boolean>;
  /** Called ONLY on `timer_conditions_met` and ONLY while the reminder effect is `none`. Plans; never sends here. Simulated email/note in tests. */
  onConditionsMet?: (context: Readonly<{ timer: J2Timer; caseVersion: number }>) => Promise<void>;
}>;

async function allCaseEvents(caseId: string) {
  const events = [];
  for (let page = 0; page < EVENT_PAGES_MAX; page += 1) {
    const batch = await listCaseEvents(caseId, { afterVersion: events.length ? events[events.length - 1]!.caseVersion : 0, limit: EVENT_PAGE });
    events.push(...batch);
    if (batch.length < EVENT_PAGE) return events;
  }
  return null;
}

/**
 * Re-reads the case and the journal NOW and answers for one FIRED timer. Idempotent and callable at any time (including after a crash
 * between the firing and the planning). Admission mapping: no admission / not agent-admitted is a final withdrawal; a policy rotation or an
 * admission input newer than the record only postpones (a re-evaluation resolves it), so a technical gap never manufactures a cancellation.
 */
export async function revalidateJ2Timer(input: Readonly<{ timerId: string; caseId: string; currentPolicyRevision: string | null; now: Date; ports: J2Ports }>): Promise<J2Revalidation | { status: "not_fired" }> {
  const timer = (await listCaseTimers(input.caseId)).find((candidate) => candidate.id === input.timerId);
  if (!timer || timer.state !== "fired") return { status: "not_fired" };
  const snapshot = await readCase(input.caseId);
  if (!snapshot) return { status: "obsolete", reasons: ["case_mismatch"] };
  const events = await allCaseEvents(input.caseId);
  if (events === null) return { status: "deferred", reasons: ["unknown_hold"], notBefore: null };
  const holds: J2ActiveHold[] = [];
  const admission = caseAdmissionStatus(snapshot, input.currentPolicyRevision);
  if (!admission.admitted && admission.reason !== "owner_not_agent") {
    holds.push(admission.reason === "no_admission" || admission.reason === "not_admitted" ? "admission_withdrawn" : "admission_unavailable");
  }
  if (!(await input.ports.budgetAvailable())) holds.push("budget_unavailable");
  const pauses = j2PausesFromAgentPause(await readSavAgentPause(requireDb(), "v2"));
  const reminderEffect = await input.ports.reminderEffect(timer);
  const result = revalidateFiredJ2({ timer, view: snapshot, events, activeHolds: holds, pauses, reminderEffect, now: input.now });
  // Planned once: a reminder that already has any effect row (planned or beyond) is never planned again.
  if (result.status === "timer_conditions_met" && reminderEffect === "none") await input.ports.onConditionsMet?.({ timer, caseVersion: result.caseVersion });
  return result;
}

export type J2PassOutcome = Readonly<{ timerId: string; caseId: string; fired: boolean; revalidation: J2Revalidation | { status: "not_fired" } }>;

/**
 * One bounded pass. `maxEvents` has NO default: the burst limit and spacing are not decided (SAV-7/SAV-13), the caller states them.
 * 1. read the V2 pause; 2. choose, with the pure collector, which due timers may fire now (not paused, inside a business slot, oldest first,
 * at most `maxEvents`: a backlog released after a pause leaves the rest scheduled with their own dates); 3. fire each through the store
 * (one transaction: timer `fired` + `timer_fired` event, or nothing if a crossing signal already cancelled it); 4. revalidate each fired one.
 */
export async function runDueJ2Pass(input: Readonly<{ now: Date; maxEvents: number; currentPolicyRevision: string | null; ports: J2Ports }>): Promise<{ outcomes: J2PassOutcome[]; paused: boolean }> {
  const pauses = j2PausesFromAgentPause(await readSavAgentPause(requireDb(), "v2"));
  const candidates = await listDueScheduledJ2Timers(input.now, Math.min(500, Math.max(1, input.maxEvents)));
  const { emitted } = collectDueJ2Events(candidates, input.now, { pauses, maxEvents: input.maxEvents });
  const outcomes: J2PassOutcome[] = [];
  for (const event of emitted) {
    const timerId = event.sourceRef.id;
    const result = await fireCaseTimer({ timerId, now: input.now });
    // A hold set between the read and the firing: the store fires nothing and the timer stays scheduled with its own due date (Q9).
    const onHold = !result.fired && "reason" in result && result.reason === "case_on_hold";
    outcomes.push({
      timerId, caseId: event.caseId, fired: result.fired,
      revalidation: result.fired
        ? await revalidateJ2Timer({ timerId, caseId: event.caseId, currentPolicyRevision: input.currentPolicyRevision, now: input.now, ports: input.ports })
        : onHold ? { status: "deferred", reasons: ["organizational_hold"], notBefore: null } : { status: "not_fired" },
    });
  }
  return { outcomes, paused: pauses.length > 0 };
}

/**
 * Recovery for a crash between the firing and the planning: a FIRED timer with no reminder effect is revalidated again, never refired.
 * `firedSince` is required (no silent "everything"): the caller bounds the look-back. Idempotent: the effect ledger answers `planned`
 * or `confirmed` once the reminder exists, and a dispatched, uncertain or failed one is verify-only.
 */
export async function recoverFiredJ2Timers(input: Readonly<{ now: Date; firedSince: Date; limit: number; currentPolicyRevision: string | null; ports: J2Ports }>): Promise<J2PassOutcome[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new RangeError("limit must be an integer from 1 to 500");
  const rows = await requireDb().select({ id: savCaseTimers.id, caseId: savCaseTimers.caseId }).from(savCaseTimers)
    .where(and(eq(savCaseTimers.state, "fired"), gte(savCaseTimers.firedAt, input.firedSince))).orderBy(asc(savCaseTimers.firedAt), sql`${savCaseTimers.key} collate "C"`).limit(input.limit);
  const outcomes: J2PassOutcome[] = [];
  for (const row of rows) {
    outcomes.push({ timerId: row.id, caseId: row.caseId, fired: true,
      revalidation: await revalidateJ2Timer({ timerId: row.id, caseId: row.caseId, currentPolicyRevision: input.currentPolicyRevision, now: input.now, ports: input.ports }) });
  }
  return outcomes;
}
