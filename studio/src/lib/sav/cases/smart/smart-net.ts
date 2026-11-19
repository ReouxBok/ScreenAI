import { containsPromptInjection } from "../../policy";
import { accessSkillKernelHits } from "../access-skill/access-skill-kernel";
import { maskCaseCustomerText } from "../investigation-customer-context";
import { normalizeSensitiveText } from "../sensitive-words";

/*
 * Agent SAV intelligent, lot D1, step 0 (20/11, calibrated the same evening): the safety net WITHOUT any model. Pure: no model, network, database or clock.
 *
 * Ugo's base stays absolute: a REAL request about cancellation, refund, billing, payment, subscription, personal data or account identity goes
 * WHOLE to the team, 0 paid call, zero tolerance. What changed (prod, 19/11: 15 mails out of 15 stopped as sensitive or handed over, none
 * answered): a WORD alone no longer stops the mail. Limova's customers run their own business with their Assistants (their invoices, their
 * prices, their quotes), and mails carry footers (« pour vous désabonner », RGPD notices), signatures (« Service facturation ») and quoted
 * history. So the net reads the INTEGRAL raw text (subject, body, signature, PS, quoted history: nothing is cut before it reads) and:
 *   - stops on a kernel phrase of the Access skill (résilier, rembourser, désabonner, supprimer mon compte, RGPD, opposition bancaire...)
 *     anywhere, quoted history and PS included, EXCEPT on a boilerplate line (legal notice, newsletter unsubscribe footer, company registration);
 *   - stops on a request form about the customer's OWN Limova bill or subscription (« ma facture », « cette facture », « j'ai été prélevé »,
 *     « double prélèvement », « changer d'offre », « mon abonnement », « combien coûte »...) in the customer's own new words (quoted history
 *     removed, boilerplate removed, signature labels removed; a PS or a sentence written after the signature still counts);
 *   - stops on a sensitive topic word in the SUBJECT when the body is too thin to say what is asked (« Question tarif » / « Bonjour »);
 *   - stops on an instruction aimed at the model, an empty mail, or a mail too long to be read whole;
 *   - otherwise lets the mail go to the model's reading (the second barrier), with closed `hint:*` codes for the words it saw but did not stop on
 *     (measured in the shadow). The server's checks on the reply (`kernel_in_reply`, promises) and the counter-read stay the third barrier.
 */

/** A mail longer than this (masked, characters) is never given to the model in part: the whole mail goes to the team. */
export const SAV_SMART_MAIL_MAX_CHARS = 8_000;
export const SAV_SMART_SUBJECT_MAX_CHARS = 300;

export type SmartNetResult = Readonly<{ stop: false; hints: readonly string[] }> | Readonly<{ stop: true; reasons: readonly string[] }>;

/** Letters left in the body once greetings are removed, under which the subject alone says what is asked. */
const SUBJECT_ONLY_MIN_CHARS = 25;
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

/** Requests about the customer's OWN Limova bill, payment or subscription (normalized text: no accent, lower case). */
const OWN_BILLING_REQUESTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["finance", /\b(?:ma|cette|votre|derniere) (?:derniere |premiere )?factur\w*\b(?! (?:de|a|aux|pour) (?:mes|nos) clients)|\bfactur\w* (?:limova|de limova|du mois|de l'abonnement|de mon abonnement)\b/],
  // Getting a copy of one's invoices (« où télécharger mes factures ? », « la facture de novembre »), the invoices of the customer's OWN clients aside.
  ["finance", /\b(?:mes|nos) factur\w*\b(?! (?:a|aux|de|des|pour) (?:mes |nos )?(?:clients|fournisseurs))|\b(?:telecharg|recuper|retrouv|obten|recevoir|consult|acced|trouv|voir|avoir)\w* (?:\w+ ){0,2}(?:la|les|une) factur\w*\b(?! (?:a|aux|de|des|pour) (?:mes |nos )?(?:clients|fournisseurs))|\bfactur\w* (?:de |d'|du mois (?:de |d'))?(?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\b/],
  ["finance", /\b(?:me |m'|nous )(?:envoyer|renvoyer|transmettre|faire parvenir|redonner)\w* (?:\w+ ){0,3}factur\w*/],
  ["finance", /\b(?:contest\w*|errone\w*|erreur (?:de|sur (?:la|ma)) factur\w*|double (?:prelevement|paiement|debit|facturation)|(?:preleve|debite|facture)\w* (?:deux|2|plusieurs) fois|trop (?:paye|preleve|facture))\b/],
  ["finance", /\b(?:j'ai ete|on m'a|vous m'avez|nous avons ete|j'ai encore ete) (?:preleve|debite|facture)\w*|\bprelevement\w*\b|\bcarte bancaire\b|\blitige\b/],
  ["finance", /\bcombien (?:ca |cela )?cout\w*|\bquel(?:le)? (?:est (?:le|votre) )?(?:prix|tarif)\b|\b(?:vos|votre) (?:tarifs?|prix)\b|\b(?:payer|paye|paie) (?:limova|l'abonnement|mon abonnement|ma facture)\b/],
  ["subscription", /\b(?:(?:mon|notre|votre|cet|son) |l')abonnement\b|\bessai gratuit\b|\bforfait\b|\b(?:changer|changement|modifier|passer|upgrade|downgrade|augmenter|reduire|baisser)\w* (?:\w+ ){0,3}(?:d'offre|d'abonnement|de forfait|de formule|(?:mon|l'|d'|notre|la|le|une) ?(?:offre|abonnement|forfait|formule|plan))\b/],
  ["cancellation", /\b(?:resili\w*|desabonn\w*|annuler (?:mon|l'|notre) (?:abonnement|compte|offre)|supprimer (?:mon|notre) compte|fermer (?:mon|notre) compte)\b/],
  ["rights", /\b(?:rgpd|donnees personnelles|droit d'acces|suppression de (?:mes|nos) donnees)\b/],
  ["identity", /\b(?:changer (?:le|de) (?:proprietaire|titulaire)|transferer (?:le|mon) compte|usurp\w*|pirat\w*|compte (?:vole|hacke))\b/],
];
/** Topic words: in the subject they stop (the subject names the topic); in the body alone they are only a hint for the model's reading. */
const TOPIC_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["finance", /\b(?:rembours\w*|factur\w*|paiement\w*|prelev\w*|debit\w*|impaye\w*|tarif\w*|prix|avoir(?:s)? (?:sur|de|commercial)|litige)\b/],
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

/** Every line of the integral text except boilerplate (kernel phrases are read there, quoted history included). */
const withoutBoilerplate = (text: string) => String(text ?? "").split(/\r?\n/).filter(line => !isBoilerplate(norm(line))).join("\n");

/** Step 0 on the integral raw texts (never truncated before reading). `reasons` and `hints`: closed codes only. */
export function smartSafetyNet(input: Readonly<{ subject: string; body: string }>): SmartNetResult {
  const subject = String(input.subject ?? ""), body = String(input.body ?? "");
  const subjectNorm = norm(subject), fresh = smartFreshText(body);
  const reasons = [
    ...accessSkillKernelHits(subject, withoutBoilerplate(body)).map(id => `kernel:${id}`),
    ...OWN_BILLING_REQUESTS.filter(([, pattern]) => pattern.test(fresh) || pattern.test(subjectNorm)).map(([family]) => `sensitive:${family}`),
    // A topic word in the subject stops only when the body is too thin to say what is asked (« Question tarif » / « Bonjour »).
    ...(fresh.replace(/\b(?:bonjour|bonsoir|hello|merci|voir (?:le )?(?:sujet|objet))\b|[^a-z]/g, "").length < SUBJECT_ONLY_MIN_CHARS
      ? TOPIC_WORDS.filter(([, pattern]) => pattern.test(subjectNorm)).map(([family]) => `sensitive:${family}`) : []),
  ];
  if (containsPromptInjection(`${subject}\n${body}`)) reasons.push("instruction_in_mail");
  if (!body.trim() && !subject.trim()) reasons.push("empty");
  if (smartMask(body).length > SAV_SMART_MAIL_MAX_CHARS || smartMask(subject).length > SAV_SMART_SUBJECT_MAX_CHARS) reasons.push("too_long");
  if (reasons.length) return { stop: true, reasons: [...new Set(reasons)] };
  const whole = norm(body);
  return { stop: false, hints: [...new Set(TOPIC_WORDS.filter(([, pattern]) => pattern.test(whole) || pattern.test(subjectNorm)).map(([family]) => `hint:${family}`))] };
}

/**
 * What the model may read of a customer text: secrets named as such, tokens, keys, IBANs, cards, phones AND email addresses masked
 * (`maskCaseCustomerText`, emails on). Masking runs before any bound, so a cut never exposes half of a secret. Idempotent.
 */
export const smartMask = (value: string) => maskCaseCustomerText(String(value ?? ""), { emails: true });
