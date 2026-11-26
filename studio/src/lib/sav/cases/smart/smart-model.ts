import { z } from "zod";
import { prepareV2SkillCall, type AccessSkillDeps } from "../access-skill/access-skill-judge";
import { readAccessSkillWireResponse, SAV_ACCESS_SKILL_GEMINI_URL, type AccessSkillUsage, type AccessSkillWireResult } from "../access-skill/access-skill-wire";
import { resolveCaseV2GeminiKey, SAV_V2_EMBEDDING_MODEL_ENV, SAV_V2_MODEL_ENV, type CaseV2Network } from "../investigation-v2-providers";
import { readCaseV2SpendPolicy, readCaseV2TransportPolicy } from "../investigation-v2-spend";
import { appendCaseAttachmentParts, type CaseCustomerAttachmentMedia } from "../investigation-customer-attachments";
import { SAV_SMART_ATTACHMENT_CALLS } from "./smart-attachments";
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
  | Readonly<{ status: "failed"; problem: string; uncertain: boolean; usage: AccessSkillUsage | null; inputBytes: number; sent: boolean;
    /** v18: on `output_json_invalid`, the object a lenient repair could read (`smartLenientJson`), else absent. Still parsed by the schema and checked. */
    lenient?: unknown }>;
/** One model call of a turn: the port a turn uses (shadow: ledger + deadline; bench: its wire; tests: a script). */
/** `media` (smart images, `smart-attachments.ts`): admitted customer files appended after the text part; absent on every call when the flag is off. */
export type SmartModelPort = (call: Readonly<{ kind: Exclude<SmartCallKind, "embed">; system: string; payload: unknown; temperature: number; media?: readonly CaseCustomerAttachmentMedia[] }>) => Promise<SmartCallResult>;
export type SmartEmbedPort = (texts: readonly string[]) => Promise<Readonly<{ status: "ok"; vectors: number[][] }> | Readonly<{ status: "failed"; problem: string; sent: boolean }>>;

/*
 * SAV-122 (bench 21/11 v7: ~12 turns `correct:finish_not_stop`, one `decide:finish_not_stop`): the body set NO thinking level, so a Gemini 3
 * model thought at its default (dynamic, high) level, and its thoughts count against the SAME `maxOutputTokens` (the policy's, never raised
 * here) as the JSON decision: the long decide / correct answers were cut (`MAX_TOKENS`). Like V1 (`savGeminiGenerationConfig`) and V2's
 * `SAV_V2_THINKING_DECISION`, a Gemini 3 model now thinks at the « low » level on every call of the new agent. Other models: unchanged body.
 */
export const SAV_SMART_THINKING_LEVEL = "low";
const GEMINI_3 = /^gemini-3(?:[.-])/;
/** The exact body of one call: system instruction, the data as ONE JSON user part (data, never instructions), JSON output. */
export function smartWireBody(system: string, payload: unknown, maxOutputTokens: number, temperature: number, model = ""): string {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
    generationConfig: { responseMimeType: "application/json", temperature, maxOutputTokens, ...(GEMINI_3.test(model) ? { thinkingConfig: { thinkingLevel: SAV_SMART_THINKING_LEVEL } } : {}) },
  });
}
export const smartWireBytes = (system: string, payload: unknown, maxOutputTokens = 8192, temperature = 0) => Buffer.byteLength(smartWireBody(system, payload, maxOutputTokens, temperature), "utf8");

/*
 * SAV-122 (bench v11: `output_json_invalid` on decide (mdp-03) and correct (mdp-02)). Not the « low » thinking: a cut answer ends with
 * `MAX_TOKENS` and is read first as `finish_not_stop`; these answers ended with `STOP` and a text that `JSON.parse` refused. The text is never
 * logged, so its form is now a CLOSED code, and the forms a reader can undo deterministically are read: a Markdown fence, text before or
 * after the object, a raw line break or tab inside a string. Nothing else is guessed (an unbalanced, repeated or otherwise broken object stays
 * refused).
 */
export type SmartJsonForm = "fenced" | "leading_text" | "trailing_text" | "control_char" | "unbalanced" | "multiple" | "other";
export function smartReadJson(text: string): Readonly<{ ok: true; value: unknown; form: SmartJsonForm | null }> | Readonly<{ ok: false; form: SmartJsonForm }> {
  const parse = (value: string) => { try { return { ok: true as const, value: JSON.parse(value) as unknown }; } catch { return { ok: false as const }; } };
  const whole = parse(text);
  if (whole.ok) return { ok: true, value: whole.value, form: null };
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const fenced = unfenced !== text.trim();
  const start = unfenced.search(/[{[]/);
  if (start < 0) return { ok: false, form: "other" };
  // One string-aware scan: the end of the first balanced object, raw control characters inside strings escaped.
  let depth = 0, inString = false, escaped = false, end = -1, repaired = "", control = false;
  for (let index = start; index < unfenced.length && end < 0; index++) {
    const char = unfenced[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      else if (char === "\n" || char === "\r" || char === "\t") { control = true; repaired += char === "\t" ? "\\t" : char === "\r" ? "\\r" : "\\n"; continue; }
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") { depth--; if (depth === 0) end = index; }
    repaired += char;
  }
  if (end < 0) return { ok: false, form: "unbalanced" };
  // PORTE 2G (P1): more than one root object (« conforme » then « non_conforme », even cut) is never read as its first one.
  if (/[{[]/.test(unfenced.slice(end + 1))) return { ok: false, form: "multiple" };
  const read = parse(repaired);
  if (!read.ok) return { ok: false, form: "other" };
  const form: SmartJsonForm = control ? "control_char" : fenced ? "fenced" : start > 0 ? "leading_text" : "trailing_text";
  return { ok: true, value: read.value, form };
}
/** V2's reader of a Gemini answer, with the smart agent's JSON reading (above); a refused text says its form: `output_json_invalid:<form>`. */
export function smartWireResponse(json: unknown): AccessSkillWireResult {
  const read = readAccessSkillWireResponse(json);
  if (read.status === "ok" || read.problem !== "output_json_invalid") return read;
  const text = ((json as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }).candidates?.[0]?.content?.parts ?? [])
    .map(part => typeof part.text === "string" ? part.text : "").join("");
  const own = smartReadJson(text);
  if (own.ok) return { status: "ok", output: own.value, usage: read.usage };
  // v18: the refusal stays a refusal (one new attempt first, `smart-agent.ts`); the lenient reading travels with it for the decide pass only.
  const lenient = own.form === "multiple" ? null : smartLenientJson(text);
  const failed = { ...read, problem: `output_json_invalid:${own.form}`, ...(lenient !== null ? { lenient } : {}) };
  return failed;
}

/*
 * v18 (bench 22/11, pareil-02: decide JSON invalid three times, then a handoff). A LENIENT reading, used only after the one new attempt: the first
 * object, a trailing comma before a closing bracket removed, the missing closing brackets added at the end. An answer cut INSIDE a string (a reply
 * cut mid-sentence) is never repaired, nor several root objects. Null when nothing can be read. The value is still parsed by the step schema and
 * goes through every check: unparsed text is never sent.
 */
export function smartLenientJson(text: string): unknown {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  if (start < 0) return null;
  const stack: string[] = [];
  let out = "", inString = false, escaped = false, closed = false, end = unfenced.length;
  for (let index = start; index < unfenced.length && !closed; index++) {
    end = index + 1;
    const char = unfenced[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      else if (char === "\n" || char === "\r" || char === "\t") { out += char === "\t" ? "\\t" : char === "\r" ? "\\r" : "\\n"; continue; }
      out += char; continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return null;
      out = out.replace(/,\s*$/, "");
      if (!stack.length) closed = true;
    }
    out += char;
  }
  if (inString) return null;
  if (closed && /[{[]/.test(unfenced.slice(end))) return null;
  const repaired = out.replace(/,\s*$/, "") + [...stack].reverse().join("");
  try { const value = JSON.parse(repaired) as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
}

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

/**
 * The usage of one Gemini answer, only when it is COMPLETE: input and output counts both present, safe non-negative integers (thoughts optional,
 * same rule). Anything else (absent output count, unreadable metadata) is null, and a null usage costs the full reservation, never zero.
 */
export function smartUsageOf(meta: unknown): AccessSkillUsage | null {
  if (!meta || typeof meta !== "object") return null;
  const { promptTokenCount: input, candidatesTokenCount: output, thoughtsTokenCount: thoughts } = meta as Record<string, unknown>;
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!count(input) || !count(output) || (thoughts !== undefined && !count(thoughts))) return null;
  return { inputTokens: input, outputTokens: output + (thoughts ?? 0) };
}

/**
 * The prices of V2's approved policy (read only). A call costs its MEASURED cost from a complete usage, even above its reservation (never
 * clipped: the ledger must see the real spend); an unknown or incomplete usage costs its reservation.
 */
export function smartPrices(env: Env) {
  const read = readCaseV2SpendPolicy(env);
  if (!read.ok) return null;
  const { model, embedding } = read.policy;
  return {
    modelReserve: model.reserveMicroUsdPerCall, embeddingReserve: embedding.reserveMicroUsdPerCall,
    modelCost: (usage: AccessSkillUsage | null) => {
      if (!usage || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || usage.inputTokens < 0 || usage.outputTokens < 0) return model.reserveMicroUsdPerCall;
      const measured = Math.ceil((usage.inputTokens * model.microUsdPerMillionInputTokens + usage.outputTokens * model.microUsdPerMillionOutputTokens) / 1_000_000);
      return Number.isSafeInteger(measured) ? measured : model.reserveMicroUsdPerCall;
    },
  };
}

/** V2's transport for one call, no budget: refused before sending when the key, model, policy or byte cap says no. */
export function smartGeminiModel(deps: AccessSkillDeps & Readonly<{ callTimeoutMs?: () => number }>): SmartModelPort {
  return async ({ system, payload, temperature, media }) => {
    const env = deps.env(), cap = smartInputCap(env, deps.now());
    let inputBytes = 0;
    // Smart images: the text body is measured and bounded exactly as before (cap and policy `maxInputBytes`); the admitted files are appended to
    // the body on the wire only, after those checks, as V2's decision call does (`appendCaseAttachmentParts`). No media: the same network as before.
    const network = media?.length ? smartNetworkWithMedia(deps.network, media) : deps.network;
    const prepared = prepareV2SkillCall({ env: deps.env, now: deps.now, network, timeoutMs: deps.callTimeoutMs?.() ?? deps.timeoutMs }, maxOutputTokens => {
      const body = smartWireBody(system, payload, maxOutputTokens, temperature, env[SAV_V2_MODEL_ENV] ?? "");
      inputBytes = Buffer.byteLength(body, "utf8");
      return body;
    }, smartWireResponse);
    if (!prepared.ok) return { status: "failed", problem: prepared.call.status === "failed" ? prepared.call.problem : "skipped", uncertain: false, usage: null, inputBytes, sent: false };
    if (cap === null) return { status: "failed", problem: "cap_invalid", uncertain: false, usage: null, inputBytes, sent: false };
    if (inputBytes > cap) return { status: "failed", problem: "input_too_large", uncertain: false, usage: null, inputBytes, sent: false };
    const result = await prepared.send();
    return result.status === "ok" ? { status: "ok", output: result.output, usage: result.usage, inputBytes }
      : { status: "failed", problem: result.problem, uncertain: result.uncertain, usage: result.usage, inputBytes, sent: true,
        ...("lenient" in result && result.lenient !== undefined ? { lenient: result.lenient } : {}) };
  };
}

/** The network of one call that carries files: the same request, the files appended as `inlineData` parts after the text part. */
function smartNetworkWithMedia(network: CaseV2Network | undefined, media: readonly CaseCustomerAttachmentMedia[]): CaseV2Network {
  const send = network ?? ((url, init) => fetch(url, init));
  return (url, init) => send(url, typeof init.body === "string" ? { ...init, body: appendCaseAttachmentParts(init.body, media) } : init);
}

/**
 * Smart images: the token allowance of the files ONE call may carry. The policy leaves `maxInputTokens - maxInputBytes` tokens above the text bound
 * of a call (≥ 16 384); the turn's single reservation is computed from `maxInputTokens`. That room is shared by every call of the turn that may carry
 * the files (`SAV_SMART_ATTACHMENT_CALLS`), so all the image tokens of a turn fit inside it. 0 (nothing attached) when the policy cannot be read.
 */
export function smartAttachmentTokenRoom(env: Env, now: Date): number {
  try {
    const bounds = readCaseV2TransportPolicy(env, now);
    return Math.max(0, Math.floor((bounds.maxInputTokens - bounds.maxInputBytes) / SAV_SMART_ATTACHMENT_CALLS));
  } catch { return 0; }
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
