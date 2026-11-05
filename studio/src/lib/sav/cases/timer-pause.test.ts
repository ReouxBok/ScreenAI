import { describe, expect, it } from "vitest";
import { firstJ2SlotAtOrAfter, isWithinJ2Slot, nextJ2Slot } from "./j2-calendar";
import {
  applyJ2Signal, collectDueJ2Events, describeJ2Timer, j2ResumeAt, revalidateFiredJ2, scheduleJ2Timer,
  type J2CaseEventView, type J2CaseView, type J2PauseWindow, type J2ReminderEffect, type J2Timer,
} from "./timer-lifecycle";

// SAV-8 contract of 2026-10-27: a technical pause suspends J2 and keeps question, timer and original due date.
// All instants below are written in UTC; the Paris reading is in the comment. Oct 25 2026 02:00 CEST -> CET; Mar 29 2026 02:00 CET -> CEST.
const CASE = "case-1";
const EFFECT = "effect-q1";
const iso = (value: string) => new Date(value);

// Wednesday 28 Oct 2026 09:00 Paris (CET) is the J2 of a question sent Monday 23:00 Paris.
const SENT = iso("2026-10-26T22:00:00.000Z");
const DUE = "2026-10-28T08:00:00.000Z";
const PAUSE_START = "2026-10-28T07:55:00.000Z"; // 08:55 Paris
const PAUSE_END = "2026-10-28T09:00:00.000Z"; // 10:00 Paris

const timer = (id: string, sentAt: Date, effect = id): J2Timer => {
  const result = scheduleJ2Timer({
    timerId: id, caseId: CASE, questionEffectId: effect, caseVersion: 3, send: { status: "confirmed", sentAt },
    lastCustomerInboundAt: null, existing: [], now: sentAt,
  });
  if (!result.scheduled) throw new Error("not scheduled");
  return result.scheduled;
};
const main = () => timer("t1", SENT, EFFECT);
const pause = (from: string, to: string | null, cause = "technical"): J2PauseWindow => ({ from, to, cause });
const collect = (timers: readonly J2Timer[], now: string, pauses: readonly J2PauseWindow[], maxEvents = 50) =>
  collectDueJ2Events(timers, iso(now), { pauses, maxEvents });

describe("calendar: first slot at or after an instant (no extra 24 h)", () => {
  it.each([
    ["inside the slot: unchanged", "2026-10-28T09:00:00.000Z", "2026-10-28T09:00:00.000Z"], // Wed 10:00 Paris
    ["09:00 Paris is included", "2026-10-28T08:00:00.000Z", "2026-10-28T08:00:00.000Z"],
    ["17:59:59.999 Paris is still inside", "2026-10-28T16:59:59.999Z", "2026-10-28T16:59:59.999Z"],
    ["18:00 Paris is excluded -> next day 09:00", "2026-10-28T17:00:00.000Z", "2026-10-29T08:00:00.000Z"],
    ["Wednesday 23:00 -> Thursday 09:00, not Friday", "2026-10-28T22:00:00.000Z", "2026-10-29T08:00:00.000Z"],
    ["Wednesday 08:55 -> same day 09:00", "2026-10-28T07:55:00.000Z", "2026-10-28T08:00:00.000Z"],
    ["Friday 18:00 -> Monday 09:00", "2026-10-23T16:00:00.000Z", "2026-10-26T08:00:00.000Z"], // Fri CEST 18:00 -> Mon CET 09:00 (DST switched)
    ["Saturday noon -> Monday 09:00", "2026-10-24T10:00:00.000Z", "2026-10-26T08:00:00.000Z"],
    ["Sunday -> Monday 09:00", "2026-11-01T12:00:00.000Z", "2026-11-02T08:00:00.000Z"],
    ["spring change over the weekend: Fri 18:30 CET -> Mon 09:00 CEST", "2026-03-27T17:30:00.000Z", "2026-03-30T07:00:00.000Z"],
  ])("%s", (_label, at, expected) => {
    expect(firstJ2SlotAtOrAfter(iso(at)).toISOString()).toBe(expected);
  });
  it("is the building block of nextJ2Slot: sentAt + 24 h, then the first slot", () => {
    for (const sent of ["2026-10-26T22:00:00Z", "2026-10-23T15:00:00Z", "2026-03-26T16:00:00Z", "2026-10-27T05:00:00Z"]) {
      expect(nextJ2Slot(iso(sent)).toISOString()).toBe(firstJ2SlotAtOrAfter(new Date(Date.parse(sent) + 24 * 3600 * 1000)).toISOString());
    }
  });
  it("rejects invalid or implausible instants", () => {
    expect(() => firstJ2SlotAtOrAfter(new Date("nope"))).toThrow(RangeError);
    expect(() => firstJ2SlotAtOrAfter("2026-10-28T09:00:00Z" as unknown as Date)).toThrow(TypeError);
    expect(() => firstJ2SlotAtOrAfter(new Date("1969-12-31T00:00:00Z"))).toThrow(RangeError);
  });
  it("isWithinJ2Slot: 09:00 included, 18:00 excluded, weekends closed, DST read in Paris", () => {
    expect(isWithinJ2Slot(iso("2026-10-28T07:59:59.999Z"))).toBe(false);
    expect(isWithinJ2Slot(iso("2026-10-28T08:00:00.000Z"))).toBe(true);
    expect(isWithinJ2Slot(iso("2026-10-28T16:59:59.999Z"))).toBe(true);
    expect(isWithinJ2Slot(iso("2026-10-28T17:00:00.000Z"))).toBe(false);
    expect(isWithinJ2Slot(iso("2026-10-24T10:00:00.000Z"))).toBe(false);
    expect(isWithinJ2Slot(iso("2026-10-25T10:00:00.000Z"))).toBe(false);
    expect(isWithinJ2Slot(iso("2026-10-23T07:00:00.000Z"))).toBe(true); // Fri 09:00 CEST
    expect(isWithinJ2Slot(iso("2026-10-23T06:59:59.999Z"))).toBe(false);
    expect(() => isWithinJ2Slot(new Date("nope"))).toThrow(RangeError);
  });
});

describe("resume instant after pauses", () => {
  const free = (dueAt: string, pauses: J2PauseWindow[]) => {
    const result = j2ResumeAt(dueAt, pauses);
    if (result.status !== "free") throw new Error(`blocked: ${result.cause}`);
    return result.at.toISOString();
  };
  it("no pause, or a pause that ended before the due date: the original due date stays", () => {
    expect(free(DUE, [])).toBe(DUE);
    expect(free(DUE, [pause("2026-10-28T06:00:00Z", "2026-10-28T07:59:59.999Z")])).toBe(DUE);
    expect(free(DUE, [pause("2026-10-28T09:00:00Z", "2026-10-28T10:00:00Z")])).toBe(DUE); // pause entirely after the due date
  });
  it("brief example: pause 08:55-10:00 with J2 at 09:00 -> exactly 10:00 (no new 24 h)", () => {
    expect(free(DUE, [pause(PAUSE_START, PAUSE_END)])).toBe(PAUSE_END);
  });
  it("the pause end is exclusive: a J2 at the very resume instant is not delayed", () => {
    expect(free(DUE, [pause("2026-10-28T06:00:00Z", DUE)])).toBe(DUE);
  });
  it("resume at 23:00 -> next day 09:00; resume Friday evening or on a weekend -> Monday 09:00", () => {
    expect(free(DUE, [pause(PAUSE_START, "2026-10-28T22:00:00Z")])).toBe("2026-10-29T08:00:00.000Z");
    expect(free("2026-10-23T15:00:00.000Z", [pause("2026-10-23T14:00:00Z", "2026-10-23T17:30:00Z")])).toBe("2026-10-26T08:00:00.000Z");
    expect(free("2026-10-23T15:00:00.000Z", [pause("2026-10-23T14:00:00Z", "2026-10-24T10:00:00Z")])).toBe("2026-10-26T08:00:00.000Z");
    expect(free("2026-10-23T15:00:00.000Z", [pause("2026-10-23T14:00:00Z", "2026-10-25T20:00:00Z")])).toBe("2026-10-26T08:00:00.000Z");
  });
  it("daylight saving: resume over the spring change is read in Paris (Mon 09:00 CEST = 07:00Z), the autumn one likewise", () => {
    expect(free("2026-03-27T16:00:00.000Z", [pause("2026-03-27T15:00:00Z", "2026-03-29T08:00:00Z")])).toBe("2026-03-30T07:00:00.000Z");
    expect(free("2026-10-23T15:00:00.000Z", [pause("2026-10-23T14:00:00Z", "2026-10-25T23:30:00Z")])).toBe("2026-10-26T08:00:00.000Z");
  });
  it("nested and overlapping pauses resume at the last end; chained pauses chain", () => {
    expect(free(DUE, [pause("2026-10-28T06:00:00Z", "2026-10-28T11:00:00Z"), pause("2026-10-28T07:30:00Z", "2026-10-28T09:00:00Z")])).toBe("2026-10-28T11:00:00.000Z");
    expect(free(DUE, [pause(PAUSE_START, "2026-10-28T08:20:00Z"), pause("2026-10-28T08:20:00Z", PAUSE_END)])).toBe(PAUSE_END);
    expect(free(DUE, [pause("2026-10-28T08:30:00Z", PAUSE_END), pause(PAUSE_START, "2026-10-28T08:40:00Z")])).toBe(PAUSE_END);
  });
  it("the same pause resumed several times: only the pause that covers the due date matters, later ones are not applied to it", () => {
    expect(free(DUE, [pause(PAUSE_START, "2026-10-28T08:20:00Z"), pause("2026-10-28T08:30:00Z", PAUSE_END)])).toBe("2026-10-28T08:20:00.000Z");
  });
  it("says which cause delayed the reminder; an unknown cause wins over a technical one", () => {
    const delayedBy = (pauses: J2PauseWindow[]) => (j2ResumeAt(DUE, pauses) as { delayedBy: unknown }).delayedBy;
    expect(delayedBy([])).toBeNull();
    expect(delayedBy([pause(PAUSE_START, PAUSE_END)])).toBe("technical");
    expect(delayedBy([pause(PAUSE_START, PAUSE_END, "???")])).toBe("unknown");
    expect(delayedBy([pause(PAUSE_START, "2026-10-28T08:20:00Z", "???"), pause("2026-10-28T08:20:00Z", PAUSE_END)])).toBe("unknown");
    expect(delayedBy([pause(PAUSE_START, "2026-10-28T08:20:00Z"), pause("2026-10-28T08:20:00Z", PAUSE_END, "???")])).toBe("unknown");
  });
  it("an open pause blocks and names its cause; an unknown or malformed cause blocks as unknown", () => {
    expect(j2ResumeAt(DUE, [pause(PAUSE_START, null)])).toEqual({ status: "blocked", cause: "technical" });
    expect(j2ResumeAt(DUE, [pause(PAUSE_START, null, "unknown")])).toEqual({ status: "blocked", cause: "unknown" });
    expect(j2ResumeAt(DUE, [pause(PAUSE_START, null, "deployment-window-42")])).toEqual({ status: "blocked", cause: "unknown" });
    expect(j2ResumeAt(DUE, [pause(PAUSE_START, "2026-10-28T09:00:00Z", "mystery"), pause("2026-10-28T09:00:00Z", null)])).toEqual({ status: "blocked", cause: "technical" });
  });
  it("a window that cannot be read blocks (fail closed) instead of being ignored or throwing away the work", () => {
    for (const bad of [pause("garbage", "2026-10-28T09:00:00Z"), pause(PAUSE_START, "garbage"), pause(PAUSE_END, PAUSE_START)]) {
      expect(j2ResumeAt(DUE, [bad])).toEqual({ status: "blocked", cause: "unknown" });
    }
  });
});

describe("collection under pause", () => {
  it("brief example: J2 at 09:00, pause 08:55-10:00 -> nothing before 10:00, then exactly one event, dueAt untouched", () => {
    const timers = [main()];
    const pauses = [pause(PAUSE_START, PAUSE_END)];
    for (const now of ["2026-10-28T07:54:59Z", "2026-10-28T07:55:00Z", "2026-10-28T08:00:00Z", "2026-10-28T08:59:59.999Z"]) {
      const quiet = collect(timers, now, pauses); // 07:54:59Z is before both the pause and the due date
      expect(quiet.emitted).toEqual([]);
      expect(quiet.timers).toBe(timers);
    }
    const resumed = collect(timers, PAUSE_END, pauses);
    expect(resumed.emitted).toHaveLength(1);
    expect(resumed.timers[0]).toMatchObject({ state: "fired", firedAt: PAUSE_END, dueAt: DUE, sentAt: SENT.toISOString(), id: "t1" });
    expect(collect(resumed.timers, "2026-10-28T10:00:00Z", pauses).emitted).toEqual([]); // once
  });
  it("a pause that ends before the due date changes nothing", () => {
    const result = collect([main()], DUE, [pause("2026-10-28T05:00:00Z", "2026-10-28T06:00:00Z")]);
    expect(result.emitted).toHaveLength(1);
    expect(result.timers[0].firedAt).toBe(DUE);
  });
  it("an open pause never fires and never cancels, however long it lasts; the timer is intact when it ends", () => {
    const timers = [main()];
    const open = [pause("2026-10-27T12:00:00Z", null)];
    for (const now of [DUE, "2026-10-30T09:00:00Z", "2027-02-01T09:00:00Z"]) {
      const result = collect(timers, now, open);
      expect(result.emitted).toEqual([]);
      expect(result.timers).toBe(timers);
    }
    expect(timers[0]).toMatchObject({ state: "scheduled", dueAt: DUE, cancelReason: null, cancelledAt: null });
    expect(collect(timers, "2027-02-02T10:00:00Z", [pause("2026-10-27T12:00:00Z", "2027-02-02T09:30:00Z")]).emitted).toHaveLength(1);
  });
  it("a pause of unknown cause blocks the same way and destroys nothing", () => {
    const timers = [main()];
    const result = collect(timers, "2026-10-29T09:00:00Z", [pause("2026-10-27T12:00:00Z", null, "???")]);
    expect(result.emitted).toEqual([]);
    expect(result.timers).toBe(timers);
  });
  it("a pause that started after the due date but before the collector ran still blocks the firing", () => {
    const timers = [main()];
    expect(collect(timers, "2026-10-28T08:30:00Z", [pause("2026-10-28T08:10:00Z", null)]).emitted).toEqual([]);
    expect(collect(timers, "2026-10-28T08:30:00Z", [pause("2026-10-28T08:10:00Z", "2026-10-28T08:40:00Z")]).emitted).toEqual([]);
  });
  it("resume at 23:00: nothing fires at 23:05, the reminder fires at the next 09:00 (Paris)", () => {
    const pauses = [pause(PAUSE_START, "2026-10-28T22:00:00Z")];
    expect(collect([main()], "2026-10-28T22:05:00Z", pauses).emitted).toEqual([]);
    expect(collect([main()], "2026-10-29T07:59:59.999Z", pauses).emitted).toEqual([]);
    const result = collect([main()], "2026-10-29T08:00:00Z", pauses);
    expect(result.emitted).toHaveLength(1);
    expect(result.timers[0]).toMatchObject({ dueAt: DUE, firedAt: "2026-10-29T08:00:00.000Z" });
  });
  it("weekend: due Friday 17:00, pause Friday 16:00 -> Saturday noon, fires Monday 09:00 and not before", () => {
    const friday = timer("t-fri", iso("2026-10-22T15:00:00Z")); // sent Thu 17:00 CEST -> due Fri 23 Oct 17:00 CEST
    expect(friday.dueAt).toBe("2026-10-23T15:00:00.000Z");
    const pauses = [pause("2026-10-23T14:00:00Z", "2026-10-24T10:00:00Z")];
    for (const now of ["2026-10-24T10:00:00Z", "2026-10-25T09:00:00Z", "2026-10-26T07:59:59.999Z"]) expect(collect([friday], now, pauses).emitted).toEqual([]);
    expect(collect([friday], "2026-10-26T08:00:00Z", pauses).emitted).toHaveLength(1);
  });
  it("daylight saving: due Friday 17:00 CET before the March change, resume Sunday -> Monday 09:00 CEST (07:00Z), not 08:00Z", () => {
    const friday = timer("t-dst", iso("2026-03-26T16:00:00Z"));
    expect(friday.dueAt).toBe("2026-03-27T16:00:00.000Z");
    const pauses = [pause("2026-03-27T15:00:00Z", "2026-03-29T08:00:00Z")];
    expect(collect([friday], "2026-03-30T06:59:59.999Z", pauses).emitted).toEqual([]);
    expect(collect([friday], "2026-03-30T07:00:00Z", pauses).emitted).toHaveLength(1);
  });
  it("nested pauses: the reminder waits for the last resume", () => {
    const pauses = [pause("2026-10-28T06:00:00Z", "2026-10-28T11:00:00Z"), pause("2026-10-28T07:30:00Z", PAUSE_END)];
    expect(collect([main()], "2026-10-28T10:59:59.999Z", pauses).emitted).toEqual([]);
    expect(collect([main()], "2026-10-28T11:00:00Z", pauses).emitted).toHaveLength(1);
  });
  it("the same pause resumed twice: the reminder is released at the first resume, then no second reminder exists", () => {
    const pauses = [pause(PAUSE_START, "2026-10-28T08:20:00Z"), pause("2026-10-28T08:30:00Z", PAUSE_END)];
    const first = collect([main()], "2026-10-28T08:20:00Z", pauses);
    expect(first.emitted).toHaveLength(1);
    expect(collect(first.timers, "2026-10-28T09:30:00Z", pauses).emitted).toEqual([]);
  });
  it("an accumulated queue is released at a bounded rate: oldest first, one reminder per question, the rest stay scheduled with their own dates", () => {
    const sentBase = Date.parse("2026-10-26T22:00:00Z");
    const timers = [0, 1, 2, 3, 4].map((index) => timer(`q${index}`, new Date(sentBase + index * 60_000), `effect-${index}`));
    const pauses = [pause("2026-10-28T07:00:00Z", "2026-10-28T09:00:00Z")];
    // every timer is due at 08:00Z, inside the pause: all wait for 09:00Z
    expect(timers.map((entry) => entry.dueAt)).toEqual(Array(5).fill(DUE)); // same slot: 09:00 Paris
    const first = collect(timers, "2026-10-28T09:00:00Z", pauses, 2);
    expect(first.emitted.map((event) => event.dedupeKey)).toEqual(["timer:q0", "timer:q1"]);
    expect(first.timers.map((entry) => entry.state)).toEqual(["fired", "fired", "scheduled", "scheduled", "scheduled"]);
    expect(first.timers.every((entry) => entry.dueAt === DUE)).toBe(true);
    const second = collect(first.timers, "2026-10-28T09:01:00Z", pauses, 2);
    expect(second.emitted.map((event) => event.dedupeKey)).toEqual(["timer:q2", "timer:q3"]);
    const third = collect(second.timers, "2026-10-28T09:02:00Z", pauses, 2);
    expect(third.emitted.map((event) => event.dedupeKey)).toEqual(["timer:q4"]);
    expect(collect(third.timers, "2026-10-28T09:03:00Z", pauses, 2).emitted).toEqual([]);
  });
  it("nothing fires outside a business slot even without any pause: a timer found late at night waits for 09:00", () => {
    const timers = [main()];
    for (const now of ["2026-10-28T17:00:00Z", "2026-10-28T22:00:00Z", "2026-10-29T07:59:59.999Z", "2026-10-31T17:00:00Z", "2026-11-01T10:00:00Z"]) {
      expect(collect(timers, now, []).emitted).toEqual([]); // 18:00 and 23:00 Paris, Thu 08:59, Fri 18:00, Sunday
    }
    expect(collect(timers, "2026-10-29T08:00:00Z", []).emitted).toHaveLength(1);
  });
  it("firing is exactly 'not paused now, inside a slot, due reached': the same answer as the resume instant, on a grid of pauses and clocks", () => {
    const windowSets: J2PauseWindow[][] = [
      [], [pause(PAUSE_START, PAUSE_END)], [pause(PAUSE_START, "2026-10-28T22:00:00Z")], [pause(PAUSE_START, null)], [pause("garbage", "x")],
      [pause("2026-10-28T06:00:00Z", "2026-10-28T11:00:00Z"), pause("2026-10-28T07:30:00Z", PAUSE_END)],
      [pause(PAUSE_START, "2026-10-28T08:20:00Z"), pause("2026-10-28T08:30:00Z", PAUSE_END)],
      [pause("2026-10-28T16:00:00Z", "2026-10-31T10:00:00Z")], [pause("2026-10-28T08:10:00Z", "2026-10-28T08:40:00Z", "???")],
    ];
    const clocks = [];
    for (let minutes = 0; minutes <= 6 * 24 * 60; minutes += 37) clocks.push(new Date(Date.parse("2026-10-27T20:00:00Z") + minutes * 60_000));
    for (const pauses of windowSets) for (const now of clocks) {
      const fires = collect([main()], now.toISOString(), pauses).emitted.length === 1;
      const resume = j2ResumeAt(DUE, pauses);
      expect(fires).toBe(resume.status === "free" && resume.at.getTime() <= now.getTime() && isWithinJ2Slot(now) && now.getTime() >= Date.parse(DUE)
        && !pauses.some((window) => Date.parse(window.from) <= now.getTime() && (window.to === null || now.getTime() < Date.parse(window.to)) || Number.isNaN(Date.parse(window.from))));
    }
  });
  it("without a pause list or a bound the call is refused instead of guessing", () => {
    expect(() => (collectDueJ2Events as unknown as (...args: unknown[]) => unknown)([main()], iso(DUE))).toThrow(TypeError);
    expect(() => (collectDueJ2Events as unknown as (...args: unknown[]) => unknown)([main()], iso(DUE), { maxEvents: 5 })).toThrow(TypeError);
    for (const maxEvents of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => collect([main()], DUE, [], maxEvents)).toThrow(RangeError);
    }
  });
  it("a pause is not a cancellation signal any more: an old caller sending it fails loudly instead of silently cancelling", () => {
    const timers = [main()];
    expect(() => applyJ2Signal(timers, { kind: "pause", caseId: CASE } as never, iso(DUE))).toThrow(TypeError);
    expect(() => applyJ2Signal(timers, { kind: "deploy", caseId: CASE } as never, iso(DUE))).toThrow(TypeError);
    expect(timers[0].state).toBe("scheduled");
  });
});

describe("what still cancels the old J2, with or without a pause", () => {
  const pauses = [pause(PAUSE_START, PAUSE_END)];
  it.each([
    [{ kind: "customer_inbound", caseId: CASE }, "customer_inbound"],
    [{ kind: "human_outbound", caseId: CASE }, "human_outbound"],
    [{ kind: "owner_changed", caseId: CASE }, "owner_changed"],
    [{ kind: "new_question", caseId: CASE, questionEffectId: "effect-q2" }, "new_question"],
  ] as const)("%j during the pause cancels the timer; the end of the pause never brings it back", (signal, reason) => {
    const cancelled = applyJ2Signal([main()], signal, iso("2026-10-28T08:10:00Z"));
    expect(cancelled.cancelled).toEqual([{ timerId: "t1", key: main().key, reason }]);
    expect(collect(cancelled.timers, PAUSE_END, pauses).emitted).toEqual([]);
    expect(collect(cancelled.timers, "2026-10-30T09:00:00Z", []).emitted).toEqual([]);
    const handedBack = applyJ2Signal(cancelled.timers, { kind: "owner_changed", caseId: CASE }, iso("2026-10-28T09:30:00Z"));
    expect(handedBack.timers[0].state).toBe("cancelled");
    expect(scheduleJ2Timer({
      timerId: "t-again", caseId: CASE, questionEffectId: EFFECT, caseVersion: 4, send: { status: "confirmed", sentAt: SENT },
      lastCustomerInboundAt: null, existing: handedBack.timers, now: iso(PAUSE_END),
    }).skipped).toBe("already_exists");
  });
  it("a new question asked while paused gets its own timer from its own send time; the old one is cancelled", () => {
    const result = scheduleJ2Timer({
      timerId: "t2", caseId: CASE, questionEffectId: "effect-q2", caseVersion: 5, send: { status: "confirmed", sentAt: iso("2026-10-28T08:30:00Z") },
      lastCustomerInboundAt: null, existing: [main()], now: iso("2026-10-28T08:30:00Z"),
    });
    expect(result.cancelled).toEqual([{ timerId: "t1", key: main().key, reason: "new_question" }]);
    expect(result.scheduled?.dueAt).toBe("2026-10-29T08:30:00.000Z"); // +24 h from the new question, inside the slot
  });
  it("a customer reply that arrived during the pause but is only processed after it still cancels (late processing costs a reminder, never an extra send)", () => {
    const afterPause = applyJ2Signal([main()], { kind: "customer_inbound", caseId: CASE }, iso("2026-10-28T09:30:00Z"));
    expect(afterPause.cancelled).toHaveLength(1);
  });
});

describe("revalidation under pause", () => {
  const view = (overrides: Partial<Omit<J2CaseView, "body">> & { body?: Partial<J2CaseView["body"]> } = {}): J2CaseView => {
    const { body, ...rest } = overrides;
    return {
      caseId: CASE, version: 12, owner: "agent", phase: "awaiting_customer", sensitivity: "none",
      body: { questions: [{ id: "q1", askedAt: SENT.toISOString(), askedInEffect: EFFECT }], waiting: { kind: "customer", timerId: "t1" }, ...body },
      ...rest,
    };
  };
  const fired = (): J2Timer => ({ ...main(), state: "fired", firedAt: DUE });
  type Parts = {
    timer?: J2Timer; view?: J2CaseView; events?: J2CaseEventView[]; activeHolds?: Array<"admission_withdrawn" | "admission_unavailable" | "budget_unavailable">;
    pauses?: J2PauseWindow[]; reminderEffect?: J2ReminderEffect; now?: string;
  };
  const revalidate = (parts: Parts = {}) => revalidateFiredJ2({
    timer: parts.timer ?? fired(), view: parts.view ?? view(), events: parts.events ?? [], activeHolds: parts.activeHolds ?? [],
    pauses: parts.pauses ?? [], reminderEffect: parts.reminderEffect ?? "none", now: iso(parts.now ?? "2026-10-28T09:00:00Z"),
  });

  it("passes after the pause when everything still holds, and still hands back only the case version", () => {
    const result = revalidate({ pauses: [pause(PAUSE_START, PAUSE_END)] });
    expect(result).toEqual({ status: "timer_conditions_met", caseVersion: 12 });
  });
  it("while a technical pause is active: deferred (not obsolete), the work is kept, the end is unknown for an open pause", () => {
    expect(revalidate({ pauses: [pause(PAUSE_START, null)], now: "2026-10-28T08:30:00Z" })).toEqual({
      status: "deferred", reasons: ["technical_pause"], notBefore: null,
    });
  });
  it("a pause of unknown cause is deferred under its own reason", () => {
    expect(revalidate({ pauses: [pause(PAUSE_START, null, "???")], now: "2026-10-28T08:30:00Z" })).toEqual({
      status: "deferred", reasons: ["pause_cause_unknown"], notBefore: null,
    });
    expect(revalidate({ pauses: [pause(PAUSE_START, null), pause(PAUSE_START, null, "???")], now: "2026-10-28T08:30:00Z" })).toMatchObject({
      status: "deferred", reasons: ["technical_pause", "pause_cause_unknown"],
    });
  });
  it("a pause that ends at a known time says when to look again (the first slot at or after the resume)", () => {
    expect(revalidate({ pauses: [pause(PAUSE_START, "2026-10-28T22:00:00Z")], now: "2026-10-28T08:30:00Z" })).toEqual({
      status: "deferred", reasons: ["technical_pause"], notBefore: "2026-10-29T08:00:00.000Z",
    });
  });
  it("after a late-evening resume it is still deferred until the next slot; never an off-hours send", () => {
    expect(revalidate({ pauses: [pause(PAUSE_START, "2026-10-28T22:00:00Z")], now: "2026-10-28T22:30:00Z" })).toEqual({
      status: "deferred", reasons: ["outside_business_slot"], notBefore: "2026-10-29T08:00:00.000Z",
    });
    expect(revalidate({ pauses: [pause(PAUSE_START, "2026-10-28T22:00:00Z")], now: "2026-10-29T08:00:00Z" }).status).toBe("timer_conditions_met");
  });
  it("before the original due date it is deferred as not_due with that date", () => {
    expect(revalidate({ now: "2026-10-28T07:59:59.999Z" })).toEqual({ status: "deferred", reasons: ["not_due"], notBefore: DUE });
  });
  it("business reasons beat a pause: a customer reply during the pause makes the old J2 obsolete, and the pause is not listed", () => {
    const result = revalidate({
      pauses: [pause(PAUSE_START, null)], now: "2026-10-28T08:30:00Z",
      events: [{ kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: "2026-10-28T08:10:00Z" }],
    });
    expect(result).toEqual({ status: "obsolete", reasons: ["inbound_after_question"] });
  });
  it.each([
    ["human reply during the pause", { kind: "outbound_observed", direction: "human_outbound", occurredAt: "2026-10-28T08:10:00Z" }, "human_outbound_since"],
    ["owner change during the pause", { kind: "owner_changed", direction: "internal", occurredAt: "2026-10-28T08:10:00Z" }, "owner_changed_since"],
  ] as const)("%s", (_label, event, reason) => {
    expect(revalidate({ events: [event], pauses: [pause(PAUSE_START, PAUSE_END)] })).toEqual({ status: "obsolete", reasons: [reason] });
  });
  it("a new message between the re-read and the effect: the second re-read refuses, and the first result's version is already stale", () => {
    const first = revalidate();
    expect(first).toEqual({ status: "timer_conditions_met", caseVersion: 12 });
    const second = revalidate({
      view: view({ version: 13 }),
      events: [{ kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: "2026-10-28T09:00:01Z" }],
    });
    expect(second).toEqual({ status: "obsolete", reasons: ["inbound_after_question"] });
  });
  it.each(["technical_wait", "deferred_budget", "reconciling", "blocked_technical", "blocked_reconcile", "needs_review"])(
    "case phase %s is a transient state: deferred, not a business cancellation", (phase) => {
      expect(revalidate({ view: view({ phase }) })).toEqual({ status: "deferred", reasons: ["case_phase_transient"], notBefore: null });
    });
  it.each(["queued", "acting", "resolved", "closed_no_reply", "handoff_pending", "human_owned", "mystery"])(
    "case phase %s makes the J2 obsolete", (phase) => {
      expect(revalidate({ view: view({ phase }) })).toMatchObject({ status: "obsolete", reasons: expect.arrayContaining(["phase_changed"]) });
    });
  it("admission: withdrawn is final, an unavailable check is only deferred", () => {
    expect(revalidate({ activeHolds: ["admission_withdrawn"] })).toEqual({ status: "obsolete", reasons: ["admission_withdrawn"] });
    expect(revalidate({ activeHolds: ["admission_unavailable"] })).toEqual({ status: "deferred", reasons: ["admission_unavailable"], notBefore: null });
    expect(revalidate({ activeHolds: ["budget_unavailable"] })).toEqual({ status: "deferred", reasons: ["budget_unavailable"], notBefore: null });
  });
  it("sensitive cases are excluded for good, pause or not", () => {
    expect(revalidate({ view: view({ owner: "human", phase: "human_owned", sensitivity: "finance" }), pauses: [pause(PAUSE_START, null)], now: "2026-10-28T08:30:00Z" }))
      .toEqual({ status: "obsolete", reasons: ["owner_not_agent", "phase_changed", "sensitive_case"] });
  });
  it("lists every deferral once, in a stable order", () => {
    const result = revalidate({
      pauses: [pause(PAUSE_START, null), pause(PAUSE_START, null)], now: "2026-10-28T07:56:00Z",
      activeHolds: ["budget_unavailable", "admission_unavailable"], view: view({ phase: "technical_wait" }),
    });
    expect(result).toEqual({
      status: "deferred", notBefore: null,
      reasons: ["not_due", "technical_pause", "case_phase_transient", "admission_unavailable", "budget_unavailable"],
    });
  });
  it("the result never carries a permission-like field", () => {
    for (const result of [revalidate(), revalidate({ now: "2026-10-28T07:59:00Z" }), revalidate({ reminderEffect: "uncertain" }), revalidate({ reminderEffect: "confirmed" })]) {
      expect(JSON.stringify(result)).not.toMatch(/allow|permit|eligible|admitted|send|authori/i);
    }
  });

  describe("the reminder effect itself (engaged or unknown -> verify only)", () => {
    it.each(["none", "planned"] as const)("%s: normal revalidation", (reminderEffect) => {
      expect(revalidate({ reminderEffect }).status).toBe("timer_conditions_met");
    });
    it.each(["dispatched", "uncertain", "failed"] as const)("%s: verification only, even if the case also looks obsolete or paused", (reminderEffect) => {
      expect(revalidate({ reminderEffect })).toEqual({ status: "verify_only", effect: reminderEffect, alsoObsolete: [] });
      const stale = revalidate({
        reminderEffect, pauses: [pause(PAUSE_START, null)], now: "2026-10-28T08:30:00Z",
        events: [{ kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: "2026-10-28T08:10:00Z" }],
      });
      expect(stale).toEqual({ status: "verify_only", effect: reminderEffect, alsoObsolete: ["inbound_after_question"] });
    });
    it("confirmed: the reminder was already sent, so nothing is sent again", () => {
      expect(revalidate({ reminderEffect: "confirmed" })).toEqual({ status: "obsolete", reasons: ["reminder_already_sent"] });
    });
    it("an unknown effect value is treated as uncertain, never as none", () => {
      expect(revalidate({ reminderEffect: "weird" as never })).toEqual({ status: "verify_only", effect: "uncertain", alsoObsolete: [] });
    });
  });
});

describe("what the follow-up looks like to an operator", () => {
  const at = (now: string, timers: J2Timer, pauses: J2PauseWindow[]) => describeJ2Timer({ timer: timers, pauses, now: iso(now) });
  it("following: scheduled, nothing in the way", () => {
    expect(at("2026-10-27T12:00:00Z", main(), [])).toEqual({ status: "following", reason: null, nextStep: "wait_for_due_date", resumesAt: DUE });
  });
  it("suspended technically is not cancelled: the cause and the next step are explicit", () => {
    expect(at("2026-10-28T08:30:00Z", main(), [pause(PAUSE_START, PAUSE_END)])).toEqual({
      status: "suspended_technically", reason: "technical", nextStep: "resume_at_next_slot", resumesAt: PAUSE_END,
    });
    expect(at("2026-10-28T08:30:00Z", main(), [pause(PAUSE_START, null)])).toEqual({
      status: "suspended_technically", reason: "technical", nextStep: "wait_for_pause_end", resumesAt: null,
    });
  });
  it("unknown cause: still a suspension, flagged for a human look", () => {
    expect(at("2026-10-28T08:30:00Z", main(), [pause(PAUSE_START, null, "???")])).toEqual({
      status: "suspended_technically", reason: "unknown", nextStep: "identify_pause_cause", resumesAt: null,
    });
  });
  it("a closed pause of unknown cause that delays the reminder is flagged as unknown, with its resume instant", () => {
    expect(at("2026-10-28T08:30:00Z", main(), [pause(PAUSE_START, PAUSE_END, "???")])).toEqual({
      status: "suspended_technically", reason: "unknown", nextStep: "resume_at_next_slot", resumesAt: PAUSE_END,
    });
  });
  it("a pause that does not touch the due date does not show as suspended", () => {
    expect(at("2026-10-27T12:00:00Z", main(), [pause("2026-10-27T10:00:00Z", "2026-10-27T11:00:00Z")]).status).toBe("following");
  });
  it("cancelled keeps its business reason and has no next step", () => {
    const cancelled = applyJ2Signal([main()], { kind: "customer_inbound", caseId: CASE }, iso("2026-10-27T12:00:00Z")).timers[0];
    expect(at("2026-10-28T08:30:00Z", cancelled, [pause(PAUSE_START, null)])).toEqual({
      status: "cancelled", reason: "customer_inbound", nextStep: "none", resumesAt: null,
    });
  });
  it("fired: the next step is the re-read before any effect", () => {
    expect(at("2026-10-28T09:00:00Z", { ...main(), state: "fired", firedAt: DUE }, [])).toEqual({
      status: "fired", reason: null, nextStep: "revalidate_before_effect", resumesAt: null,
    });
  });
});

describe("purity of the pause code", () => {
  it("never mutates its inputs", () => {
    const timers = Object.freeze([Object.freeze(main())]);
    const pauses = Object.freeze([Object.freeze(pause(PAUSE_START, PAUSE_END))]);
    expect(() => collectDueJ2Events(timers, iso(PAUSE_END), { pauses, maxEvents: 1 })).not.toThrow();
    expect(() => j2ResumeAt(DUE, pauses)).not.toThrow();
    expect(() => describeJ2Timer({ timer: timers[0], pauses, now: iso(PAUSE_END) })).not.toThrow();
    expect(timers[0].state).toBe("scheduled");
  });
});
