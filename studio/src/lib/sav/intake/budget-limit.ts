import { SAV_INTAKE_OPERATIONAL_PROFILE } from "./budget-profile";

/** Which sub-limit stopped a model call. The error keeps the historical code, so every
 * existing retry, deferral and display path is unchanged; only the cause is added. */
export const INTAKE_BUDGET_LIMITS = ["per_message", "per_version", "daily_calls", "campaign_calls", "daily_nano_usd", "campaign_nano_usd", "rolling_nano_usd", "analysis_calls"] as const;
export type IntakeBudgetLimit = typeof INTAKE_BUDGET_LIMITS[number];
export class IntakeBudgetExhaustedError extends Error {
  constructor(readonly limit: IntakeBudgetLimit) { super("SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED"); }
}
/** The first exceeded bound, in the order the ledger checks them; null when none is. */
export function intakeExhaustedLimit(input: { own: number; version: number; needed: number; perMessage: number; perVersion: number; priceNanoUsd: number;
  usage: { profile: string; remainingCalls: number; remainingNanoUsd: number; remainingRollingNanoUsd: number } }): IntakeBudgetLimit | null {
  const scope = input.usage.profile === SAV_INTAKE_OPERATIONAL_PROFILE ? "daily" : "campaign";
  if (input.own + input.needed > input.perMessage) return "per_message";
  if (input.version + input.needed > input.perVersion) return "per_version";
  if (input.needed > input.usage.remainingCalls) return `${scope}_calls`;
  if (input.needed * input.priceNanoUsd > input.usage.remainingNanoUsd) return `${scope}_nano_usd`;
  if (input.needed * input.priceNanoUsd > input.usage.remainingRollingNanoUsd) return "rolling_nano_usd";
  return null;
}
export const publicIntakeBudgetLimit = (value: unknown) => (INTAKE_BUDGET_LIMITS as readonly string[]).includes(String(value)) ? value as IntakeBudgetLimit : null;
