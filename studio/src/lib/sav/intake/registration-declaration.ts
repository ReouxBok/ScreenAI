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
/** R3/R4: a retraction of THIS declaration only, read in the rest of its sentence (up to the next
 * written address) or in the sentence right after it: an interjection opening it ("…, non",
 * "Sorry, …"), or a statement that refers back to the address ("ce n'est pas mon compte",
 * "this is not my account", "c'est le compte de mon collègue"). An independent later statement
 * ("Je ne connais pas mon identifiant", "mon collègue a un problème sur son compte") is not one. */
const CORRECTION = /^[\s,;:.!?-]*(?:non|no|nope|pardon|oups|sorry)(?![\p{L}\d])/u;
const OWNED = `(?:${MARKER.source}|le bon|la bonne|[àa] moi|(?:le |l')(?:compte|adresse|e-?mail|mail) (?:de|d'un|d'une|du) \\p{L}+|the right (?:account|email|e-mail|address)|mine|(?:my |his |her |their )?\\p{L}+'s (?:account|email|e-mail|address)|(?:his|her|their|someone else's) (?:account|email|e-mail|address))`;
const REFERS_BACK = new RegExp(word([
  `(?:ce|c'|cela|ça|ca|elle|cette adresse|cet e-?mail|ce mail)\\s*(?:n'|ne\\s+)?(?:est|était|sera)\\s+(?:(?:pas|plus|jamais)\\s+(?:\\S+\\s+){0,2}?${OWNED}|(?:le |l')(?:compte|adresse|e-?mail|mail) (?:de|d'un|d'une|du) \\p{L}+)`,
  `(?:this|that|it|this address|this email|that address)\\s*(?:is|'s|was)\\s+(?:(?:not|no longer|never)\\s+(?:\\S+\\s+){0,2}?${OWNED}|(?:my |his |her |their )?\\p{L}+'s (?:account|email|e-mail|address)|(?:his|her|their|someone else's) (?:account|email|e-mail|address))`,
  `(?:this|that|it)\\s*(?:isn't|wasn't)\\s+(?:\\S+\\s+){0,2}?${OWNED}`,
].join("|")), "u");
/** R5: an admitted mistake corrects this address only when it bears on an address/account
 * ("je me suis trompé d'adresse") or leads straight to another written address ("Je me suis
 * trompé, voici la bonne : Y", "My mistake, the correct one is Y"); a mistake about anything
 * else ("je me suis trompé dans la configuration du calendrier") or an "Erreur 500" is not one. */
const MISTAKE = `je me suis tromp\\p{L}*|je me trompe|erreur de ma part|au(?:tant| temps) pour moi|faute de frappe|my mistake|my bad|i was wrong|i made a (?:mistake|typo)|i mistyped(?: it)?|typo`;
const MISTAKE_ON_ADDRESS = new RegExp(word(`(?:${MISTAKE})\\s*(?:d'|de |dans l'|dans le |sur l'|sur le |in the |on the |with the )(?:adresse|compte|e-?mail|mail|address|account|identifiant)`), "u");
const MISTAKE_BEFORE_ADDRESS = new RegExp(word(MISTAKE), "u");
const REPLACEMENT = new RegExp(word("voici la bonne|la bonne(?: adresse| e-?mail)?(?: est| c'est)|c'est plut[ôo]t|the (?:correct|right) (?:one|address|email|e-mail|account)(?: is)?|it should be|it's actually"), "u");
/** R6: an explicit replacement written right before the next address ("Correction : Y …",
 * "Utilisez plutôt Y", "…, ou plutôt Y", "Use Y instead"). "Correction : le calendrier B …" does
 * not reach the address directly and replaces nothing. */
const REPLACES_NEXT = new RegExp(`${word("correction|rectification|erratum|plut[ôo]t|rather|à la place|instead")}[\\s:,-]*$`, "u");
const USE_NEXT = new RegExp(`${word("utilisez|utiliser|use|prenez|take")}\\s+$`, "u");
const INSTEAD = new RegExp(`^\\s*${word("instead|à la place|plut[ôo]t|rather")}`, "u");
type Part = { text: string; stopped: boolean; after: string };
const corrects = (part: Part) =>
  MISTAKE_ON_ADDRESS.test(part.text) || (part.stopped && (MISTAKE_BEFORE_ADDRESS.test(part.text) || REPLACEMENT.test(part.text)
    || REPLACES_NEXT.test(part.text) || (USE_NEXT.test(part.text) && INSTEAD.test(part.after))));
const WRONG_HERE = new RegExp(word("wrong (?:account|email|e-mail|address)|not the right (?:account|email|e-mail|address)|pas (?:le bon (?:compte|e-?mail|mail)|la bonne adresse)|mauvaise? (?:compte|adresse|e-?mail|mail)"), "u");
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
  // Retraction of this declaration (see REFERS_BACK), never past the next written address, so
  // another, unretracted account keeps its own statement.
  const cut = (part: string): Part => part.includes("\u0001")
    ? { text: part.slice(0, part.indexOf("\u0001")), stopped: true, after: part.slice(part.indexOf("\u0001")).replace(/^\u0001+/u, "") }
    : { text: part, stopped: false, after: "" };
  const sentenceEnd = ends.length ? Math.min(...ends) : masked.length;
  const here = cut(fold(masked.slice(target.end, sentenceEnd)));
  const following = masked.slice(sentenceEnd).replace(/^[\s.!?;]+/u, "");
  const nextEnds = [".", "!", "?", ";", "\n"].map(b => following.indexOf(b)).filter(i => i >= 0);
  const next = here.stopped ? { text: "", stopped: false, after: "" } : cut(fold(following.slice(0, nextEnds.length ? Math.min(...nextEnds) : following.length)));
  const retracted = CORRECTION.test(here.text) || REFERS_BACK.test(here.text) || WRONG_HERE.test(here.text) || corrects(here)
    || CORRECTION.test(next.text) || REFERS_BACK.test(next.text) || corrects(next);
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

/** Every distinct address of one source that proves the account role on its own: written, every
 * occurrence either proving it or saying nothing about it, with at least one proof (R1–R6). */
function admittedAccounts(sourceText: string, continuation: boolean): string[] {
  const occurrences = intakeWrittenAddresses(sourceText);
  return [...new Set(occurrences.map(o => o.address))].filter(address => {
    const verdicts = occurrences.filter(o => o.address === address).map(o => occurrenceVerdict(sourceText, occurrences, o, continuation));
    return verdicts.some(v => v.account) && verdicts.every(v => v.account || !v.statement);
  });
}

/** R7: one source that still admits two distinct accounts is a conflict, never a choice: neither
 * proves the role, whichever the reader picked. A retraction that leaves one account (R3–R6), a
 * resource, a third party or a denied address is no second account. */
export function savIntakeAccountConflict(sourceText: string, options: { continuation: boolean }): boolean {
  return admittedAccounts(sourceText, options.continuation).length > 1;
}

/** True only when the address is the single account its source admits. */
export function savIntakeDeclaredAccount(sourceText: string, address: string, options: { continuation: boolean }): boolean {
  const admitted = admittedAccounts(sourceText, options.continuation);
  return admitted.length === 1 && admitted[0] === address.trim().toLowerCase();
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
type CandidateInput = Pick<EngineInput, "message" | "conversation" | "identificationContinuation">;
function candidateSources(input: CandidateInput): [string, boolean][] {
  const sender = input.message.fromEmail.trim().toLowerCase();
  const prior = input.conversation.status === "complete" ? input.conversation.data.filter(m => m.direction === "inbound" && m.contentComplete
    && m.fromEmail.trim().toLowerCase() === sender) : [];
  return [[input.message.currentText, Boolean(input.identificationContinuation)], ...prior.map(m => [m.currentText, false] as [string, boolean])];
}
/** R7: a source of this input admits two distinct accounts; the comparison refuses it before any
 * paid call. Distinct sources (an earlier message and the current one) are not a conflict. */
export function savIntakeDeclaredAddressConflict(input: CandidateInput): boolean {
  return candidateSources(input).some(([text, continuation]) => savIntakeAccountConflict(text, { continuation }));
}
export function savIntakeDeclaredAddressCandidates(input: CandidateInput): string[] {
  const sender = input.message.fromEmail.trim().toLowerCase(), found = new Set<string>();
  for (const [text, continuation] of candidateSources(input)) for (const { address } of intakeWrittenAddresses(text))
    if (address !== sender && z.email().safeParse(address).success && savIntakeDeclaredAccount(text, address, { continuation })) found.add(address);
  return [...found].sort();
}
