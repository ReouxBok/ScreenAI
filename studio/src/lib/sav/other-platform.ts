/*
 * SAV-122 (21/11): ONE source of truth for « never send the customer to another platform », shared by the bench (its corpus patterns) and the
 * smart agent's server check on OUR reply (`cases/smart/smart-checks.ts`). Pure: no model, network or clock. It never reads an inbound mail as
 * a filter: the customer's text is only used to recognise, in our reply, the name of a tool the customer wrote himself.
 *
 * Every function here reads FOLDED text (no accent, lower case, straight apostrophes), like the bench's `mustNotMatch` patterns.
 */

/** Signing up elsewhere: the bench's `NO_SIGNUP` (corpus C), moved here. The bench reads them on the whole reply; the check, per sentence. */
export const SAV_OTHER_PLATFORM_SIGNUP = ["inscri", "creez un compte (chez|sur)", "abonnez-vous"] as const;

/** Third parties a customer may name: none may be recommended; one may be named only when the customer uses it already (or a cited card names it). */
export const SAV_OTHER_PLATFORM_THIRD_PARTIES = Object.freeze([
  "yonos", "wix", "shopify", "wordpress", "squarespace", "webflow", "jimdo", "prestashop", "zapier", "make.com", "n8n", "ifttt", "hubspot", "salesforce", "pipedrive",
  "brevo", "sendinblue", "mailchimp", "aircall", "ringover", "twilio", "vapi", "retell", "bland", "calendly", "chatgpt", "openai", "copilot", "notion", "monday", "trello",
  "canva", "lemlist", "waalaxy", "zoho", "odoo", "axonaut", "pennylane", "intercom", "zendesk", "crisp", "tidio", "manychat", "systeme.io", "kajabi", "podia", "agicap",
]);

/** Limova's own words: a sentence that names them is about Limova (« inscrivez-vous au webinaire Limova », « créez votre compte sur l'Academy »). */
export const SAV_OTHER_PLATFORM_LIMOVA = /\b(?:limova|webinaires?|academy|charly)\b/;

/** The sentence tells the customer to leave or replace Limova: always a redirection, with or without a name. */
export const SAV_OTHER_PLATFORM_LEAVES = /\b(?:remplac\w* limova|a la place de limova|au lieu de limova|plutot que limova|quitt\w* limova|sans limova)\b/;

/*
 * PORTE 1J (orchestrator): ONE principle, read per CLAUSE (cut on commas, « si », « mais », « ou », « puis »): the third-party tool NAMED in the
 * clause decides. A clause is refused when it carries an orientation verb AND a named third party (known list or written by the customer),
 * unless that same clause configures, connects, links or uses the tool in / with Limova, or picks it in the Intégrations menu. A clause without a
 * named third party is never refused for a sign-up (« Sur Limova, créez votre compte » passes); leaving Limova is refused above.
 */
export const savOtherPlatformClauses = (foldedSentence: string) => foldedSentence.split(/[,;()]|:\s|\b(?:si|mais|ou|puis)\b/).map(row => row.trim()).filter(Boolean);
const ORIENT = new RegExp(String.raw`\b(?:(?:d'|de |vous pouvez |vous pourriez |je vous invite a |mieux vaut |il vaut mieux )(?:utiliser|passer (?:par|chez|sur)|essayer|tester|opter pour|vous tourner vers)|utilisez|passez (?:par|chez|sur)|essayez|testez|optez pour|tournez-vous vers|rendez-vous sur|allez sur|activez|prenez|recommande|conseille|suggere|souscri\w*|ouvrez un compte|creez (?:un|votre) compte|${SAV_OTHER_PLATFORM_SIGNUP.join("|")})`);
const INSIDE_LIMOVA = /\b(?:configur|connect|reli|branch|synchronis|integr|associ)\w*\b.{0,60}\b(?:dans|a|avec|sur|de) limova\b|\b(?:avec|dans|a|depuis) limova\b|\b(?:dans|depuis|via) (?:le |vos |les )?(?:menu |onglet |rubrique )?(?:integrations?|parametres)\b|\b(?:parametres|integrations) >/;
const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namesPattern = (names: readonly string[]) => new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${names.map(escapeName).join("|")})(?![\p{L}\p{N}])`, "u");
/** True when one clause orients the customer to a NAMED third party, outside configuring it in Limova. */
export function savOtherPlatformOrients(foldedSentence: string, names: readonly string[]): boolean {
  if (!names.length) return false;
  const named = namesPattern(names);
  return savOtherPlatformClauses(foldedSentence).some(clause => ORIENT.test(clause) && named.test(clause) && !INSIDE_LIMOVA.test(clause));
}

/*
 * Advice to go and use another tool, with no name needed: « vous pourriez passer par un autre outil », « changez de créateur de site »,
 * « passez à la formule supérieure ». The bench's own patterns (`(changez|passez) (de|sur) (site|createur|outil)`) are a subset.
 */
const TOOL_NOUN = String.raw`(?:autre|outil|service|plateforme|logiciel|solution|application|createur|hebergeur|prestataire|fournisseur|formule|offre|chatbot|version (?:payante|superieure|pro))`;
const REDIRECT: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:vous pouvez|vous pourriez|il vous suffit d[e']|je vous invite a|n'hesitez pas a|le plus simple (?:est|serait) d[e']|mieux vaut|il vaut mieux|il faudrait|vous devriez|je vous (?:recommande|conseille|suggere) d[e'])\s*(?:aussi |plutot |egalement |donc |peut-etre |alors )?(?:passer (?:par|chez|sur|a)|utiliser|essayer|tester|opter pour|vous tourner vers|migrer vers|changer d[e']|souscrire(?: a)?|prendre|activer|choisir)\s*(?:un |une |le |la |l'|leur |son |sa |cet |cette |ce )?${TOOL_NOUN}\b`),
  new RegExp(String.raw`\b(?:changez|changer|passez|passer|migrez|migrer) (?:de |d'|chez |vers |pour )(?:site|createur|outil|plateforme|hebergeur|logiciel|prestataire|solution|fournisseur|editeur|un autre|une autre)\b`),
  new RegExp(String.raw`\b(?:passez|passer) (?:a|chez|pour) (?:un |une |la |l'|leur |son |sa )?(?:autre|formule|offre|version (?:payante|superieure|pro))\b`),
  SAV_OTHER_PLATFORM_LEAVES,
];
/** True when the folded sentence advises using another tool or platform to do what Limova does (no name needed). */
export const savOtherPlatformRedirect = (foldedSentence: string) => REDIRECT.some(pattern => pattern.test(foldedSentence));

/*
 * A NAMED third party compared favourably (the shape of the bench's patterns `<name>.{0,60}(mieux|meilleur|plus simple|plus adapte|vaut)`):
 * « Botario est plus simple », « Yonos Voice vaut le coup ». Recommending it is `savOtherPlatformOrients`.
 */
export function savOtherPlatformEndorses(foldedSentence: string, names: readonly string[]): boolean {
  if (!names.length) return false;
  const name = `(?:${names.map(escapeName).join("|")})(?![\\p{L}\\p{N}])`;
  return [
    new RegExp(String.raw`(?<![\p{L}\p{N}])${name}.{0,60}?\b(?:est|serait|semble|sera|reste|sont|seraient|parait|c'est)\s(?:\S+\s){0,2}?(?:mieux|meilleure?s?|plus (?:simple|adapte|facile|complet|performant|pratique|interessant)|ideale?|une bonne (?:option|solution|alternative|idee))`, "u"),
    new RegExp(String.raw`(?<![\p{L}\p{N}])${name}.{0,60}?\bvaut (?:le coup|la peine|mieux)`, "u"),
  ].some(pattern => pattern.test(foldedSentence));
}

/*
 * The tools the customer names himself, read from his own text only to recognise them in our reply (never to filter his mail): a word inside
 * quotes, or a capitalised word right after a tool word (« mon site Siteflux », « fait avec Yonos », « un ami utilise « Botario » »). A first
 * name in a greeting or a signature is not a tool. Folded.
 */
const LIMOVA_WORDS = new Set(["limova", "charly", "max", "assistant", "assistants", "academy", "john", "lou", "elio", "parametres", "integrations", "integration", "webhooks", "webhook", "canaux"]);
export function savOtherPlatformCustomerTools(customerText: string, fold: (value: string) => string): string[] {
  const found = new Set<string>();
  const add = (word: string) => { const folded = fold(word).replace(/[^\p{L}\p{N}.-]+/gu, ""); if (folded.length >= 3 && !LIMOVA_WORDS.has(folded)) found.add(folded); };
  for (const match of customerText.matchAll(/[«"“]\s*([\p{L}\p{N}][\p{L}\p{N}.-]{1,30})\s*[»"”]/gu)) add(match[1]!);
  for (const match of customerText.matchAll(/\b(?:site|outil|logiciel|plateforme|CRM|crm|cr[ée]ateur(?: de site)?|h[ée]bergeur(?: de site)?|application|appli|solution|chatbot|[ée]diteur|utilise|utilisons|utilisent|avec|chez|comme|genre|entre|ou|et|sur)\s+(\p{Lu}[\p{L}\p{N}.-]{2,30})/gu)) add(match[1]!);
  return [...found];
}
