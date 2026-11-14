import type { IntakeHistory } from "./engine-types";

/** SAV-92 fix 1: bound on the ticket histories shown to a ticket-matching model call.
 * Before, every candidate ticket (up to 20) was sent with its whole history (up to 100
 * events of up to 100 000 characters), only stopped by the 640 KB data cap: a real dossier
 * with 7 histories reserved 0.41 USD for one call, against 0.057 for the understanding call.
 * The bound keeps the most recent events, where the current state of a ticket lives:
 * - eventsPerTicket: the 20 most recent events of an ordinary candidate;
 * - priorityEventsPerTicket / priorityChars: a ticket already tied to the dossier (the ticket
 *   of the Gmail thread, or the one a person chose) keeps up to 40 events and 48 000 characters,
 *   served first, so it is never cut away by other candidates;
 * - eventChars: one note or email is shown up to 4 000 characters (its beginning, where a reply's
 *   own words are; the quoted tail repeats earlier events);
 * - totalChars: 96 000 characters of history for the whole call, all tickets together (about
 *   25-30 k provider tokens; under 0.08 USD reserved at the current price, a few cents billed).
 * Every ticket keeps at least its newest event. Nothing is silent: a cut ticket carries the
 * exact counts of omitted and shortened events, so the model knows the history is partial.
 * Deterministic for a given input, so a retried request keeps the same body and ledger hash. */
export const SAV_INTAKE_HISTORY_BUDGET = Object.freeze({ eventsPerTicket: 20, priorityEventsPerTicket: 40, eventChars: 4_000, totalChars: 96_000, priorityChars: 48_000 });
/** Rough per-event header cost of `[id at kind] ` in the rendered text. */
const EVENT_OVERHEAD = 64;
/** The newest event is always shown, at least this much of it. */
const MIN_EVENT_CHARS = 500;

export type IntakeHistoryOmission = { events: number; shortenedEvents: number; suppliedEvents: number; totalEvents: number };
export type BoundedIntakeTicketRow<T> = T & { historyOmitted?: IntakeHistoryOmission };

function boundOne(history: IntakeHistory, maxEvents: number, budget: number) {
  const kept: IntakeHistory = [];
  let left = budget, shortened = 0;
  // History is chronological: walk from the newest event back.
  for (let i = history.length - 1; i >= 0 && kept.length < maxEvents; i--) {
    const event = history[i];
    let text = event.text.length > SAV_INTAKE_HISTORY_BUDGET.eventChars ? event.text.slice(0, SAV_INTAKE_HISTORY_BUDGET.eventChars) : event.text;
    if (text.length + EVENT_OVERHEAD > left) {
      if (kept.length) break;
      text = text.slice(0, Math.max(MIN_EVENT_CHARS, left - EVENT_OVERHEAD));
    }
    if (text.length < event.text.length) shortened++;
    kept.unshift(text === event.text ? event : { ...event, text });
    left -= text.length + EVENT_OVERHEAD;
  }
  return { kept, used: budget - left, shortened };
}

export function boundIntakeTicketHistories<T extends { ticket: { id: string }; history: IntakeHistory }>(rows: readonly T[],
  priorityTicketIds: readonly (string | null | undefined)[] = []): BoundedIntakeTicketRow<T>[] {
  const B = SAV_INTAKE_HISTORY_BUDGET;
  const priority = new Set(priorityTicketIds.filter((id): id is string => typeof id === "string" && rows.some(r => r.ticket.id === id)));
  const out = new Map<string, BoundedIntakeTicketRow<T>>();
  let remaining = B.totalChars;
  const place = (row: T, maxEvents: number, budget: number) => {
    const { kept, used, shortened } = boundOne(row.history, maxEvents, Math.max(0, budget));
    remaining -= used;
    const omitted = row.history.length - kept.length;
    out.set(row.ticket.id, omitted || shortened
      ? { ...row, history: kept, historyOmitted: { events: omitted, shortenedEvents: shortened, suppliedEvents: kept.length, totalEvents: row.history.length } }
      : row);
  };
  const first = rows.filter(r => priority.has(r.ticket.id)), others = rows.filter(r => !priority.has(r.ticket.id));
  first.forEach((row, index) => place(row, B.priorityEventsPerTicket, Math.min(B.priorityChars, Math.floor(remaining / (first.length - index)))));
  // An equal share of what is left; a ticket that needs less leaves its share to the next ones.
  others.forEach((row, index) => place(row, B.eventsPerTicket, Math.floor(remaining / (others.length - index))));
  return rows.map(r => out.get(r.ticket.id)!);
}

/** Text shown beside a cut history; absent when the history is complete, so such requests are unchanged. */
export function intakeHistoryNotice(omission: IntakeHistoryOmission) {
  return `Only the ${omission.suppliedEvents} most recent of ${omission.totalEvents} history events are supplied (${omission.events} older omitted, ${omission.shortenedEvents} long events shortened to their beginning) to bound the request size. An omitted event is unknown, not absent: never conclude from it.`;
}
