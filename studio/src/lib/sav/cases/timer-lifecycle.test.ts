import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyJ2Signal, collectDueJ2Events, j2TimerKey, revalidateFiredJ2, scheduleJ2Timer,
  type J2ActiveHold, type J2CaseEventView, type J2CaseView, type J2ScheduleInput, type J2Signal, type J2Timer,
} from "./timer-lifecycle";

// Monday 26 Oct 2026 23:00 Paris (CET) -> J2 Wednesday 28 Oct 09:00 Paris (the SAV-8 brief example).
const SENT = new Date("2026-10-26T22:00:00.000Z");
const DUE_ISO = "2026-10-28T08:00:00.000Z";
const NOW = new Date("2026-10-26T22:00:05.000Z");
const CASE = "case-1";
const EFFECT = "effect-q1";

// Same call as before the pause decision: no pause, a bound far above any test.
const collect = (timers: readonly J2Timer[], now: Date) => collectDueJ2Events(timers, now, { pauses: [], maxEvents: 50 });

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

function schedule(overrides: Partial<J2ScheduleInput> = {}) {
  return scheduleJ2Timer({
    timerId: "t1", caseId: CASE, questionEffectId: EFFECT, caseVersion: 7,
    send: { status: "confirmed", sentAt: SENT }, lastCustomerInboundAt: null, existing: [], now: NOW, ...overrides,
  });
}
const scheduledTimer = (overrides: Partial<J2ScheduleInput> = {}): J2Timer => {
  const result = schedule(overrides);
  if (!result.scheduled) throw new Error(`not scheduled: ${result.skipped}`);
  return result.scheduled;
};
const firedTimer = (): J2Timer => collect([scheduledTimer()], new Date(DUE_ISO)).timers[0];

function view(overrides: Partial<Omit<J2CaseView, "body">> & { body?: Partial<J2CaseView["body"]> } = {}): J2CaseView {
  const { body, ...rest } = overrides;
  return {
    caseId: CASE, version: 12, owner: "agent", phase: "awaiting_customer", sensitivity: "none",
    body: {
      questions: [{ id: "q1", askedAt: SENT.toISOString(), askedInEffect: EFFECT }],
      waiting: { kind: "customer", timerId: "t1" }, ...body,
    },
    ...rest,
  };
}
const AFTER_DUE = new Date("2026-10-28T08:00:01.000Z");
const revalidate = (parts: { timer?: J2Timer; view?: J2CaseView; events?: J2CaseEventView[]; activeHolds?: J2ActiveHold[]; now?: Date } = {}) =>
  revalidateFiredJ2({
    timer: parts.timer ?? firedTimer(), view: parts.view ?? view(), events: parts.events ?? [], activeHolds: parts.activeHolds ?? [],
    pauses: [], reminderEffect: "none", now: parts.now ?? AFTER_DUE,
  });
const reasonsOf = (result: ReturnType<typeof revalidate>) => (result.status === "obsolete" ? [...result.reasons] : []);

describe("timer key", () => {
  it("builds timer:j2:<caseId>:<questionEffectId>", () => {
    expect(j2TimerKey("case-1", "effect-q1")).toBe("timer:j2:case-1:effect-q1");
    expect(j2TimerKey("case-1", "effect:with:colons")).toBe("timer:j2:case-1:effect:with:colons");
  });
  it.each([["", "e"], ["c", ""], [" c", "e"], ["c", "e "], ["c:d", "e"], ["c\n", "e"]])("rejects caseId %j / effect %j", (caseId, effect) => {
    expect(() => j2TimerKey(caseId, effect)).toThrow(TypeError);
  });
  it("stays unambiguous: a colon is only allowed in the effect id, so (a, b:c) cannot collide with (a:b, c)", () => {
    expect(j2TimerKey("a", "b:c")).toBe("timer:j2:a:b:c");
    expect(() => j2TimerKey("a:b", "c")).toThrow(TypeError);
  });
});

describe("scheduling", () => {
  it("a confirmed question schedules one timer at the calendar slot (Monday 23:00 -> Wednesday 09:00)", () => {
    const result = schedule();
    expect(result.skipped).toBeNull();
    expect(result.cancelled).toEqual([]);
    expect(result.scheduled).toEqual({
      id: "t1", key: "timer:j2:case-1:effect-q1", caseId: CASE, questionEffectId: EFFECT,
      sentAt: SENT.toISOString(), dueAt: DUE_ISO, state: "scheduled", scheduledAtCaseVersion: 7,
      firedAt: null, cancelledAt: null, cancelReason: null,
    });
    expect(result.timers).toEqual([result.scheduled]);
  });
  it.each(["pending", "dispatched", "uncertain", "failed"] as const)("a %s send schedules nothing and changes nothing", (status) => {
    const existing = [scheduledTimer({ timerId: "old", questionEffectId: "effect-old" })];
    const result = schedule({ send: { status }, existing });
    expect(result.scheduled).toBeNull();
    expect(result.skipped).toBe("send_not_confirmed");
    expect(result.timers).toBe(existing);
    expect(result.cancelled).toEqual([]);
  });
  it("replaying the same question is a no-op, whatever the state of the first timer", () => {
    const first = scheduledTimer();
    for (const timer of [first, { ...first, state: "fired" as const }, { ...first, state: "cancelled" as const, cancelReason: "customer_inbound" as const }]) {
      const existing = [timer];
      const result = schedule({ timerId: "t-replay", existing });
      expect(result).toMatchObject({ scheduled: null, skipped: "already_exists", cancelled: [] });
      expect(result.timers).toBe(existing);
    }
  });
  it("a new confirmed question cancels the case's other scheduled timers and gets its own", () => {
    const first = scheduledTimer();
    const other = scheduledTimer({ timerId: "x1", caseId: "case-2", questionEffectId: "effect-x" });
    const result = schedule({ timerId: "t2", questionEffectId: "effect-q2", existing: [first, other], now: new Date("2026-10-27T10:00:00Z") });
    expect(result.cancelled).toEqual([{ timerId: "t1", key: first.key, reason: "new_question" }]);
    expect(result.timers.map((timer) => [timer.id, timer.state])).toEqual([["t1", "cancelled"], ["x1", "scheduled"], ["t2", "scheduled"]]);
    expect(result.timers[0]).toMatchObject({ cancelReason: "new_question", cancelledAt: "2026-10-27T10:00:00.000Z" });
  });
  it("a new question never touches fired or cancelled timers", () => {
    const fired = { ...scheduledTimer(), state: "fired" as const, firedAt: DUE_ISO };
    const result = schedule({ timerId: "t2", questionEffectId: "effect-q2", existing: [fired] });
    expect(result.cancelled).toEqual([]);
    expect(result.timers[0]).toBe(fired);
  });
  it("a customer message after the question schedules no J2 but still obsoletes older timers", () => {
    const older = scheduledTimer({ timerId: "t0", questionEffectId: "effect-q0" });
    const result = schedule({ lastCustomerInboundAt: new Date(SENT.getTime() + 1), existing: [older] });
    expect(result).toMatchObject({ scheduled: null, skipped: "inbound_after_question" });
    expect(result.cancelled).toEqual([{ timerId: "t0", key: older.key, reason: "new_question" }]);
    expect(result.timers).toHaveLength(1);
  });
  it("a customer message exactly at the send time counts as crossing; one millisecond before does not", () => {
    expect(schedule({ lastCustomerInboundAt: SENT }).skipped).toBe("inbound_after_question");
    expect(schedule({ lastCustomerInboundAt: new Date(SENT.getTime() - 1) }).skipped).toBeNull();
  });
  it("rejects malformed input instead of guessing", () => {
    expect(() => schedule({ timerId: "" })).toThrow(TypeError);
    expect(() => schedule({ caseVersion: 0 })).toThrow(RangeError);
    expect(() => schedule({ caseVersion: 1.5 })).toThrow(RangeError);
    expect(() => schedule({ now: new Date("nope") })).toThrow(RangeError);
    expect(() => schedule({ send: { status: "confirmed", sentAt: new Date("nope") } })).toThrow(RangeError);
    expect(() => schedule({ send: { status: "confirmed", sentAt: "2026-10-26T22:00:00Z" as unknown as Date } })).toThrow(TypeError);
    expect(() => schedule({ lastCustomerInboundAt: "x" as unknown as Date })).toThrow(TypeError);
  });
  it("does not schedule when the calendar refuses the send time", () => {
    expect(() => schedule({ send: { status: "confirmed", sentAt: new Date("1969-12-31T00:00:00Z") } })).toThrow(RangeError);
  });
});

describe("cancellation signals", () => {
  const signals: Array<[J2Signal, string]> = [
    [{ kind: "customer_inbound", caseId: CASE }, "customer_inbound"],
    [{ kind: "owner_changed", caseId: CASE }, "owner_changed"],
    [{ kind: "human_outbound", caseId: CASE }, "human_outbound"],
    [{ kind: "admission_withdrawn", caseId: CASE }, "admission_withdrawn"],
    [{ kind: "new_question", caseId: CASE, questionEffectId: "effect-q2" }, "new_question"],
  ];
  it.each(signals)("%j cancels the scheduled timer with reason %s", (signal, reason) => {
    const timer = scheduledTimer();
    const at = new Date("2026-10-27T09:00:00Z");
    const result = applyJ2Signal([timer], signal, at);
    expect(result.cancelled).toEqual([{ timerId: "t1", key: timer.key, reason }]);
    expect(result.timers[0]).toMatchObject({ state: "cancelled", cancelReason: reason, cancelledAt: at.toISOString(), dueAt: DUE_ISO });
  });
  it("a new_question signal for the same effect leaves its own timer alone", () => {
    const timers = [scheduledTimer()];
    const result = applyJ2Signal(timers, { kind: "new_question", caseId: CASE, questionEffectId: EFFECT }, NOW);
    expect(result.cancelled).toEqual([]);
    expect(result.timers).toBe(timers);
  });
  it("only the signalled case is affected", () => {
    const mine = scheduledTimer();
    const theirs = scheduledTimer({ timerId: "x1", caseId: "case-2", questionEffectId: "effect-x" });
    const result = applyJ2Signal([mine, theirs], { kind: "customer_inbound", caseId: CASE }, NOW);
    expect(result.timers.map((timer) => timer.state)).toEqual(["cancelled", "scheduled"]);
  });
  it("fired and cancelled timers are terminal: no signal changes them", () => {
    const fired = firedTimer();
    const cancelled = applyJ2Signal([scheduledTimer({ timerId: "c1", questionEffectId: "effect-c" })], { kind: "customer_inbound", caseId: CASE }, NOW).timers[0];
    const timers = [fired, cancelled];
    for (const [signal] of signals) {
      const result = applyJ2Signal(timers, signal, NOW);
      expect(result.cancelled).toEqual([]);
      expect(result.timers).toBe(timers);
    }
  });
  it("applying the same signal twice cancels once", () => {
    const first = applyJ2Signal([scheduledTimer()], { kind: "customer_inbound", caseId: CASE }, NOW);
    const second = applyJ2Signal(first.timers, { kind: "customer_inbound", caseId: CASE }, NOW);
    expect(first.cancelled).toHaveLength(1);
    expect(second.cancelled).toEqual([]);
    expect(second.timers).toBe(first.timers);
  });
  it("a hand-back after a cancellation does not revive the timer", () => {
    const cancelled = applyJ2Signal([scheduledTimer()], { kind: "owner_changed", caseId: CASE }, NOW).timers;
    const afterHandBack = applyJ2Signal(cancelled, { kind: "owner_changed", caseId: CASE }, NOW).timers;
    expect(afterHandBack[0].state).toBe("cancelled");
    expect(collect(afterHandBack, AFTER_DUE).emitted).toEqual([]);
    // a replay of the very same question cannot recreate it either
    expect(schedule({ timerId: "t-again", existing: afterHandBack }).skipped).toBe("already_exists");
  });
  it("rejects malformed signals", () => {
    expect(() => applyJ2Signal([], { kind: "customer_inbound", caseId: "" }, NOW)).toThrow(TypeError);
    expect(() => applyJ2Signal([], { kind: "customer_inbound", caseId: "a:b" }, NOW)).toThrow(TypeError);
    expect(() => applyJ2Signal([], { kind: "new_question", caseId: CASE, questionEffectId: "" }, NOW)).toThrow(TypeError);
    expect(() => applyJ2Signal([], { kind: "customer_inbound", caseId: CASE }, new Date("nope"))).toThrow(RangeError);
  });
});

describe("due timers only emit an event", () => {
  it("nothing fires one millisecond before dueAt; the timer fires exactly at dueAt", () => {
    const timers = [scheduledTimer()];
    const early = collect(timers, new Date(Date.parse(DUE_ISO) - 1));
    expect(early.emitted).toEqual([]);
    expect(early.timers).toBe(timers);
    const onTime = collect(timers, new Date(DUE_ISO));
    expect(onTime.emitted).toEqual([{
      kind: "timer_fired", caseId: CASE, dedupeKey: "timer:t1", sourceRef: { type: "timer", id: "t1" },
      detail: { timerKey: "timer:j2:case-1:effect-q1", questionEffectId: EFFECT, dueAt: DUE_ISO },
    }]);
    expect(onTime.timers[0]).toMatchObject({ state: "fired", firedAt: DUE_ISO });
  });
  it("fires once: a second collection emits nothing", () => {
    const first = collect([scheduledTimer()], AFTER_DUE);
    const second = collect(first.timers, new Date("2026-11-30T00:00:00Z"));
    expect(first.emitted).toHaveLength(1);
    expect(second.emitted).toEqual([]);
    expect(second.timers).toBe(first.timers);
  });
  it("a timer found days late still fires once, without moving its slot", () => {
    const result = collect([scheduledTimer()], new Date("2026-11-05T12:00:00Z"));
    expect(result.emitted).toHaveLength(1);
    expect(result.timers[0]).toMatchObject({ dueAt: DUE_ISO, state: "fired", firedAt: "2026-11-05T12:00:00.000Z" });
  });
  it("a cancelled timer never fires", () => {
    const cancelled = applyJ2Signal([scheduledTimer()], { kind: "customer_inbound", caseId: CASE }, NOW).timers;
    expect(collect(cancelled, new Date("2027-01-01T10:00:00Z")).emitted).toEqual([]);
  });
  it("emits in dueAt then key order and leaves later timers scheduled", () => {
    const a = scheduledTimer({ timerId: "a", caseId: "case-a", questionEffectId: "z" });
    const b = scheduledTimer({ timerId: "b", caseId: "case-b", questionEffectId: "y" });
    const later = scheduledTimer({ timerId: "c", caseId: "case-c", questionEffectId: "x", send: { status: "confirmed", sentAt: new Date("2026-10-27T10:00:00Z") } });
    const result = collect([later, b, a], new Date(DUE_ISO));
    expect(result.emitted.map((event) => event.dedupeKey)).toEqual(["timer:a", "timer:b"]);
    expect(result.timers.map((timer) => timer.state)).toEqual(["scheduled", "fired", "fired"]);
  });
  it("an earlier dueAt is emitted before a later one even when its key sorts last", () => {
    const earlier = scheduledTimer({ timerId: "e", caseId: "case-z", questionEffectId: "z", send: { status: "confirmed", sentAt: new Date("2026-10-26T10:00:00Z") } });
    const sameDay = scheduledTimer({ timerId: "a", caseId: "case-a", questionEffectId: "a" });
    expect(earlier.dueAt).toBe("2026-10-27T10:00:00.000Z");
    expect(collect([sameDay, earlier], new Date(DUE_ISO)).emitted.map((event) => event.dedupeKey)).toEqual(["timer:e", "timer:a"]);
  });
  it("rejects an invalid clock", () => {
    expect(() => collect([], new Date("nope"))).toThrow(RangeError);
  });
});

describe("races between a customer message and the timer", () => {
  it("message handled first: the timer is cancelled and never produces an event", () => {
    const afterInbound = applyJ2Signal([scheduledTimer()], { kind: "customer_inbound", caseId: CASE }, new Date("2026-10-28T07:59:59Z"));
    expect(collect(afterInbound.timers, AFTER_DUE).emitted).toEqual([]);
  });
  it("timer handled first: the event exists but revalidation finds the later message and refuses", () => {
    const fired = collect([scheduledTimer()], AFTER_DUE);
    expect(fired.emitted).toHaveLength(1);
    const late = applyJ2Signal(fired.timers, { kind: "customer_inbound", caseId: CASE }, AFTER_DUE);
    expect(late.cancelled).toEqual([]); // already fired: terminal
    const result = revalidate({
      timer: fired.timers[0],
      view: view({ phase: "queued" }),
      events: [{ kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: "2026-10-28T07:59:59.000Z" }],
    });
    expect(reasonsOf(result)).toEqual(expect.arrayContaining(["inbound_after_question", "phase_changed"]));
  });
  it("a message that arrived while the question was in flight (before the timer existed) blocks scheduling", () => {
    expect(schedule({ lastCustomerInboundAt: new Date(SENT.getTime() + 500) }).skipped).toBe("inbound_after_question");
  });
});

describe("revalidation before any J2", () => {
  it("passes when every timer-side condition holds and hands back the case version to prepare the decision on", () => {
    expect(revalidate()).toEqual({ status: "timer_conditions_met", caseVersion: 12 });
  });
  it("is not an authorisation: the result carries no permission-like field", () => {
    expect(Object.keys(revalidate()).sort()).toEqual(["caseVersion", "status"]);
    expect(JSON.stringify(revalidate())).not.toMatch(/allow|permit|eligible|admitted|send|authori/i);
  });
  it("the case version is the current one, not the one at scheduling", () => {
    const result = revalidate({ view: view({ version: 99 }) });
    expect(result).toEqual({ status: "timer_conditions_met", caseVersion: 99 });
    expect(firedTimer().scheduledAtCaseVersion).toBe(7);
  });
  it("its own timer_fired event (a later case version) does not make it obsolete", () => {
    expect(revalidate({ events: [{ kind: "timer_fired", direction: "internal", occurredAt: DUE_ISO }] }).status).toBe("timer_conditions_met");
  });

  it.each([
    ["owner human", { owner: "human", phase: "human_owned" }, ["owner_not_agent", "phase_changed"]],
    ["unknown owner", { owner: "robot" }, ["owner_not_agent"]],
    ["phase handoff", { phase: "handoff_pending" }, ["phase_changed"]],
    ["phase acting", { phase: "acting" }, ["phase_changed"]],
    ["phase resolved", { phase: "resolved" }, ["phase_changed"]],
    ["finance case", { sensitivity: "finance" }, ["sensitive_case"]],
    ["cancellation case", { sensitivity: "cancellation" }, ["sensitive_case"]],
    ["unknown sensitivity", { sensitivity: "subscription" }, ["sensitive_case"]],
    ["another case", { caseId: "case-2" }, ["case_mismatch"]],
  ] as const)("refuses: %s", (_label, patch, expected) => {
    expect(reasonsOf(revalidate({ view: view(patch) }))).toEqual(expected);
  });

  it("refuses when the question is gone, answered, or no longer the latest", () => {
    expect(reasonsOf(revalidate({ view: view({ body: { questions: [] } }) }))).toEqual(["question_missing"]);
    const answered = [{ id: "q1", askedAt: SENT.toISOString(), askedInEffect: EFFECT, answeredBy: { type: "email", id: "m9" } }];
    expect(reasonsOf(revalidate({ view: view({ body: { questions: answered } }) }))).toEqual(["question_answered"]);
    const newer = [...view().body.questions, { id: "q2", askedAt: "2026-10-27T10:00:00.000Z", askedInEffect: "effect-q2" }];
    expect(reasonsOf(revalidate({ view: view({ body: { questions: newer } }) }))).toEqual(["question_superseded"]);
  });
  it("refuses when the case is no longer waiting for the customer on this timer", () => {
    expect(reasonsOf(revalidate({ view: view({ body: { waiting: null } }) }))).toEqual(["not_waiting_for_customer"]);
    expect(reasonsOf(revalidate({ view: view({ body: { waiting: { kind: "team", timerId: "t1" } } }) }))).toEqual(["not_waiting_for_customer"]);
    expect(reasonsOf(revalidate({ view: view({ body: { waiting: { kind: "customer", timerId: "t-other" } } }) }))).toEqual(["timer_not_linked"]);
    expect(reasonsOf(revalidate({ view: view({ body: { waiting: { kind: "customer" } } }) }))).toEqual(["timer_not_linked"]);
  });

  const at = (iso: string) => iso;
  it.each([
    ["customer message at the send time", { kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: at(SENT.toISOString()) }, ["inbound_after_question"]],
    ["customer message later", { kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: "2026-10-27T08:00:00Z" }, ["inbound_after_question"]],
    ["owner change since", { kind: "owner_changed", direction: "internal", occurredAt: "2026-10-27T08:00:00Z" }, ["owner_changed_since"]],
    ["human message since", { kind: "outbound_observed", direction: "human_outbound", occurredAt: "2026-10-27T08:00:00Z" }, ["human_outbound_since"]],
    ["later agent message", { kind: "outbound_observed", direction: "agent_outbound", occurredAt: "2026-10-26T22:00:00.001Z" }, ["newer_agent_message"]],
    ["unreadable event time", { kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: "yesterday" }, ["invalid_time"]],
  ] as const)("refuses on events: %s", (_label, event, expected) => {
    expect(reasonsOf(revalidate({ events: [event] }))).toEqual(expected);
  });
  it("ignores events older than the question and the question's own outbound event", () => {
    const events: J2CaseEventView[] = [
      { kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: new Date(SENT.getTime() - 1).toISOString() },
      { kind: "owner_changed", direction: "internal", occurredAt: "2026-10-26T10:00:00Z" },
      { kind: "outbound_observed", direction: "human_outbound", occurredAt: "2026-10-26T10:00:00Z" },
      { kind: "outbound_observed", direction: "agent_outbound", occurredAt: SENT.toISOString() },
      { kind: "crm_observed", direction: "internal", occurredAt: "2026-10-27T10:00:00Z" },
    ];
    expect(revalidate({ events }).status).toBe("timer_conditions_met");
  });

  it("refuses for good once the admission is withdrawn (the other holds only defer, see timer-pause.test.ts)", () => {
    expect(reasonsOf(revalidate({ activeHolds: ["admission_withdrawn"] }))).toEqual(["admission_withdrawn"]);
  });
  it("refuses a timer that is not fired, was cancelled, or is not yet due", () => {
    expect(reasonsOf(revalidate({ timer: scheduledTimer() }))).toEqual(["timer_not_fired"]);
    const cancelled = applyJ2Signal([scheduledTimer()], { kind: "customer_inbound", caseId: CASE }, NOW).timers[0];
    expect(reasonsOf(revalidate({ timer: cancelled }))).toEqual(["timer_cancelled"]);
    // not yet due is a deferral now (nothing is lost), not an obsolescence
    expect(revalidate({ now: new Date(Date.parse(DUE_ISO) - 1) })).toEqual({ status: "deferred", reasons: ["not_due"], notBefore: DUE_ISO });
  });
  it("lists every reason, once each, in a stable order", () => {
    const result = revalidate({
      view: view({ owner: "human", phase: "human_owned", sensitivity: "finance", body: { waiting: null } }),
      events: [
        { kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: "2026-10-27T08:00:00Z" },
        { kind: "inbound_confirmed", direction: "customer_inbound", occurredAt: "2026-10-27T09:00:00Z" },
      ],
      activeHolds: ["admission_withdrawn", "admission_withdrawn"],
    });
    expect(reasonsOf(result)).toEqual(["owner_not_agent", "phase_changed", "sensitive_case", "not_waiting_for_customer", "inbound_after_question", "admission_withdrawn"]);
  });
});

describe("scenario: finance request after a usage question", () => {
  it("owner goes human and finance is recorded: cancelled before due, and a fired copy is refused", () => {
    const timer = scheduledTimer();
    const cancelled = applyJ2Signal([timer], { kind: "owner_changed", caseId: CASE }, new Date("2026-10-27T09:00:00Z"));
    expect(collect(cancelled.timers, AFTER_DUE).emitted).toEqual([]);
    const result = revalidate({ view: view({ owner: "human", phase: "human_owned", sensitivity: "finance" }) });
    expect(reasonsOf(result)).toEqual(["owner_not_agent", "phase_changed", "sensitive_case"]);
  });
  it("admission withdrawn after the timer fired: no J2 even though the case still looks like an agent case", () => {
    expect(reasonsOf(revalidate({ activeHolds: ["admission_withdrawn"] }))).toEqual(["admission_withdrawn"]);
  });
});

describe("purity", () => {
  it("never mutates its inputs", () => {
    const timer = deepFreeze(scheduledTimer());
    const timers = deepFreeze([timer]);
    expect(() => schedule({ existing: timers, timerId: "t2", questionEffectId: "effect-q2" })).not.toThrow();
    expect(() => applyJ2Signal(timers, { kind: "customer_inbound", caseId: CASE }, NOW)).not.toThrow();
    expect(() => collect(timers, AFTER_DUE)).not.toThrow();
    const fired = deepFreeze(firedTimer());
    expect(() => revalidate({ timer: fired, view: deepFreeze(view()), events: deepFreeze([]), activeHolds: deepFreeze([]) })).not.toThrow();
    expect(timers[0].state).toBe("scheduled");
  });
  it("same inputs, same outputs", () => {
    expect(schedule()).toEqual(schedule());
    expect(revalidate()).toEqual(revalidate());
  });
  it("the module reads no clock, environment, database or provider and offers no send or close", () => {
    const source = readFileSync(new URL("./timer-lifecycle.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Date\.now\(|new Date\(\)|process\.env|performance\.now|Math\.random|randomUUID/);
    // Only the calendar and the SAV-5 storage types (zod schemas, no I/O) may be imported: the timer record is not defined twice.
    expect([...source.matchAll(/from "([^"]+)"/g)].map(m => m[1]).sort()).toEqual(["./case-types", "./j2-calendar"]);
    for (const dependency of ["case-types.ts", "../playbook-contract.ts"]) {
      expect(readFileSync(new URL(dependency, import.meta.url), "utf8")).not.toMatch(/process\.env|requireDb|fetch\(|node:|drizzle|server-only/);
    }
    expect(source).not.toMatch(/\b(fetch|gmail|hubspot|slack|requireDb|drizzle)\b/i);
    expect(source).not.toMatch(/export (async )?function (send|close|dispatch|enqueue)/i);
  });
});
