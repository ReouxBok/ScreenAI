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
