import { describe, expect, it } from "vitest";
import { caseCallSignal, caseCallsInWindow } from "./investigation-call-signal";
import { SAV_CASE_INVESTIGATION_RECORD_KIND } from "./investigation-record";

const NOW = new Date("2026-10-28T12:00:00Z");
const recorded = (inputKey: string, modelCalls: number, createdAt: string, kind: string = SAV_CASE_INVESTIGATION_RECORD_KIND) =>
  ({ kind: "observation_recorded", createdAt, detail: { record: { kind, inputKey, progress: { modelCalls } } } });

describe("P1 (Ugo 28/10, option c): calls per case over a window, flagged, never blocking", () => {
  it("counts per input only the calls recorded inside the window", () => {
    const events = [
      recorded("in:a", 2, "2026-10-27T08:00:00Z"), // before the window: 2 calls already spent on input a
      recorded("in:a", 3, "2026-10-27T13:00:00Z"), // inside: 1 more call on a
      recorded("in:b", 1, "2026-10-28T09:00:00Z"),
      recorded("in:b", 3, "2026-10-28T10:00:00Z"), // inside: 3 calls on b, counted once (the highest)
    ];
    expect(caseCallsInWindow(events, NOW, 24)).toBe(4);
    expect(caseCallsInWindow(events, NOW, 1)).toBe(0);
  });
  it("ignores what is not an investigation record and counts an unreadable date inside (never fewer calls)", () => {
    const events = [
      recorded("in:a", 3, "2026-10-28T10:00:00Z", "other-kind"),
      { kind: "timer_fired", createdAt: "2026-10-28T10:00:00Z", detail: null },
      { kind: "observation_recorded", createdAt: "2026-10-28T10:00:00Z", detail: { record: { kind: SAV_CASE_INVESTIGATION_RECORD_KIND, inputKey: "in:x", progress: { modelCalls: "3" } } } },
      recorded("in:c", 2, "not-a-date"),
    ];
    expect(caseCallsInWindow(events, NOW, 24)).toBe(2);
  });
  it("measures only with no threshold, flags above a threshold, and is off when absent or out of bounds", () => {
    const events = [recorded("in:a", 3, "2026-10-28T10:00:00Z")];
    expect(caseCallSignal(events, NOW, undefined, 1)).toBeNull();
    expect(caseCallSignal(events, NOW, { windowHours: 24, threshold: null }, 1)).toEqual({ windowHours: 24, calls: 4, threshold: null, over: null });
    expect(caseCallSignal(events, NOW, { windowHours: 24, threshold: 4 }, 1)).toMatchObject({ calls: 4, over: false });
    expect(caseCallSignal(events, NOW, { windowHours: 24, threshold: 3 }, 1)).toMatchObject({ calls: 4, over: true });
    for (const bad of [{ windowHours: 0, threshold: null }, { windowHours: 1.5, threshold: null }, { windowHours: 200, threshold: null }, { windowHours: 24, threshold: 0 }, { windowHours: 24, threshold: Number.NaN }])
      expect(caseCallSignal(events, NOW, bad, 1)).toBeNull();
  });
  it("carries no value of its own: nothing in the code chooses the window or the threshold", () => {
    expect(caseCallSignal([], NOW, undefined, 3)).toBeNull();
  });
});
