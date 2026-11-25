import "server-only";
import { accessSkillSendProblem } from "../access-skill/access-skill-send-fence";
import { accessSkillKernelHits } from "../access-skill/access-skill-kernel";
import { readSavBlockSwitch, savBlockReplyGate } from "../block-switch";
import type { CaseReplyProposal } from "../case-effects";
import { caseReplyEditableBody } from "../case-reply-outbound";
import { SAV_CASE_ACCESS_BLOCK_ID } from "../case-types";
import { ACCESS_AUTO_APPROVAL_BASIS, readAccessAutoApprovalConfig } from "../customer-return";
import { savAppTicketsMode } from "../app-tickets-config";
import { SAV_SMART_ENTRY_BLOCK_ID } from "../smart-entry-switch";
import { smartSwitchProblem } from "../smart-support-scope";
import { smartSendProblem } from "../smart/smart-send-fence";
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

/**
 * SAV-138 (Ugo 25/11): the rights an AUTOMATED first mail of an app ticket rests on when the SMART brain wrote it. No new right: the smart reply's own, as on
 * a mail (`smartSwitchProblem`: smart entry on, `SAV_V2_SMART_SUPPORT_MODE=auto`, the global automatic reply and its approver; the smart send fence on OUR
 * text; the smart block switch at `rule`), plus `SAV_APP_TICKETS_MODE=live`. Read at the approval and again at the send gate, under the same locks.
 */
export async function smartFirstMailAutoProblem(db: Reader, env: Env, input: Readonly<{ proposal: Pick<CaseReplyProposal, "text" | "purpose">; decidedBy: string | null; admissionRecord: unknown }>): Promise<string | null> {
  const problem = smartFirstMailConfigProblem(env, input.admissionRecord), config = readAccessAutoApprovalConfig(env);
  if (problem || config.mode !== "on") return problem ?? "auto_disabled";
  if (input.decidedBy !== null && input.decidedBy.toLowerCase() !== config.approverId) return "approver_not_rule";
  let body: string;
  try { body = caseReplyEditableBody(input.proposal.text); } catch { return "reply_unreadable"; }
  const fence = smartSendProblem({ admission: input.admissionRecord as Parameters<typeof smartSendProblem>[0]["admission"], body, purpose: input.proposal.purpose });
  if (fence) return fence.toLowerCase();
  return smartFirstMailBlockProblem(db, env);
}

/** The configuration part, no text needed: read BEFORE any model call (review 25/11), so a mail that could never leave automatically costs nothing. */
export function smartFirstMailConfigProblem(env: Env, admissionRecord: unknown): string | null {
  const config = readAccessAutoApprovalConfig(env);
  if (config.mode !== "on") return `auto_${config.why}`;
  if (savAppTicketsMode(env) !== "live") return "app_tickets_not_live";
  const switched = smartSwitchProblem({ env, admission: admissionRecord as Parameters<typeof smartSendProblem>[0]["admission"], basis: ACCESS_AUTO_APPROVAL_BASIS,
    approvedBy: config.approverId });
  return switched ? switched.toLowerCase() : null;
}

/** The smart block switch, read now through `db`: only `rule` lets an automated smart mail leave. */
export async function smartFirstMailBlockProblem(db: Reader, env: Env): Promise<string | null> {
  const gate = savBlockReplyGate(await readSavBlockSwitch(db, SAV_SMART_ENTRY_BLOCK_ID, env));
  return gate.send === "rule" ? null : gate.code;
}
