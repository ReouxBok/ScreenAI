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

const SIGNUP = SAV_OTHER_PLATFORM_SIGNUP.map(source => new RegExp(source));
/** A sentence that invites to sign up elsewhere (the bench's patterns), Limova's own sign-ups excepted. */
export const savOtherPlatformSignup = (foldedSentence: string) => !SAV_OTHER_PLATFORM_LIMOVA.test(foldedSentence) && SIGNUP.some(pattern => pattern.test(foldedSentence));

/*
 * Advice to go and use another tool, with no name needed: « vous pourriez passer par un autre outil », « changez de créateur de site »,
 * « passez à la formule supérieure ». The bench's own patterns (`(changez|passez) (de|sur) (site|createur|outil)`) are a subset.
 */
const TOOL_NOUN = String.raw`(?:autre|outil|service|plateforme|logiciel|solution|application|createur|hebergeur|prestataire|fournisseur|formule|offre|chatbot|version (?:payante|superieure|pro))`;
const REDIRECT: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:vous pouvez|vous pourriez|il vous suffit d[e']|je vous invite a|n'hesitez pas a|le plus simple (?:est|serait) d[e']|mieux vaut|il vaut mieux|il faudrait|vous devriez|je vous (?:recommande|conseille|suggere) d[e'])\s*(?:aussi |plutot |egalement |donc |peut-etre |alors )?(?:passer (?:par|chez|sur|a)|utiliser|essayer|tester|opter pour|vous tourner vers|migrer vers|changer d[e']|souscrire(?: a)?|prendre|activer|choisir)\s*(?:un |une |le |la |l'|leur |son |sa |cet |cette |ce )?${TOOL_NOUN}\b`),
  new RegExp(String.raw`\b(?:changez|changer|passez|passer|migrez|migrer) (?:de |d'|chez |vers |pour )(?:site|createur|outil|plateforme|hebergeur|logiciel|prestataire|solution|fournisseur|editeur|un autre|une autre)\b`),
  new RegExp(String.raw`\b(?:passez|passer) (?:a|chez|pour) (?:un |une |la |l'|leur |son |sa )?(?:autre|formule|offre|version (?:payante|superieure|pro))\b`),
];
/** True when the folded sentence advises using another tool or platform to do what Limova does (no name needed). */
export const savOtherPlatformRedirect = (foldedSentence: string) => REDIRECT.some(pattern => pattern.test(foldedSentence));

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/*
 * A NAMED third party praised, compared favourably or recommended (the shape of the bench's per-conversation patterns
 * `<name>.{0,60}(mieux|meilleur|plus simple|plus adapte|recommand|conseill|essayez|activez|prenez|vaut)`), without the words that also describe
 * the right answer (« Assistant téléphonique », « agent », « lien »): « Botario est plus simple », « je vous conseille Waalaxy »,
 * « activez le chatbot de Webly », « Yonos Voice vaut le coup ». Naming the customer's tool to connect it to Limova passes.
 */
export function savOtherPlatformEndorses(foldedSentence: string, names: readonly string[]): boolean {
  if (!names.length) return false;
  const name = `(?:${names.map(escape).join("|")})(?![\\p{L}\\p{N}])`;
  return [
    new RegExp(String.raw`(?<![\p{L}\p{N}])${name}.{0,60}?\b(?:est|serait|semble|sera|reste|sont|seraient|parait|c'est)\s(?:\S+\s){0,2}?(?:mieux|meilleure?s?|plus (?:simple|adapte|facile|complet|performant|pratique|interessant)|ideale?|une bonne (?:option|solution|alternative|idee))`, "u"),
    new RegExp(String.raw`\b(?:recommande|conseille|suggere|essayez|testez|optez pour|prenez|activez|choisissez|tournez-vous vers|allez sur)\s(?:(?:vous|plutot|aussi|donc|d'utiliser|d'essayer|de passer par|de prendre|de tester|de choisir|de vous tourner vers|d'opter pour|de vous inscrire (?:sur|chez|a))\s)*(?:(?:le|la|l'|les|son|sa|leur|ses)\s?(?!integration|connexion|connecteur|synchronisation|compte)[\p{L}-]+(?: [\p{L}-]+)? (?:de |d'|chez ))?${name}`, "u"),
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
