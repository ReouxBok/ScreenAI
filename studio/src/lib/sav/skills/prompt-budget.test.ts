import { describe, expect, it } from "vitest";
import { measurePromptBudget, type PromptBudgetStage } from "./prompt-budget";

describe("prompt budget", () => {
  it.each<[PromptBudgetStage, number, number, "pass" | "fail"]>([
    ["entry", 84, 100, "pass"],
    ["confirm", 85, 100, "fail"],
    ["decision", 86, 100, "fail"],
    ["entry", 100, 100, "fail"],
    ["confirm", 5, 6, "pass"],
    ["decision", 6, 7, "fail"],
    ["entry", 0, 1, "pass"],
    ["decision", 1, Number.MAX_SAFE_INTEGER, "pass"],
  ])("measures %s with %d bytes and a ceiling of %d", (stage, bytes, ceiling, status) => {
    expect(measurePromptBudget(stage, "a".repeat(bytes), ceiling)).toEqual({ stage, bodyBytes: bytes, ceilingBytes: ceiling, status });
  });

  it("counts JSON syntax, escapes and UTF-8 bytes of the actual body", () => {
    const body = JSON.stringify({ text: 'é📬\n"' });
    expect(body.length).toBe(18);
    expect(measurePromptBudget("entry", body, 25)).toEqual({ stage: "entry", bodyBytes: 21, ceilingBytes: 25, status: "pass" });
    expect(measurePromptBudget("decision", body, 24).status).toBe("fail");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid ceiling of %s", ceiling => {
    expect(() => measurePromptBudget("entry", "", ceiling)).toThrow(RangeError);
  });
});
