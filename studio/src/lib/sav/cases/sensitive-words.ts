import type { CaseRequestFamily } from "./case-types";

/*
 * The fixed code rule on sensitive words (finance, cancellation, subscription, rights, identity), shared by the V2 return rule
 * (`investigation-return-qualify.ts`, where it was defined) and the block harness (SAV-92): any of these words anywhere in a mail sends
 * the WHOLE mail to the team, whatever block the cards point to. A block, a card or a manifest can never relax it. Pure.
 */
export const normalizeSensitiveText = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`]/g, "'");
// Read on the customer's own new words (quoted history and signature removed). Any sensitive word wins: a sensitive or mixed return stops.
export const SAV_CASE_SENSITIVE_WORDS: ReadonlyArray<readonly [CaseRequestFamily, RegExp]> = [
  ["cancellation", /\b(?:resili\w*|desabonn\w*|annuler (?:mon|l'|notre) (?:abonnement|compte|offre)|supprimer (?:mon|notre) compte|fermer (?:mon|notre) compte)\b/],
  ["finance", /\b(?:rembours\w*|factur\w*|paiement\w*|pay(?:er|e|ee|es|ees|ant|ante)|prelev\w*|debit\w*|carte bancaire|avoirs?|litige|impaye\w*|tarif\w*|prix)\b/],
  ["subscription", /\b(?:abonnement|changer d'offre|changement d'offre|upgrade|downgrade|essai gratuit|forfait)\b/],
  ["rights", /\b(?:rgpd|donnees personnelles|droit d'acces|suppression de (?:mes|nos) donnees)\b/],
  ["identity", /\b(?:changer (?:le|de) (?:proprietaire|titulaire)|transferer (?:le|mon) compte|usurp\w*|pirat\w*|compte (?:vole|hacke))\b/],
];
// Leave ambiguous "avoir" under the financial fence. Only an infinitive with an explicit
// login object or a reported check is removed from the sensitive scan; other words still count.
export const SAV_CASE_LOGIN_INFINITIVE = /(?<!\b(?:un |cet |mon |ton |son |notre |votre |leur |l'))\bavoir(?=\s+(?:(?:le|mon|un|ce) (?:bon )?(?:code|lien)|acces|(?:bien |deja )?(?:verifie|consulte|regarde|essaye))\b)/g;

/** The sensitive families whose words appear in this text (normalized, the login infinitive « avoir le code » set aside), in rule order. */
export function caseSensitiveFamiliesInText(text: string): CaseRequestFamily[] {
  const value = normalizeSensitiveText(text).replace(SAV_CASE_LOGIN_INFINITIVE, "");
  return SAV_CASE_SENSITIVE_WORDS.filter(([, pattern]) => pattern.test(value)).map(([family]) => family);
}
