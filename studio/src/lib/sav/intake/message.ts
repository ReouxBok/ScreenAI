import { splitSavMessageText, SAV_MESSAGE_CONTEXT_REVISION } from "../message-context";
import { intakeMessageSchema, type IntakeMessage } from "./engine-types";
import { intakeHtmlDocumentText, intakeHtmlDocumentComplete } from "./html-message";

/** Pure transport derivation. Does not open a Studio dossier or mark it read. */
export function prepareSavIntakeMessage(input: Omit<IntakeMessage, "currentText" | "contentComplete" | "forwardedQuoteOnly" | "standaloneAuthoredLine"> & {
  subject: string; body: string; bodyComplete: boolean; unresolvedAttachments: boolean;
}) {
  // Intake needs every section for provenance. The V0 display context caps
  // individual sections, so its truncated snapshot cannot establish completeness.
  const context = splitSavMessageText(intakeHtmlDocumentText(input.body));
  const { subject, body, bodyComplete, unresolvedAttachments, ...metadata } = input;
  void body;
  const subjectInherited = /^\s*(?:re|rép|aw|sv|fw|fwd|tr)\s*:/i.test(subject);
  const subjectTruncated = subject.length > 2000;
  const currentText = [subjectInherited ? "" : subject.trim().slice(0, 2000), context.currentText].filter(Boolean).join("\n\n");
  // The complete source must fit both the storage boundary and message contract.
  // A bounded diagnostic view may be returned, but never labeled complete.
  const truncated = input.body.length >= 100_000 || subjectTruncated || currentText.length > 100_000;
  const textComplete = bodyComplete && intakeHtmlDocumentComplete(input.body) && !truncated;
  const message = intakeMessageSchema.parse({ ...metadata,
    ...(textComplete && !unresolvedAttachments && !subjectInherited && !context.quotedText && !context.signatureText
      && currentText && !currentText.includes("\n") ? { standaloneAuthoredLine: true } : {}),
    ...(/^\s*(?:fw|fwd|tr)\s*:/i.test(subject) && !context.currentText && context.quotedText ? { forwardedQuoteOnly: true } : {}),
    currentText: currentText.slice(0, 100_000),
    contentComplete: textComplete && !unresolvedAttachments });
  return { message, provenance: { revision: SAV_MESSAGE_CONTEXT_REVISION, messageId: message.id,
    subject: subject.slice(0, 2000), subjectInherited,
    currentText: context.currentText, quotedText: context.quotedText, signatureText: context.signatureText, parts: context.parts,
    truncated, textComplete, unresolvedAttachments } };
}

/** A quote is context, never an authenticated sender. The worker can park
 * a complete forwarded-only mail without billing an analysis or reading CRM. */
export function intakeForwardNeedsOriginal(message: IntakeMessage) {
  return message.forwardedQuoteOnly === true && message.contentComplete && !message.currentText.trim()
    && !message.operatorInformation && !message.attachmentInputs?.length && !message.unreadAttachments?.length;
}

/** SAV-90: the current mail answers a mail of the support mailbox itself. True only when a quote header
 * (Gmail/Apple « Le … a écrit : » / « On … wrote: », possibly wrapped on two lines, or an Outlook/forward
 * « De : » / « From: » line) names the mailbox's exact address. An address merely mentioned in prose,
 * another sender, or a look-alike address does not count; a line in the text that imitates a quote header
 * does count, which at worst sends the mail to a human choice. It only keeps a mail out of « Autres »
 * and in the team's classification choice: it never creates a ticket nor chooses a classification. */
export function intakeQuotesMailbox(provenance: { currentText: string; quotedText: string }, mailboxEmail: string) {
  const address = mailboxEmail.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) return false;
  const named = new RegExp(`(?<![\\w.+@-])${escapeRegExp(address)}(?![\\w.@-])`, "i");
  return quoteHeaders(provenance).some(header => named.test(header));
}
/** Quote header lines (Gmail/Apple « Le … a écrit : » / « On … wrote: », possibly wrapped, or « De : » / « From: »). */
function quoteHeaders(provenance: { currentText: string; quotedText: string }) {
  const lines = `${provenance.currentText}\n${provenance.quotedText}`.split("\n").map(line => line.replace(/^[\s>]+/, "").trim());
  return lines.map((line, index) => {
    const next = lines[index + 1] ?? "";
    return /^(?:a\s+)?(?:écrit|wrote)\s*:$/i.test(next) ? `${line} ${next}` : line;
  }).filter(header => /(?:\bwrote|a\s+écrit|écrit)\s*:$/i.test(header) || /^(?:from|de)\s*:/i.test(header));
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Shared public mail providers: an address there is never a team member's. */
const PUBLIC_MAIL_DOMAINS = /^(?:gmail\.com|googlemail\.com|outlook\.[a-z.]+|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com|yahoo\.[a-z.]+|ymail\.com|icloud\.com|me\.com|mac\.com|aol\.com|gmx\.[a-z.]+|proton(?:mail)?\.[a-z.]+|orange\.fr|wanadoo\.fr|free\.fr|sfr\.fr|laposte\.net|bbox\.fr|neuf\.fr)$/i;
/** Orientation (17/11): the current mail answers a mail of the team: a quote header names an address of the
 * support mailbox's own (non-public) domain, e.g. a colleague's offer or follow-up. Like intakeQuotesMailbox it
 * only keeps a mail out of an automatic « commercial » hand-off and in the team's choice; it never creates a
 * ticket, chooses a classification, names an owner, or proves that anyone took the follow-up. */
export function intakeQuotesTeamAddress(provenance: { currentText: string; quotedText: string }, mailboxEmail: string) {
  const domain = /^[^\s@<>]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(mailboxEmail.trim())?.[1]?.toLowerCase();
  if (!domain || PUBLIC_MAIL_DOMAINS.test(domain)) return false;
  const named = new RegExp(`(?<![\\w.+@-])[a-z0-9._%+-]+@${escapeRegExp(domain)}(?![\\w.@-])`, "i");
  return quoteHeaders(provenance).some(header => named.test(header));
}
