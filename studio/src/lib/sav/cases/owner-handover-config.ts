export const SAV_V2_OWNER_HANDOVER_PERMISSION = "start_case_owner_handover" as const;

export function savV2OwnerHandoverEnabled(env: Record<string, string | undefined> = process.env) {
  return env.VERCEL_ENV === "production" && env.SAV_V2_OWNER_HANDOVER === "on"
    && env.SAV_CASE_RECORDING === "on" && env.SAV_V2_ENTRY === "on";
}
