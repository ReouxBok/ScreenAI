import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSavRuleReplay } from "./replay";

describe("versioned SAV replay corpus", () => {
  it("passes development and unseen control partitions", () => {
    const cases = JSON.parse(readFileSync(new URL("../../../test/fixtures/sav-replay-v1.json", import.meta.url), "utf8"));
    const report = runSavRuleReplay(cases);
    expect(report.development.length).toBeGreaterThanOrEqual(5);
    expect(report.control.length).toBeGreaterThanOrEqual(5);
    expect(report.failed).toBe(0);
  });
});
