import { accessSkillKernelHits } from "../access-skill/access-skill-kernel";
import { isSmartSupportProvenance } from "../case-types";
import { smartOtherPlatformInvite, smartSensitiveCommitment } from "./smart-checks";

/*
 * SAV-123 (N8): the last look at OUR text before a smart reply leaves, whoever approved it (a person or, under `SAV_V2_SMART_SUPPORT_MODE=auto`, the rule).
 * Pure, no model: called by the effect driver under the case lock beside the Access skill's fence, and by the reply passage before it asks for the rule.
 * An answer, question or reminder of a case the smart entry admitted is cancelled, never sent, when it carries a kernel phrase or a sensitive commitment
 * (cancellation, refund, account deletion...) or invites to use another platform. A hand-over or closing notice is the team's path: never judged here.
 */
type Admission = { qualification?: { requests?: ReadonlyArray<{ provenance?: { kind?: string; ruleId?: string; revision?: string; blockId?: string } }> } } | null | undefined;
export type SmartSendProblem = "CANCELLED_REPLY_SENSITIVE_WORDING" | "CANCELLED_REPLY_OTHER_PLATFORM";

export function smartSendProblem(input: Readonly<{ admission: Admission; body: string; purpose: string }>): SmartSendProblem | null {
  if (input.purpose === "handoff" || input.purpose === "closing") return null;
  const smart = (input.admission?.qualification?.requests ?? []).some(row => row.provenance && isSmartSupportProvenance({ kind: row.provenance.kind ?? "", ...row.provenance }));
  if (!smart) return null;
  if (accessSkillKernelHits(input.body).length || smartSensitiveCommitment(input.body)) return "CANCELLED_REPLY_SENSITIVE_WORDING";
  if (smartOtherPlatformInvite(input.body)) return "CANCELLED_REPLY_OTHER_PLATFORM";
  return null;
}
