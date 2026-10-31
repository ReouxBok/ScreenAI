import { z } from "zod";
import type { EngineInput } from "./engine-types";

/** SAV-46 R1: a written address and a verbatim quote locate a declared registration address;
 * they never prove it is the customer's own Limova account. The role is proven only by an
 * explicit first-person account statement in the same sentence (or, in a server-verified
 * identification continuation, by the reply itself). An address to connect, synchronize or
 * share, a third party's, a negated, quoted or signature one is not a declaration. Unknown
 * phrasing fails closed. One deterministic rule shared by both readers, the engine and the
 * comparison capture, so the capture covers exactly the addresses the engine may look up. */

/** Same tokenization as the readers' discard rule; trailing sentence punctuation is not part of it. */
const ADDRESS = /[^\s<>()[\]"',;:]+@[^\s<>()[\]"',;:]+/g;
const word = (source: string) => `(?<![\\p{L}\\d])(?:${source})(?![\\p{L}\\d])`;
const MARKER = new RegExp(word([
  "(?:mon|notre) compte(?: limova)?", "compte limova",
  "(?:l'|mon |notre )?(?:adresse|e-?mail|mail|courriel)(?: e-?mail| mail)? (?:d'inscription|de connexion|(?:de |du )(?:mon |notre )?compte(?: limova)?)",
  "(?:mon |notre )?identifiant(?: de connexion)?",
  "inscrit(?:e|s|es)?(?: chez vous| sur limova)? (?:avec|sous)", "enregistr(?:é|ée|és|ées)(?: chez vous| sur limova)? (?:avec|sous)",
  "(?:my|our) (?:limova )?account(?: email| e-mail| address)?", "limova account", "account (?:email|e-mail|address)",
  "registration (?:email|e-mail|address)", "registered (?:with|under|email|e-mail|address)", "signed up (?:with|using)", "login (?:email|e-mail)",
].join("|")), "gu");
/** Words allowed between the account statement and the address ("mon compte Limova est …").
 * Anything else ("à", "pour", a product name) breaks the link. */
const CONNECTORS = new Set(["est", "c'est", "sera", "était", "reste", "toujours", "bien", "actuellement", "voici", "is", "was", "still", "currently", "here",
  "it's", "sur", "chez", "vous", "limova", "avec", "sous", "with", "under", "using", "l'adresse", "adresse", "l'e-mail", "l'email", "e-mail", "email", "mail",
  "le", "la", "the", "address", "de", "du", "of", "mon", "my", "notre", "our", "d'inscription", "inscription", "connexion", "compte", "account", "identifiant", "login"]);
const LINK_SPAN = 48;
/** A negation bearing on the account statement itself ("ce n'est pas mon compte", "not my account"). */
const NEGATED_STATEMENT = /(?:(?<![\p{L}\d])(?:ne|n')\s*(?:\p{L}+\s+)?(?:pas|plus|jamais)|(?<![\p{L}\d])(?:not|never|no longer|isn't|aren't|wasn't))\s+(?:\S+\s+){0,2}$/u;
/** In a continuation reply without an account statement, any negation in the address's clause. */
const NEGATION = /(?<![\p{L}\d])(?:ne|pas|plus|jamais|not|never|isn't|aren't|wasn't)(?![\p{L}\d])|(?<![\p{L}\d])n'/u;
/** A resource to connect/share or a third party in the sentence: never the customer's own account. */
const CONTEXT_VETO = new RegExp(word([
  "outlook", "gmail", "google", "microsoft", "office ?365", "o365", "exchange", "icloud", "yahoo", "hotmail", "agendas?", "calendriers?", "calendars?",
  "bo[iî]tes?", "mailbox(?:es)?", "inbox", "partag\\p{L}*", "shared?", "teams", "whatsapp", "imap", "smtp", "pop3?", "alias", "redirect\\p{L}*", "redirig\\p{L}*",
  "transf[eé]r\\p{L}*", "forward\\p{L}*", "synchro\\p{L}*", "sync\\p{L}*", "branch\\p{L}*", "reli\\p{L}*", "int[eé]gr\\p{L}*", "integrat\\p{L}*", "link(?:ed|ing|s)?",
  "coll[eè]gues?", "colleagues?", "coworkers?", "salari[eé]e?s?", "employ[eé]e?s?", "assistante?s?", "secr[eé]taires?",
  "son compte", "sa bo[iî]te", "leur compte", "his account", "her account", "their account",
].join("|")), "u");
/** Connecting something is a resource; logging oneself in ("me connecter") is not. */
const CONNECT = /(?<![\p{L}\d])(?<!(?:me|se|nous|vous|m'|s')\s?)connect\p{L}*/u;
/** A later correction bound to this address: an interjection right after it ("…, non pardon"),
 * a wrong/someone else's account, or a negated account statement ("mais ce n'est pas mon compte"). */
const CORRECTION = /^[\s,;:.!?-]*(?:non|no|nope|pardon|oups|sorry)(?![\p{L}\d])/u;
const OTHER_ACCOUNT = new RegExp(word([
  "(?:le |un )?compte (?:de|d'un|d'une|du) \\p{L}+", "son compte", "leur compte", "someone else's account", "(?:his|her|their) account", "\\p{L}+'s account",
  "wrong (?:account|email|e-mail|address)", "not the right (?:account|email|e-mail|address)",
  "pas (?:le bon (?:compte|e-?mail|mail)|la bonne adresse)", "mauvaise? (?:compte|adresse|e-?mail|mail)",
].join("|")), "u");
const QUOTED_LINE = /^\s*>/u;
const SIGNOFF = /^\s*(?:--|—|cordialement|bien cordialement|tr[eè]s cordialement|bien [àa] vous|salutations(?: distingu[ée]es)?|best regards|kind regards|regards|best|sincerely|cheers|merci d'avance|merci par avance|bonne journ[ée]e)[\s,.!]*$/u;
const REPLY_HEADER = /^\s*(?:le .{1,160}a [ée]crit\s*:|on .{1,160}wrote\s*:|-{2,}\s*(?:original message|message d'origine|message transf[ée]r[ée])|de\s*:|from\s*:|envoy[ée]\s*:|sent\s*:)/u;
const CLAUSE = /[,:]|(?<![\p{L}\d])(?:et|and|mais|but|puis|then)(?![\p{L}\d])/gu;
/** The clause(s) spanning [from, to): boundaries strictly inside the span do not cut it. */
function clauseAround(sentence: string, from: number, to: number) {
  let start = 0, end = sentence.length;
  for (const boundary of sentence.matchAll(CLAUSE)) {
    if (boundary.index + boundary[0].length <= from) start = boundary.index + boundary[0].length;
    else if (boundary.index >= to) { end = boundary.index; break; }
  }
  return sentence.slice(start, end);
}
const fold = (text: string) => text.normalize("NFC").toLowerCase().replace(/[’`]/g, "'");

type Occurrence = { address: string; start: number; end: number };
export function intakeWrittenAddresses(text: string): Occurrence[] {
  return [...text.matchAll(ADDRESS)].map(match => {
    const raw = match[0].replace(/[.!?]+$/u, "");
    return { address: raw.toLowerCase(), start: match.index, end: match.index + raw.length };
  });
}

type Verdict = { statement: boolean; account: boolean };
function occurrenceVerdict(text: string, occurrences: Occurrence[], target: Occurrence, continuation: boolean): Verdict {
  // Addresses are masked so their dots are no sentence boundary and their domains no keyword.
  let masked = text;
  for (const o of occurrences) masked = masked.slice(0, o.start) + (o === target ? "\u0002" : "\u0001").repeat(o.end - o.start) + masked.slice(o.end);
  const lines = fold(masked.slice(0, target.start)).split("\n");
  const located = QUOTED_LINE.test(lines.at(-1) ?? "") || lines.slice(0, -1).some(line => SIGNOFF.test(line) || REPLY_HEADER.test(line));
  const from = Math.max(...[".", "!", "?", ";", "\n"].map(b => masked.lastIndexOf(b, target.start - 1))) + 1;
  const ends = [".", "!", "?", ";", "\n"].map(b => masked.indexOf(b, target.end)).filter(i => i >= 0);
  const sentence = fold(masked.slice(from, ends.length ? Math.min(...ends) : masked.length));
  const at = sentence.indexOf("\u0002"), after = sentence.lastIndexOf("\u0002") + 1;
  const markers = [...sentence.matchAll(MARKER)];
  const statement = markers.length > 0;
  if (located) return { statement, account: false };
  const linked = (span: string) => span.length <= LINK_SPAN && !span.includes("\u0001")
    && (span.match(/[\p{L}\d'-]+/gu) ?? []).every(token => CONNECTORS.has(token));
  // Vetoes bear on the clause that links the statement to this address, not on the whole
  // sentence: "mon compte Limova est A et je veux connecter B à Outlook" proves A, never B.
  const vetoed = (clause: string) => CONTEXT_VETO.test(clause) || CONNECT.test(clause);
  // A retraction after the address, up to the next written address (so another, unretracted
  // account keeps its own statement): "Mon compte Limova est A, mais ce n'est pas mon compte."
  const rest = fold(masked.slice(target.end)), tail = rest.slice(0, rest.includes("\u0001") ? rest.indexOf("\u0001") : rest.length);
  const retracted = CORRECTION.test(tail) || OTHER_ACCOUNT.test(tail)
    || [...tail.matchAll(MARKER)].some(marker => NEGATED_STATEMENT.test(tail.slice(0, marker.index)));
  for (const marker of markers) {
    const start = marker.index, end = start + marker[0].length;
    if (!(end <= at ? linked(sentence.slice(end, at)) : start >= after && linked(sentence.slice(after, start)))) continue;
    // Only a statement linked to this address can deny it; another address's denial does not.
    if (NEGATED_STATEMENT.test(sentence.slice(0, start))) return { statement, account: false };
    return { statement, account: !retracted && !vetoed(clauseAround(sentence, Math.min(start, at), Math.max(end, after))) };
  }
  if (!continuation) return { statement, account: false };
  // The server verified that an identification template asked this sender for the address.
  const clause = clauseAround(sentence, at, after);
  return { statement, account: !retracted && !NEGATION.test(clause) && !vetoed(clause) };
}

/** True only when the address is written in the source and every one of its occurrences either
 * proves the account role or says nothing about it, with at least one proof. */
export function savIntakeDeclaredAccount(sourceText: string, address: string, options: { continuation: boolean }): boolean {
  const normalized = address.trim().toLowerCase(), occurrences = intakeWrittenAddresses(sourceText);
  const verdicts = occurrences.filter(o => o.address === normalized).map(o => occurrenceVerdict(sourceText, occurrences, o, options.continuation));
  return verdicts.some(v => v.account) && verdicts.every(v => v.account || !v.statement);
}

/** An unproven optional declaration may be discarded (identity then falls back to the sender)
 * only without an inherited continuation request and when no other written address carries an
 * account statement. A resource or third-party address with no such statement is no alternative
 * account; a stated one keeps the strict check, so the reader fails closed instead of guessing. */
export function intakeRegistrationDiscardable(currentText: string, senderEmail: string, inherited: boolean) {
  if (inherited) return false;
  const sender = senderEmail.trim().toLowerCase(), occurrences = intakeWrittenAddresses(currentText);
  return occurrences.every(o => o.address === sender || !occurrenceVerdict(currentText, occurrences, o, false).statement);
}

/** SAV-46 R2: a comparison captures sender scope plus at most this many admissible declared
 * addresses before any paid call. The engine looks up one declared address; a second covers one
 * correction in the same thread. More is refused before dispatch, never truncated. */
export const SAV_INTAKE_DECLARED_ADDRESS_CAP = 2;

/** Every address other than the sender's that the engine could accept as a declared registration
 * for this input: the current message (with the continuation rule when one is supplied) and the
 * sender's earlier complete inbound messages. A superset of what the engine may look up. */
export function savIntakeDeclaredAddressCandidates(input: Pick<EngineInput, "message" | "conversation" | "identificationContinuation">): string[] {
  const sender = input.message.fromEmail.trim().toLowerCase(), found = new Set<string>();
  const prior = input.conversation.status === "complete" ? input.conversation.data.filter(m => m.direction === "inbound" && m.contentComplete
    && m.fromEmail.trim().toLowerCase() === sender) : [];
  const sources: [string, boolean][] = [[input.message.currentText, Boolean(input.identificationContinuation)], ...prior.map(m => [m.currentText, false] as [string, boolean])];
  for (const [text, continuation] of sources) for (const { address } of intakeWrittenAddresses(text))
    if (address !== sender && z.email().safeParse(address).success && savIntakeDeclaredAccount(text, address, { continuation })) found.add(address);
  return [...found].sort();
}
