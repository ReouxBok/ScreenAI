import { accessSkillWireAnswer } from "../src/lib/sav/cases/access-skill/access-skill-wire";

/*
 * SAV-97 test double of the Gemini model behind the Access skill's transport: it answers at the network boundary only, so the real wire, key
 * resolution, transport bounds, V2 spend gate, store and rule all run. Synthetic values only (no real key, model or customer text).
 */

export const ACCESS_SKILL_TEST_POLICY = { revision: "synthetic-skill", approvedBy: "20000000-0000-4000-8000-000000000097", approvedAt: "2026-11-18T00:00:00Z",
  transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(), maxInputTokens: 131072, maxOutputTokens: 1024, maxInputBytes: 100_000,
    embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1024 },
  // The price pin stays valid one year after the run (a fixed date would turn every test red the day it passes).
  // One micro-dollar per million tokens: a reservation of 1 covers a full window, so the whole corpus fits the shared caps.
  model: { dailyCapMicroUsd: 1_000_000, reserveMicroUsdPerCall: 1, microUsdPerMillionInputTokens: 1, microUsdPerMillionOutputTokens: 1 },
  embedding: { dailyCapMicroUsd: 1_000_000, reserveMicroUsdPerCall: 1, microUsdPerMillionInputTokens: 1 } };
export const ACCESS_SKILL_TEST_PROVIDER_ENV = { SAV_V2_GEMINI_API_KEY: "synthetic-key-not-real", SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding",
  SAV_V2_SPEND_POLICY_JSON: JSON.stringify(ACCESS_SKILL_TEST_POLICY) };

export type AccessSkillDoubleCall = { kind: "judge" | "counter"; payload: { purpose: string; subject: string; text: string; requests?: Array<{ requestId: string; kind: string; words: string | null }> } };
/** What the double answers for one call: a model output, an HTTP status, or a lost connection. */
export type AccessSkillDoubleAnswer = { output: unknown } | { http: number } | { lost: true } | { raw: unknown };

export function accessSkillModelDouble(script: (call: AccessSkillDoubleCall) => AccessSkillDoubleAnswer) {
  const calls: AccessSkillDoubleCall[] = [];
  const network = async (url: string, init: RequestInit) => {
    if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/synthetic-model:generateContent$/.test(url)) throw Error(`UNEXPECTED_URL ${url}`);
    const body = JSON.parse(String(init.body)) as { systemInstruction: { parts: Array<{ text: string }> }; contents: Array<{ parts: Array<{ text: string }> }> };
    const kind = body.systemInstruction.parts[0]!.text.startsWith("CONTRE-LECTURE") ? "counter" as const : "judge" as const;
    const call = { kind, payload: JSON.parse(body.contents[0]!.parts[0]!.text) };
    calls.push(call);
    const answer = script(call);
    if ("lost" in answer) throw Error("SYNTHETIC_CONNECTION_LOST");
    if ("http" in answer) return new Response("{}", { status: answer.http });
    return new Response(JSON.stringify("raw" in answer ? answer.raw : accessSkillWireAnswer(answer.output)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { network, calls };
}

/** A judge's reading of a single-request mail. */
export function judgeSays(verdict: "access" | "sensitive" | "other" | "unsure", quote: string, extra: { requestId?: string; family?: string | null; confidence?: string; sensitive?: string;
  mentions?: unknown[]; thirdParty?: boolean; instructionLike?: boolean } = {}) {
  return { mail: { sensitive: extra.sensitive ?? (verdict === "sensitive" ? "request" : verdict === "unsure" ? "unsure" : "none"), thirdParty: extra.thirdParty ?? false, instructionLike: extra.instructionLike ?? false },
    requests: [{ requestId: extra.requestId ?? "r1", verdict, family: extra.family ?? (verdict === "sensitive" ? "finance" : null), confidence: extra.confidence ?? "high", quote, reason: "synthetic" }],
    sensitiveMentions: extra.mentions ?? [] };
}
export const counterSays = (answer: "yes" | "no" | "unsure") => ({ asksOrContestsSensitive: answer, families: answer === "no" ? [] : ["finance"], quote: null, reason: "synthetic" });
