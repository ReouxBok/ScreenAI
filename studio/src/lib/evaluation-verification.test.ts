import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const credentials = vi.hoisted(() => vi.fn(() => "fixture-extension-key"));
vi.mock("@/lib/embeddings", () => ({ embeddingApiKey: credentials }));
import { checkEvaluationJudgement, verifyEvaluationObservation } from "./evaluation-verification";

const expectation = { successCriteria: ["The integration is connected"], expectedPages: ["/settings"] };
const page = () => ({ text: "Connection status: Connected", origin: "https://app.example", path: "/settings", contextVersion: 3, observedAt: new Date().toISOString() });
const decision = { checks: [{ index: 0, satisfied: true, quote: "Connection status: Connected" }] };
const response = (value: unknown, finishReason = "STOP") => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(value) }] } }] });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { credentials.mockReturnValue("fixture-extension-key"); fetchMock = vi.fn().mockImplementation(async () => response(decision)); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("grounded evaluation criterion judgement", () => {
  it("requires one supported result for every criterion", () => {
    expect(checkEvaluationJudgement(expectation.successCriteria, page().text, decision)).toBe(true);
    expect(checkEvaluationJudgement([], page().text, { checks: [] })).toBe(false);
    expect(checkEvaluationJudgement(["One", "Two"], page().text, decision)).toBe(false);
  });
  it.each([
    { checks: [{ index: 0, satisfied: true, quote: "Invented success" }] },
    { checks: [{ index: 0, satisfied: false, quote: "Connection status: Connected" }] },
    { checks: [{ index: 0, satisfied: true, quote: "" }] },
    { checks: [{ index: 1, satisfied: true, quote: "Connected" }] },
    { checks: [decision.checks[0], decision.checks[0]] },
  ])("refuses unsupported or incomplete judgements: %j", raw => {
    expect(checkEvaluationJudgement(expectation.successCriteria, page().text, raw)).toBe(false);
  });
});

describe("Studio evaluation observation verifier", () => {
  it("uses the extension credential and sends no grant or assistant conversation", async () => {
    expect(await verifyEvaluationObservation(expectation, page())).toMatchObject({ verified: true, reason: "criteria_supported", contextVersion: 3 });
    expect(credentials).toHaveBeenCalledWith("extension");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).not.toContain("fixture-extension-key");
    expect(options.headers["x-goog-api-key"]).toBe("fixture-extension-key");
    const body = JSON.parse(options.body);
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual({ criteria: expectation.successCriteria, observation: expect.objectContaining({ text: page().text }) });
  });
  it.each([
    { path: "/other" }, { path: "/settings?token=private" }, { origin: "http://app.example" },
    { observedAt: "2000-01-01T00:00:00.000Z" }, { observedAt: "2099-01-01T00:00:00.000Z" }, { contextVersion: -1 },
  ])("does not call the model for invalid or irrelevant evidence: %j", async patch => {
    expect((await verifyEvaluationObservation(expectation, { ...page(), ...patch })).verified).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not fall back to SAV credentials or rules if configuration is missing", async () => {
    credentials.mockReturnValue("");
    expect(await verifyEvaluationObservation(expectation, page())).toMatchObject({ verified: false, reason: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["MAX_TOKENS", "SAFETY"])("refuses incomplete model output %s", async finish => {
    fetchMock.mockResolvedValue(response(decision, finish));
    expect(await verifyEvaluationObservation(expectation, page())).toMatchObject({ verified: false, reason: "unavailable" });
  });
  it("fails closed on provider errors", async () => {
    fetchMock.mockRejectedValue(new Error("provider failed"));
    expect(await verifyEvaluationObservation(expectation, page())).toMatchObject({ verified: false, reason: "unavailable" });
  });
});
