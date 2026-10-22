import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { dispatchSavDerivedCall, isSavDerivedBudgetDeferred, reserveSavDerivedCall, savDerivedCostQuote, settleSavDerivedCall } from "./derived-budget";
import { savRunProvenance } from "./config";
import { parseSavGeminiJson, readSavGeminiResponse, type SavGeminiMetadata } from "./gemini-response";
import { createHash } from "node:crypto";
import { isSavAdmittedImage, type SavAdmittedImage } from "./attachment-image";
import { SAV_ATTACHMENT_LIMITS } from "./attachment-contract";

export const SAV_AI_TRANSPORT_REVISION = "sav-gemini-transport-2026-10-22.v6";
export type SavAiPhase = "understanding" | "composition" | "coherence" | "ticket_matching" | "repair" | "learning_comparison" | "attachment_reading" | "translation";
export type SavAiFailureCategory = "authentication" | "billing" | "rate_limited" | "provider_unavailable" | "invalid_output" | "blocked_output" | "budget_exhausted";
export type SavAiTransportTrace = {
  transportRevision: string; correlationId: string; phase: SavAiPhase; model: string; promptRevision: string;
  attempts: number; retries: number; durationMs: number; errorCode: string | null;
  failureCategory: SavAiFailureCategory | null;
};
type Budget = { id: string; elapsedMs: number; reservedMs: number; calls: number; retries: number; reservedTokens: number; outputTokens: number; repairs: number; visualCalls: number };
const budgets = new AsyncLocalStorage<Budget>();
export const SAV_AI_BUDGET = { durationMs: 60_000, calls: 6, retries: 1, tokenAllowance: 262_144, outputTokens: 49_152, repairs: 1 } as const;
const ATTEMPT_MS = 18_000;
const PHASE_MS = 37_000;
const remainingTime = (budget: Budget) => SAV_AI_BUDGET.durationMs - budget.elapsedMs - budget.reservedMs;

/** One correlation and shared allowances, including CRM matching. Provider attempts,
 * retry waits and attachment preparation consume AI time; unrelated CRM/DB waits do not. */
export function withSavAiBudget<T>(work: () => Promise<T>): Promise<T> {
  if (budgets.getStore()) return work();
  return budgets.run({ id: randomUUID(), elapsedMs: 0, reservedMs: 0, calls: 0, retries: 0, reservedTokens: 0, outputTokens: 0, repairs: 0, visualCalls: 0 }, work);
}

/** Download and decode time belong to the same budget as the following model phases. */
export function withSavAttachmentReadBudget<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return withSavAiBudget(async () => {
    const budget = budgets.getStore()!;
    if (remainingTime(budget) < SAV_ATTACHMENT_LIMITS.downloadMs + 18_000) throw new Error("SAV_AI_BUDGET_EXCEEDED");
    const started = Date.now(), reserved = SAV_ATTACHMENT_LIMITS.downloadMs;
    budget.reservedMs += reserved;
    const signal = AbortSignal.timeout(reserved);
    try { const result = await work(signal); if (signal.aborted) throw new Error("SAV_AI_TIMEOUT"); return result; }
    finally { budget.reservedMs -= reserved; budget.elapsedMs += Math.max(0, Date.now() - started); }
  });
}

function rejectUntypedMedia(value: unknown, depth = 0): void {
  if (depth > 30) throw new Error("SAV_AI_MEDIA_ADMISSION_REQUIRED");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["inlineData", "inline_data", "fileData", "file_data"].includes(key)) throw new Error("SAV_AI_MEDIA_ADMISSION_REQUIRED");
    rejectUntypedMedia(child, depth + 1);
  }
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

/** Build and validate the exact provider wire body before durable reservation.
 * Shared by transport and intake; callers cannot inject unadmitted inline data. */
export function savGeminiWireBody(input: { phase: SavAiPhase; model: string; body: { generationConfig: Record<string, unknown>; [key: string]: unknown }; media?: readonly SavAdmittedImage[] }) {
  const generationConfig = savGeminiGenerationConfig(input.model, input.body.generationConfig);
  const output = generationConfig.maxOutputTokens;
  if (typeof output !== "number" || !Number.isInteger(output) || output < 1 || output > 8192) throw new Error("SAV_AI_BUDGET_EXCEEDED");
  rejectUntypedMedia(input.body);
  const textBody = { ...input.body, generationConfig };
  const textBytes = Buffer.byteLength(JSON.stringify(textBody), "utf8");
  let body = JSON.stringify(textBody), mediaAllowance = 0;
  const visual = input.phase === "attachment_reading" || input.phase === "understanding" && Boolean(input.media);
  if (input.media) {
    if (!visual || !/^gemini-3[.-]/.test(input.model)) throw new Error("SAV_AI_MEDIA_UNSUPPORTED_MODEL");
    if (!input.media.length || input.media.length > SAV_ATTACHMENT_LIMITS.images || input.media.some(image => !isSavAdmittedImage(image)
      || image.bytes.length > SAV_ATTACHMENT_LIMITS.imageBytes || image.width * image.height > SAV_ATTACHMENT_LIMITS.pixels
      || createHash("sha256").update(image.bytes).digest("hex") !== image.hash)
      || input.media.reduce((sum, image) => sum + image.bytes.length, 0) > SAV_ATTACHMENT_LIMITS.totalBytes) throw new Error("SAV_AI_MEDIA_ADMISSION_REQUIRED");
    const contents = input.body.contents as Array<{ role?: string; parts: unknown[] }>;
    if (!Array.isArray(contents) || contents.length !== 1 || !Array.isArray(contents[0].parts)) throw new Error("SAV_AI_MEDIA_ADMISSION_REQUIRED");
    // Gemini 3 HIGH currently documents ~1120 tokens/image. Reserve 4096 each,
    // separately from wire bytes; this is a conservative admission unit, not a price.
    mediaAllowance = input.media.length * 4096;
    body = JSON.stringify({ ...textBody, contents: [{ ...contents[0], parts: [...contents[0].parts,
      ...input.media.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.bytes.toString("base64") }, mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" } }))] }] });
    if (Buffer.byteLength(body, "utf8") > Math.ceil(SAV_ATTACHMENT_LIMITS.totalBytes / 3) * 4 + 64_000) throw new Error("SAV_AI_BUDGET_EXCEEDED");
  } else if (visual) throw new Error("SAV_AI_MEDIA_ADMISSION_REQUIRED");
  return { generationConfig, output, textBody, textBytes, body, mediaAllowance, visual };
}

export async function requestSavGeminiJson(input: {
  phase: SavAiPhase; apiKey: string; model: string; body: { generationConfig: Record<string, unknown>; [key: string]: unknown };
  fetch?: typeof fetch; allowRetry?: boolean; promptRevision?: string; derivedReservationId?: string;
  media?: readonly SavAdmittedImage[];
}): Promise<{ json: unknown; metadata: SavGeminiMetadata }> {
  if (!budgets.getStore()) return withSavAiBudget(() => requestSavGeminiJson(input));
  const budget = budgets.getStore()!;
  const started = Date.now(), deadline = started + PHASE_MS;
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
  let wire: ReturnType<typeof savGeminiWireBody>;
  try { wire = savGeminiWireBody(input); }
  catch (error) { return fail(error instanceof Error ? error.message : "SAV_AI_MEDIA_ADMISSION_REQUIRED"); }
  const { output, textBody, textBytes, body, mediaAllowance, visual } = wire;
  const requestBody = textBody;
  const derivedStage = input.phase === "learning_comparison" ? "comparison" : input.phase === "translation" ? "translation" : null;
  const reservationId = derivedStage ? input.derivedReservationId ?? (await reserveSavDerivedCall(derivedStage, input.model, output)).reservationId : null;
  // UTF-8 bytes conservatively reserve input capacity. Unknown failed usage is
  // never refunded. This is an admission bound, not a provider billing estimate.
  const allowance = textBytes + mediaAllowance + output;
  if (visual) {
    if (budget.visualCalls || budget.calls > SAV_AI_BUDGET.calls - 4 || remainingTime(budget) < SAV_ATTACHMENT_LIMITS.readMs + 18_000
      || budget.reservedTokens + allowance > SAV_AI_BUDGET.tokenAllowance - 100_000 || budget.outputTokens + output > SAV_AI_BUDGET.outputTokens - 24_576) return fail("SAV_AI_BUDGET_EXCEEDED");
    budget.visualCalls++;
  }
  for (;;) {
    const remaining = Math.min(deadline - Date.now(), remainingTime(budget));
    if (remaining <= 0 || budget.calls >= SAV_AI_BUDGET.calls || budget.reservedTokens + allowance > SAV_AI_BUDGET.tokenAllowance || budget.outputTokens + output > SAV_AI_BUDGET.outputTokens)
      return fail("SAV_AI_BUDGET_EXCEEDED");
    if (derivedStage && reservationId) await dispatchSavDerivedCall(reservationId, derivedStage, input.model, requestBody);
    budget.calls++; budget.reservedTokens += allowance; budget.outputTokens += output; attempts++;
    const controller = new AbortController();
    // Reserve time before awaiting so concurrent phases cannot spend it twice.
    const attemptMs = Math.min(remaining, visual ? SAV_ATTACHMENT_LIMITS.readMs : ATTEMPT_MS), attemptStarted = Date.now();
    budget.reservedMs += attemptMs;
    const timer = setTimeout(() => controller.abort(), attemptMs);
    let code = "SAV_AI_GENERATION_FAILED", retryAfter = 0;
    try {
      if (derivedStage) savDerivedCostQuote(input.model, output);
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
      budget.reservedTokens += Math.max(0, (generated.metadata.inputTokens ?? 0) - textBytes - mediaAllowance);
      for (const field of ["inputTokens", "outputTokens", "thoughtTokens", "totalTokens"] as const) metadata[field] = derivedStage ? generated.metadata[field] : (metadata[field] ?? 0) + (generated.metadata[field] ?? 0);
      metadata = { ...generated.metadata, ...metadata };
      let json: unknown;
      try { json = parseSavGeminiJson(generated); }
      catch (error) {
        if (derivedStage && reservationId && !controller.signal.aborted && Date.now() <= deadline) await settleSavDerivedCall(reservationId, metadata);
        throw error;
      }
      if (controller.signal.aborted || Date.now() > deadline) return fail("SAV_AI_TIMEOUT");
      if (derivedStage && reservationId) await settleSavDerivedCall(reservationId, metadata);
      metadata.transport = trace(null);
      console.info("sav_ai_transport", { ...savRunProvenance(), ...metadata.transport, ...metadata, transport: undefined });
      return { json, metadata };
    } catch (error) {
      if (error instanceof SavAiTransportError || isSavDerivedBudgetDeferred(error)) throw error;
      if (controller.signal.aborted || error instanceof Error && error.name === "AbortError") code = "SAV_AI_TIMEOUT";
      else if (error instanceof Error && /^SAV_AI_(HTTP_[1-5]\d{2}|INVALID_RESPONSE|INVALID_JSON|OUTPUT_(BLOCKED|TRUNCATED|INCOMPLETE)|EMPTY_OUTPUT)$/.test(error.message)) code = error.message;
    } finally {
      clearTimeout(timer);
      budget.reservedMs -= attemptMs;
      budget.elapsedMs += Math.max(0, Date.now() - attemptStarted);
    }
    const transient = ["SAV_AI_TIMEOUT", "SAV_AI_GENERATION_FAILED", "SAV_AI_HTTP_429", "SAV_AI_HTTP_502", "SAV_AI_HTTP_503", "SAV_AI_HTTP_504"].includes(code);
    const delay = Math.max(0, retryAfter, 200) + Math.floor(Math.random() * 100);
    // Admit a retry only with enough time for a complete second attempt.
    if (derivedStage || visual || input.allowRetry === false || !transient || attempts >= 2 || budget.retries >= SAV_AI_BUDGET.retries || Math.min(deadline - Date.now(), remainingTime(budget)) < delay + ATTEMPT_MS || budget.calls >= SAV_AI_BUDGET.calls) return fail(code);
    budget.retries++;
    const waitStarted = Date.now();
    budget.reservedMs += delay;
    try { await new Promise(resolve => setTimeout(resolve, delay)); }
    finally { budget.reservedMs -= delay; budget.elapsedMs += Math.max(0, Date.now() - waitStarted); }
  }
}
