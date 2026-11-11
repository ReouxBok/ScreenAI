// SAV-10 / UX: the AI mention of a V2 reply, on the SHARED outbound format (`reply-format.ts`, no new wording, no delay, no legal text).
// The mention is part of the text a person reads, the text that is hashed and approved, and the text that is sent: it is added ONCE, when the proposal
// is prepared (before it is stored, shown and validated), never after an approval. The intent builder only checks it; it never appends anything.
// Pure: nothing is read, stored or sent here.
//
// CONTRACT for the producer and the store (pole C owns the store, its fixtures and the B -> C glue; UX owns this file):
// 1. the producer builds the proposal with `finalizeCaseReplyProposal(draft, { language, validation })`, never with a raw text. `validation: "automated"` is format only, never a right;
// 2. the store refuses, BEFORE any row or hash is written, a proposal whose `caseReplyFinalTextProblem(text, expectedMode)` is not null (code `proposal_invalid`,
//    detail = that problem; `expectedMode` read from the persisted authority, default the human validation); the stored text is then the text shown, approved, hashed and the MIME body;
// 3. `buildReplySendIntent` re-checks the approved text and refuses (never fixes) one that breaks the contract;
// 4. any edit is a new text: it goes through 1 again and needs its own approval (the hash covers the text, mention included).
import { cleanSavModelDraft, renderSavOutboundReply, savReplyFooter, type SavReplySendMode } from "../reply-format";
import type { CaseReplyApproval, CaseReplyProposal, CaseReplyPurpose } from "./case-effects";

export const CASE_REPLY_OUTBOUND_CONTRACT = "sav-v2-reply-outbound.v1";

/** The two modes of a reply the agent prepared. `manual_authored` (a reply a person wrote) is never a V2 proposal: a V2 text is always AI-prepared. */
export type CaseReplyAiMode = Extract<SavReplySendMode, "manual_reviewed" | "automated">;
export type CaseReplyLanguage = "fr" | "en";
export type CaseReplyDisclosure = Readonly<{ mode: CaseReplyAiMode; language: CaseReplyLanguage }>;
/** Why a text cannot be stored as a V2 proposal. Stable strings: the store returns them as the `proposal_invalid` detail. */
export type CaseReplyFinalTextProblem = "ai_notice_missing" | "ai_notice_mode";

const MODES: readonly CaseReplyAiMode[] = ["manual_reviewed", "automated"];
const LANGUAGES: readonly CaseReplyLanguage[] = ["fr", "en"];

/**
 * Ugo (4/11): the line every V2 reply gives the customer so the next exchange starts from the facts. V2 only (the V1 format in `reply-format.ts` and a person's own
 * replies never carry it). It sits just above the signature and the AI mention, in the body the mention follows, so a stored text without it (a proposal written earlier,
 * its hash) stays valid. It asks for what happened, never for a code, a password or any other secret.
 */
const HELP_LINES: Readonly<Record<CaseReplyLanguage, string>> = {
  fr: "Pour nous aider à vous répondre, précisez ce que vous essayiez de faire, ce qui s’est affiché et ce que vous avez déjà essayé.",
  en: "To help us answer you, please tell us what you were trying to do, what appeared on screen and what you have already tried.",
};
export const caseReplyHelpLine = (language: CaseReplyLanguage | "unknown") => HELP_LINES[language === "en" ? "en" : "fr"];
const BARE_SIGNATURES = ["L’équipe Limova", "The Limova team"];
/** The draft's own content: without the help line in either language or a trailing bare signature, so preparing again (or in the other language) never stacks. */
function caseReplyBody(draft: string): string {
  let text = cleanSavModelDraft(draft);
  for (let previous = ""; previous !== text;) {
    previous = text;
    for (const line of LANGUAGES.map(language => HELP_LINES[language])) text = text.split(line).join("").trim();
    for (const signature of BARE_SIGNATURES) if (text.endsWith(signature)) text = text.slice(0, -signature.length).trim();
  }
  return text;
}

/**
 * The final text of a reply, help line and mention included. Idempotent: a text that already carries a known footer (any language or mode, current or historical)
 * is re-rendered with exactly one, so preparing twice, or again in the other language, never stacks. `unknown` reads as French, like the shared format.
 * `automated` keeps the shared "sent automatically by an AI, may contain errors, reply to continue" notice; the human-validation path never uses it (see `finalize…`).
 */
export function prepareCaseReplyText(draft: string, language: CaseReplyLanguage | "unknown", mode: CaseReplyAiMode, purpose?: CaseReplyPurpose): string {
  const body = caseReplyBody(draft);
  if (!body) throw new Error("SAV_REPLY_EMPTY");
  // ONE follow-up per reply (Ugo 11/11): a `question` reply IS its follow-up (the tracked question, which J2 follows), so the standard line is not stacked after it.
  // Every other purpose keeps the standard line as its only generic follow-up; the code that composes a reply (decision-validator) never writes a second one.
  return renderSavOutboundReply(purpose === "question" ? body : `${body}\n\n${caseReplyHelpLine(language)}`, language, mode);
}

/**
 * The mention a final text carries, or null when it carries none, an incomplete one, a footer that claims a human wrote it, a second (contradictory)
 * mention inside the body, or any text that the shared format would not produce as is (so nothing is approved that would be re-rendered differently).
 */
export function readCaseReplyDisclosure(text: string): CaseReplyDisclosure | null {
  if (typeof text !== "string") return null;
  for (const mode of MODES) for (const language of LANGUAGES) {
    const footer = `\n\n${savReplyFooter(language, mode)}`;
    if (!text.endsWith(footer)) continue;
    const body = text.slice(0, -footer.length);
    if (!body.trim() || cleanSavModelDraft(body) !== body) return null;
    return renderSavOutboundReply(text, language, mode) === text ? { mode, language } : null;
  }
  return null;
}

/** The default V2 text: validated by a person in the Studio (`decideCaseReply`, injected authorizer), it says "written with help from our AI agent". */
export const CASE_REPLY_V2_MODE: CaseReplyAiMode = "manual_reviewed";

/**
 * Null when `text` can be stored, shown, approved and sent as is under `expectedMode`; otherwise the reason, checked before any row or hash is written. The default stays the
 * human validation, so no older caller is widened. `expectedMode` must come from the persisted authority of the validation (pole C), never from the text itself or a client
 * parameter: this function only compares a text with the mode it is told to expect, it grants nothing. Any other expected mode (a person's own signature, unknown) is refused.
 */
export function caseReplyFinalTextProblem(text: string, expectedMode: CaseReplyAiMode = CASE_REPLY_V2_MODE): CaseReplyFinalTextProblem | null {
  const disclosure = readCaseReplyDisclosure(text);
  if (!disclosure) return "ai_notice_missing";
  return MODES.includes(expectedMode) && disclosure.mode === expectedMode ? null : "ai_notice_mode";
}

/**
 * The producer's single entry point: the proposal as it will be stored, shown, hashed, approved and sent. `validation` picks the FORMAT and grants nothing: `human` is the
 * mention of a text a person validates, `automated` the mention of a text sent automatically. `automated` is not a right: it may be asked only after a proven admission and
 * authorization (pole B), and the store and the send re-read the persisted authority (pole C). Any other value is refused. Idempotent: same proposal, hence same hash.
 */
export function finalizeCaseReplyProposal(draft: Omit<CaseReplyProposal, "text"> & Readonly<{ text: string }>,
  options: Readonly<{ language: CaseReplyLanguage | "unknown"; validation: "human" | "automated" }>): CaseReplyProposal {
  if (options.validation !== "human" && options.validation !== "automated") throw new Error("SAV_REPLY_VALIDATION_INVALID");
  return { ...draft, text: prepareCaseReplyText(draft.text, options.language, options.validation === "automated" ? "automated" : CASE_REPLY_V2_MODE, draft.purpose) };
}

/**
 * The mode an approval allows the text to claim. A `CaseReplyApproval` is a person's validation, re-read from the stored row under lock by the driver:
 * the text must say "prepared with AI and validated by our team". A text saying "sent automatically" is refused rather than sent under a human approval.
 */
export const caseReplyApprovedMode = (approval: CaseReplyApproval): CaseReplyAiMode | null => approval.approvedBy ? CASE_REPLY_V2_MODE : null;
