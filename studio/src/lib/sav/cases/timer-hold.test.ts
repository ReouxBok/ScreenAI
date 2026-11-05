import { describe, expect, it } from "vitest";
import {
  applyJ2Signal, collectDueJ2Events, revalidateFiredJ2, scheduleJ2Timer,
  type J2CaseEventView, type J2CaseView, type J2Revalidation, type J2Timer,
} from "./timer-lifecycle";

// Q9 (Ugo, 2026-10-28): a technical or organisational hold keeps J2 and its original due date; the follow-up resumes after revalidation in a
// business slot. A person taking the case over (human_takeover, handoff, hand_back, unknown transition) cancels the old follow-up.
// "admin_hold" is split: the hold itself is organisational, whoever releases it to a human ends in owner "human".
const CASE = "case-1", EFFECT = "effect-q1";
const SENT = new Date("2026-10-26T22:00:00.000Z"); // Mon 23:00 Paris
const DUE = "2026-10-28T08:00:00.000Z"; // Wed 09:00 Paris
const NOW = new Date("2026-10-28T08:00:01.000Z");
const scheduled = (): J2Timer => {
  const result = scheduleJ2Timer({ timerId: "t1", caseId: CASE, questionEffectId: EFFECT, caseVersion: 7, send: { status: "confirmed", sentAt: SENT }, lastCustomerInboundAt: null, existing: [], now: SENT });
  if (!result.scheduled) throw new Error("not scheduled");
  return result.scheduled;
};
const fired = (): J2Timer => collectDueJ2Events([scheduled()], new Date(DUE), { pauses: [], maxEvents: 5 }).timers[0]!;
const view = (patch: Partial<J2CaseView> = {}): J2CaseView => ({
  caseId: CASE, version: 12, owner: "agent", phase: "awaiting_customer", sensitivity: "none",
  body: { questions: [{ id: "q1", askedAt: SENT.toISOString(), askedInEffect: EFFECT }], waiting: { kind: "customer", timerId: "t1" } }, ...patch,
});
const owner = (transition: unknown, occurredAt = "2026-10-27T10:00:00.000Z"): J2CaseEventView => ({ kind: "owner_changed", direction: "internal", occurredAt, detail: { transition } });
const revalidate = (v: J2CaseView, events: J2CaseEventView[] = []): J2Revalidation =>
  revalidateFiredJ2({ timer: fired(), view: v, events, activeHolds: [], pauses: [], reminderEffect: "none", now: NOW });

describe("Q9: an organisational hold keeps J2", () => {
  it("the organizational_hold signal cancels nothing and returns the same timers", () => {
    const timers = [scheduled()];
    const result = applyJ2Signal(timers, { kind: "organizational_hold", caseId: CASE }, NOW);
    expect(result.cancelled).toEqual([]);
    expect(result.timers).toBe(timers);
    expect(result.timers[0]).toMatchObject({ state: "scheduled", dueAt: DUE, cancelReason: null });
  });
  it("a personal takeover (owner_changed) still cancels, once, and a hold afterwards revives nothing", () => {
    const cancelled = applyJ2Signal([scheduled()], { kind: "owner_changed", caseId: CASE }, NOW);
    expect(cancelled.cancelled).toMatchObject([{ reason: "owner_changed" }]);
    expect(applyJ2Signal(cancelled.timers, { kind: "organizational_hold", caseId: CASE }, NOW).timers[0]).toMatchObject({ state: "cancelled", cancelReason: "owner_changed" });
  });
  it("while the case is on an organisational hold the due follow-up waits; it is not obsolete and has no invented resume date", () => {
    const result = revalidate(view({ owner: "system_hold" }), [owner("admin_hold")]);
    expect(result).toEqual({ status: "deferred", reasons: ["organizational_hold"], notBefore: null });
  });
  it("after the hold is released to the agent, with the case waiting on the same timer, the follow-up resumes (conditions met, case version carried)", () => {
    const result = revalidate(view(), [owner("admin_hold", "2026-10-27T10:00:00.000Z"), owner("hold_release", "2026-10-27T12:00:00.000Z")]);
    expect(result).toEqual({ status: "timer_conditions_met", caseVersion: 12 });
  });
  it("contract v7 names the two holds: both keep the follow-up, and `admin_hold` stays readable in older journals", () => {
    for (const hold of ["technical_hold", "organisational_hold", "admin_hold"]) {
      expect(revalidate(view({ owner: "system_hold" }), [owner(hold)])).toEqual({ status: "deferred", reasons: ["organizational_hold"], notBefore: null });
      expect(revalidate(view(), [owner(hold), owner("hold_release", "2026-10-27T12:00:00.000Z")])).toEqual({ status: "timer_conditions_met", caseVersion: 12 });
    }
  });
  it("after a release the store restores the wait (contract v8): the follow-up resumes with the phase `awaiting_customer`", () => {
    expect(revalidate(view({ phase: "awaiting_customer" }), [owner("technical_hold"), owner("hold_release", "2026-10-27T12:00:00.000Z")])).toEqual({ status: "timer_conditions_met", caseVersion: 12 });
  });
  it("C no longer rescues `queued`: a case that is not waiting for the customer is obsolete, with or without a release", () => {
    expect(revalidate(view({ phase: "queued" }), [])).toMatchObject({ status: "obsolete", reasons: ["phase_changed"] });
    expect(revalidate(view({ phase: "queued" }), [owner("technical_hold"), owner("hold_release", "2026-10-27T12:00:00.000Z")])).toMatchObject({ status: "obsolete", reasons: ["phase_changed"] });
    expect(revalidate(view({ phase: "acting" }), [owner("hold_release")])).toMatchObject({ status: "obsolete", reasons: ["phase_changed"] });
    expect(revalidate(view({ phase: "handoff_pending" }), [owner("hold_release")])).toMatchObject({ status: "obsolete", reasons: ["phase_changed"] });
  });
  it("a release to the agent after which the customer wait is no longer this timer's is still obsolete", () => {
    const moved = view({ phase: "awaiting_customer", body: { questions: [{ id: "q1", askedAt: SENT.toISOString(), askedInEffect: EFFECT }], waiting: { kind: "customer", timerId: "another-timer" } } });
    expect(revalidate(moved, [owner("technical_hold"), owner("hold_release")])).toMatchObject({ status: "obsolete", reasons: ["timer_not_linked"] });
    expect(revalidate(view({ phase: "awaiting_customer", body: { questions: [{ id: "q1", askedAt: SENT.toISOString(), askedInEffect: EFFECT }], waiting: null } }), [owner("hold_release")]))
      .toMatchObject({ status: "obsolete", reasons: ["not_waiting_for_customer"] });
  });
});

describe("Q9: a person taking over cancels the follow-up", () => {
  for (const transition of ["human_takeover", "handoff", "hand_back", "admission_withdrawn", "something_new", undefined, 42, null]) {
    it(`transition ${JSON.stringify(transition)} makes the follow-up obsolete`, () => {
      expect(revalidate(view(), [owner(transition)])).toMatchObject({ status: "obsolete", reasons: ["owner_changed_since"] });
    });
  }
  it("an owner_changed event without any detail fails closed", () => {
    expect(revalidate(view(), [{ kind: "owner_changed", direction: "internal", occurredAt: "2026-10-27T10:00:00.000Z" }])).toMatchObject({ status: "obsolete", reasons: ["owner_changed_since"] });
    expect(revalidate(view(), [{ kind: "owner_changed", direction: "internal", occurredAt: "2026-10-27T10:00:00.000Z", detail: null }])).toMatchObject({ status: "obsolete" });
  });
  it("a hold then a takeover is a takeover; a hold released to a human is obsolete by owner", () => {
    expect(revalidate(view(), [owner("admin_hold"), owner("human_takeover", "2026-10-27T11:00:00.000Z")])).toMatchObject({ status: "obsolete", reasons: ["owner_changed_since"] });
    expect(revalidate(view({ owner: "human" }), [owner("admin_hold"), owner("hold_release")])).toMatchObject({ status: "obsolete", reasons: ["owner_not_agent"] });
  });
  it("an unknown owner value is never read as a hold", () => {
    expect(revalidate(view({ owner: "paused_by_someone" }))).toMatchObject({ status: "obsolete", reasons: ["owner_not_agent"] });
  });
});
