import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./runtime-store", () => ({ settleSavIntakeCall: vi.fn(async () => true) }));
import { createIntakeModelDispatcher } from "./model-dispatch";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";
import { savGeminiWireBody } from "../gemini-transport";
import type { IntakeGeminiCall } from "./model-readers";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import { settleSavIntakeCall } from "./runtime-store";
import { savDerivedCostQuote } from "../derived-budget";
import { admitSavAttachmentImage } from "../attachment-image";
import { syntheticImage } from "../../../../test/sav-attachments";

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

it("settles a malformed visual response once without caching raw output and preserves its real reason", async () => {
  const { z } = await import("zod");
  const input = inputAtSize(1000);
  input.phase = "understanding";
  input.media = [await admitSavAttachmentImage(await syntheticImage(), "image/png")];
  input.sanitizeResponse = raw => z.object({ requiredField: z.string() }).parse(raw);
  const network = vi.fn<typeof fetch>(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"privateRaw":"must not be cached"}' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } }));
  const dispatcher = createIntakeModelDispatcher({ config, live: async () => {}, reserve: async () => ({ id: "synthetic-reservation", cached: null }), network,
    signal: new AbortController().signal, env: () => ({ SAV_GEMINI_API_KEY: "synthetic-key" }) });
  await expect(dispatcher.call(input)).rejects.toBeInstanceOf(z.ZodError);
  expect(dispatcher.failureReason).toBe("SAV_INTAKE_MODEL_OUTPUT_REJECTED");
  expect(settleSavIntakeCall).toHaveBeenCalledExactlyOnceWith("synthetic-reservation", expect.objectContaining({ inputTokens: 100, outputTokens: 50, thoughtTokens: 0, totalTokens: 150 }));
  expect(JSON.stringify(vi.mocked(settleSavIntakeCall).mock.calls)).not.toContain("privateRaw");
});
it("clears an obsolete failure after a successful, separately reserved repair", async () => {
  const input = inputAtSize(1000), network = vi.fn<typeof fetch>(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"fixture":true}' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } }));
  let calls = 0;
  const dispatcher = createIntakeModelDispatcher({ config, live: async () => {}, reserve: async () => {
    if (++calls === 1) throw Error("SAV_INTAKE_RUNTIME_CALL_ALREADY_CONSUMED");
    return { id: "synthetic-repair", cached: null };
  }, network, signal: new AbortController().signal, env: () => ({ SAV_GEMINI_API_KEY: "synthetic-key" }) });
  await expect(dispatcher.call(input)).rejects.toThrow("CALL_ALREADY_CONSUMED");
  const repair = { ...input, body: structuredClone(input.body) };
  repair.body.systemInstruction.parts[0].text += " Repair format v1.";
  await expect(dispatcher.call(repair)).resolves.toMatchObject({ json: { fixture: true } });
  expect(network).toHaveBeenCalledTimes(1); expect(dispatcher.failureReason).toBeUndefined();
});
