import { z } from "zod";
import { savSemanticArtifactHash } from "./semantic-evaluation";

export const SAV_EVALUATION_ADAPTER_REVISION = "sav-isolated-analysis-v1";
const record = z.record(z.string(), z.unknown());
export const savPrivateModelCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  input: z.object({ from: z.string().max(300), subject: z.string().max(1000), body: z.string().max(100000),
    autoSubmitted: z.string().optional(), displayName: z.string().max(300).optional(),
    conversation: record.optional(), dossierContext: record.optional(),
  }).strict(),
  knowledge: z.object({ revision: z.string().min(1), results: z.array(record).max(100) }).strict(),
  crm: record,
}).strict();
export type SavPrivateModelCase = z.infer<typeof savPrivateModelCaseSchema>;
export type SavIsolatedAnalysis = (input: SavPrivateModelCase["input"], context: { evaluation: {
  apiKey: string; model: string; mode: "off" | "shadow" | "pilot" | "on"; pilot: boolean;
  searchKnowledge: () => Promise<SavPrivateModelCase["knowledge"]>;
  readHubspotContext: () => Promise<SavPrivateModelCase["crm"]>; fetch: typeof fetch;
} }) => Promise<unknown>;

export function assertSavEvaluationEnvironment(env: Record<string, string | undefined>) {
  if (env.SAV_EVAL_ALLOW_MODEL_CALLS !== "1" || !env.SAV_EVAL_GEMINI_API_KEY?.trim()) throw new Error("SAV_SEMANTIC_EXPLICIT_MODEL_OPT_IN_REQUIRED");
  const forbidden = /^(?:DATABASE.*|DB_.*|DIRECT_URL|POSTGRES.*|NEON.*|PG(?:HOST|USER|PASSWORD|DATABASE|PORT)|HUBSPOT.*|GMAIL.*|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_API_KEY|GEMINI_API_KEY|GOOGLE_CLOUD.*|GCLOUD.*|SAV_(?!EVAL_).*)$/i;
  if (Object.entries(env).some(([key, value]) => value && forbidden.test(key))) throw new Error("SAV_SEMANTIC_PRODUCTION_ENV_FORBIDDEN");
}

export type SavEvaluationRequest = { status: number | null; durationMs: number; requestId: string | null; inputTokens: number | null; outputTokens: number | null; responseHash: string | null; errorCode: "transport_failure" | "response_unreadable" | null };
/** Process fetch guard; OS/network sandboxing remains a separate requirement for a real campaign. */
export function createSavEvaluationFetch(options: { apiKey: string; model: string; fetch: typeof fetch; requests: SavEvaluationRequest[] }): typeof fetch {
  return async (resource, init) => {
    const request = resource instanceof Request ? resource : null;
    const url = new URL(request?.url ?? String(resource));
    const headers = new Headers(init?.headers ?? request?.headers);
    const key = url.searchParams.get("key") ?? headers.get("x-goog-api-key");
    const expectedPath = `/v1beta/models/${options.model}`;
    if (url.protocol !== "https:" || url.hostname !== "generativelanguage.googleapis.com" || url.port
      || ![`${expectedPath}:generateContent`, `${expectedPath}:streamGenerateContent`].includes(decodeURIComponent(url.pathname))
      || (init?.method ?? request?.method ?? "GET").toUpperCase() !== "POST" || key !== options.apiKey) {
      throw new Error("SAV_SEMANTIC_EXTERNAL_REQUEST_BLOCKED");
    }
    const started = Date.now();
    // Manual redirect prevents a provider response from bypassing the host restriction.
    let response: Response;
    try { response = await options.fetch(resource, { ...init, redirect: "error" }); }
    catch (error) {
      options.requests.push({ status: null, durationMs: Date.now() - started, requestId: null, inputTokens: null, outputTokens: null, responseHash: null, errorCode: "transport_failure" });
      throw error;
    }
    let content: string;
    try { content = await response.clone().text(); }
    catch (error) {
      options.requests.push({ status: response.status, durationMs: Date.now() - started, requestId: response.headers.get("x-request-id"), inputTokens: null, outputTokens: null, responseHash: null, errorCode: "response_unreadable" });
      throw error;
    }
    let payloads: Array<Record<string, unknown>> = [];
    try {
      const parsed: unknown = JSON.parse(content);
      payloads = (Array.isArray(parsed) ? parsed : [parsed]).filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
    } catch {
      for (const line of content.split("\n")) if (line.startsWith("data: ")) {
        try { const parsed: unknown = JSON.parse(line.slice(6)); if (parsed && typeof parsed === "object") payloads.push(parsed as Record<string, unknown>); } catch { /* Invalid provider text is reported by the pipeline. */ }
      }
    }
    const last = payloads.findLast((item) => item.usageMetadata && typeof item.usageMetadata === "object");
    const usage = last?.usageMetadata as Record<string, unknown> | undefined;
    const count = (name: string) => typeof usage?.[name] === "number" && Number.isFinite(usage[name]) ? usage[name] as number : null;
    const output = count("candidatesTokenCount"), thoughts = count("thoughtsTokenCount");
    options.requests.push({ status: response.status, durationMs: Date.now() - started,
      requestId: response.headers.get("x-request-id") ?? (typeof last?.responseId === "string" ? last.responseId : null),
      inputTokens: count("promptTokenCount"), outputTokens: output === null ? null : output + (thoughts ?? 0), responseHash: savSemanticArtifactHash(content), errorCode: null });
    return response;
  };
}

/** Returns raw private evidence, never fabricated expected labels or human verdicts. */
export async function runSavPrivateModelCase(testCase: SavPrivateModelCase, options: {
  apiKey: string; model: string; mode: "off" | "shadow" | "pilot" | "on"; analyze: SavIsolatedAnalysis; fetch: typeof fetch; requests?: SavEvaluationRequest[];
}) {
  const parsed = savPrivateModelCaseSchema.parse(testCase);
  const requests = options.requests ?? [], offset = requests.length, started = Date.now();
  const guardedFetch = createSavEvaluationFetch({ ...options, requests });
  const result = await options.analyze(parsed.input, { evaluation: { apiKey: options.apiKey, model: options.model, mode: options.mode, pilot: options.mode === "pilot",
    searchKnowledge: async () => structuredClone(parsed.knowledge), readHubspotContext: async () => structuredClone(parsed.crm), fetch: guardedFetch } });
  return { caseId: parsed.id, inputHash: savSemanticArtifactHash(parsed), outputHash: savSemanticArtifactHash(result),
    durationMs: Date.now() - started, requests: requests.slice(offset), result, humanReview: null };
}
