import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { savCaseEvents, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { splitSavMessageText } from "../message-context";
import type { CaseTx, CustomerReturnWrite } from "./case-store";
import type { CaseSnapshot } from "./case-types";

/** Binds an outbound journal entry to its recipient without putting the address in the journal. */
export const trialRecipientBinding = (caseId: string, address: string) =>
  createHash("sha256").update(JSON.stringify([caseId, address.trim().toLowerCase()])).digest("hex");

// A negative symptom by itself does not prove that the customer tried our procedure.
// Require both statements in the customer's own new words, with no second request.
const tried = /^(?:bonjour[,.!]?\s+)?j'ai (?:bien )?(?:suivi (?:toutes )?(?:les|vos) (?:etapes|instructions)|essaye toutes les etapes|tout essaye)\s*[,.;!]?\s*(?:mais |et )?(?:toujours rien|(?:ca|cela) ne (?:fonctionne|marche) (?:toujours )?pas|je (?:ne recois toujours pas (?:le|de) code|suis toujours bloque[e]?|n'arrive toujours pas a me connecter))[.!]?$/;
export function explicitTrialFailure(text: string): string | null {
  // The splitter caps its input. Never derive proof from a partial message.
  if (text.length > 100_000) return null;
  const current = splitSavMessageText(text);
  if (!current.currentText || current.currentText.length > 500 || current.signatureText) return null;
  // The splitter treats ALL lines below a mail header as history, including a
  // possible inline correction. Only explicitly prefixed old lines are safe.
  const quotedLines = current.quotedText.split("\n").map(line => line.trim()).filter(Boolean);
  if (quotedLines.length && !quotedLines[0].startsWith(">")) quotedLines.shift(); // recognized mail header
  if (current.quotedText && (!quotedLines.length || quotedLines.some(line => !line.startsWith(">")))) return null;
  // Joining unquoted fragments across inline quotes can manufacture a statement
  // the sender never made. Accept only a single leading customer statement.
  const boundary = current.parts.find(part => part.kind !== "current");
  if (boundary && current.currentLines.some(line => line.line > boundary.startLine && line.text.trim())) return null;
  const value = current.currentText.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[’`]/g, "'").toLowerCase().replace(/\s+/g, " ").trim();
  return tried.test(value) ? current.currentText : null;
}

/** Called under the case lock, exactly once per stored return. An old receipt, an ambiguous trial,
 * or a different sender/thread leaves the trial pending; the return still follows normal investigation. */
export async function trialsOnCustomerReturn(tx: CaseTx, snapshot: CaseSnapshot, input: CustomerReturnWrite) {
  const trials = snapshot.body.trials;
  const open = snapshot.body.openRequests.filter(request => request.status === "open");
  if (input.route !== "continue" || snapshot.sensitivity !== "none" || open.length !== 1 || open[0].family !== "access") return trials;
  const pending = trials.filter(trial => trial.requestId === open[0].id && trial.outcome === "pending");
  if (pending.length !== 1 || Date.parse(input.receivedAt) <= Date.parse(pending[0].askedAt)) return trials;
  const trial = pending[0];
  // Only the immediate exchange belongs to this trial. A reopened cycle, a later message
  // or a human takeover between answer and return makes the reference ambiguous.
  const [sent] = await tx.select().from(savCaseEvents).where(and(eq(savCaseEvents.caseId, snapshot.caseId),
    lte(savCaseEvents.caseVersion, snapshot.version), inArray(savCaseEvents.kind, ["outbound_observed", "inbound_confirmed", "owner_changed"])))
    .orderBy(desc(savCaseEvents.caseVersion)).limit(1);
  if (!sent || sent.direction !== "agent_outbound" || sent.occurredAt.toISOString() !== trial.askedAt) return trials;
  const detail = decryptSavPayload<{ detail?: { effectId?: string; purpose?: string; gmailThreadId?: string; trialRecipient?: string } }>(sent.payloadCiphertext).detail;
  if (!detail?.effectId || detail.purpose !== "answer" || !detail.trialRecipient || trial.id !== `trial:${detail.effectId}:1`) return trials;
  const [mail] = await tx.select({ subject: savMessages.subject, sender: savMessages.fromEmail, body: savMessages.bodyCiphertext, gmailThread: savThreads.gmailThreadId, receivedAt: savMessages.receivedAt })
    .from(savMessages).innerJoin(savThreads, eq(savThreads.id, savMessages.threadId))
    .where(and(eq(savMessages.id, input.messageId), eq(savMessages.gmailMessageId, input.gmailMessageId), eq(savMessages.threadId, input.threadId), eq(savMessages.direction, "inbound")));
  if (!mail || /^\s*(?:tr|fw|fwd)\s*:/iu.test(mail.subject) || mail.gmailThread !== detail.gmailThreadId || mail.receivedAt.toISOString() !== input.receivedAt ||
    trialRecipientBinding(snapshot.caseId, mail.sender) !== detail.trialRecipient) return trials;
  const body = decryptSavPayload<{ text?: string }>(mail.body);
  const quote = typeof body.text === "string" && explicitTrialFailure(body.text);
  if (!quote) return trials;
  return trials.map(row => row.id === trial.id ? { ...row, outcome: "failed" as const, resultAt: input.receivedAt,
    result: { text: quote, source: { type: "email" as const, id: input.gmailMessageId } } } : row);
}
