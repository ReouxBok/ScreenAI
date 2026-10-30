import { describe, expect, it } from "vitest";
import { intakePauseIntervals, intakePausedAt, measureSavIntake, type IntakeMeasureDossier } from "./business-measures";

// Synthetic dossiers only: identifiers and dates, no customer content.
const period = { from: "2026-10-30T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" };
const d = (threadId: string, outcome: IntakeMeasureDossier["outcome"], at: string[], extra: Partial<IntakeMeasureDossier> = {}): IntakeMeasureDossier =>
  ({ threadId, outcome, confirmedEffects: outcome === "autonomous_confirmed" ? 3 : 0, messages: at.map((receivedAt, i) => ({ id: `${threadId}-${i}`, receivedAt })), ...extra });
const pause = [{ at: "2026-10-30T10:00:00.000Z", previousLevel: "running", nextLevel: "fully_paused" }, { at: "2026-10-30T14:00:00.000Z", previousLevel: "fully_paused", nextLevel: "running" }];

describe("SAV-77 business measures", () => {
  it("reconstructs pause intervals from audited changes without inventing a start", () => {
    expect(intakePauseIntervals(pause)).toEqual([{ from: "2026-10-30T10:00:00.000Z", to: "2026-10-30T14:00:00.000Z", level: "fully_paused" }]);
    const alreadyPaused = intakePauseIntervals([{ at: "2026-10-30T14:00:00.000Z", previousLevel: "actions_paused", nextLevel: "running" }]);
    expect(alreadyPaused).toEqual([{ from: null, to: "2026-10-30T14:00:00.000Z", level: "actions_paused" }]);
    expect(intakePausedAt(alreadyPaused, "2026-10-30T09:00:00.000Z")).toBeNull();
    expect(intakePausedAt(alreadyPaused, "2026-10-30T15:00:00.000Z")).toBe(false);
    expect(intakePauseIntervals([{ at: "2026-10-30T10:00:00.000Z", previousLevel: "running", nextLevel: "fully_paused" }])).toEqual([{ from: "2026-10-30T10:00:00.000Z", to: null, level: "fully_paused" }]);
    expect(intakePausedAt(null, "2026-10-30T09:00:00.000Z")).toBeNull();
  });
  it("counts a dossier once whatever its number of messages and late returns", () => {
    const m = measureSavIntake({ period, pauses: intakePauseIntervals(pause), dossiers: [
      d("a", "autonomous_confirmed", ["2026-10-30T08:00:00.000Z", "2026-10-30T08:30:00.000Z", "2026-10-30T20:00:00.000Z"]),
      d("b", "operator_catchup", ["2026-10-30T09:00:00.000Z"]),
    ] });
    expect(m.denominators).toMatchObject({ messages: 4, savMessages: 4, dossiers: 2, confirmedEffects: 3 });
    expect(m.running.autonomousRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });
  it("keeps noise out of SAV denominators and rates", () => {
    const m = measureSavIntake({ period, pauses: intakePauseIntervals(pause), dossiers: [
      d("auto-reply", "acknowledgement_completed", ["2026-10-30T08:00:00.000Z"], { messages: [{ id: "n1", receivedAt: "2026-10-30T08:00:00.000Z", noise: true }] }),
      d("real", "autonomous_confirmed", ["2026-10-30T08:00:00.000Z"]),
    ] });
    expect(m.denominators).toMatchObject({ messages: 2, noiseMessages: 1, savMessages: 1, dossiers: 1, noiseOnlyDossiers: 1 });
    expect(m.running.autonomousRate.denominator).toBe(1);
  });
  it("isolates the pause cohort: no failure for the running agent, catch-up measured after resume", () => {
    const m = measureSavIntake({ period, pauses: intakePauseIntervals(pause), dossiers: [
      d("before", "autonomous_confirmed", ["2026-10-30T09:00:00.000Z"]),
      d("during-wait", "expected_wait", ["2026-10-30T11:00:00.000Z"]),
      d("during-caught-up", "autonomous_confirmed", ["2026-10-30T12:00:00.000Z"], { outcomeAt: "2026-10-30T14:05:00.000Z" }),
      d("during-blocked", "technical_failure", ["2026-10-30T13:00:00.000Z"]),
      d("after", "technical_failure", ["2026-10-30T15:00:00.000Z"]),
    ] });
    expect(m.running.dossiers).toBe(2);
    expect(m.running.technicalFailureRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(m.pausedCohort).toMatchObject({ dossiers: 3, lastResumeAt: "2026-10-30T14:00:00.000Z", caughtUpAfterResume: 1 });
    expect(m.pausedCohort.outcomes).toMatchObject({ expected_wait: 1, autonomous_confirmed: 1, technical_failure: 1 });
  });
  it("expected waits and uncertain effects are never counted as success", () => {
    const m = measureSavIntake({ period, pauses: [], dossiers: [
      d("wait", "expected_wait", ["2026-10-30T08:00:00.000Z"]), d("uncertain", "uncertain_effect", ["2026-10-30T08:00:00.000Z"]),
      d("ok", "autonomous_confirmed", ["2026-10-30T08:00:00.000Z"]),
    ] });
    // expected_wait is not decided yet: outside the denominator; uncertain is decided and not a success.
    expect(m.running.autonomousRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });
  it("without pause boundaries, no rate is attributed to the running agent and the limit is explicit", () => {
    const m = measureSavIntake({ period, pauses: null, dossiers: [d("x", "technical_failure", ["2026-10-30T08:00:00.000Z"])] });
    expect(m.running.dossiers).toBe(0); expect(m.unknownCohort.dossiers).toBe(1);
    expect(m.running.technicalFailureRate.value).toBeNull();
    expect(m.limits).toContain("pause_boundaries_unknown");
  });
  it("ignores a repeated dossier entry instead of counting it twice, and says so", () => {
    const m = measureSavIntake({ period, pauses: [], dossiers: [d("a", "autonomous_confirmed", ["2026-10-30T08:00:00.000Z"]), d("a", "autonomous_confirmed", ["2026-10-30T08:00:00.000Z"])] });
    expect(m.denominators.dossiers).toBe(1); expect(m.limits).toContain("duplicate_dossier_ignored");
  });
  it("messages outside the period are not counted; an empty denominator gives no rate", () => {
    const m = measureSavIntake({ period, pauses: [], dossiers: [d("old", "autonomous_confirmed", ["2026-10-29T08:00:00.000Z"])] });
    expect(m.denominators.dossiers).toBe(0); expect(m.running.autonomousRate).toEqual({ numerator: 0, denominator: 0, value: null });
  });
});
