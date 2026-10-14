import { describe, expect, it } from "vitest";
import { readOrderedEvaluationEvidence } from "./evaluation-evidence-order";
const action = (ordinal: number, status = "ok") => ({ ordinal, kind: "tool_result", toolName: "click_element", status, technicalMetadata: {} });
const verification = (ordinal: number, status = "ok") => ({ ...action(ordinal, status), toolName: "verify_expected_result" });
const response = (ordinal: number, status = "ok") => ({ ...action(ordinal, status), kind: "response", toolName: null });
describe("chronological Studio evidence", () => {
  it("accepts a response and verification after the last successful action", () => {
    expect(readOrderedEvaluationEvidence([response(3), action(1), verification(2)])).toEqual({ failed: false, manual: false, delivered: true, actionSucceeded: true, verified: true });
  });
  it("invalidates old success and response when another action occurs", () => {
    expect(readOrderedEvaluationEvidence([action(1), verification(2), response(3), action(4)]))
      .toMatchObject({ actionSucceeded: true, delivered: false, verified: false });
  });
  it("uses the most recent verification rather than any previous success", () => {
    expect(readOrderedEvaluationEvidence([action(1), verification(2), verification(3, "not_found"), response(4)]).verified).toBe(false);
  });
  it("allows verification to succeed after earlier insufficient evidence", () => {
    expect(readOrderedEvaluationEvidence([action(1), verification(2, "not_found"), verification(3), response(4)]))
      .toMatchObject({ verified: true, failed: false });
  });
  it("does not count verification preceding the action", () => {
    expect(readOrderedEvaluationEvidence([verification(1), action(2), response(3)]).verified).toBe(false);
  });
  it("allows a delivered explanation without inventing action evidence", () => {
    expect(readOrderedEvaluationEvidence([response(1)])).toMatchObject({ delivered: true, actionSucceeded: false, verified: false });
  });
  it.each([0, -1, 1.5, NaN])("rejects invalid event ordering %s", ordinal => {
    expect(readOrderedEvaluationEvidence([action(ordinal), verification(2), response(3)]).verified).toBe(false);
  });
  it("does not resolve duplicate ordinals by arbitrary array order", () => {
    expect(readOrderedEvaluationEvidence([action(1), verification(1), response(2)]))
      .toMatchObject({ delivered: false, actionSucceeded: false, verified: false });
  });
  it("preserves failure and manual-intervention exclusions", () => {
    const events = [action(1, "failed"), { ...action(2), technicalMetadata: { manualIntervention: true } }, verification(3), response(4)];
    expect(readOrderedEvaluationEvidence(events)).toMatchObject({ failed: true, manual: true });
  });
});
