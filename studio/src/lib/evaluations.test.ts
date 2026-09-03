import { describe, expect, it } from "vitest";
import { scoreEvaluation } from "./evaluations";

describe("real-condition evaluation scoring", () => {
  it("passes a verified autonomous action confirmed by the contributor", () => {
    expect(scoreEvaluation({
      isLive: true,
      delivered: true,
      actionSucceeded: true,
      verified: true,
      failed: false,
      manual: false,
      verdict: "correct",
      threshold: 80,
    })).toEqual({ score: 100, passed: true, failureCode: null });
  });

  it("never passes when the contributor had to finish the flow manually", () => {
    expect(scoreEvaluation({
      isLive: true,
      delivered: true,
      actionSucceeded: true,
      verified: true,
      failed: false,
      manual: true,
      verdict: "correct",
      threshold: 80,
    })).toMatchObject({ passed: false, failureCode: "manual_intervention" });
  });

  it("does not accept a positive verdict without action and verification evidence", () => {
    expect(scoreEvaluation({
      isLive: true,
      delivered: true,
      actionSucceeded: false,
      verified: false,
      failed: false,
      manual: false,
      verdict: "correct",
      threshold: 80,
    })).toEqual({ score: 40, passed: false, failureCode: "criteria_not_met" });
  });
});
