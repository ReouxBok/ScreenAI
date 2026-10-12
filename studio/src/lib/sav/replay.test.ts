import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSavRuleReplay } from "./replay";

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
