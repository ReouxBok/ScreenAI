import type { SavGeminiMetadata } from "../gemini-response";
/** Recognize only the omitted zero proven by explicit provider accounting. */
export function reconcileIntakeZeroThoughtUsage(metadata?: SavGeminiMetadata): SavGeminiMetadata & { usageReconciliation?: string } {
  const i=metadata?.inputTokens,o=metadata?.outputTokens,total=metadata?.totalTokens;
  const zero=metadata?.thoughtTokens===undefined && [i,o,total].every(n=>Number.isSafeInteger(n)&&Number(n)>=0)
    && Number(i)>=1 && Number(i)<=1_048_576 && Number(o)<=8192 && Number(i)+Number(o)===total;
  const clean={...metadata} as SavGeminiMetadata & {usageReconciliation?:string};
  delete clean.usageReconciliation;
  return {...clean,...(zero?{thoughtTokens:0,usageReconciliation:"gemini_omitted_zero_thoughts.v1"}:{})};
}
/** Received statuses the provider documents as not charged: "If your request fails with a 400
 * or 500 error, you won't be charged for the tokens used" (ai.google.dev/gemini-api/docs/billing),
 * plus the 429 already admitted. Other received 4xx are not named there and stay uncertain. */
export const unbilledProviderStatus = (status: number | undefined) => status === 400 || status === 429 || status !== undefined && status >= 500 && status <= 599;
