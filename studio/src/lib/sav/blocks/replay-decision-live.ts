import "server-only";
import { caseGeminiDecisionProvider, prepareCaseGeminiDecisionRequest, type CaseV2Network } from "../cases/investigation-v2-providers";
import { readCaseV2SpendPolicy, readCaseV2TransportPolicy } from "../cases/investigation-v2-spend";
import type { SavReplayModelTransport } from "./replay-decision";

/*
 * SAV-92 harness, phase 1b: the LIVE model transport of the replay, built only on explicit request (`--model live`). It is the production
 * V2 Gemini transport itself (`caseGeminiDecisionProvider`: the same prompt, body, bounds, key choice and response parsing), called once per
 * request, WITHOUT the production call ledger or spend register: the replay's own in-memory meter reserves and settles each call.
 * Prices and bounds are read (never written) from the approved V2 spend policy (`SAV_V2_SPEND_POLICY_JSON`); without a valid policy, nothing
 * is built. Cost: input tokens × input price + output tokens (thoughts included) × output price, from the usage the provider reports; an
 * unknown usage keeps the worst case (the policy's full input window and maximum output).
 */

type Env = Readonly<Record<string, string | undefined>>;

export function createSavReplayLiveModel(input: Readonly<{ env: Env; network?: CaseV2Network; timeoutMs?: number }>): SavReplayModelTransport {
  const read = readCaseV2SpendPolicy(input.env);
  if (!read.ok) throw new Error(`SAV_REPLAY_LIVE_${read.reason.toUpperCase()}`);
  // Throws when the policy does not pin this model, its bounds or valid prices (`SAV_V2_TRANSPORT_POLICY_*`): no guessed tariff.
  const bounds = readCaseV2TransportPolicy(input.env);
  const { microUsdPerMillionInputTokens: inPrice, microUsdPerMillionOutputTokens: outPrice } = read.policy.model;
  const usd = (inputTokens: number, outputTokens: number) => (inputTokens * inPrice + outputTokens * outPrice) / 1e12;
  const reservePerCallUsd = usd(bounds.maxInputTokens, bounds.maxOutputTokens);
  const provider = caseGeminiDecisionProvider({ env: () => input.env, ...(input.network ? { network: input.network } : {}), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) });
  return {
    kind: "live", model: bounds.model, reservePerCallUsd,
    // The body's bytes counted as tokens (the policy's own conservative assumption) and the full output bound.
    estimateUsd(request) {
      const prepared = prepareCaseGeminiDecisionRequest(request, input.env);
      return prepared.ok ? usd(prepared.metadata.inputBytes ?? bounds.maxInputBytes, bounds.maxOutputTokens) : 0;
    },
    async call(request) {
      const { result, usage } = await provider(request);
      const known = usage && Number.isFinite(usage.inputTokens ?? 0) && Number.isFinite(usage.outputTokens ?? 0);
      return { result, usage, costUsd: known ? usd(usage.inputTokens ?? 0, usage.outputTokens ?? 0) : null };
    },
  };
}
