import "server-only";
import { requireDb } from "@/db";
import { caseEffectHash, type CaseReplyProposal } from "./case-effects";
import { finalizeCaseReplyProposal } from "./case-reply-outbound";
import { readCaseThreadlessSource } from "./case-store";
import { savV2NewThreadEnabled, THREADLESS_ACCESS_DRAFT, threadlessReplyShape, threadlessReplySubject } from "./threadless-config";
import { threadlessAccessRevision } from "./threadless-guard";
import { qualifyThreadlessTicket } from "./threadless-source";

/** The fixed first-contact draft has no model, source quotation or diagnostic claim. Only Studio corrections may depart from its text. */
export async function readThreadlessReplyProvenance(proposal: CaseReplyProposal, env: Record<string, string | undefined>, humanCorrection: boolean) {
  if (!savV2NewThreadEnabled(env) || !threadlessReplyShape(proposal)) return "threadless_off_or_invalid";
  const row = await readCaseThreadlessSource(requireDb(), proposal.caseId, proposal.triggerEventId);
  if (!row?.source.contact || row.source.contact.email !== proposal.recipient || proposal.subject !== threadlessReplySubject(row.source.ticketId)
      || caseEffectHash(row.source) !== proposal.ticketSource?.version) return "threadless_source_changed";
  if ((await qualifyThreadlessTicket(row.source, env)).status !== "admitted" || !await threadlessAccessRevision(env)) return "threadless_access_unproven";
  const template = finalizeCaseReplyProposal({ ...proposal, text: THREADLESS_ACCESS_DRAFT }, { language: "fr", validation: "human" });
  return humanCorrection || template.text === proposal.text ? null : "threadless_draft_changed";
}
