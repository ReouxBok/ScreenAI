import "server-only";
import { requireDb } from "@/db";
import { caseEffectHash, type CaseReplyProposal } from "./case-effects";
import { finalizeCaseReplyProposal } from "./case-reply-outbound";
import { readCaseThreadlessSource } from "./case-store";
import { readPilotReplyProvenance, type PilotProvenanceDeps } from "./pilot-passage-provenance";
import { savV2NewThreadAutoEnabled, savV2NewThreadEnabled, THREADLESS_ACCESS_DRAFT, threadlessReplyShape, threadlessReplySubject } from "./threadless-config";
import { threadlessAccessRevision } from "./threadless-guard";
import { qualifyThreadlessTicket, threadlessAccessQualified } from "./threadless-source";

/** The input key of a first mail: the ticket's own stored event (`investigation-runner.ts` `threadlessInput`). */
export const threadlessInputKey = (eventId: string) => `ticket:${eventId}`;

/**
 * The fixed first-contact draft has no model, source quotation or diagnostic claim. Only Studio corrections may depart from its text.
 * SAV-96 B: with `SAV_V2_NEW_THREAD_AUTO=on`, a text the V2 decision model wrote is proven like any pilot reply (`readPilotReplyProvenance`): the
 * decision recorded on the ticket's input, its text, the scope in force and every shown source active now. Returns null when proven.
 */
export async function readThreadlessReplyProvenance(proposal: CaseReplyProposal, env: Record<string, string | undefined>, humanCorrection: boolean,
  deps?: PilotProvenanceDeps) {
  if (!savV2NewThreadEnabled(env) || !threadlessReplyShape(proposal)) return "threadless_off_or_invalid";
  const row = await readCaseThreadlessSource(requireDb(), proposal.caseId, proposal.triggerEventId);
  if (!row?.source.contact || row.source.contact.email !== proposal.recipient || proposal.subject !== threadlessReplySubject(row.source.ticketId)
      || caseEffectHash(row.source) !== proposal.ticketSource?.version) return "threadless_source_changed";
  if (!threadlessAccessQualified(await qualifyThreadlessTicket(row.source, env)) || !await threadlessAccessRevision(env)) return "threadless_access_unproven";
  // SAV-96 B: decided by the STORED origin of the draft, never by its text. The fixed draft (lot B, no decision, no card): its exact text, or a Studio
  // correction of it, as before. A model draft: proven like a thread reply, a correction skipping the text comparison only.
  if (proposal.ticketSource?.origin !== "model") {
    const template = finalizeCaseReplyProposal({ ...proposal, text: THREADLESS_ACCESS_DRAFT }, { language: "fr", validation: "human" });
    if (template.text === proposal.text) return null;
    return humanCorrection ? null : "threadless_draft_changed";
  }
  if (savV2NewThreadAutoEnabled(env) && deps) {
    // `reminderInputKey` names the input whose recorded decision is read: here the ticket's event, never a customer mail.
    // As a thread reply (`readPilotReplyProvenance`): a Studio correction skips the text comparison ONLY. The decision, its scope and every cited card
    // are still proven now, so a card retired or changed after a correction keeps the mail from leaving.
    const read = await readPilotReplyProvenance(proposal, deps, { humanCorrection, reminderInputKey: threadlessInputKey(row.eventId) });
    return read.status === "proven" ? null : `threadless_reply_unproven:${[...read.reasons].sort().join(",")}`;
  }
  // A model draft is only ever proven with SAV_V2_NEW_THREAD_AUTO=on and the provenance readers: anything else keeps it from leaving.
  return "threadless_model_draft_unproven";
}
