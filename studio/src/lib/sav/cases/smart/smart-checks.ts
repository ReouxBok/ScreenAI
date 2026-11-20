import { normalizeSavEvidenceText, savEvidenceContains } from "../../evidence-text";
import {
  SAV_OTHER_PLATFORM_LIMOVA, SAV_OTHER_PLATFORM_THIRD_PARTIES, savOtherPlatformCustomerTools, savOtherPlatformEndorses, savOtherPlatformRedirect, savOtherPlatformSignup,
} from "../../other-platform";
import { requestsCredential } from "../decision-validator";
import type { SmartCheckCode, SmartDecision, SmartReading } from "./smart-contract";
import { smartRepeatCodes, type SmartCaseMemory } from "./smart-memory";
import { SAV_SMART_RESOURCES } from "./smart-prompt";
import type { SmartAcademyEvidence } from "./smart-tools";

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
 *   commitment the reply COMMITS to a sensitive action on the account, or gives the customer the procedure to cancel their subscription or
 *              contract (N2, 20/11, and its review): « nous allons annuler / rembourser / supprimer », « je vous
 *              rembourse », « votre abonnement sera résilié », « je vous envoie votre mot de passe »... A word alone (« votre facture est
 *              disponible dans… », « vous pouvez annuler la routine ») never refuses: since N2 the old `kernel_in_reply` is no longer emitted;
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
  /** Academy results of this turn, citable by their call id (v2). */
  academy?: readonly SmartAcademyEvidence[];
  /** The case memory before this turn: a question already answered or a trial already failed is refused (v2, the progress rule). */
  memory?: SmartCaseMemory;
}>;
export type SmartCheckResult = Readonly<{ ok: boolean; codes: readonly SmartCheckCode[] }>;

const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`´ʼ]/g, "'").replace(/\s+/g, " ");
const sentencesOf = (value: string) => value.split(/(?<=[.!?…])\s+|\n+/).map(row => row.trim()).filter(Boolean);
const cardText = (source: SmartSource) => [source.title, source.content, ...source.steps].join("\n");

/** Third parties a customer may name (SAV-122: the list lives in `../../other-platform.ts`, shared with the bench). */
export const SAV_SMART_THIRD_PARTIES = SAV_OTHER_PLATFORM_THIRD_PARTIES;
const THIRD_PARTY = new RegExp(String.raw`(?<![\p{L}\p{N}])(${SAV_SMART_THIRD_PARTIES.map(name => name.replace(/[.]/g, "\\.")).join("|")})(?![\p{L}\p{N}])`, "gu");

// A sentence that invites to sign up, subscribe, switch or use another product. « inscrivez-vous au webinaire Limova » stays allowed (Limova named).
const SIGNUP = /\b(?:inscri(?:vez|re|ption|s|t)|creez(?:-vous)? (?:un|votre) compte|creer un compte|ouvr(?:ez|ir) un compte|abonnez-vous|souscri(?:vez|re))\b/;
const SWITCH = /\b(?:je vous (?:recommande|conseille|suggere|propose) (?:d'utiliser|de passer (?:par|chez|sur)|de vous tourner vers|de vous inscrire|l'outil|la plateforme|le service|l'application|le logiciel|un autre|une autre|plutot)|utilisez plutot|tournez-vous vers|optez pour|passez (?:plutot )?(?:par|chez) (?:un|une) (?:autre|outil|service|prestataire|plateforme)|(?:un|une) (?:autre )?(?:outil|service|prestataire|logiciel|plateforme|solution|application) (?:externe |tierce? )?(?:comme|tel(?:le)? que|du type)|(?:outil|plateforme|solution|logiciel|service) (?:alternati(?:f|ve)|concurrente?))\b/;
// SAV-122: « fait » alone is no praise (« votre site fait avec Yonos » describes the customer's tool); « Yonos fait des agents » still is.
const PRAISE = /\b(?:(?:propose(?:nt)?|offre(?:nt)?|permet(?:tent)?|dispose(?:nt)?|gere(?:nt)?|integre(?:nt)?|fournit|fournissent)\b|(?:fait|font) (?:aussi |egalement |deja |tres bien |mieux |des |du |de l'|de la |ca |cela ))/;

/*
 * SAV-122 (bench 21/11: autreoutil-01, autreoutil-05, plateforme-02): OUR reply sends the customer to another tool or platform. Per sentence:
 * a sign-up elsewhere (the bench's patterns, Limova's own excepted), an invitation to switch, advice to go and use another tool (no name
 * needed), or a named third party (known list, or a tool the customer wrote himself) praised, compared favourably or recommended. Naming the
 * customer's tool to connect it to Limova, or answering a customer who names one, passes. Never reads the inbound mail as a filter.
 */
export function smartOtherPlatformSentences(reply: string, customerText: string): string[] {
  const names = [...new Set([...SAV_OTHER_PLATFORM_THIRD_PARTIES, ...savOtherPlatformCustomerTools(customerText, fold)])];
  const known = new RegExp(String.raw`(?<![\p{L}\p{N}])(${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\p{L}\p{N}])`, "u");
  return sentencesOf(reply).filter(sentence => {
    const folded = fold(sentence), limova = SAV_OTHER_PLATFORM_LIMOVA.test(folded);
    return (SIGNUP.test(folded) && !limova) || savOtherPlatformSignup(folded) || SWITCH.test(folded) || savOtherPlatformRedirect(folded)
      || savOtherPlatformEndorses(folded, names) || (known.test(folded) && PRAISE.test(folded) && !limova);
  });
}

const PROMISES: readonly RegExp[] = [
  /\b(?:sous|dans|d'ici|en moins de|au plus tard (?:dans|sous)) (?:\d+|un|une|deux|trois|quelques) ?(?:h|heures?|jours?(?: ouvres)?|semaines?|mois|minutes?)\b/,
  /\b(?:des demain|d'ici demain|d'ici la fin (?:de|du) \w+|tres prochainement|prochainement|bientot|dans les plus brefs delais|tres vite|au plus vite)\b/,
  /\d+(?:[.,]\d+)? ?(?:€|euros?\b|eur\b|\$|dollars?\b)/,
  // N2: « remboursement » alone is a mention; a refund COMMITMENT is `sensitive_commitment`.
  /\b(?:gratuit(?:e|s|es|ement)?|offert(?:e|s|es)?|geste commercial|un avoir|reduction|remise)\b/,
  /\b(?:sera|seront) (?:bientot |prochainement )?(?:disponibles?|corrige(?:e|s|es)?|ajoute(?:e|s|es)?|integre(?:e|s|es)?|resolue?s?|deploye(?:e|s|es)?|livre(?:e|s|es)?)\b/,
  /\b(?:nous allons|on va|l'equipe va|nos equipes vont|les developpeurs vont) (?:corriger|ajouter|developper|integrer|resoudre|regler|deployer|sortir)\b/,
  /\bprochaine (?:version|mise a jour|fonctionnalite)\b/,
];
const ACCOUNT_ACTION = /\b(?:j'ai|je viens d'|nous avons|nous venons d'|on a) ?(?:bien )?(?:active|desactive|modifie|supprime|reinitialise|change|corrige|debloque|ajoute|cree|regle|resolu|reactive|verifie votre compte|mis a jour)\b|\bc'est (?:fait|regle|corrige|active)\b/;
const HANDOFF_CLAIM = /\b(?:j'ai|nous avons) (?:bien )?(?:transmis|transfere|signale|remonte)\b/;
/*
 * Sensitive commitments (N2): narrow on purpose, an ACTOR on our side (je, nous, on, l'équipe) + at most an auxiliary and pronouns + an action
 * verb in a conjugated form (never the noun: « remboursement » alone is a mention), or the passive « votre abonnement sera résilié ». What
 * they miss is the counter-read's `sensitive_commitment` code. Written on the folded text (no accent, lower case).
 */
const OUR_SIDE = String.raw`\b(?:je|j'|nous|on|l'equipe|notre equipe|nos equipes|le support|le service client)\s*`;
const AUX = String.raw`(?:(?:vais|allons|va|vont|pouvons|peux|peut|devons|dois|doit|viens d'|venons d'|vient d'|ai|avons|a|ont|me charge d[e']|nous chargeons d[e']|m'occupe d[e']|nous occupons d[e']|procede a|procedons a)\s*)?`;
const PRONOUNS = String.raw`(?:(?:vous|le|la|les|l'|en|lui|y|bien|immediatement|aujourd'hui|directement|tout de suite)\s*)*`;
const VERB_END = String.raw`(?:e|es|er|erai|erons|era|eront|ons|ee|ees)\b`;
const ACTION = String.raw`(?:(?:annul|resili|rembours|supprim|effac|recredit)${VERB_END}|(?:ferm|clotur|desactiv|suspend)\w* (?:votre|le|ce|l'|son) ?(?:compte|abonnement|contrat|acces|offre)|transfer\w* (?:la propriete|la titularite|le compte|votre compte|l'abonnement|votre abonnement)|chang\w* (?:le|de) (?:titulaire|proprietaire)|reinitialis\w* (?:votre|le|vos) (?:mot de passe|identifiant|acces|code)|(?:envoi\w*|envoy\w*|communiqu\w*|donn\w*|transmet\w*|fourni\w*) (?:votre|un|le|vos|un nouveau|votre nouveau) (?:mot de passe|identifiant|code d'acces|code de connexion|acces)|(?:accord|offr|propos)\w* (?:un |une )?(?:remboursement|avoir|geste commercial|dedommagement|mois offert|reduction|remise))`;
const COMMITMENTS: readonly RegExp[] = [
  new RegExp(`${OUR_SIDE}${AUX}${PRONOUNS}${ACTION}`),
  /\b(?:votre|vos|le|l'|ce|cet|son) ?(?:abonnement|compte|contrat|commande|offre|donnees|paiement|prelevement|acces)s? (?:sera|seront|va etre|vont etre|a ete|ont ete) (?:bien |immediatement |automatiquement |definitivement |integralement )?(?:annule|resilie|rembourse|supprime|efface|ferme|clos|cloture|desactive|transfere|suspendu|recredite)e?s?\b/,
  /\bvous (?:serez|allez etre|avez ete) (?:bien |integralement |entierement |rapidement )?(?:rembourse|recredite|dedommage)e?s?\b/,
  /\b(?:un|le|votre) (?:remboursement|avoir|geste commercial|dedommagement) (?:vous )?(?:sera|va etre|a ete) (?:effectue|fait|emis|verse|vire|lance|accorde|applique)/,
  // Astra, N2 review (P1): the PROCEDURE given to the customer to cancel their Limova subscription or contract (« vous pouvez résilier votre
  // abonnement depuis vos paramètres », « résiliez depuis… », « pour mettre fin à votre contrat, … »). Cancelling a routine stays allowed.
  new RegExp(String.raw`\b(?:vous pouvez|vous pourrez|vous pourriez|il (?:vous )?suffit d[e']|pour|afin d[e']|vous devez|il faut|merci d[e']|n'hesitez pas a)\s*(?:\w+ ){0,2}(?:resilier\b|(?:annuler|arreter|stopper|suspendre|interrompre|mettre fin a|ne pas renouveler|desactiver|clore|cloturer|fermer) (?:le renouvellement (?:de |d')?)?(?:votre|l'|le|ce|cet|son) ?(?:abonnement|contrat|offre|forfait|engagement|renouvellement)\b)`),
  // Orchestrator decision (Ugo: cancellation is never handled by the agent on its own): any word of cancellation in OUR reply, always.
  /\bresili\w*/,
  /\b(?:resiliez|(?:annulez|arretez|stoppez|suspendez|mettez fin a|cloturez|fermez) (?:votre|l'|le) ?(?:abonnement|contrat|offre|forfait|engagement|renouvellement))\b/,
];
/*
 * Orchestrator decision after the fourth review (PORTE_1G): the WHOLE reply, not a sentence (splitting « …rubrique Abonnement. Cliquez sur
 * “Annuler”… » in two sentences must not get through). A reply that carries ANYWHERE a subscription object and ANYWHERE a stop verb refuses.
 * False positives are accepted: the turn goes to the team, no risk for the customer. « compte » is not an object (« arrêter la routine depuis
 * votre compte Limova » passes); « offre » and « plan » count as nouns only (with a determiner: « Limova offre… » is a verb). A routine, a task,
 * a scheduled send, an invoice or a price carry no object here and pass.
 */
const SUBSCRIPTION_OBJECT = /\b(?:abonnements?|contrats?|forfaits?|souscriptions?|(?:l'|une?|votre|vos|mon|notre|son|cette|cet|ce|d'|des|les|le|la) ?(?:offres?|plans?))\b/;
const STOP_VERB = /\b(?:annul\w*|arret\w*|mettre fin|mis fin|mettez fin|met fin|mettons fin|stopp?\w*|suspend\w*|interromp\w*|desactiv\w*)/;
/** True when the reply commits to a sensitive action on the account, or speaks of cancelling the subscription (exported for the tests and the shadow report). */
export const smartSensitiveCommitment = (reply: string) => {
  const folded = fold(reply);
  return COMMITMENTS.some(pattern => pattern.test(folded)) || (SUBSCRIPTION_OBJECT.test(folded) && STOP_VERB.test(folded));
};

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
  if ((decision.outcome === "handoff" || decision.coverage.some(row => row.status === "handed")) && !decision.teamNote) codes.add("team_note_missing");

  // Facts and their sources.
  const cited = new Map<string, SmartSource>(), citedAcademy = new Map<string, SmartAcademyEvidence>();
  for (const fact of decision.facts) {
    if (!needIds.has(fact.needId)) { codes.add("fact_source_invalid"); continue; }
    if (!savEvidenceContains(reply, fact.sentence) && !normalizeSavEvidenceText(reply).includes(normalizeSavEvidenceText(fact.sentence))) codes.add("fact_sentence_missing");
    if (fact.type === "fait_tiers") { codes.add("third_party_fact_unsourced"); continue; }
    if ((fact.type === "fait_limova" || fact.type === "fait_temporaire") && fact.sourceKind === "academy") {
      const evidence = (input.academy ?? []).find(row => row.callId === fact.toolCallId);
      if (!fact.toolCallId || !fact.excerpt?.trim()) { codes.add("fact_source_invalid"); continue; }
      if (!evidence || evidence.needId !== fact.needId) { codes.add("card_not_retrieved_for_need"); continue; }
      citedAcademy.set(evidence.callId, evidence);
      if (!savEvidenceContains(evidence.text, fact.excerpt)) codes.add("excerpt_not_found");
      continue;
    }
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
  const citedText = [...[...cited.values()].map(source => fold(cardText(source))), ...[...citedAcademy.values()].map(row => fold(row.text))].join("\n");
  const allCardText = input.sources.map(source => cardText(source)).join("\n");

  // Links: resources, or a link written in a card given for the mail.
  const allowedUrls = [...SAV_SMART_RESOURCES.map(row => row.url), ...linksOf(allCardText).urls].map(url => url.toLowerCase());
  const allowedHosts = new Set([...allowedUrls.map(hostOf), ...linksOf(allCardText).domains].filter(Boolean).map(host => host.replace(/^www\./, "")));
  const { urls, domains } = linksOf(reply);
  if (urls.some(url => !allowedUrls.some(allowed => url.toLowerCase() === allowed || url.toLowerCase().startsWith(`${allowed.replace(/\/$/, "")}/`)))) codes.add("link_not_allowed");
  if (domains.some(domain => !allowedHosts.has(domain))) codes.add("link_not_allowed");

  // Other platforms: an invitation or a praise is refused even when the customer named it; a name is allowed only from the customer or a cited card.
  const customer = fold(input.customerText);
  if (smartOtherPlatformSentences(reply, input.customerText).length) codes.add("other_platform_recommended");
  for (const sentence of sentencesOf(reply)) {
    for (const name of [...fold(sentence).matchAll(THIRD_PARTY)].map(match => match[1]!)) if (!customer.includes(name) && !citedText.includes(name)) codes.add("third_party_named");
  }

  if (reply && requestsCredential(reply)) codes.add("credential_request");
  for (const pattern of PROMISES) {
    const match = foldedReply.match(new RegExp(pattern.source, "g")) ?? [];
    if (match.some(hit => !citedText.includes(hit))) { codes.add("promise_unsourced"); break; }
  }
  if (ACCOUNT_ACTION.test(foldedReply) || (decision.outcome !== "handoff" && HANDOFF_CLAIM.test(foldedReply))) codes.add("account_action_claimed");
  if (reply && smartSensitiveCommitment(reply)) codes.add("sensitive_commitment");
  if (input.memory) for (const code of smartRepeatCodes(input.memory, decision)) codes.add(code);
  return { ok: codes.size === 0, codes: [...codes] };
}
