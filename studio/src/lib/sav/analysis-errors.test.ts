import { describe, expect, it } from "vitest";
import { savAnalysisErrorCode } from "./analysis-errors";

describe("SAV generation error boundary", () => {
  it.each(["SAV_AI_HTTP_429", "SAV_AI_INVALID_JSON", "SAV_AI_INVALID_SCHEMA", "SAV_CITATION_QUOTE_MISMATCH", "SAV_ADK_TIMEOUT"])("preserves owned diagnostic %s", code => {
    expect(savAnalysisErrorCode(new Error(code))).toBe(code);
  });
  it.each([
    "client@example.com https://provider.invalid?key=private-credential",
    "SAV_AI_HTTP_503: private-credential customer@example.com",
    "SAV_UNKNOWN_EVIDENCE_private-credential",
    "SAV_REQUIRED_TOOL_UNAVAILABLE:customer@example.com",
  ])("does not persist raw provider text: %s", message => {
    expect(savAnalysisErrorCode(new Error(message))).toBe("SAV_AI_GENERATION_FAILED");
  });
  it("labels an abort without serializing its message", () => {
    const error = new Error("private-credential"); error.name = "AbortError";
    expect(savAnalysisErrorCode(error)).toBe("SAV_AI_TIMEOUT");
  });
});
