import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ find: vi.fn(), append: vi.fn(), verify: vi.fn() }));
vi.mock("./evaluations", () => ({ findEvaluationByToken: mocks.find, appendEvaluationEvent: mocks.append }));
vi.mock("./evaluation-verification", () => ({ verifyEvaluationObservation: mocks.verify }));
import { verifyStudioEvaluation } from "./verify-studio-evaluation";
const detail = { run: { id: "run", status: "running" }, version: { id: "version" }, item: { agentKey: "charly" },
  testCase: { id: "case", kind: "live_action", expectation: { successCriteria: ["Server criterion"] } } };
beforeEach(() => {
  vi.clearAllMocks(); mocks.find.mockReset().mockResolvedValue(detail);
  mocks.verify.mockResolvedValue({ verified: true, reason: "criteria_supported", contextVersion: 4 });
  mocks.append.mockResolvedValue({ id: "event" });
});
describe("authorized Studio outcome verification", () => {
  it("uses the pinned server criteria and stores only the resulting status", async () => {
    expect(await verifyStudioEvaluation("code", { text: "private" })).toEqual({ id: "event" });
    expect(mocks.verify).toHaveBeenCalledWith(detail.testCase.expectation, { text: "private" }, undefined);
    expect(mocks.append).toHaveBeenCalledWith("code", { kind: "tool_result", toolName: "verify_expected_result", status: "ok", contextVersion: 4 });
  });
  it.each([null, { ...detail, run: { id: "run", status: "passed" } }, { ...detail, item: { agentKey: "sav" } }])("rejects unauthorized runs before model usage", async value => {
    mocks.find.mockResolvedValue(value); expect(await verifyStudioEvaluation("code", {})).toBeNull(); expect(mocks.verify).not.toHaveBeenCalled();
  });
  it.each([null, { ...detail, version: { id: "new-version" } }, { ...detail, run: { id: "run", status: "passed" } }])("rechecks the grant after model processing", async value => {
    mocks.find.mockResolvedValueOnce(detail).mockResolvedValueOnce(value);
    expect(await verifyStudioEvaluation("code", {})).toBeNull(); expect(mocks.append).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "invalid_observation"])("does not append verification on %s", async reason => {
    mocks.verify.mockResolvedValue({ verified: false, reason });
    expect(await verifyStudioEvaluation("code", {})).toBeNull(); expect(mocks.append).not.toHaveBeenCalled();
  });
  it("records unsupported criteria without reporting verification success", async () => {
    mocks.verify.mockResolvedValue({ verified: false, reason: "insufficient_evidence", contextVersion: 4 });
    await verifyStudioEvaluation("code", {});
    expect(mocks.append).toHaveBeenCalledWith("code", expect.objectContaining({ status: "not_found" }));
  });
});
