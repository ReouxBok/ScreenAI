import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { savRunProvenance } from "./config";
import { parseSavGeminiJson, readSavGeminiResponse, type SavGeminiMetadata } from "./gemini-response";

export const SAV_AI_TRANSPORT_REVISION = "sav-gemini-transport-2026-10-16.v2";
export type SavAiPhase = "understanding" | "composition" | "coherence" | "ticket_matching" | "repair";
export type SavAiFailureCategory = "authentication" | "billing" | "rate_limited" | "provider_unavailable" | "invalid_output" | "blocked_output" | "budget_exhausted";
export type SavAiTransportTrace = {
  transportRevision: string; correlationId: string; phase: SavAiPhase; model: string; promptRevision: string;
  attempts: number; retries: number; durationMs: number; errorCode: string | null;
  failureCategory: SavAiFailureCategory | null;
};
type Budget = { id: string; deadline: number; calls: number; retries: number; reservedTokens: number; outputTokens: number; repairs: number };
const budgets = new AsyncLocalStorage<Budget>();
export const SAV_AI_BUDGET = { durationMs: 60_000, calls: 5, retries: 1, tokenAllowance: 262_144, outputTokens: 40_960, repairs: 1 } as const;
const phaseMs = (phase: SavAiPhase) => phase === "ticket_matching" ? 12_000 : 18_000;

/** One logical analysis shares call/time/token allowances, including nested CRM matching. */
export function withSavAiBudget<T>(work: () => Promise<T>): Promise<T> {
  if (budgets.getStore()) return work();
  return budgets.run({ id: randomUUID(), deadline: Date.now() + SAV_AI_BUDGET.durationMs, calls: 0, retries: 0, reservedTokens: 0, outputTokens: 0, repairs: 0 }, work);
}

function category(code: string): SavAiFailureCategory {
  if (/HTTP_(401|403)$/.test(code)) return "authentication";
  if (code === "SAV_AI_HTTP_402") return "billing";
  if (code === "SAV_AI_HTTP_429") return "rate_limited";
  if (code === "SAV_AI_BUDGET_EXCEEDED") return "budget_exhausted";
  if (code === "SAV_AI_OUTPUT_BLOCKED") return "blocked_output";
  if (/INVALID|EMPTY|TRUNCATED|INCOMPLETE/.test(code)) return "invalid_output";
  return "provider_unavailable";
}

export class SavAiTransportError extends Error {
  constructor(code: string, public readonly metadata: SavGeminiMetadata) { super(code); this.name = "SavAiTransportError"; }
}
export function savAiErrorMetadata(error: unknown): SavGeminiMetadata | undefined {
  return error instanceof SavAiTransportError ? error.metadata : undefined;
}

/** Gemini 3.x supports thinkingLevel. Leave unknown/older models untouched. */
export function savGeminiGenerationConfig(model: string, config: Record<string, unknown>) {
  if (!/^gemini-3(?:[.-])/.test(model)) return config;
  const rest = { ...config };
  delete rest.temperature;
  return { ...rest, thinkingConfig: { thinkingLevel: "low" } };
}

export async function requestSavGeminiJson(input: {
  phase: SavAiPhase; apiKey: string; model: string; body: { generationConfig: Record<string, unknown>; [key: string]: unknown };
  fetch?: typeof fetch; allowRetry?: boolean; promptRevision?: string;
}): Promise<{ json: unknown; metadata: SavGeminiMetadata }> {
  if (!budgets.getStore()) return withSavAiBudget(() => requestSavGeminiJson(input));
  const budget = budgets.getStore()!;
  const started = Date.now(), deadline = Math.min(budget.deadline, started + phaseMs(input.phase));
  let attempts = 0, metadata: SavGeminiMetadata = {};
  const trace = (code: string | null): SavAiTransportTrace => ({ transportRevision: SAV_AI_TRANSPORT_REVISION, correlationId: budget.id, phase: input.phase, model: /^[a-zA-Z0-9._-]{1,120}$/.test(input.model) ? input.model : "invalid", promptRevision: input.promptRevision ?? SAV_AI_TRANSPORT_REVISION,
    attempts, retries: Math.max(0, attempts - 1), durationMs: Date.now() - started, errorCode: code, failureCategory: code ? category(code) : null });
  const fail = (code: string): never => {
    metadata = { ...metadata, transport: trace(code) };
    console.warn("sav_ai_transport", { ...savRunProvenance(), ...metadata.transport, ...metadata, transport: undefined });
    throw new SavAiTransportError(code, metadata);
  };
  if (input.phase === "repair") {
    if (budget.repairs >= SAV_AI_BUDGET.repairs) return fail("SAV_AI_BUDGET_EXCEEDED");
    budget.repairs++;
  }
  if (!input.apiKey) return fail("SAV_AI_KEY_MISSING");
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(input.model)) return fail("SAV_AI_INVALID_MODEL");
  const generationConfig = savGeminiGenerationConfig(input.model, input.body.generationConfig);
  const output = generationConfig.maxOutputTokens;
  if (typeof output !== "number" || !Number.isInteger(output) || output < 1 || output > 8192) return fail("SAV_AI_BUDGET_EXCEEDED");
  const body = JSON.stringify({ ...input.body, generationConfig });
  // UTF-8 bytes conservatively reserve input capacity. Unknown failed usage is
  // never refunded. This is an admission bound, not a provider billing estimate.
  const allowance = Buffer.byteLength(body, "utf8") + output;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || budget.calls >= SAV_AI_BUDGET.calls || budget.reservedTokens + allowance > SAV_AI_BUDGET.tokenAllowance || budget.outputTokens + output > SAV_AI_BUDGET.outputTokens)
      return fail("SAV_AI_BUDGET_EXCEEDED");
    budget.calls++; budget.reservedTokens += allowance; budget.outputTokens += output; attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, input.phase === "ticket_matching" ? 8_000 : 12_000));
    let code = "SAV_AI_GENERATION_FAILED", retryAfter = 0;
    try {
      const response = await (input.fetch ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey }, body, signal: controller.signal,
      });
      if (!response.ok) {
        code = `SAV_AI_HTTP_${response.status}`;
        const header = response.headers?.get("retry-after");
        if (header) retryAfter = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        if (!Number.isFinite(retryAfter)) retryAfter = 0;
        // Never consume or log an external error body.
        await response.body?.cancel();
        throw new Error(code);
      }
      let payload: unknown;
      try { payload = await response.json(); } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new Error("SAV_AI_INVALID_RESPONSE");
      }
      const generated = readSavGeminiResponse(payload);
      for (const field of ["inputTokens", "outputTokens", "thoughtTokens", "totalTokens"] as const) metadata[field] = (metadata[field] ?? 0) + (generated.metadata[field] ?? 0);
      metadata = { ...generated.metadata, ...metadata };
      const json = parseSavGeminiJson(generated);
      if (controller.signal.aborted || Date.now() > deadline) return fail("SAV_AI_TIMEOUT");
      metadata.transport = trace(null);
      console.info("sav_ai_transport", { ...savRunProvenance(), ...metadata.transport, ...metadata, transport: undefined });
      return { json, metadata };
    } catch (error) {
      if (error instanceof SavAiTransportError) throw error;
      if (controller.signal.aborted || error instanceof Error && error.name === "AbortError") code = "SAV_AI_TIMEOUT";
      else if (error instanceof Error && /^SAV_AI_(HTTP_[1-5]\d{2}|INVALID_RESPONSE|INVALID_JSON|OUTPUT_(BLOCKED|TRUNCATED|INCOMPLETE)|EMPTY_OUTPUT)$/.test(error.message)) code = error.message;
      const transient = ["SAV_AI_TIMEOUT", "SAV_AI_GENERATION_FAILED", "SAV_AI_HTTP_429", "SAV_AI_HTTP_502", "SAV_AI_HTTP_503", "SAV_AI_HTTP_504"].includes(code);
      const delay = Math.max(0, retryAfter, 200) + Math.floor(Math.random() * 100);
      if (input.allowRetry === false || !transient || attempts >= 2 || budget.retries >= SAV_AI_BUDGET.retries || deadline - Date.now() <= delay + 100 || budget.calls >= SAV_AI_BUDGET.calls) return fail(code);
      budget.retries++;
      clearTimeout(timer);
      await new Promise(resolve => setTimeout(resolve, delay));
    } finally { clearTimeout(timer); }
  }
}
