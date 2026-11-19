export const SAV_V2_OWNER_HANDOVER_PERMISSION = "start_case_owner_handover" as const;

export function savV2OwnerHandoverEnabled(env: Record<string, string | undefined> = process.env) {
  return env.VERCEL_ENV === "production" && env.SAV_V2_OWNER_HANDOVER === "on"
    && env.SAV_CASE_RECORDING === "on" && env.SAV_V2_ENTRY === "on";
}

/**
 * SAV-96 repair (19/11): HubSpot never delivered a webhook to production, so the owner handover above could never start. With
 * `SAV_V2_OWNER_HANDOVER_POLL=on` (and the handover itself on), each reconcile pass reads, by a bounded HubSpot search, the support tickets owned
 * by the V2 owner and modified recently, and feeds their last owner change to the SAME markers as a webhook. Absent or any other value: off,
 * not one extra HubSpot call.
 */
export function savV2OwnerHandoverPollEnabled(env: Record<string, string | undefined> = process.env) {
  return savV2OwnerHandoverEnabled(env) && env.SAV_V2_OWNER_HANDOVER_POLL === "on";
}
