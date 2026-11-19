import { normalizeSavEvidenceText, savEvidenceContains } from "../../evidence-text";
import { accessSkillKernelHits } from "../access-skill/access-skill-kernel";
import { requestsCredential } from "../decision-validator";
import type { SmartCheckCode, SmartDecision, SmartReading } from "./smart-contract";
import { SAV_SMART_RESOURCES } from "./smart-prompt";

/*
 * Agent SAV intelligent, lot D3, server part (20/11): the checks WITHOUT any model on one decision. Pure: no model, network, database or clock.
 * They cannot be talked out of by the prompt nor by the counter-read: any code here refuses the reply (a lying counter-read changes nothing).
 *
 *   facts      each sentence is in the reply; each card fact cites a card retrieved FOR THAT NEED (id + version) and its excerpt is in the card
 *              word for word; a customer fact's excerpt is in the customer's own text; a fact about another vendor has no source in this scope;
 *   links      every link or domain of the reply comes from the resources or from a card given for the mail;
 *   platform   a sentence inviting to sign up / switch / use another product, or praising a named third party, is refused even without a link
 *              and even when the customer named it (Ugo: « Yonos fait des agents téléphoniques, inscrivez-vous » is never acceptable);
 *              a known third-party name absent from the customer's words and from the cited cards is refused;
 *   secret     the existing V2 tripwire (`requestsCredential`) on the reply;
 *   promise    a delay, a price, a gift or a future feature that no cited card carries;
 *   account    a claim that an action was done on the account;
 *   kernel     a kernel phrase (cancel, refund...) in OUR reply;
 *   coverage   every need of the reading is answered, asked or handed; a reply or a question has a text; a handoff has a team note.
 * The checks are deliberately narrow (closed patterns): what they miss is the counter-read's job, and the shadow measures both.
 */

export type SmartSource = Readonly<{
  cardId: string; version: string; title: string; content: string; steps: readonly string[];
  /** The needs this card was retrieved for: a card of need A never supports need B. */
  needIds: readonly string[];
  /** A temporary card (an ongoing bug, a time-limited message) ends this day (YYYY-MM-DD). */
  validUntil?: string | null;
}>;
export type SmartCheckInput = Readonly<{
  decision: SmartDecision; reading: SmartReading;
  /** The customer's masked texts (subject, mail, thread) as given to the model. */
  customerText: string;
  sources: readonly SmartSource[];
}>;
export type SmartCheckResult = Readonly<{ ok: boolean; codes: readonly SmartCheckCode[] }>;

const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`´ʼ]/g, "'").replace(/\s+/g, " ");
const sentencesOf = (value: string) => value.split(/(?<=[.!?…])\s+|\n+/).map(row => row.trim()).filter(Boolean);
const cardText = (source: SmartSource) => [source.title, source.content, ...source.steps].join("\n");

/** Third parties a customer may name: none may be recommended; one may be named only when the customer uses it already (or a cited card names it). */
export const SAV_SMART_THIRD_PARTIES = Object.freeze([
  "yonos", "wix", "shopify", "wordpress", "squarespace", "webflow", "jimdo", "prestashop", "zapier", "make.com", "n8n", "ifttt", "hubspot", "salesforce", "pipedrive",
  "brevo", "sendinblue", "mailchimp", "aircall", "ringover", "twilio", "vapi", "retell", "bland", "calendly", "chatgpt", "openai", "copilot", "notion", "monday", "trello",
  "canva", "lemlist", "waalaxy", "zoho", "odoo", "axonaut", "pennylane", "intercom", "zendesk", "crisp", "tidio", "manychat", "systeme.io", "kajabi", "podia", "agicap",
]);
const THIRD_PARTY = new RegExp(String.raw`(?<![\p{L}\p{N}])(${SAV_SMART_THIRD_PARTIES.map(name => name.replace(/[.]/g, "\\.")).join("|")})(?![\p{L}\p{N}])`, "gu");

// A sentence that invites to sign up, subscribe, switch or use another product. « inscrivez-vous au webinaire Limova » stays allowed (Limova named).
const SIGNUP = /\b(?:inscri(?:vez|re|ption|s|t)|creez(?:-vous)? (?:un|votre) compte|creer un compte|ouvr(?:ez|ir) un compte|abonnez-vous|souscri(?:vez|re))\b/;
const SWITCH = /\b(?:je vous (?:recommande|conseille|suggere|propose) (?:d'utiliser|de passer (?:par|chez|sur)|de vous tourner vers|de vous inscrire|l'outil|la plateforme|le service|l'application|le logiciel|un autre|une autre|plutot)|utilisez plutot|tournez-vous vers|optez pour|passez (?:plutot )?(?:par|chez) (?:un|une) (?:autre|outil|service|prestataire|plateforme)|(?:un|une) (?:autre )?(?:outil|service|prestataire|logiciel|plateforme|solution|application) (?:externe |tierce? )?(?:comme|tel(?:le)? que|du type)|(?:outil|plateforme|solution|logiciel|service) (?:alternati(?:f|ve)|concurrente?))\b/;
const PRAISE = /\b(?:propose(?:nt)?|offre(?:nt)?|permet(?:tent)?|fait|font|dispose(?:nt)?|gere(?:nt)?|integre(?:nt)?|fournit|fournissent)\b/;

const PROMISES: readonly RegExp[] = [
  /\b(?:sous|dans|d'ici|en moins de|au plus tard (?:dans|sous)) (?:\d+|un|une|deux|trois|quelques) ?(?:h|heures?|jours?(?: ouvres)?|semaines?|mois|minutes?)\b/,
  /\b(?:des demain|d'ici demain|d'ici la fin (?:de|du) \w+|tres prochainement|prochainement|bientot|dans les plus brefs delais|tres vite|au plus vite)\b/,
  /\d+(?:[.,]\d+)? ?(?:€|euros?\b|eur\b|\$|dollars?\b)/,
  /\b(?:gratuit(?:e|s|es|ement)?|offert(?:e|s|es)?|geste commercial|remboursement|rembourse\w*|un avoir|reduction|remise)\b/,
  /\b(?:sera|seront) (?:bientot |prochainement )?(?:disponibles?|corrige(?:e|s|es)?|ajoute(?:e|s|es)?|integre(?:e|s|es)?|resolue?s?|deploye(?:e|s|es)?|livre(?:e|s|es)?)\b/,
  /\b(?:nous allons|on va|l'equipe va|nos equipes vont|les developpeurs vont) (?:corriger|ajouter|developper|integrer|resoudre|regler|deployer|sortir)\b/,
  /\bprochaine (?:version|mise a jour|fonctionnalite)\b/,
];
const ACCOUNT_ACTION = /\b(?:j'ai|je viens d'|nous avons|nous venons d'|on a) ?(?:bien )?(?:active|desactive|modifie|supprime|reinitialise|change|corrige|debloque|ajoute|cree|regle|resolu|reactive|verifie votre compte|mis a jour)\b|\bc'est (?:fait|regle|corrige|active)\b/;
const HANDOFF_CLAIM = /\b(?:j'ai|nous avons) (?:bien )?(?:transmis|transfere|signale|remonte)\b/;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/giu;
const DOMAIN = /(?<![\p{L}\p{N}@./-])(?:www\.)?[a-z0-9][a-z0-9-]{1,62}(?:\.[a-z0-9-]{1,62})*\.(?:com|fr|io|ai|net|org|co|app|eu|be|ch|ca|me|so|dev)(?![\p{L}\p{N}-])/giu;

const stripUrl = (value: string) => value.replace(/[.,;:!?]+$/, "");
const hostOf = (url: string) => { try { return new URL(url).host.toLowerCase(); } catch { return ""; } };

/** The links and domains of a text (lower case, trailing punctuation removed). */
function linksOf(text: string) {
  const urls = [...text.matchAll(URL_RE)].map(match => stripUrl(match[0]));
  const rest = text.replace(URL_RE, " ");
  const domains = [...rest.matchAll(DOMAIN)].map(match => match[0].toLowerCase().replace(/^www\./, ""));
  return { urls, domains };
}

/** The server's checks on one decision. Empty `codes`: nothing refused (the counter-read may still refuse). */
export function smartServerChecks(input: SmartCheckInput): SmartCheckResult {
  const { decision, reading } = input, codes = new Set<SmartCheckCode>();
  const reply = decision.reply?.trim() ?? "", foldedReply = fold(reply);
  const needIds = new Set(reading.needs.map(need => need.id));

  // Coverage.
  if (decision.outcome !== "handoff" && !reply) codes.add("reply_missing");
  if (decision.coverage.some(row => !needIds.has(row.needId)) || new Set(decision.coverage.map(row => row.needId)).size !== decision.coverage.length) codes.add("coverage_invalid");
  if ([...needIds].some(id => !decision.coverage.some(row => row.needId === id))) codes.add("need_not_covered");
  if ((decision.outcome === "handoff" || decision.coverage.some(row => row.status === "handed")) && !decision.teamNote?.trim()) codes.add("team_note_missing");

  // Facts and their sources.
  const cited = new Map<string, SmartSource>();
  for (const fact of decision.facts) {
    if (!needIds.has(fact.needId)) { codes.add("fact_source_invalid"); continue; }
    if (!savEvidenceContains(reply, fact.sentence) && !normalizeSavEvidenceText(reply).includes(normalizeSavEvidenceText(fact.sentence))) codes.add("fact_sentence_missing");
    if (fact.type === "fait_tiers") { codes.add("third_party_fact_unsourced"); continue; }
    if (fact.type === "fait_limova" || fact.type === "fait_temporaire") {
      if (fact.sourceKind !== "fiche" || !fact.cardId || !fact.version || !fact.excerpt?.trim()) { codes.add("fact_source_invalid"); continue; }
      const source = input.sources.find(row => row.cardId === fact.cardId && row.version === fact.version);
      if (!source || !source.needIds.includes(fact.needId)) { codes.add("card_not_retrieved_for_need"); continue; }
      cited.set(`${source.cardId}:${source.version}`, source);
      if (!savEvidenceContains(cardText(source), fact.excerpt)) codes.add("excerpt_not_found");
      continue;
    }
    if (fact.type === "dit_par_le_client") {
      if (fact.sourceKind !== "client" || !fact.excerpt?.trim()) { codes.add("fact_source_invalid"); continue; }
      if (!savEvidenceContains(input.customerText, fact.excerpt)) codes.add("excerpt_not_found");
      continue;
    }
    // conseil: no source by definition; a source given to advice is ignored.
  }
  const citedText = [...cited.values()].map(source => fold(cardText(source))).join("\n");
  const allCardText = input.sources.map(source => cardText(source)).join("\n");

  // Links: resources, or a link written in a card given for the mail.
  const allowedUrls = [...SAV_SMART_RESOURCES.map(row => row.url), ...linksOf(allCardText).urls].map(url => url.toLowerCase());
  const allowedHosts = new Set([...allowedUrls.map(hostOf), ...linksOf(allCardText).domains].filter(Boolean).map(host => host.replace(/^www\./, "")));
  const { urls, domains } = linksOf(reply);
  if (urls.some(url => !allowedUrls.some(allowed => url.toLowerCase() === allowed || url.toLowerCase().startsWith(`${allowed.replace(/\/$/, "")}/`)))) codes.add("link_not_allowed");
  if (domains.some(domain => !allowedHosts.has(domain))) codes.add("link_not_allowed");

  // Other platforms: an invitation or a praise is refused even when the customer named it; a name is allowed only from the customer or a cited card.
  const customer = fold(input.customerText);
  for (const sentence of sentencesOf(reply)) {
    const folded = fold(sentence), names = [...folded.matchAll(THIRD_PARTY)].map(match => match[1]!);
    const limova = /\b(?:limova|webinaire|academy|charly)\b/.test(folded);
    if (SIGNUP.test(folded) && !limova) codes.add("other_platform_recommended");
    if (SWITCH.test(folded)) codes.add("other_platform_recommended");
    if (names.length && PRAISE.test(folded) && !limova) codes.add("other_platform_recommended");
    for (const name of names) if (!customer.includes(name) && !citedText.includes(name)) codes.add("third_party_named");
  }

  if (reply && requestsCredential(reply)) codes.add("credential_request");
  for (const pattern of PROMISES) {
    const match = foldedReply.match(new RegExp(pattern.source, "g")) ?? [];
    if (match.some(hit => !citedText.includes(hit))) { codes.add("promise_unsourced"); break; }
  }
  if (ACCOUNT_ACTION.test(foldedReply) || (decision.outcome !== "handoff" && HANDOFF_CLAIM.test(foldedReply))) codes.add("account_action_claimed");
  if (reply && accessSkillKernelHits(reply).length) codes.add("kernel_in_reply");
  return { ok: codes.size === 0, codes: [...codes] };
}
