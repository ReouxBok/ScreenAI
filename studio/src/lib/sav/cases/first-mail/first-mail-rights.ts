import "server-only";
import { accessSkillSendProblem } from "../access-skill/access-skill-send-fence";
import { accessSkillKernelHits } from "../access-skill/access-skill-kernel";
import { readSavBlockSwitch, savBlockReplyGate } from "../block-switch";
import type { CaseReplyProposal } from "../case-effects";
import { caseReplyEditableBody } from "../case-reply-outbound";
import { SAV_CASE_ACCESS_BLOCK_ID } from "../case-types";
import { readAccessAutoApprovalConfig } from "../customer-return";
import { savV2NewThreadAutoEnabled } from "../threadless-config";
import { firstMailSkillPinned } from "./first-mail-skill";

/*
 * SAV-96 B: the rights an AUTOMATED first mail (a HubSpot ticket with no thread) rests on. No new right is invented: the existing Access
 * auto-reply authority (`SAV_V2_AUTO_REPLY=access` + its approver, `auto_access.v1`) and the Access block switch (`auto`), plus the explicit
 * `SAV_V2_NEW_THREAD_AUTO=on`, the pinned first-mail skill and the kernel on OUR text. Read at the approval (`threadless-first-mail.ts`) and again
 * at the send gate, under the parent, case and validation locks (`threadless-effects.ts`). Anything missing: no automated send.
 */

type Env = Readonly<Record<string, string | undefined>>;
type Reader = Parameters<typeof readSavBlockSwitch>[0];

/** The text-and-switch part, pure: why an automated first mail may not leave now, or null. */
export function threadlessAutoTextProblem(env: Env, proposal: Pick<CaseReplyProposal, "text" | "purpose">, admissionRecord: unknown): string | null {
  if (!savV2NewThreadAutoEnabled(env)) return "new_thread_auto_off";
  if (!firstMailSkillPinned()) return "first_mail_skill_unpinned";
  // OUR text: never a kernel phrase (cancel, refund, delete the account...), whatever the Access skill switch says.
  let body: string;
  try { body = caseReplyEditableBody(proposal.text); } catch { return "reply_unreadable"; }
  if (accessSkillKernelHits(body).length) return "reply_sensitive_wording";
  // SAV-97's send fence: a case the skill admitted is only answered at the same skill revision, switch still `on`.
  const fence = accessSkillSendProblem({ env, admission: admissionRecord as Parameters<typeof accessSkillSendProblem>[0]["admission"], text: proposal.text, purpose: proposal.purpose });
  return fence ? fence.toLowerCase() : null;
}

/** The whole check, with the Access block switch read now through `db` (a transaction at the send gate). */
export async function threadlessAutoSendProblem(db: Reader, env: Env, input: Readonly<{ proposal: Pick<CaseReplyProposal, "text" | "purpose">; decidedBy: string | null; admissionRecord: unknown }>): Promise<string | null> {
  const config = readAccessAutoApprovalConfig(env);
  if (config.mode !== "on") return `auto_${config.why}`;
  if (input.decidedBy !== null && input.decidedBy.toLowerCase() !== config.approverId) return "approver_not_rule";
  const text = threadlessAutoTextProblem(env, input.proposal, input.admissionRecord);
  if (text) return text;
  const gate = savBlockReplyGate(await readSavBlockSwitch(db, SAV_CASE_ACCESS_BLOCK_ID));
  return gate.send === "rule" ? null : gate.code;
}
