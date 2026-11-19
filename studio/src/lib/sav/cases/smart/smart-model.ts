import { z } from "zod";
import { prepareV2SkillCall, type AccessSkillDeps } from "../access-skill/access-skill-judge";
import { SAV_ACCESS_SKILL_GEMINI_URL, type AccessSkillUsage } from "../access-skill/access-skill-wire";
import { resolveCaseV2GeminiKey, SAV_V2_EMBEDDING_MODEL_ENV, type CaseV2Network } from "../investigation-v2-providers";
import { readCaseV2SpendPolicy, readCaseV2TransportPolicy } from "../investigation-v2-spend";
import type { SmartCallKind } from "./smart-contract";

/*
 * Agent SAV intelligent (20/11): the wire of the new agent's calls on V2's EXISTING Gemini transport, with NO budget of V2: the shadow has
 * its own ledger (`smart-ledger.ts`), the bench its own wire. V2's key resolution, model (`SAV_V2_MODEL`, the one model already approved),
 * transport bounds and byte cap (`prepareV2SkillCall`: the policy's `maxInputBytes`, never raised here; an own lower cap may be set) apply.
 * One send per call, no retry. Only the endpoint is called; the provider's text is never logged.
 *
 * The embedding call (knowledge search) is the same `batchEmbedContents` request as V2's (`caseGeminiEmbeddingTransport`), but behind the
 * shadow's ledger instead of V2's reservation. The provider reports no usage for it: it always costs its reservation.
 */

type Env = Readonly<Record<string, string | undefined>>;
export type SmartCallResult =
  | Readonly<{ status: "ok"; output: unknown; usage: AccessSkillUsage | null; inputBytes: number }>
  | Readonly<{ status: "failed"; problem: string; uncertain: boolean; usage: AccessSkillUsage | null; inputBytes: number; sent: boolean }>;
/** One model call of a turn: the port a turn uses (shadow: ledger + deadline; bench: its wire; tests: a script). */
export type SmartModelPort = (call: Readonly<{ kind: Exclude<SmartCallKind, "embed">; system: string; payload: unknown; temperature: number }>) => Promise<SmartCallResult>;
export type SmartEmbedPort = (texts: readonly string[]) => Promise<Readonly<{ status: "ok"; vectors: number[][] }> | Readonly<{ status: "failed"; problem: string; sent: boolean }>>;

/** The exact body of one call: system instruction, the data as ONE JSON user part (data, never instructions), JSON output. */
export function smartWireBody(system: string, payload: unknown, maxOutputTokens: number, temperature: number): string {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
    generationConfig: { responseMimeType: "application/json", temperature, maxOutputTokens },
  });
}
export const smartWireBytes = (system: string, payload: unknown, maxOutputTokens = 8192, temperature = 0) => Buffer.byteLength(smartWireBody(system, payload, maxOutputTokens, temperature), "utf8");

/** The byte cap of one call: the transport's existing `maxInputBytes`, or an own LOWER cap (`SAV_V2_SMART_MAX_INPUT_BYTES`); never above. */
export const SAV_SMART_MAX_INPUT_BYTES_ENV = "SAV_V2_SMART_MAX_INPUT_BYTES";
export function smartInputCap(env: Env, now: Date): number | null {
  let bounds: ReturnType<typeof readCaseV2TransportPolicy>;
  try { bounds = readCaseV2TransportPolicy(env, now); } catch { return null; }
  const raw = env[SAV_SMART_MAX_INPUT_BYTES_ENV];
  if (raw === undefined || raw === "") return bounds.maxInputBytes;
  const own = /^[0-9]{1,7}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(own) && own >= 4_000 ? Math.min(own, bounds.maxInputBytes) : null;
}

/** The prices of V2's approved policy (read only): what a call costs, from its usage, or its reservation when the usage is unknown. */
export function smartPrices(env: Env) {
  const read = readCaseV2SpendPolicy(env);
  if (!read.ok) return null;
  const { model, embedding } = read.policy;
  return {
    modelReserve: model.reserveMicroUsdPerCall, embeddingReserve: embedding.reserveMicroUsdPerCall,
    modelCost: (usage: AccessSkillUsage | null) => usage
      ? Math.min(model.reserveMicroUsdPerCall, Math.ceil((usage.inputTokens * model.microUsdPerMillionInputTokens + usage.outputTokens * model.microUsdPerMillionOutputTokens) / 1_000_000))
      : model.reserveMicroUsdPerCall,
  };
}

/** V2's transport for one call, no budget: refused before sending when the key, model, policy or byte cap says no. */
export function smartGeminiModel(deps: AccessSkillDeps & Readonly<{ callTimeoutMs?: () => number }>): SmartModelPort {
  return async ({ system, payload, temperature }) => {
    const env = deps.env(), cap = smartInputCap(env, deps.now());
    let inputBytes = 0;
    const prepared = prepareV2SkillCall({ env: deps.env, now: deps.now, network: deps.network, timeoutMs: deps.callTimeoutMs?.() ?? deps.timeoutMs }, maxOutputTokens => {
      const body = smartWireBody(system, payload, maxOutputTokens, temperature);
      inputBytes = Buffer.byteLength(body, "utf8");
      return body;
    });
    if (!prepared.ok) return { status: "failed", problem: prepared.call.status === "failed" ? prepared.call.problem : "skipped", uncertain: false, usage: null, inputBytes, sent: false };
    if (cap === null) return { status: "failed", problem: "cap_invalid", uncertain: false, usage: null, inputBytes, sent: false };
    if (inputBytes > cap) return { status: "failed", problem: "input_too_large", uncertain: false, usage: null, inputBytes, sent: false };
    const result = await prepared.send();
    return result.status === "ok" ? { status: "ok", output: result.output, usage: result.usage, inputBytes }
      : { status: "failed", problem: result.problem, uncertain: result.uncertain, usage: result.usage, inputBytes, sent: true };
  };
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const embedResponse = z.object({ embeddings: z.array(z.object({ values: z.array(z.number()) })) });
/** The embedding request of the knowledge search, same body as V2's, no V2 reservation (the shadow's ledger reserved it). */
export function smartGeminiEmbed(deps: Readonly<{ env: () => Env; now: () => Date; network?: CaseV2Network; dimension: number; callTimeoutMs?: () => number }>): SmartEmbedPort {
  return async texts => {
    const env = deps.env(), key = resolveCaseV2GeminiKey(env), model = env[SAV_V2_EMBEDDING_MODEL_ENV] ?? "";
    if (!key.ok) return { status: "failed", problem: "key_unavailable", sent: false };
    if (!MODEL_ID.test(model)) return { status: "failed", problem: "embedding_model_invalid", sent: false };
    let bounds: ReturnType<typeof readCaseV2TransportPolicy>;
    try { bounds = readCaseV2TransportPolicy(env, deps.now()); } catch { return { status: "failed", problem: "policy_invalid", sent: false }; }
    if (!texts.length || texts.length > bounds.embeddingMaxTexts || texts.some(text => !text.trim() || Buffer.byteLength(text, "utf8") > bounds.embeddingMaxTextBytes))
      return { status: "failed", problem: "embedding_unbounded", sent: false };
    const network = deps.network ?? ((url, init) => fetch(url, init));
    try {
      const response = await network(`${SAV_ACCESS_SKILL_GEMINI_URL}/${encodeURIComponent(model)}:batchEmbedContents`, {
        method: "POST", signal: AbortSignal.timeout(deps.callTimeoutMs?.() ?? 15_000), headers: { "content-type": "application/json", "x-goog-api-key": key.key },
        body: JSON.stringify({ requests: texts.map(text => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: deps.dimension })) }),
      });
      if (!response.ok) { await response.body?.cancel(); return { status: "failed", problem: `http_${response.status}`, sent: true }; }
      const parsed = embedResponse.safeParse(await response.json());
      if (!parsed.success || parsed.data.embeddings.length !== texts.length || parsed.data.embeddings.some(row => row.values.length !== deps.dimension))
        return { status: "failed", problem: "embedding_invalid", sent: true };
      return { status: "ok", vectors: parsed.data.embeddings.map(row => row.values) };
    } catch { return { status: "failed", problem: "network_failed", sent: true }; }
  };
}
