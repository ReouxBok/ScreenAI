import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./runtime-store", () => ({ settleSavIntakeCall: vi.fn(async () => true) }));
import { createIntakeModelDispatcher } from "./model-dispatch";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";
import { savGeminiWireBody } from "../gemini-transport";
import type { IntakeGeminiCall } from "./model-readers";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import { settleSavIntakeCall } from "./runtime-store";
import { savDerivedCostQuote } from "../derived-budget";

const config = { model: "gemini-3.6-flash" } as IntakeRuntimeConfig;
function inputAtSize(bytes: number): Parameters<IntakeGeminiCall>[0] {
  const input: Parameters<IntakeGeminiCall>[0] = { model: config.model, phase: "ticket_matching", promptRevision: "fixture",
    signal: new AbortController().signal, allowRetry: false,
    body: { systemInstruction: { parts: [{ text: "Lire tout." }] }, contents: [{ role: "user", parts: [{ text: 'é😀 "citation" \\ chemin\n' }] }],
      generationConfig: { maxOutputTokens: 8192 } } };
  input.body.contents[0].parts[0].text += "x".repeat(bytes - savGeminiWireBody(input).textBytes);
  expect(savGeminiWireBody(input).textBytes).toBe(bytes);
  return input;
}
beforeEach(() => vi.clearAllMocks());
it("keeps the existing conservative price reservation above the expanded text envelope", () => {
  const quote = savDerivedCostQuote(config.model, 8192, new Date("2026-10-22T00:00:00Z"));
  expect(quote.reservedNanoUsd).toBe(817_152_000);
  // The transport additionally reserves up to three admitted images at 4096
  // capacity units each; the price already covers the full model input window.
  expect(SAV_INTAKE_MODEL_LIMITS.wireTextBytes + 3 * 4096).toBeLessThan(quote.maxInputTokens);
});
it.each([-1, 0, 1])("enforces the full 128 KiB wire boundary %+d before reservation or network", async delta => {
  const input = inputAtSize(SAV_INTAKE_MODEL_LIMITS.wireTextBytes + delta);
  const reserve = vi.fn(async () => ({ id: "synthetic-reservation", cached: null }));
  const network = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.body).toBe(savGeminiWireBody(input).body);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"fixture":true}' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
  });
  const dispatcher = createIntakeModelDispatcher({ config, live: async () => {}, reserve, network,
    signal: new AbortController().signal, env: () => ({ SAV_GEMINI_API_KEY: "synthetic-key" }) });
  if (delta <= 0) {
    await expect(dispatcher.call(input)).resolves.toMatchObject({ json: { fixture: true } });
    expect(reserve).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(network).toHaveBeenCalledTimes(1); expect(settleSavIntakeCall).toHaveBeenCalledTimes(1);
  } else {
    await expect(dispatcher.call(input)).rejects.toThrow("SAV_INTAKE_RUNTIME_REQUEST_REJECTED");
    expect(reserve).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(settleSavIntakeCall).not.toHaveBeenCalled();
    expect(dispatcher.failureReason).toBe("SAV_INTAKE_RUNTIME_REQUEST_REJECTED");
  }
});
