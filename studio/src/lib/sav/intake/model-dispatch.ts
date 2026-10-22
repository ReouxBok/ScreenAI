import "server-only";
import { reconcileIntakeZeroThoughtUsage } from "./model-usage";
import type { IntakeGeminiCall } from "./model-readers";
import { readSavGeminiResponse, type SavGeminiMetadata } from "../gemini-response";
import { requestSavGeminiJson, savAiErrorMetadata, savGeminiWireBody } from "../gemini-transport";
import { evaluationProviderResponse } from "./server-runner";
import { intakeRuntimeHash, type IntakeRuntimeConfig } from "./runtime-contract";
import { settleSavIntakeCall, type reserveSavIntakeCall } from "./runtime-store";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";

/** Fixed model endpoint and exact-body reservation, shared by automatic work
 * and authenticated human continuations. No CRM/Gmail write capability. */
export function createIntakeModelDispatcher(options: { config: IntakeRuntimeConfig; live: () => Promise<void>;
  reserve: (hash: string) => ReturnType<typeof reserveSavIntakeCall>; signal: AbortSignal;
  env?: () => Record<string,string|undefined>; network?: typeof fetch }) {
  const {config,live}=options, env=options.env??(()=>process.env), network=options.network??fetch;
  let uncertain=false, failureReason:string|undefined;
  const pending:Promise<unknown>[]=[];
  const execute: IntakeGeminiCall = async input => {
      await live();
      if (input.model !== config.model || input.allowRetry !== false || input.signal.aborted || uncertain) throw Error("SAV_INTAKE_RUNTIME_DISPATCH_REJECTED");
      const key = env().SAV_GEMINI_API_KEY!;
      const wire = savGeminiWireBody(input);
      const expectedBody = wire.body;
      if (wire.textBytes > SAV_INTAKE_MODEL_LIMITS.wireTextBytes || input.body.generationConfig.maxOutputTokens !== 8192) throw Error("SAV_INTAKE_RUNTIME_REQUEST_REJECTED");
      let sent = false;
      const reserved = await options.reserve(intakeRuntimeHash(expectedBody));
      if (reserved.cached) return reserved.cached;
      const reservation = reserved.id;
      let providerUsage: SavGeminiMetadata | undefined;
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
        sent = true;
        await live();
        const signal = AbortSignal.any([options.signal, input.signal, ...(init.signal ? [init.signal] : [])]);
        if (signal.aborted) throw Error("SAV_INTAKE_RUNTIME_CONTEXT_CHANGED");
        const response = await evaluationProviderResponse(await network(url, { ...init, signal, redirect: "error" }), signal);
        if (response.ok) {
          try { providerUsage = readSavGeminiResponse(await response.clone().json()).metadata; }
          catch { providerUsage = undefined; }
        }
        return response;
      };
      try {
        const generated = await requestSavGeminiJson({ ...input, apiKey: key, fetch: guardedNetwork, allowRetry: false });
        const metadata = exactUsage(generated.metadata);
        let json: unknown;
        try { json = input.media ? input.sanitizeResponse?.(generated.json) : generated.json;
          if (input.media && !input.sanitizeResponse) throw Error("SAV_INTAKE_VISUAL_VALIDATOR_REQUIRED");
        } catch (error) { uncertain = !await settleSavIntakeCall(reservation!, metadata); throw error; }
        const result = { json, metadata };
        if (!reservation) throw Error("SAV_INTAKE_RUNTIME_DISPATCH_REJECTED");
        uncertain = !await settleSavIntakeCall(reservation, result.metadata, result);
        return result;
      } catch (error) {
        if (reservation) uncertain = !await settleSavIntakeCall(reservation, exactUsage(savAiErrorMetadata(error)));
        failureReason = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_PROVIDER_UNAVAILABLE";
        throw error;
      }
    };
    const call: IntakeGeminiCall = input => { const work = execute(input).catch(error => {
      failureReason = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_PROVIDER_UNAVAILABLE";
      throw error;
    }); pending.push(work); return work; };

  return { call, pending, get uncertain() { return uncertain; }, get failureReason() { return failureReason; } };
}
