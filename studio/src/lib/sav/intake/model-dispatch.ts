import "server-only";
import { z } from "zod";
import { reconcileIntakeZeroThoughtUsage } from "./model-usage";
import type { IntakeGeminiCall } from "./model-readers";
import { readSavGeminiResponse, type SavGeminiMetadata } from "../gemini-response";
import { requestSavGeminiJson, savAiCancellationCode, savAiErrorMetadata, savGeminiWireBody } from "../gemini-transport";
import { evaluationProviderResponse } from "./server-runner";
import { intakeRuntimeHash, type IntakeRuntimeConfig } from "./runtime-contract";
import { settleSavIntakeCall, type reserveSavIntakeCall } from "./runtime-store";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";

/** Fixed model endpoint and exact-body reservation, shared by automatic work
 * and authenticated human continuations. No CRM/Gmail write capability. */
export function createIntakeModelDispatcher(options: { config: IntakeRuntimeConfig; live: () => Promise<void>;
  reserve: (hash: string) => ReturnType<typeof reserveSavIntakeCall>; signal: AbortSignal;
  preflight?: (hashes: string[]) => Promise<void>;
  env?: () => Record<string,string|undefined>; network?: typeof fetch;
  /** Informational: the ledger, not this ordinal, decides whether a body may be dispatched again. */
  retryOrdinal?: number;
  /** Settlement of a reservation; the live ledger by default, a separate one for the comparison. */
  settle?: typeof settleSavIntakeCall }) {
  const {config,live}=options, env=options.env??(()=>process.env), network=options.network??fetch, settle=options.settle??settleSavIntakeCall;
  let uncertain=false, failureReason:string|undefined;
  const pending:Promise<unknown>[]=[];
  const execute: IntakeGeminiCall = async input => {
      const signal = AbortSignal.any([options.signal, input.signal]);
      const active = () => { const code = savAiCancellationCode(signal); if (code) throw Error(code); };
      active();
      await live();
      active();
      if (input.model !== config.model || input.allowRetry !== false || input.signal.aborted || uncertain) throw Error("SAV_INTAKE_RUNTIME_DISPATCH_REJECTED");
      const key = env().SAV_GEMINI_API_KEY!;
      const wire = savGeminiWireBody(input);
      const expectedBody = wire.body;
      if (wire.textBytes > SAV_INTAKE_MODEL_LIMITS.wireTextBytes || input.body.generationConfig.maxOutputTokens !== 8192) throw Error("SAV_INTAKE_RUNTIME_REQUEST_REJECTED");
      let sent = false;
      // The store resolves the exact ledger row (cache, retry of an unbilled rejection, or new),
      // with the same rule as the preflight of a grouped plan.
      const reserved = await options.reserve(intakeRuntimeHash(expectedBody));
      if (reserved.cached) { active(); failureReason = undefined; return reserved.cached; }
      const reservation = reserved.id;
      let providerUsage: SavGeminiMetadata | undefined, providerStatus: number | undefined;
      // Gemini may omit a zero thoughts counter. Recognize only that zero when
      // the three explicit counters prove the accounting equation; never infer
      // other missing counters or a positive remainder. Settlement stays strict.
      const exactUsage = (metadata?: SavGeminiMetadata) => reconcileIntakeZeroThoughtUsage({ ...metadata,
        inputTokens:providerUsage?.inputTokens,outputTokens:providerUsage?.outputTokens,
        thoughtTokens:providerUsage?.thoughtTokens,totalTokens:providerUsage?.totalTokens });
      const guardedNetwork: typeof fetch = async (url, init) => {
        await live();
        if (sent || input.signal.aborted || String(url) !== `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`
          || init?.method !== "POST" || init.body !== expectedBody || new Headers(init.headers).get("x-goog-api-key") !== key) throw Error("SAV_INTAKE_RUNTIME_NETWORK_REJECTED");
        active();
        await live();
        active();
        sent = true;
        const signal = AbortSignal.any([options.signal, input.signal, ...(init.signal ? [init.signal] : [])]);
        if (signal.aborted) throw Error("SAV_INTAKE_RUNTIME_CONTEXT_CHANGED");
        const response = await evaluationProviderResponse(await network(url, { ...init, signal, redirect: "error" }), signal);
        providerStatus = response.status;
        if (response.ok) {
          try { providerUsage = readSavGeminiResponse(await response.clone().json()).metadata; }
          catch { providerUsage = undefined; }
        }
        return response;
      };
      try {
        active();
        const generated = await requestSavGeminiJson({ ...input, signal, apiKey: key, fetch: guardedNetwork, allowRetry: false });
        const metadata = exactUsage(generated.metadata);
        if (input.media && !input.sanitizeResponse) throw Error("SAV_INTAKE_VISUAL_VALIDATOR_REQUIRED");
        const json = input.media ? input.sanitizeResponse!(generated.json) : generated.json;
        const result = { json, metadata };
        if (!reservation) throw Error("SAV_INTAKE_RUNTIME_DISPATCH_REJECTED");
        uncertain = !await settle(reservation, result.metadata, result);
        failureReason = undefined;
        return result;
      } catch (error) {
        // A complete 429/5xx answer from the provider means the request was not processed:
        // settled at zero, explicitly marked. A timeout or lost answer stays uncertain.
        const unbilled = providerStatus !== undefined && (providerStatus === 429 || providerStatus >= 500 && providerStatus <= 599)
          && error instanceof Error && error.message === `SAV_AI_HTTP_${providerStatus}` ? providerStatus : undefined;
        if (reservation) uncertain = !await (unbilled === undefined ? settle(reservation, exactUsage(savAiErrorMetadata(error)))
          : settle(reservation, exactUsage(savAiErrorMetadata(error)), undefined, unbilled));
        failureReason = error instanceof z.ZodError ? "SAV_INTAKE_MODEL_OUTPUT_REJECTED"
          : error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_PROVIDER_UNAVAILABLE";
        throw error;
      }
    };
    const call: IntakeGeminiCall = input => { const work = execute(input).catch(error => {
      failureReason = error instanceof z.ZodError ? "SAV_INTAKE_MODEL_OUTPUT_REJECTED"
        : error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_PROVIDER_UNAVAILABLE";
      throw error;
    }); pending.push(work); return work; };

  const plan = async (inputs: Parameters<IntakeGeminiCall>[0][]) => {
    try {
      const code = savAiCancellationCode(options.signal); if (code) throw Error(code);
      await live();
      if (!options.preflight || options.signal.aborted || uncertain || !inputs.length || inputs.length > 3) throw Error("SAV_INTAKE_RUNTIME_BATCH_PLANNING_REQUIRED");
      const hashes = inputs.map(input => {
        const wire = savGeminiWireBody(input);
        if (input.model !== config.model || input.phase !== "ticket_matching" || input.media || input.allowRetry !== false || input.signal.aborted
          || wire.textBytes > SAV_INTAKE_MODEL_LIMITS.wireTextBytes || input.body.generationConfig.maxOutputTokens !== 8192) throw Error("SAV_INTAKE_RUNTIME_REQUEST_REJECTED");
        return intakeRuntimeHash(wire.body);
      });
      await options.preflight(hashes);
      await live();
    } catch (error) {
      failureReason = error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_BATCH_PLANNING_FAILED";
      throw error;
    }
  };
  return { call, plan, pending, get uncertain() { return uncertain; }, get failureReason() { return failureReason; } };
}
