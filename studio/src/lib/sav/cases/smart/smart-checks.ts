import { normalizeSavEvidenceText, savEvidenceContains } from "../../evidence-text";
import {
  SAV_OTHER_PLATFORM_LIMOVA, SAV_OTHER_PLATFORM_THIRD_PARTIES, savOtherPlatformClauses, savOtherPlatformCustomerTools, savOtherPlatformEndorses, savOtherPlatformOrients,
  savOtherPlatformRedirect,
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
  /** SAV-122 (PORTE 2E, P1): the instruction the reading found in the mail (`reading.instructionText` by default). */
  instruction?: string | null;
  /** The customer's masked texts (subject, mail, thread) as given to the model. */
  customerText: string;
  sources: readonly SmartSource[];
  /** Academy results of this turn, citable by their call id (v2). */
  academy?: readonly SmartAcademyEvidence[];
  /** The case memory before this turn: a question already answered or a trial already failed is refused (v2, the progress rule). */
  memory?: SmartCaseMemory;
}>;
/**
 * `factProblems` (SAV-122, bench v8: `fact_source_invalid` again at the second pass on expiree-01 / autreoutil-06): the fact-level codes WITH
 * the sentence of the fact in cause. Before, the correction received the code with an empty sentence and could not know which fact to fix.
 */
export type SmartCheckResult = Readonly<{ ok: boolean; codes: readonly SmartCheckCode[]; factProblems: ReadonlyArray<Readonly<{ code: SmartCheckCode; sentence: string }>> }>;

const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`´ʼ]/g, "'").replace(/\s+/g, " ");
const sentencesOf = (value: string) => value.split(/(?<=[.!?…])\s+|\n+/).map(row => row.trim()).filter(Boolean);
const cardText = (source: SmartSource) => [source.title, source.content, ...source.steps].join("\n");

/** Third parties a customer may name (SAV-122: the list lives in `../../other-platform.ts`, shared with the bench). */
export const SAV_SMART_THIRD_PARTIES = SAV_OTHER_PLATFORM_THIRD_PARTIES;
const THIRD_PARTY = new RegExp(String.raw`(?<![\p{L}\p{N}])(${SAV_SMART_THIRD_PARTIES.map(name => name.replace(/[.]/g, "\\.")).join("|")})(?![\p{L}\p{N}])`, "gu");

// A sentence that invites to switch or use another product, no name needed (a sign-up is judged per clause by the named tool: PORTE 1J).
const SWITCH = /\b(?:je vous (?:recommande|conseille|suggere|propose) (?:d'utiliser|de passer (?:par|chez|sur)|de vous tourner vers|l'outil|la plateforme|le service|l'application|le logiciel|un autre|une autre|plutot)|utilisez plutot|tournez-vous vers|optez pour|passez (?:plutot )?(?:par|chez) (?:un|une) (?:autre|outil|service|prestataire|plateforme)|(?:un|une) (?:autre )?(?:outil|service|prestataire|logiciel|plateforme|solution|application) (?:externe |tierce? )?(?:comme|tel(?:le)? que|du type)|(?:outil|plateforme|solution|logiciel|service) (?:alternati(?:f|ve)|concurrente?))\b/;
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
    // PORTE 1J: per clause, the named third party decides; a « Limova » word elsewhere in the sentence exempts nothing.
    const folded = fold(sentence);
    return SWITCH.test(folded) || savOtherPlatformRedirect(folded) || savOtherPlatformOrients(folded, names) || savOtherPlatformEndorses(folded, names)
      || savOtherPlatformClauses(folded).some(clause => known.test(clause) && PRAISE.test(clause) && !SAV_OTHER_PLATFORM_LIMOVA.test(clause));
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
const ACTION = String.raw`(?:(?:annul|resili|rembours|supprim|effac|recredit)${VERB_END}|(?:ferm|clotur|desactiv|suspend)\w* (?:votre|le|ce|l'|son) ?(?:compte|abonnement|contrat|acces|offre)|transfer\w* (?:la propriete|la titularite|le compte|votre compte|l'abonnement|votre abonnement)|chang\w* (?:le|de) (?:titulaire|proprietaire)|reinitialis\w* (?:votre|le|vos) (?:mot de passe|identifiant|acces|code)|(?:envoi\w*|envoy\w*|communiqu\w*|donn\w*|transmet\w*|fourni\w*) (?:votre|un|le|vos|un nouveau|votre nouveau) (?:mot de passe|identifiant|code d'acces|code de connexion|acces)|(?:accord|offr|propos)\w* (?:un |une )?(?:remboursement|avoir|geste commercial|dedommagement|mois offert|reduction|remise)|(?:proced|effectu|lanc|realis|fai|emet|emett|vers|appliqu)\w* (?:au |a un |a une |un |une |le |la |votre |l')?(?:remboursement|avoir|geste commercial|dedommagement|recredit))`;
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
  // PORTE 2B: unsubscribing is a cancellation (« pour vous désabonner, cliquez ici », « se désinscrire de l'abonnement »).
  /\bdesabonn\w*|\bdesinscri\w* (?:de |d'|a )?(?:votre |l'|ce |cet |son |mon )?abonnement/,
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
/*
 * PORTE 2C (one rule, for Ugo: « l'agent ne parle d'argent que pour dire que l'équipe s'en occupe »): a part of a sentence (cut on « ; » and « mais ») that
 * speaks of money (remboursement, avoir, geste commercial, dédommagement, annulation d'un prélèvement ou d'une facture) is refused, unless that same part
 * hands it to the team (« notre équipe vous répondra », « un conseiller », « transmis à l'équipe »). A bare « notre équipe reste disponible » is no hand-over.
 */
const MONEY = /\brembours\w*|\b(?:un|d'un|l'|votre|cet|son|vos|des) ?avoirs?\b|\bgeste commercial|\bdedommag\w*|\brecredit\w*|\bannul\w* (?:(?:de|du|d'|le|la|les|des|votre|vos|ce|cette|l')\s*){0,2}(?:prelevement|facture)s?\b|\b(?:prelevement|facture)s? (?:\S+ ){0,4}annul\w*/;
// PORTE 2D: only a hand-over to COME or a transmission counts (« vous répondra », « reviendra vers vous », « va vous recontacter », « prendra le relais »,
// « transmis à l'équipe »); a past or a statement (« a traité », « a validé ») does not.
const TO_TEAM = /\b(?:notre equipe|nos equipes|l'equipe|un conseiller|nos conseillers|le service (?:client|facturation|comptabilite))\b.{0,40}\b(?:(?:vous )?(?:repondr|reviendr|recontacter|contacter|examiner|etudier|traiter|verifier)(?:a|ont)\b|(?:va|vont) vous (?:repondre|recontacter|contacter)|(?:va|vont) (?:revenir vers vous|examiner|etudier|traiter)|prendr(?:a|ont) (?:le relais|en charge)|s'en occupera)|\btransmis\w* (?:a|au) (?:notre |l'|un |nos )?(?:equipe|conseiller|service)/;
// PORTE 2D: a financial RESULT announced (remboursement / avoir / geste / dédommagement + validé, effectué, confirmé, accordé, en cours, versé, crédité) refuses always.
const MONEY_NOUN = String.raw`(?:rembours\w*|(?:un|d'un|l'|votre|cet|son|vos|des) ?avoirs?\b|geste commercial|dedommag\w*)`;
const MONEY_RESULT_WORD = String.raw`(?:valid\w*|effectu\w*|confirm\w*|accord\w*|en cours|vers[ee]s?\b|verse\w*|credit\w*|recredit\w*|appliqu\w*|vire\w*)`;
const MONEY_RESULT = new RegExp(String.raw`\b${MONEY_NOUN}.{0,40}\b${MONEY_RESULT_WORD}|\b${MONEY_RESULT_WORD}.{0,40}\b${MONEY_NOUN}`);
const moneyParts = (reply: string) => sentencesOf(reply).flatMap(sentence => fold(sentence).split(/;|\bmais\b/)).map(row => row.trim()).filter(Boolean);
/** True when the reply commits to a sensitive action on the account, speaks of cancelling the subscription, or of money outside a hand-over to the team. */
export const smartSensitiveCommitment = (reply: string) => {
  const folded = fold(reply);
  return COMMITMENTS.some(pattern => pattern.test(folded)) || (SUBSCRIPTION_OBJECT.test(folded) && STOP_VERB.test(folded))
    || moneyParts(reply).some(part => MONEY_RESULT.test(part) || (MONEY.test(part) && !TO_TEAM.test(part)));
};

/*
 * SAV-123 (N8), PORTE 2A: the send fence's other-platform rule is the shared one (`../../other-platform.ts`), no list of its own: per sentence, advice to
 * leave Limova or go to another tool (`savOtherPlatformRedirect`, « pour remplacer Limova… » included), a named third party compared favourably
 * (`savOtherPlatformEndorses`), or a clause orienting to a named third party (`savOtherPlatformOrients`). A sentence set in Limova's Intégrations menu
 * (« Dans les intégrations de Limova, optez pour HubSpot ») places the tool inside Limova: its orientation is not a redirection.
 */
const INTEGRATIONS_MENU = /\b(?:dans|depuis|via) (?:le |vos |les )?(?:menu |onglet |rubrique )?integrations?\b|\bintegrations >/;
// PORTE 2B/2C: the exception holds only for the part of the sentence that carries BOTH the named tool and the Intégrations marker. A sentence is cut on « si »,
// « mais », « puis », « ou », « et », « ; » and parentheses (a leading « Dans les intégrations de Limova, » stays with the choice that follows it); every other part is judged
// by the shared per-clause rule (« Dans les intégrations de Limova, si le connecteur manque, optez pour Wix… » refuses).
const integrationParts = (folded: string) => folded.split(/[;()]|\b(?:si|mais|puis|ou|et)\b/).map(row => row.trim()).filter(Boolean);
export const smartOtherPlatformInvite = (reply: string) => sentencesOf(reply).some(sentence => {
  const folded = fold(sentence);
  if (savOtherPlatformRedirect(folded) || savOtherPlatformEndorses(folded, SAV_OTHER_PLATFORM_THIRD_PARTIES)) return true;
  return integrationParts(folded).some(part => !INTEGRATIONS_MENU.test(part) && savOtherPlatformOrients(part, SAV_OTHER_PLATFORM_THIRD_PARTIES));
});

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

/*
 * SAV-122 (bench 21/11 v7: sujet-03, sujet-05 refused twice on `fact_sentence_missing`): a fact's sentence must be IN the reply, but its form
 * may differ from the list line it was written in: the model writes the fact « Partagez le fichier… . » (capital, final period) while the
 * reply's numbered step reads « 1. Partagez le fichier… » without a period, or the reverse case. Same words, same order: the sentence is
 * there. Compared without list marker, final punctuation or case; a sentence absent from the reply is still refused.
 */
const sentenceKey = (value: string) => normalizeSavEvidenceText(value).replace(/^(?:\d+[.)]|[-•*])\s+/, "").replace(/[\s.!?;:…]+$/u, "").trim();
/**
 * PORTE 2E (P2): only the FIRST letter's case is ignored (a sentence starts with a capital, a step inside a sentence does not). The rest keeps
 * its case: « AbC123 » is not « abc123 », a value the customer must copy stays exact.
 */
const firstLetterForms = (key: string) => key ? [...new Set([key, key.charAt(0).toLocaleLowerCase("fr") + key.slice(1), key.charAt(0).toLocaleUpperCase("fr") + key.slice(1)])] : [];
export function smartFactSentenceInReply(reply: string, sentence: string): boolean {
  const text = normalizeSavEvidenceText(reply), declaredNegations = negations(sentence);
  // SAV-122 (fact binding): a declared sentence found INSIDE a reply sentence right after a negation (« Ne jamais | transmettre son mot de
  // passe ») says the opposite of what the customer reads: not found, unless the declared sentence carries a negation itself.
  const negatedBefore = (at: number) => {
    const head = text.slice(0, at), start = Math.max(...[".", "!", "?", "\n"].map(mark => head.lastIndexOf(mark))) + 1;
    return !declaredNegations && negations(head.slice(start).trim().split(/\s+/).slice(-3).join(" ")) !== "";
  };
  for (const form of new Set([normalizeSavEvidenceText(sentence), ...firstLetterForms(sentenceKey(sentence))].filter(Boolean)))
    for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) if (!negatedBefore(at)) return true;
  return false;
}
/** The facts whose sentence is not in the reply: given to the correction one by one, so it knows WHICH sentence to copy or to remove. */
/**
 * SAV-122 (bench v7, pareil-02, plateforme-04-v2: `excerpt_not_found`): the same comparison defect as the fact sentence. A card's steps are
 * joined by line breaks without final punctuation and start with a capital, so an excerpt copied as « épingler l'extension via l'icône
 * puzzle. » or « 2. Recharger la page » was refused. The excerpt must STILL be in the source: only its list number, its final punctuation and
 * the case of its FIRST letter are ignored (PORTE 2E, P2), with the word boundaries of `savEvidenceContains` (no fuzzy match, no accent removal, no word dropped).
 */
export function smartExcerptInSource(source: string, excerpt: string): boolean {
  if (savEvidenceContains(source, excerpt)) return true;
  return firstLetterForms(sentenceKey(excerpt)).some(form => savEvidenceContains(source, form));
}
export const smartMissingFactSentences = (reply: string, facts: SmartDecision["facts"]) => facts.filter(fact => !smartFactSentenceInReply(reply, fact.sentence)).map(fact => fact.sentence);

/**
 * SAV-122 diagnostic (bench v8: `fact_sentence_missing` / `fact_source_invalid` at the second pass, form unknown): CLOSED codes describing the
 * shape of each fact the final decision got wrong, never its text. `fact_sentence_form:split` (every clause of the sentence is in the reply,
 * cut apart), `:reworded` (most of its words are), `:absent`; `fact_shape:<type>:<sourceKind>:card_<y|n>:excerpt_<y|n>:need_<known|unknown>` for a fact that breaks
 * the `fact_source_invalid` rule.
 */
/** The form of a fact sentence that is not in the reply (null when it is): cut apart, reworded, or absent. */
export function smartFactSentenceForm(replyText: string, sentence: string): "split" | "reworded" | "absent" | null {
  if (smartFactSentenceInReply(replyText, sentence)) return null;
  const reply = normalizeSavEvidenceText(replyText).toLocaleLowerCase("fr");
  const wordsOf = (value: string) => value.split(/[^\p{L}\p{N}']+/u).filter(word => word.length > 3);
  const key = sentenceKey(sentence).toLocaleLowerCase("fr"), clauses = key.split(/[,;:]|\s(?:puis|et|ou)\s/).map(row => row.trim()).filter(row => row.split(/\s+/).length >= 2);
  const words = wordsOf(key), present = words.filter(word => reply.includes(word)).length;
  return clauses.length > 1 && clauses.every(row => reply.includes(row)) ? "split" : words.length && present / words.length >= 0.6 ? "reworded" : "absent";
}

/*
 * SAV-122 (bench v11: ~14 turns `refused_after_correction` + `fact_sentence_missing` twice, form `reworded`): the model declares in `facts`
 * a sentence that rewords the one it wrote in the reply, and does it again after the correction. The server BINDS such a fact to the real
 * sentence of the reply ONLY when both say the same words in the same order (PORTE 2G: a share of common words let « Contacts » / « Contrats »,
 * swapped roles, swapped delays and a moved negation through). The sequence of a sentence: its significant words (4+ letters) reduced to a
 * root (agreement endings dropped, first 5 letters), its numbers, and its negations, IN ORDER. Two sentences bind only with the SAME
 * sequence: only small words (articles, short prepositions), punctuation, the first letter's case and agreements may differ. A synonym is
 * never bound (it goes to the correction, the safe side). The real sentence then goes through every source check and the counter-read.
 */
const NEGATION = /(?:^|[^\p{L}])(n'|(?:ne|pas|jamais|aucun|aucune|sans|rien|non)(?=$|[^\p{L}]))/gu;
const NEGATION_WORD = /^(?:ne|pas|jamais|aucun|aucune|sans|rien|non)$/;
/** The negation words of a text (« n' » read as « ne »), sorted: used to see a negation just before a declared sentence. */
const negations = (value: string) => [...fold(value).matchAll(NEGATION)].map(match => match[1] === "n'" ? "ne" : match[1]).sort().join("|");
/** The ordered sequence of a sentence: roots of its significant words, its numbers (#n) and its negations (!). */
export function smartFactSequence(value: string): string[] {
  return fold(value).replace(/(^|[^\p{L}])n'/gu, "$1ne ").split(/[^\p{L}\p{N}]+/u).flatMap(word => {
    if (!word) return [];
    if (/^\d/.test(word)) return [`#${word}`];
    if (NEGATION_WORD.test(word)) return ["!"];
    return word.length >= 4 ? [word.replace(/(?:es|s|e|x)$/, "").slice(0, 5)] : [];
  });
}
/** The sentence of the reply a declared fact sentence may be bound to (same sequence, at least 3 significant words), or null. */
export function smartBindableSentence(replyText: string, sentence: string): string | null {
  const wanted = smartFactSequence(sentence);
  if (wanted.filter(item => !item.startsWith("#") && item !== "!").length < 3) return null;
  const key = wanted.join(" ");
  return sentencesOf(replyText).map(row => row.replace(/^(?:\d+[.)]|[-•*])\s+/, "")).find(candidate => smartFactSequence(candidate).join(" ") === key) ?? null;
}
/** The decision with each reworded fact sentence replaced by the real sentence of the reply it binds to; `bound` counts them. */
export function smartBindFactSentences(decision: SmartDecision): { decision: SmartDecision; bound: number } {
  const reply = decision.reply?.trim() ?? "";
  if (!reply) return { decision, bound: 0 };
  let bound = 0;
  const facts = decision.facts.map(fact => {
    if (smartFactSentenceInReply(reply, fact.sentence)) return fact;
    const real = smartBindableSentence(reply, fact.sentence);
    if (!real) return fact;
    bound++;
    return { ...fact, sentence: real };
  });
  return { decision: bound ? { ...decision, facts } : decision, bound };
}

export function smartFactDiagnostics(decision: SmartDecision | null, needIds: readonly string[]): string[] {
  if (!decision) return [];
  const original = decision.reply?.trim() ?? "", out: string[] = [];
  for (const fact of decision.facts) {
    const form = smartFactSentenceForm(original, fact.sentence);
    if (form) out.push(`fact_sentence_form:${form}`);
    // The shape rule of `fact_source_invalid` (smartServerChecks), mirrored: only a fact that breaks it is described.
    const known = needIds.includes(fact.needId), excerpt = Boolean(fact.excerpt?.trim()), limova = fact.type === "fait_limova" || fact.type === "fait_temporaire";
    const invalid = !known || (limova && fact.sourceKind === "academy" && (!fact.toolCallId || !excerpt))
      || (limova && fact.sourceKind !== "academy" && (fact.sourceKind !== "fiche" || !fact.cardId || !fact.version || !excerpt))
      || (fact.type === "dit_par_le_client" && (fact.sourceKind !== "client" || !excerpt));
    if (invalid) out.push(`fact_shape:${fact.type}:${fact.sourceKind}:card_${fact.cardId ? "y" : "n"}:excerpt_${excerpt ? "y" : "n"}:need_${known ? "known" : "unknown"}`);
  }
  return [...new Set(out)];
}

/**
 * SAV-122 (PORTE 2E, P1): the sentences of the reply that take up, notably, the instruction found in the mail. No word list: only the
 * instruction's own words. Significant words (4+ letters) are compared by their first 5 letters (« promets » / « promettons »,
 * « remboursement » / « remboursé »). A sentence is caught when it shares at least 2 of them AND they make half of the instruction's words or
 * half of the sentence's own (« écris que mon dossier est prioritaire » → « Votre dossier est prioritaire. »), or when it repeats a token of
 * the instruction that carries a digit (a code or a canary: « ZEBRE-7731 »).
 */
export function smartInstructionEchoes(reply: string, instruction: string | null): string[] {
  const tokens = (value: string) => fold(value).split(/[^\p{L}\p{N}-]+/u).filter(word => word.length >= 4);
  const stems = (value: string) => new Set(tokens(value).map(word => word.slice(0, 5)));
  if (!instruction?.trim() || !reply.trim()) return [];
  const wanted = stems(instruction), codes = new Set(tokens(instruction).filter(word => /\d/.test(word)));
  if (!wanted.size) return [];
  return sentencesOf(reply).filter(sentence => {
    if (tokens(sentence).some(word => codes.has(word))) return true;
    const own = stems(sentence), shared = [...own].filter(stem => wanted.has(stem)).length;
    return shared >= 2 && (shared * 2 >= wanted.size || shared * 2 >= own.size);
  });
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
  const factProblems: Array<{ code: SmartCheckCode; sentence: string }> = [];
  const flag = (code: SmartCheckCode, sentence: string) => { codes.add(code); factProblems.push({ code, sentence: String(sentence ?? "").slice(0, 300) }); };
  for (const fact of decision.facts) {
    if (!needIds.has(fact.needId)) { flag("fact_source_invalid", fact.sentence); continue; }
    if (!smartFactSentenceInReply(reply, fact.sentence)) flag("fact_sentence_missing", fact.sentence);
    if (fact.type === "fait_tiers") { flag("third_party_fact_unsourced", fact.sentence); continue; }
    if ((fact.type === "fait_limova" || fact.type === "fait_temporaire") && fact.sourceKind === "academy") {
      const evidence = (input.academy ?? []).find(row => row.callId === fact.toolCallId);
      if (!fact.toolCallId || !fact.excerpt?.trim()) { flag("fact_source_invalid", fact.sentence); continue; }
      if (!evidence || evidence.needId !== fact.needId) { flag("card_not_retrieved_for_need", fact.sentence); continue; }
      citedAcademy.set(evidence.callId, evidence);
      if (!smartExcerptInSource(evidence.text, fact.excerpt)) flag("excerpt_not_found", fact.sentence);
      continue;
    }
    if (fact.type === "fait_limova" || fact.type === "fait_temporaire") {
      if (fact.sourceKind !== "fiche" || !fact.cardId || !fact.version || !fact.excerpt?.trim()) { flag("fact_source_invalid", fact.sentence); continue; }
      const source = input.sources.find(row => row.cardId === fact.cardId && row.version === fact.version);
      if (!source || !source.needIds.includes(fact.needId)) { flag("card_not_retrieved_for_need", fact.sentence); continue; }
      cited.set(`${source.cardId}:${source.version}`, source);
      if (!smartExcerptInSource(cardText(source), fact.excerpt)) flag("excerpt_not_found", fact.sentence);
      continue;
    }
    if (fact.type === "dit_par_le_client") {
      if (fact.sourceKind !== "client" || !fact.excerpt?.trim()) { flag("fact_source_invalid", fact.sentence); continue; }
      if (!smartExcerptInSource(input.customerText, fact.excerpt)) flag("excerpt_not_found", fact.sentence);
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
  // SAV-122 (PORTE 2E, P1): a sentence of OUR reply that takes up the instruction found in the mail (never a word list on the mail).
  for (const sentence of smartInstructionEchoes(reply, input.instruction ?? reading.instructionText ?? null)) {
    codes.add("instruction_followed"); factProblems.push({ code: "instruction_followed", sentence: sentence.slice(0, 300) });
  }
  return { ok: codes.size === 0, codes: [...codes], factProblems };
}
