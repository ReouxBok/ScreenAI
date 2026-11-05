// SAV-10 (pole C): which AI mention a V2 reply text may carry is decided by the PERSISTED authorization basis, never by the text, a client parameter or a name.
// `automated` is a FORMAT (the footer says the mail was sent automatically by an AI); it grants nothing. The right to send under that footer is the validation row
// written by `decideCaseReply` through the injected `CaseReplyAuthorizer`: `decided_by` = the rule's approver, `authorization_basis` = `auto_access.v1` (pole A's rule).
//   basis `auto_access.v1`  -> the text must carry the `automated` mention
//   any other basis         -> the text must carry the `manual_reviewed` mention ("prepared with AI and validated by our team")
// A text under the wrong authority is refused at the approval, at the queue entry, at the plan and at every marker. Pure: no database, no clock, no network.
import { readCaseReplyDisclosure, type CaseReplyAiMode } from "./case-reply-outbound";
import { ACCESS_AUTO_APPROVAL_BASIS } from "./customer-return";

export type CaseReplyTextProblem = "ai_notice_missing" | "ai_notice_mode";

/** The mention an approval allows. An unknown, absent or malformed basis is the human one: the automated mention is never granted by default. */
export const caseReplyModeForBasis = (basis: string | null | undefined): CaseReplyAiMode => basis === ACCESS_AUTO_APPROVAL_BASIS ? "automated" : "manual_reviewed";

/** A stored proposal must carry one complete, canonical mention, in either mode. Which mode is allowed is the authority's business (below). */
export function caseReplyStoredTextProblem(text: string): "ai_notice_missing" | null {
  return readCaseReplyDisclosure(text) ? null : "ai_notice_missing";
}

/** Null when `text` carries exactly the mention the persisted authority allows. */
export function caseReplyTextProblemForBasis(text: string, basis: string | null | undefined): CaseReplyTextProblem | null {
  const disclosure = readCaseReplyDisclosure(text);
  if (!disclosure) return "ai_notice_missing";
  return disclosure.mode === caseReplyModeForBasis(basis) ? null : "ai_notice_mode";
}
