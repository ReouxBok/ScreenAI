import "server-only";
import { planSavIntake } from "./engine";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall, type IntakeModelTrace } from "./model-readers";
import { withSavAiBudget, requestSavGeminiJson, savGeminiGenerationConfig, savAiErrorMetadata } from "../gemini-transport";
import { evaluationHash, evaluationConfig, type EvaluationBatch, type ServerEvaluationConfig } from "./server-contract";
import { claimServerEvaluation, reserveServerEvaluationCall, settleServerEvaluationCall, saveServerEvaluationResult, readServerEvaluation } from "./server-ledger";
import type { IntakeAdapters, ReadResult } from "./engine-types";

/** Deliberately has no HubSpot/Gmail/network reader or operational service. */
export function snapshotEvaluationReaders(item: EvaluationBatch["cases"][number]): Pick<IntakeAdapters, "findContactsByEmail" | "getContact" | "directAssociations" | "ticketsForContact" | "ticketHistory"> {
  const get = <T>(table: Record<string, ReadResult<T>>, key: string): ReadResult<T> => {
    if (!Object.hasOwn(table, key)) throw Error("SAV_EVAL_SNAPSHOT_MISSING");
    return structuredClone(table[key]);
  };
  return {
    findContactsByEmail: async email => get(item.snapshots.lookups, email.toLowerCase()),
    getContact: async id => get(item.snapshots.contacts, id),
    directAssociations: async id => get(item.snapshots.associations, id),
    ticketsForContact: async id => get(item.snapshots.tickets, id),
    ticketHistory: async id => get(item.snapshots.histories, id),
  };
}

/** Only the fixed Gemini generate endpoint can leave this capability. Buffer the
 * bounded response before the shared transport's response.json() allocation. */
export async function evaluationProviderResponse(response: Response, signal: AbortSignal) {
  if (!response.ok) { await response.body?.cancel(); return new Response(null, { status: response.status }); }
  const reader = response.body?.getReader();
  if (!reader) throw Error("SAV_EVAL_PROVIDER_RESPONSE_REJECTED");
  const chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw Error("SAV_EVAL_CANCELLED");
      const value = await reader.read(); if (value.done) break;
      length += value.value.byteLength;
      if (length > 262_144) throw Error("SAV_EVAL_PROVIDER_RESPONSE_REJECTED");
      chunks.push(value.value);
    }
    if (signal.aborted) throw Error("SAV_EVAL_CANCELLED");
    return new Response(Buffer.concat(chunks, length), { status: response.status, headers: { "content-type": "application/json" } });
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); }
}

export async function runServerEvaluation(batch: EvaluationBatch, config: ServerEvaluationConfig, actorEmail: string, requestSignal: AbortSignal,
  deps: { network?: typeof fetch; env?: () => Record<string, string | undefined> } = {}) {
  const env = deps.env ?? (() => process.env), network = deps.network ?? fetch;
  const lifecycle = new AbortController();
  const sealedBatch = evaluationHash(JSON.stringify(batch));
  const assertLive = () => {
    const fresh = evaluationConfig(env());
    if (JSON.stringify(fresh) !== JSON.stringify(config) || sealedBatch !== config.manifestHash || evaluationHash(JSON.stringify(batch)) !== sealedBatch || batch.campaignId !== config.campaignId || requestSignal.aborted || lifecycle.signal.aborted) throw Error("SAV_EVAL_CONTEXT_CHANGED");
    if (!env().SAV_GEMINI_API_KEY || !env().SAV_ENCRYPTION_KEY_V1 || env().SAV_ENCRYPTION_KEY_V1!.length < 32) throw Error("SAV_EVAL_SERVER_ACCESS_MISSING");
  };
  assertLive();
  const claim = await claimServerEvaluation(config, actorEmail);
  if (!claim.claimed) return readServerEvaluation(config); // Never redispatch a lost/incomplete claim.
  const evidence: { codeRevision: string; model: string; results: unknown[]; modelCalls: number; stopReason: string | null } = { codeRevision: config.codeRevision, model: config.model, results: [], modelCalls: 0, stopReason: null };
  let uncertain = false;
  try {
    for (const item of batch.cases) {
      assertLive();
      if (uncertain) throw Error("SAV_EVAL_USAGE_UNCERTAIN");
      let calls = 0; const traces: IntakeModelTrace[] = [], pending: Promise<unknown>[] = [];
      const execute: IntakeGeminiCall = async input => {
        assertLive();
        if (uncertain || input.signal.aborted || calls >= 3 || evidence.modelCalls >= 9 || input.model !== config.model || input.allowRetry !== false
          || !["understanding", "ticket_matching"].includes(input.phase)) throw Error("SAV_EVAL_DISPATCH_REJECTED");
        const key = env().SAV_GEMINI_API_KEY!;
        const expectedBody = JSON.stringify({ ...input.body, generationConfig: savGeminiGenerationConfig(config.model, input.body.generationConfig) });
        if (Buffer.byteLength(expectedBody, "utf8") > 65_536 || input.body.generationConfig.maxOutputTokens !== 8192) throw Error("SAV_EVAL_REQUEST_REJECTED");
        let reservation: string | null = null, sent = false;
        const guardedNetwork: typeof fetch = async (url, init) => {
          assertLive();
          if (sent || input.signal.aborted || String(url) !== "https://generativelanguage.googleapis.com/v1beta/models/" + config.model + ":generateContent"
            || init?.method !== "POST" || init.body !== expectedBody || new Headers(init.headers).get("x-goog-api-key") !== key) throw Error("SAV_EVAL_NETWORK_REJECTED");
          sent = true;
          reservation = await reserveServerEvaluationCall(claim.id, evaluationHash(expectedBody), actorEmail);
          assertLive();
          calls++; evidence.modelCalls++;
          const signal = AbortSignal.any([requestSignal, lifecycle.signal, input.signal, ...(init.signal ? [init.signal] : [])]);
          if (signal.aborted) throw Error("SAV_EVAL_CANCELLED");
          return evaluationProviderResponse(await network(url, { ...init, signal, redirect: "error" }), signal);
        };
        try {
          const result = await requestSavGeminiJson({ ...input, apiKey: key, fetch: guardedNetwork, allowRetry: false });
          if (!reservation) throw Error("SAV_EVAL_DISPATCH_REJECTED");
          uncertain = !await settleServerEvaluationCall(reservation, result.metadata);
          return result;
        } catch (error) {
          if (reservation) uncertain = !await settleServerEvaluationCall(reservation, savAiErrorMetadata(error));
          throw error;
        }
      };
      const call: IntakeGeminiCall = input => { const work = execute(input); pending.push(work); return work; };
      const semantics = createSavIntakeSemanticReaders({ model: config.model, call, onTrace: trace => traces.push(trace) });
      const plan = await withSavAiBudget(() => planSavIntake(item.input, { ...snapshotEvaluationReaders(item), ...semantics }, item.policy, { timeoutMs: 10_000 }, () => new Date()));
      if (plan.effects !== "not_connected" || plan.steps.some(step => step.status !== "not_dispatched")) throw Error("SAV_EVAL_EFFECT_REJECTED");
      // The engine may return after its own deadline while provider cancellation
      // and durable settlement are still finishing. Never advance/complete first.
      const caseResult = { caseId: item.caseId, plan, traces, calls, callSettlement: "pending" };
      evidence.results.push(caseResult); // Preserve verified plan even if draining fails.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled: PromiseSettledResult<unknown>[];
      try { settled = await Promise.race([Promise.allSettled(pending), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("SAV_EVAL_SETTLEMENT_UNCERTAIN")), 15_000); })]); }
      finally { if (timer) clearTimeout(timer); }
      caseResult.callSettlement = "closed";
      await saveServerEvaluationResult(claim.id, evidence, "running");
      if (uncertain) throw Error("SAV_EVAL_USAGE_UNCERTAIN");
      const rejected = settled.find(value => value.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    }
    await saveServerEvaluationResult(claim.id, evidence, "complete");
  } catch (error) {
    lifecycle.abort();
    evidence.stopReason = error instanceof Error && /^SAV_(?:EVAL|DERIVED)_[A-Z_]+$/.test(error.message) ? error.message : "SAV_EVAL_INTERRUPTED";
    await saveServerEvaluationResult(claim.id, evidence, "uncertain");
  }
  return readServerEvaluation(config);
}
