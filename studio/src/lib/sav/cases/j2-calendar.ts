// Pure J2 calendar (SAV V2). No clock, no I/O, no table: the timer store and the case_event emission are a later sub-lot.
// Rule: due = sentAt + 24 real hours, moved forward to the first Monday-Friday 09:00 (included) - 18:00 (excluded) slot in Europe/Paris.
// No public holidays: only Saturday and Sunday are closed (decision Ugo, 2026-10-27).
// Replies to inbound mail are not limited by this slot and must not use this module.

export const J2_TIME_ZONE = "Europe/Paris";
export const J2_MIN_DELAY_MS = 24 * 60 * 60 * 1000;
export const J2_SLOT_OPENS_HOUR = 9;
export const J2_SLOT_CLOSES_HOUR = 18;

// Plausible send times only: keeps Intl years four-digit and the arithmetic far from Date limits.
const MIN_SENT_AT_MS = Date.UTC(1970, 0, 1);
const MAX_SENT_AT_MS = Date.UTC(3000, 0, 1);

type CivilDay = { year: number; month: number; day: number };
type ParisClock = CivilDay & { hour: number };

let parisFormat: Intl.DateTimeFormat | undefined;

function parisClock(atMs: number): ParisClock {
  parisFormat ??= new Intl.DateTimeFormat("en-GB", {
    timeZone: J2_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric",
  });
  const parts: Record<string, number> = {};
  for (const part of parisFormat.formatToParts(atMs)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour };
}

function civilKey({ year, month, day }: CivilDay) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextCivilDay({ year, month, day }: CivilDay): CivilDay {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function isBusinessDay(day: CivilDay) {
  const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

// Paris is UTC+1 or UTC+2 and the 01:00 UTC switches never touch 09:00 local, so exactly one of the two candidates reads 09:00 that day.
function slotOpening(day: CivilDay): number {
  const wall = Date.UTC(day.year, day.month - 1, day.day, J2_SLOT_OPENS_HOUR);
  for (const offsetHours of [1, 2]) {
    const candidate = wall - offsetHours * 60 * 60 * 1000;
    const clock = parisClock(candidate);
    if (civilKey(clock) === civilKey(day) && clock.hour === J2_SLOT_OPENS_HOUR) return candidate;
  }
  throw new RangeError(`No ${J2_SLOT_OPENS_HOUR}:00 ${J2_TIME_ZONE} instant on ${civilKey(day)}`);
}

function requirePlausibleInstant(at: Date, name: string): number {
  if (Object.prototype.toString.call(at) !== "[object Date]") throw new TypeError(`${name} must be a Date`);
  const atMs = at.getTime();
  if (!Number.isFinite(atMs)) throw new RangeError(`${name} is an invalid Date`);
  if (atMs < MIN_SENT_AT_MS || atMs >= MAX_SENT_AT_MS) throw new RangeError(`${name} is outside 1970-3000`);
  return atMs;
}

/** True when `at` falls in a Monday-Friday 09:00 (included) - 18:00 (excluded) Europe/Paris slot. */
export function isWithinJ2Slot(at: Date): boolean {
  const clock = parisClock(requirePlausibleInstant(at, "at"));
  return isBusinessDay(clock) && clock.hour >= J2_SLOT_OPENS_HOUR && clock.hour < J2_SLOT_CLOSES_HOUR;
}

/**
 * The instant itself when it is already inside a slot, else the next slot opening. It adds no delay: it is what a suspended
 * follow-up uses after a pause ends. A question's first due date is nextJ2Slot, which adds the 24 hours first.
 */
export function firstJ2SlotAtOrAfter(at: Date): Date {
  const atMs = requirePlausibleInstant(at, "at");
  const clock = parisClock(atMs);
  let day: CivilDay = clock;
  if (isBusinessDay(day)) {
    if (clock.hour >= J2_SLOT_OPENS_HOUR && clock.hour < J2_SLOT_CLOSES_HOUR) return new Date(atMs);
    if (clock.hour < J2_SLOT_OPENS_HOUR) return new Date(slotOpening(day));
  }
  // Any week has five weekdays, so a business day is at most 7 civil days away.
  for (let step = 0; step < 7; step += 1) {
    day = nextCivilDay(day);
    if (isBusinessDay(day)) return new Date(slotOpening(day));
  }
  throw new RangeError("No J2 business day found");
}

/** First J2 due instant for a question sent at `sentAt` (UTC instant in, UTC instant out): sentAt + 24 real hours, then the first slot. */
export function nextJ2Slot(sentAt: Date): Date {
  const sentMs = requirePlausibleInstant(sentAt, "sentAt");
  return firstJ2SlotAtOrAfter(new Date(sentMs + J2_MIN_DELAY_MS));
}
