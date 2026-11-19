import { createHash } from "node:crypto";

/*
 * SAV-109: the bench's ONE door to the model (agent and judge calls alike), reused from the Access evaluation script
 * (`scripts/evaluate-sav-access-skill.ts`): a cache by request fingerprint (an interrupted run resumes without paying twice), a spend cap in EUR
 * checked BEFORE each paid call on its worst case, and a dry-run that never touches the network. It has the shape of `fetch`, so the production
 * transports take it as their `network` unchanged (the same body, parsing and diagnostics as production).
 *
 * Dry-run: no key, no network, no money. A scripted answer stands in for the model (`dryAnswer`), and every body is still measured, so the
 * dry-run gives the estimated cost of the same pass with the real model.
 */

export const SAV_BENCH_CAP_EUR = Object.freeze({ default: 2, max: 10 });
export type SavBenchWireMode = "dry-run" | "live";
export type SavBenchPrices = Readonly<{ eurPerMillionInput: number; eurPerMillionOutput: number }>;
export type SavBenchWireTotals = Readonly<{
  mode: SavBenchWireMode; capEur: number; spentEur: number; paidCalls: number; cachedCalls: number; dryCalls: number; failedCalls: number;
  /** Bodies measured (every call, cached or not): the base of the cost estimate. */
  measuredCalls: number; inputBytes: number;
  /** Estimate of the same calls with the real model: typical (4 bytes per token, `typicalOutputTokens`) and worst (2 bytes per token, max output). */
  estimatedEur: Readonly<{ typical: number; worst: number }> | null;
  stopped: string | null;
}>;
export type SavBenchWire = Readonly<{
  network: (url: string, init: RequestInit) => Promise<Response>;
  totals(): SavBenchWireTotals;
  /** Why the wire refused a call (`spend_cap`), or null. Read by the runner after each turn: the turn is then discarded and the run stops. */
  stopped(): string | null;
}>;

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const bodyText = (init: RequestInit) => typeof init.body === "string" ? init.body : "";

export function createSavBenchWire(options: Readonly<{
  mode: SavBenchWireMode; capEur: number; maxOutputTokens: number; prices: SavBenchPrices | null; typicalOutputTokens?: number;
  cache: Record<string, unknown>; persist?: () => void;
  /** The real network (live only); defaults to `fetch`. */
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  /** Dry-run: the scripted model's JSON answer (a Gemini `generateContent` envelope) for this body. */
  dryAnswer?: (url: string, body: string) => unknown;
}>): SavBenchWire {
  if (!(Number.isFinite(options.capEur) && options.capEur > 0)) throw new Error("SAV_BENCH_CAP_INVALID");
  if (options.capEur > SAV_BENCH_CAP_EUR.max) throw new Error("SAV_BENCH_CAP_ABOVE_APPROVED_10_EUR");
  if (options.mode === "live" && !options.prices) throw new Error("SAV_BENCH_PRICES_REQUIRED");
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  let spentEur = 0, paidCalls = 0, cachedCalls = 0, dryCalls = 0, failedCalls = 0, measuredCalls = 0, inputBytes = 0, typical = 0, worst = 0;
  let stopped: string | null = null;
  const price = (inTokens: number, outTokens: number) => options.prices ? (inTokens * options.prices.eurPerMillionInput + outTokens * options.prices.eurPerMillionOutput) / 1e6 : 0;
  const worstEur = (bytes: number) => price(bytes / 2, options.maxOutputTokens);

  const network = async (url: string, init: RequestInit): Promise<Response> => {
    const body = bodyText(init), bytes = Buffer.byteLength(body);
    // The fingerprint: the endpoint (model) and the exact body. The key travels in a header and never enters it.
    const hash = createHash("sha256").update(JSON.stringify([url.replace(/\?.*$/, ""), body])).digest("hex");
    measuredCalls++; inputBytes += bytes;
    typical += price(bytes / 4, options.typicalOutputTokens ?? 1_500); worst += worstEur(bytes);
    const cached = options.cache[hash];
    if (cached !== undefined) { cachedCalls++; return Response.json(cached); }
    if (options.mode === "dry-run") {
      dryCalls++;
      const answer = options.dryAnswer?.(url, body);
      if (answer === undefined) { failedCalls++; return new Response(null, { status: 503 }); }
      return Response.json(answer);
    }
    if (stopped || spentEur + worstEur(bytes) > options.capEur) {
      stopped = "spend_cap";
      // Refused before sending: the caller reads a failure that consumed nothing; the runner discards the turn and stops.
      return new Response(null, { status: 400, statusText: "SAV_BENCH_SPEND_CAP" });
    }
    paidCalls++;
    let response: Response;
    try { response = await fetcher(url, init); }
    catch (error) { failedCalls++; spentEur += worstEur(bytes); throw error; }
    if (!response.ok) { failedCalls++; spentEur += response.status >= 500 || response.status === 408 || response.status === 429 ? worstEur(bytes) : 0; return response; }
    const json = await response.json().catch(() => null) as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } } | null;
    if (json === null) { failedCalls++; spentEur += worstEur(bytes); return new Response("not json", { status: 200 }); }
    const usage = json.usageMetadata;
    spentEur += usage && Number.isFinite(usage.promptTokenCount) ? price(usage.promptTokenCount ?? 0, (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)) : worstEur(bytes);
    options.cache[hash] = json;
    options.persist?.();
    return Response.json(json);
  };
  return {
    network,
    stopped: () => stopped,
    totals: () => ({ mode: options.mode, capEur: options.capEur, spentEur: round(spentEur), paidCalls, cachedCalls, dryCalls, failedCalls, measuredCalls, inputBytes,
      estimatedEur: options.prices ? { typical: round(typical), worst: round(worst) } : null, stopped }),
  };
}

/** A Gemini `generateContent` envelope around a JSON value (the dry-run's scripted answers). */
export const savBenchGeminiEnvelope = (value: unknown, usage = { promptTokenCount: 0, candidatesTokenCount: 0 }) =>
  ({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: "STOP" }], usageMetadata: usage });
