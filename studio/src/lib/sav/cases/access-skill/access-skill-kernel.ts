import { SAV_CASE_SENSITIVE_WORDS } from "../sensitive-words";

/*
 * SAV-97 (Ugo 18/11): the deterministic EXCLUDE-only kernel of the Access skill. Pure: no model, network, database or clock.
 *
 * It can only send a mail to the team, never admit one: the model decides Access (`access-skill-guidelines.ts`), this file only refuses.
 * It matches PHRASES that always name a request Ugo keeps with the team (cancel, unsubscribe, refund, delete or close the account, stop the
 * subscription, GDPR, a bank dispute), never a lone word: « supprimer un fichier » or « fermer la fenêtre » do not trigger it (Ugo, 18/11).
 * The normalisation (accents, case, apostrophes, doubled letters of common misspellings) is spelling, not a judgment of the wording.
 *
 * The broader context words (prélèvement, abonnement, forfait, payé, facture...) are NOT vetoes: they only ask for the independent
 * model counter-read (`accessSkillContextHits`), so a login trouble that mentions a payment (capcar) can still be Access.
 */

/** Accents, case, apostrophes, spacing, then doubled letters squeezed (« résillier », « abbonnement », « rembourssement »). */
export function normalizeAccessSkillText(value: string): string {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr")
    .replace(/[’`´ʼ]/g, "'").replace(/[ \s]+/g, " ").replace(/([a-z])\1+/g, "$1").trim();
}

/** One kernel phrase: an id for the logs and reports (never the customer's text) and its pattern on the normalised text. */
export type AccessSkillKernelPhrase = Readonly<{ id: string; family: "cancellation" | "subscription" | "finance" | "rights"; pattern: RegExp }>;

// Patterns are written on the NORMALISED text: no accent, lower case, doubled letters squeezed (« supprimer » is « suprimer », « annuler » is « anuler »).
const OWN = String.raw`(?:mon|le|notre|ce|du|l'|cet|mes|nos|les)`;
export const SAV_ACCESS_SKILL_KERNEL: readonly AccessSkillKernelPhrase[] = [
  { id: "resilier", family: "cancellation", pattern: /\bre[sz]il(?:i|y)\w*/ },
  { id: "desabonner", family: "cancellation", pattern: /\bdesabo(?:n\w*)?\b/ },
  { id: "rembourser", family: "finance", pattern: /\br[ae][mn]bour?s\w*/ },
  { id: "supprimer_compte", family: "cancellation", pattern: new RegExp(String.raw`\bsuprim\w* ${OWN} ?(?:propre )?comptes?\b|\bsupresion (?:de |du )?(?:mon |notre |ce |le )?comptes?\b`) },
  { id: "fermer_compte", family: "cancellation", pattern: new RegExp(String.raw`\bferm\w* ${OWN} ?comptes?\b|\bfermeture (?:de |du )?(?:mon |notre |ce |le )?comptes?\b`) },
  { id: "arreter_abonnement", family: "subscription", pattern: new RegExp(String.raw`\b(?:suprim|anul|aret|stop|interomp|clotur|ferm)\w* ${OWN} ?abonements?\b|\b(?:metre|met|mis) fin a ${OWN} ?abonements?\b|\b(?:anulation|suspension|aret|supresion|cloture) (?:de |du )?(?:mon |notre |l'|le )?abonements?\b`) },
  { id: "rgpd", family: "rights", pattern: /\b(?:rgpd|gdpr|droit a l'oubli)\b|\b(?:supresion|efacement|suprimer|efacer) (?:de |toutes )?(?:mes|nos|toutes mes) (?:dones|informations personeles)\b/ },
  { id: "opposition_bancaire", family: "finance", pattern: /\b(?:faire|fait|ferai|ferais|mettre|mis|mets|fais|faites) (?:une )?oposition\b|\boposition (?:bancaire|au prelevement|sur (?:le|mon|ma|la|ce|cete) (?:prelevement|carte|paiement|virement))\b|\blitige (?:bancaire|avec (?:ma|la|notre) banque|de paiement|aupres de (?:ma|la|notre) banque)\b|\bchargeback\b/ },
  // The same requests in English (exclude-only translations of the phrases above).
  { id: "en_cancel", family: "cancellation", pattern: /\bcancel\w* (?:my|the|our|this) (?:subscription|acount|plan|membership|contract)\b|\bunsubscrib\w*|\b(?:delete|close|terminate|remove) (?:my|the|our|this) acount\b/ },
  { id: "en_refund", family: "finance", pattern: /\brefund\w*|\bdispute (?:the|a|this|my) (?:charge|payment)\b/ },
];

/** The ids of the kernel phrases present in these texts (subject, whole body, an original request...), in kernel order. Empty: the kernel says nothing. */
export function accessSkillKernelHits(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const value = normalizeAccessSkillText(texts.filter(Boolean).join("\n"));
  return SAV_ACCESS_SKILL_KERNEL.filter(phrase => phrase.pattern.test(value)).map(phrase => phrase.id);
}

/*
 * Context words: they never decide, they only ask for the second, independent model reading (the counter-read). The existing sensitive word list
 * (`sensitive-words.ts`, read on the same normalisation as before, accents removed and NOT squeezed) plus a few more forms (English, mandate, plan...).
 */
const EXTRA_CONTEXT = /\b(?:abon+e\w*|mandat|sepa|renouvel\w*|offre|plan|credit|virement|cb|carte|commande|devis|contrat|engagement|annul\w*|supprim\w*|ferm(?:er|ez|eture) (?:mon|le|notre) (?:espace|acces)|donnees|proprietaire|titulaire|identite|hack\w*|subscription|invoice|billing|payment|paid|pay|charged?|price|pricing|trial|upgrade|downgrade|renew\w*|bank)\b/;
const normalizeWords = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`]/g, "'");

/** The context families or words present (closed ids only). Non-empty: the counter-read must answer « no » before anything is admitted. */
export function accessSkillContextHits(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const value = normalizeWords(texts.filter(Boolean).join("\n"));
  const hits: string[] = SAV_CASE_SENSITIVE_WORDS.filter(([, pattern]) => pattern.test(value)).map(([family]) => `sensitive_${family}`);
  if (EXTRA_CONTEXT.test(value)) hits.push("context_extra");
  return hits;
}
