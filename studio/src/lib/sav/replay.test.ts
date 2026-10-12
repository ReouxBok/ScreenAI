import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSavRuleReplay, savRuleReplayExitCode } from "./replay";

describe("versioned SAV replay corpus", () => {
  it("does not claim a lexical preflight evaluated semantic quality", () => {
    const cases = JSON.parse(readFileSync(new URL("../../../test/fixtures/sav-replay-v1.json", import.meta.url), "utf8"));
    const report = runSavRuleReplay(cases);
    expect(report.development.length).toBeGreaterThanOrEqual(5);
    expect(report.control.length).toBeGreaterThanOrEqual(5);
    expect(report.failed).toBe(0);
    expect(report.notEvaluated).toBeGreaterThan(0);
    expect(report.passed + report.failed + report.notEvaluated).toBe(report.total);
    for (const result of report.results.filter(result => !result.evaluated)) {
      expect(result.passed).toBe(false);
      expect(result.actual.reasonCode).toBe("semantic_understanding_required");
    }
  });
});

it("allows an explicit technical-only CI check without passing unevaluated semantics", () => {
  expect(savRuleReplayExitCode({ failed: 0, notEvaluated: 12 })).toBe(1);
  expect(savRuleReplayExitCode({ failed: 0, notEvaluated: 12 }, true)).toBe(0);
  expect(savRuleReplayExitCode({ failed: 1, notEvaluated: 12 }, true)).toBe(1);
  expect(savRuleReplayExitCode({ failed: 0, notEvaluated: 0 })).toBe(0);
});

it("fails a lost technical exclusion instead of hiding it as unevaluated", () => {
  const report = runSavRuleReplay([{ id: "technical-regression", partition: "control",
    input: { from: "fixture@example.invalid", subject: "Automated reply fixture", body: "Fixture without its expected technical header" },
    expected: { kind: "automatic_reply", requiresHumanApproval: false } }]);
  expect(report).toMatchObject({ total: 1, failed: 1, passed: 0, notEvaluated: 0 });
  expect(report.results[0].actual.reasonCode).toBe("semantic_understanding_required");
  expect(savRuleReplayExitCode(report, true)).toBe(1);
});
