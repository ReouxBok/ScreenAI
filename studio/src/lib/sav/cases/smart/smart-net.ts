import { containsPromptInjection } from "../../policy";
import { maskCaseCustomerText } from "../investigation-customer-context";
import { normalizeSensitiveText } from "../sensitive-words";

/*
 * Agent SAV intelligent, lot D1, step 0 (20/11; N2 the same night, Ugo: « le mini-filet doit être smart mais pas restrictif »): the net WITHOUT
 * any model before the first call. Pure: no model, network, database or clock.
 *
 * It no longer stops a mail on its WORDS (calibrated word lists stopped 8 ordinary mails out of 10 in the shadow: invoices, prices,
 * subscriptions are part of the customers' own business). What is left before the model is TECHNICAL only:
 *   - an empty mail, or a mail too long to be read whole (never given to the model in part);
 *   - an instruction aimed at the model (`smartInstructionToModel`): a security stop, not a judgment of the subject. Since the N2 review it
 *     is the shared detector, except that its bare words (« system prompt ») need an order addressed to the assistant: a customer who
 *     reports the LABEL « system prompt » shown by their Assistant is not stopped;
 *   - the cleaning of quoted history (`smartFreshText`) and the masking of personal data (`smartMask`).
 * Sensitivity and anger are the MODEL's judgment (the reading: `sensible`, `sensitiveFamilies`, `upset`), with zero tolerance: any doubt
 * goes to the team. After the model, the server reads only OUR reply (`smart-checks.ts`, `sensitive_commitment`), then the counter-read.
 * `hints`: closed `hint:*` codes for topic words seen in the mail, informational only (shadow report), never a stop.
 */

/** A mail longer than this (masked, characters) is never given to the model in part: the whole mail goes to the team. */
export const SAV_SMART_MAIL_MAX_CHARS = 8_000;
export const SAV_SMART_SUBJECT_MAX_CHARS = 300;

export type SmartNetResult = Readonly<{ stop: false; hints: readonly string[] }> | Readonly<{ stop: true; reasons: readonly string[] }>;

const norm = (value: string) => normalizeSensitiveText(value).replace(/[ \t]+/g, " ");

/** The start of quoted history: « Le lun. 18 nov. a écrit : », « On ... wrote: », « -----Message d'origine----- », an Outlook « De : » header, or a « > » line. */
const QUOTE_START = /^(?:>|(?:le|on) .{0,160}(?:a ecrit|wrote)\s*:?\s*$|-{2,}\s*(?:message d'origine|original message|message transfere|forwarded message)|de ?: .{1,160}$)/;
/**
 * Boilerplate lines: identifiable footer FORMULAS only (Astra, 20/11: a lone « pièce jointe » or « destinataire » is not a footer, « vous trouverez
 * en pièce jointe la demande de remboursement » is a request). Confidentiality notice, print/environment notice, legal data notice, newsletter
 * unsubscribe, « envoyé depuis », company registration.
 */
const BOILERPLATE = /\b(?:(?:ce|cet) (?:message|e-?mail|courriel|mail)(?: et (?:ses|les|toutes? (?:ses|les)) pieces? jointes?)? (?:est|sont|peut|peuvent)\b.{0,60}\bconfidentiel\w*|si vous n'etes pas (?:le|la|les) destinataires?|(?:information|message)s? confidentiel\w* (?:et|destine)|avant d'imprimer|imprimer ce (?:mail|message|courriel)|pensez a l'environnement|conformement (?:au rgpd|a la (?:loi|reglementation))[^.]{0,40}vous disposez|vous disposez d'un droit|politique de (?:confidentialite|protection)|mentions legales|pour (?:vous|se) desabonner|se desabonner|desinscri\w*|unsubscribe|gerer (?:vos|mes) preferences|cet e-?mail (?:a ete|vous a ete) envoye|this (?:e-?mail|message) (?:is|may|was)|siret|siren|rcs |capital (?:social )?de|tva intra\w*|envoye depuis|sent from my)\b/;
/** Where a signature starts (the lines after it may be labels: « Service facturation », « Gérant | Tarifs sur demande »). */
const SIGN_OFF = /^(?:--\s*|cordialement\b.*|bien (?:a vous|cordialement)\b.*|bonne (?:journee|soiree)\b.*|belle journee\b.*|merci d'avance\b.*|sinceres salutations\b.*|salutations\b.*|a bientot\b.*|regards?\b.*|best\b.*)$/;
/** First person: a line where the customer speaks for themself is never boilerplate (« je souhaite, conformément au RGPD, ... »). */
const FIRST_PERSON = /\b(?:je|j'|moi|mon|ma|mes|nous|notre)\b/;
const isBoilerplate = (line: string) => BOILERPLATE.test(line) && !FIRST_PERSON.test(line);
/** A line that speaks (first person, a request, a question): never a mere signature label. A PS always speaks. */
const SPEAKS = /(?:^p\.? ?s\.?\b|\?|\b(?:je|j'|nous|on|vous|mon|ma|mes|notre|nos|pouvez|pourriez|voudrais|veux|souhaite|merci de|svp|stp)\b)/;

/** Topic words: informational hints only (never a stop since N2). */
const TOPIC_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["finance", /\b(?:rembours\w*|factur\w*|paiement\w*|prelev\w*|debit\w*|impaye\w*|tarif\w*|prix|avoirs? (?:sur (?:ma|la|votre|notre|cette) facture|commercial)|un avoir\b|litige)\b/],
  ["subscription", /\b(?:abonnement\w*|offre|forfait|essai gratuit|upgrade|downgrade)\b/],
  ["cancellation", /\b(?:resili\w*|desabonn\w*)\b/],
  ["rights", /\b(?:rgpd|donnees personnelles)\b/],
  ["identity", /\b(?:proprietaire|titulaire|pirat\w*|usurp\w*)\b/],
];

/** The customer's own new words: quoted history removed, boilerplate lines removed, signature labels removed (a PS or a speaking line kept). */
export function smartFreshText(body: string): string {
  const kept: string[] = [];
  let signature = false;
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = norm(raw).trim();
    if (!line) continue;
    if (QUOTE_START.test(line)) break;
    if (isBoilerplate(line)) continue;
    if (SIGN_OFF.test(line)) { signature = true; continue; }
    if (signature && !SPEAKS.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Astra, N2 review (P2): the shared detector (`containsPromptInjection`) also stops on the BARE words « system prompt », « developer message »
 * or « jailbreak », so a customer who reports that label shown by their Assistant went to the team. Here those bare words count only with an
 * order addressed to the assistant (normalized text). The other patterns of the shared detector are kept as they are: never broader than it.
 */
const BARE_LABELS = /system prompt|developer message|jailbreak/gi;
const ORDER_TO_MODEL: readonly RegExp[] = [
  /\b(?:revele[sz]?|devoile[sz]?|montre[sz]?-moi|affiche[sz]?-moi|donne[sz]?-moi|repete[sz]?|recopie[sz]?|ecris-moi)\b(?: \w+){0,2} (?:ton|tes|votre|vos) (?:prompt|system prompt|consignes|instructions|regles)\b/,
  /\b(?:reveal|show me|print|repeat|output|dump|leak|disclose|tell me|ignore|forget|disregard)\b(?: \w+){0,2} (?:your|the) (?:system prompt|hidden prompt|developer message|instructions|initial prompt|rules)\b/,
  /\bjailbreak(?:ed|ing)? (?:mode|prompt|yourself|toi)\b|\b(?:tu es|you are) (?:maintenant|now) (?:en mode|in) (?:dan|developpeur|developer|jailbreak)\b/,
];
/** True when a customer text gives the assistant an order about its own rules (exported for the tests). */
export function smartInstructionToModel(value: string): boolean {
  if (!containsPromptInjection(value)) return false;
  if (containsPromptInjection(value.replace(BARE_LABELS, " "))) return true;
  const text = norm(value);
  return ORDER_TO_MODEL.some(pattern => pattern.test(text));
}

/** Step 0 on the integral raw texts (never truncated before reading). Technical stops only; `reasons` and `hints`: closed codes only. */
export function smartSafetyNet(input: Readonly<{ subject: string; body: string }>): SmartNetResult {
  const subject = String(input.subject ?? ""), body = String(input.body ?? "");
  const reasons: string[] = [];
  if (smartInstructionToModel(`${subject}\n${body}`)) reasons.push("instruction_in_mail");
  if (!body.trim() && !subject.trim()) reasons.push("empty");
  if (smartMask(body).length > SAV_SMART_MAIL_MAX_CHARS || smartMask(subject).length > SAV_SMART_SUBJECT_MAX_CHARS) reasons.push("too_long");
  if (reasons.length) return { stop: true, reasons };
  const whole = `${norm(subject)}\n${norm(body)}`;
  return { stop: false, hints: TOPIC_WORDS.filter(([, pattern]) => pattern.test(whole)).map(([family]) => `hint:${family}`) };
}

/**
 * What the model may read of a customer text: secrets named as such, tokens, keys, IBANs, cards, phones AND email addresses masked
 * (`maskCaseCustomerText`, emails on). Masking runs before any bound, so a cut never exposes half of a secret. Idempotent.
 */
export const smartMask = (value: string) => maskCaseCustomerText(String(value ?? ""), { emails: true });
