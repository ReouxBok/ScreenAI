import { isSmartSupportProvenance } from "../case-types";
import { smartOtherPlatformInvite, smartSensitiveCommitment } from "./smart-checks";

/*
 * SAV-123 (N8): the last look at OUR text before a smart reply leaves, whoever approved it (a person or, under `SAV_V2_SMART_SUPPORT_MODE=auto`, the rule).
 * Pure, no model: called by the effect driver under the case lock beside the Access skill's fence, and by the reply passage before it asks for the rule.
 * An answer, question or reminder of a case the smart entry admitted is cancelled, never sent, when it speaks of cancelling (`resili*`, or a subscription
 * object with a stop verb), commits to a sensitive account action (`smartSensitiveCommitment`, the CAP's `sensitive_commitment`), or sends the customer to
 * another platform. A neutral mention (« pour la question de remboursement, notre équipe vous répondra ») passes: the Access kernel is not applied here
 * (PORTE 2A, P2). A hand-over or closing notice is the team's path: never judged here.
 */
export type Admission = { qualification?: { requests?: ReadonlyArray<{ provenance?: { kind?: string; ruleId?: string; revision?: string; blockId?: string } }> } } | null | undefined;
export type SmartSendProblem = "CANCELLED_REPLY_SENSITIVE_WORDING" | "CANCELLED_REPLY_OTHER_PLATFORM";

export const smartAdmission = (admission: Admission) =>
  (admission?.qualification?.requests ?? []).some(row => row.provenance && isSmartSupportProvenance({ kind: row.provenance.kind ?? "", ...row.provenance }));

export function smartSendProblem(input: Readonly<{ admission: Admission; body: string; purpose: string }>): SmartSendProblem | null {
  if (input.purpose === "handoff" || input.purpose === "closing") return null;
  if (!smartAdmission(input.admission)) return null;
  if (smartSensitiveCommitment(input.body)) return "CANCELLED_REPLY_SENSITIVE_WORDING";
  if (smartOtherPlatformInvite(input.body)) return "CANCELLED_REPLY_OTHER_PLATFORM";
  return null;
}
