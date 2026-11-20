import { isSmartSupportProvenance } from "../case-types";
import { ACCESS_AUTO_APPROVAL_BASIS, readAccessAutoApprovalConfig } from "../customer-return";
import { savV2EntrySmartOn, savV2SmartSupportAuto } from "../smart-entry-switch";
import { smartOtherPlatformInvite, smartSensitiveCommitment } from "./smart-checks";

/*
 * SAV-123 (N8): the last look at OUR text before a smart reply leaves, whoever approved it (a person or, under `SAV_V2_SMART_SUPPORT_MODE=auto`, the rule).
 * Pure, no model: called by the effect driver under the case lock beside the Access skill's fence, and by the reply passage before it asks for the rule.
 * An answer, question or reminder of a case the smart entry admitted is cancelled, never sent, when it speaks of cancelling (`resili*`, or a subscription
 * object with a stop verb), commits to a sensitive account action (`smartSensitiveCommitment`, the CAP's `sensitive_commitment`), or sends the customer to
 * another platform. A neutral mention (« pour la question de remboursement, notre équipe vous répondra ») passes: the Access kernel is not applied here
 * (PORTE 2A, P2). A hand-over or closing notice is the team's path: never judged here.
 */
type Env = Readonly<Record<string, string | undefined>>;
type Admission = { qualification?: { requests?: ReadonlyArray<{ provenance?: { kind?: string; ruleId?: string; revision?: string; blockId?: string } }> } } | null | undefined;
export type SmartSendProblem = "CANCELLED_REPLY_SENSITIVE_WORDING" | "CANCELLED_REPLY_OTHER_PLATFORM";
export type SmartSwitchProblem = "CANCELLED_SMART_ENTRY_OFF" | "CANCELLED_SMART_AUTO_OFF";

const smartAdmission = (admission: Admission) =>
  (admission?.qualification?.requests ?? []).some(row => row.provenance && isSmartSupportProvenance({ kind: row.provenance.kind ?? "", ...row.provenance }));

export function smartSendProblem(input: Readonly<{ admission: Admission; body: string; purpose: string }>): SmartSendProblem | null {
  if (input.purpose === "handoff" || input.purpose === "closing") return null;
  if (!smartAdmission(input.admission)) return null;
  if (smartSensitiveCommitment(input.body)) return "CANCELLED_REPLY_SENSITIVE_WORDING";
  if (smartOtherPlatformInvite(input.body)) return "CANCELLED_REPLY_OTHER_PLATFORM";
  return null;
}

/*
 * PORTE 2A (P1): the switches, read again at every look before a smart reply's plan, marker or send (after it was queued). `SAV_V2_ENTRY_SMART=on` is
 * required for any smart reply (the smart stamp depends on it). A reply the RULE approved (basis `auto_access.v1`) also needs, now, the smart block's
 * `SAV_V2_SMART_SUPPORT_MODE=auto` and the global automatic reply (`SAV_V2_AUTO_REPLY=access` with the same approver). A person's explicit approval
 * needs neither. Switched off after the queue: cancelled, nothing leaves.
 */
export function smartSwitchProblem(input: Readonly<{ env: Env; admission: Admission; basis?: string | null; approvedBy?: string | null }>): SmartSwitchProblem | null {
  if (!smartAdmission(input.admission)) return null;
  if (!savV2EntrySmartOn(input.env)) return "CANCELLED_SMART_ENTRY_OFF";
  if (input.basis !== ACCESS_AUTO_APPROVAL_BASIS) return null;
  const auto = readAccessAutoApprovalConfig(input.env);
  if (!savV2SmartSupportAuto(input.env) || auto.mode !== "on" || auto.approverId !== (input.approvedBy ?? "").toLowerCase()) return "CANCELLED_SMART_AUTO_OFF";
  return null;
}
