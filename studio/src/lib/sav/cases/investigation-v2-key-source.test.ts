import { describe, expect, it, vi } from "vitest";
import {
  caseGeminiDecisionProvider, caseGeminiEmbeddingTransport, caseV2GeminiKeyStatus, caseV2ProviderConfigProblems, resolveCaseV2GeminiKey,
} from "./investigation-v2-providers";
import type { CaseInvestigationModelRequest } from "./investigation-runner";

// Synthetic values only: no real key, no real model, no network.
const V1 = "synthetic-v1-key", V2 = "synthetic-v2-key";
const policy = { revision: "synthetic", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00Z",
  transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 131072, maxOutputTokens: 1024, maxInputBytes: 100_000, embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1024 },
  model: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 200_000, microUsdPerMillionInputTokens: 1_000_000, microUsdPerMillionOutputTokens: 1_000_000 },
  embedding: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 10_000, microUsdPerMillionInputTokens: 1_000_000 } };
const base = { SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(policy) };
const request = { purpose: "decision", snapshot: { version: 1, body: { openRequests: [], facts: [], questions: [], trials: [] } }, knowledge: [], coverage: null, feedback: [], closure: [] } as unknown as CaseInvestigationModelRequest;
const ok = () => Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });

describe("V2 Gemini key source (explicit, non-secret selector)", () => {
  it("defaults to V2's own key and never reads V1's key when the source is absent or dedicated", () => {
    for (const source of [undefined, "", "  ", "dedicated"]) {
      const env = { ...base, SAV_GEMINI_API_KEY: V1, ...(source === undefined ? {} : { SAV_V2_GEMINI_KEY_SOURCE: source }) };
      expect(resolveCaseV2GeminiKey(env)).toEqual({ ok: false, problem: "v2_gemini_key_absent" });
      expect(resolveCaseV2GeminiKey({ ...env, SAV_V2_GEMINI_API_KEY: V2 })).toEqual({ ok: true, source: "dedicated", key: V2 });
    }
  });

  it("shared_v1 uses V1's key only, and refuses when it is absent (no fallback to a dedicated key)", () => {
    expect(resolveCaseV2GeminiKey({ ...base, SAV_V2_GEMINI_KEY_SOURCE: "shared_v1", SAV_GEMINI_API_KEY: V1 })).toEqual({ ok: true, source: "shared_v1", key: V1 });
    for (const v1 of [undefined, "", "   "])
      expect(resolveCaseV2GeminiKey({ ...base, SAV_V2_GEMINI_KEY_SOURCE: "shared_v1", ...(v1 === undefined ? {} : { SAV_GEMINI_API_KEY: v1 }) }))
        .toEqual({ ok: false, problem: "v2_shared_v1_gemini_key_absent" });
  });

  it("refuses shared_v1 while a dedicated key is also set: which key is meant is never guessed", () => {
    expect(resolveCaseV2GeminiKey({ ...base, SAV_V2_GEMINI_KEY_SOURCE: "shared_v1", SAV_GEMINI_API_KEY: V1, SAV_V2_GEMINI_API_KEY: V2 }))
      .toEqual({ ok: false, problem: "v2_gemini_key_source_conflict" });
  });

  it.each(["shared", "SHARED_V1", "v1", "true", "on", "shared_v1,dedicated"])("refuses an unknown source %j even with both keys present", source => {
    expect(resolveCaseV2GeminiKey({ ...base, SAV_V2_GEMINI_KEY_SOURCE: source, SAV_GEMINI_API_KEY: V1, SAV_V2_GEMINI_API_KEY: V2 }))
      .toEqual({ ok: false, problem: "v2_gemini_key_source_invalid" });
  });

  it("reports the precise problem to the factory and the status without ever exposing a key value", () => {
    const cases: Array<[Record<string, string>, string | null]> = [
      [{ SAV_V2_GEMINI_API_KEY: V2 }, null],
      [{ SAV_V2_GEMINI_KEY_SOURCE: "shared_v1", SAV_GEMINI_API_KEY: V1 }, null],
      [{ SAV_GEMINI_API_KEY: V1 }, "v2_gemini_key_absent"],
      [{ SAV_V2_GEMINI_KEY_SOURCE: "shared_v1" }, "v2_shared_v1_gemini_key_absent"],
      [{ SAV_V2_GEMINI_KEY_SOURCE: "shared_v1", SAV_GEMINI_API_KEY: V1, SAV_V2_GEMINI_API_KEY: V2 }, "v2_gemini_key_source_conflict"],
      [{ SAV_V2_GEMINI_KEY_SOURCE: "bogus", SAV_GEMINI_API_KEY: V1 }, "v2_gemini_key_source_invalid"],
    ];
    for (const [keys, problem] of cases) {
      const env = { ...base, ...keys }, problems = caseV2ProviderConfigProblems(env), status = caseV2GeminiKeyStatus(env);
      expect(problems).toEqual(problem ? [problem] : []);
      expect(status.usable).toBe(problem === null);
      expect(status.problem).toBe(problem);
      expect(JSON.stringify({ problems, status })).not.toMatch(/synthetic-v[12]-key/);
    }
  });

  it("generation sends V1's key only under shared_v1, with V2's model, and sends nothing when the source is refused", async () => {
    const network = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => ok());
    await caseGeminiDecisionProvider({ env: () => ({ ...base, SAV_V2_GEMINI_KEY_SOURCE: "shared_v1", SAV_GEMINI_API_KEY: V1 }), network })(request);
    expect(network).toHaveBeenCalledTimes(1);
    const [url, init] = network.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(V1);
    expect(url).toContain("/synthetic-model:generateContent");
    network.mockClear();
    for (const keys of [{ SAV_GEMINI_API_KEY: V1 }, { SAV_V2_GEMINI_KEY_SOURCE: "shared_v1" }, { SAV_V2_GEMINI_KEY_SOURCE: "bogus", SAV_GEMINI_API_KEY: V1, SAV_V2_GEMINI_API_KEY: V2 },
      { SAV_V2_GEMINI_KEY_SOURCE: "shared_v1", SAV_GEMINI_API_KEY: V1, SAV_V2_GEMINI_API_KEY: V2 }])
      expect(await caseGeminiDecisionProvider({ env: () => ({ ...base, ...keys }), network })(request))
        .toEqual({ result: { status: "failed", uncertain: false }, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(network).not.toHaveBeenCalled();
  });

  it("embedding refuses a missing or invalid source before any network and still requires its reservation under shared_v1", async () => {
    const network = vi.fn();
    const embed = (keys: Record<string, string>) => caseGeminiEmbeddingTransport({ env: () => ({ ...base, ...keys }), network })({ texts: ["ok"], signal: AbortSignal.timeout(1000) });
    await expect(embed({ SAV_GEMINI_API_KEY: V1 })).rejects.toThrow("SAV_V2_GEMINI_KEY_ABSENT");
    await expect(embed({ SAV_V2_GEMINI_KEY_SOURCE: "shared_v1" })).rejects.toThrow("SAV_V2_GEMINI_KEY_ABSENT");
    await expect(embed({ SAV_V2_GEMINI_KEY_SOURCE: "bogus", SAV_GEMINI_API_KEY: V1 })).rejects.toThrow("SAV_V2_GEMINI_KEY_SOURCE_INVALID");
    await expect(embed({ SAV_V2_GEMINI_KEY_SOURCE: "shared_v1", SAV_GEMINI_API_KEY: V1, SAV_V2_GEMINI_API_KEY: V2 })).rejects.toThrow("SAV_V2_GEMINI_KEY_SOURCE_CONFLICT");
    // The shared key passes the key check but every V2 bound still applies: no reservation, no call.
    await expect(embed({ SAV_V2_GEMINI_KEY_SOURCE: "shared_v1", SAV_GEMINI_API_KEY: V1 })).rejects.toThrow("SAV_V2_EMBEDDING_RESERVATION_REQUIRED");
    expect(network).not.toHaveBeenCalled();
  });
});
