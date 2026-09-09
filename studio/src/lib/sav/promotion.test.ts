import { describe, expect, it } from "vitest";
import { evaluateSavPromotion, savConfidenceCalibrationError } from "./promotion";

describe("SAV autonomy promotion gate", () => {
  const passing = { versionReviewed: 30, versionCorrect: 28, versionPartial: 2, versionCritical: 0, versionDegraded: 0, versionCalibrationError: 5, globalReviewed: 100, failedActions: 0 };
  it("requires every documented criterion", () => expect(evaluateSavPromotion(passing)).toMatchObject({ eligible: true, acceptanceRate: 96.7, reasons: [] }));
  it.each([
    ["versionReviewed", 29, "SAV_PROMOTION_NEEDS_30_VERSION_REVIEWS"],
    ["versionCorrect", 20, "SAV_PROMOTION_ACCEPTANCE_BELOW_90"],
    ["versionCritical", 1, "SAV_PROMOTION_HAS_CRITICAL_REVIEW"],
    ["versionDegraded", 1, "SAV_PROMOTION_HAS_DEGRADED_RUN"],
    ["versionCalibrationError", 16, "SAV_PROMOTION_CONFIDENCE_NOT_CALIBRATED"],
    ["globalReviewed", 99, "SAV_PROMOTION_NEEDS_100_GLOBAL_REVIEWS"],
    ["failedActions", 1, "SAV_PROMOTION_HAS_FAILED_ACTION"],
  ] as const)("blocks %s", (key, value, reason) => {
    expect(evaluateSavPromotion({ ...passing, [key]: value })).toMatchObject({ eligible: false });
    expect(evaluateSavPromotion({ ...passing, [key]: value }).reasons).toContain(reason);
  });
  it("measures confidence against the human outcome", () => {
    expect(savConfidenceCalibrationError([{ confidence: 950, verdict: "correct" }, { confidence: 500, verdict: "partial" }])).toBe(2.5);
    expect(savConfidenceCalibrationError(Array.from({ length: 10 }, (_, index) => ({ confidence: 800, verdict: index < 8 ? "correct" : "incorrect" })))).toBe(0);
    expect(savConfidenceCalibrationError([])).toBe(100);
  });
});
