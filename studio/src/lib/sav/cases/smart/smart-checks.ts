import { normalizeSavEvidenceText, savEvidenceContains } from "../../evidence-text";
import {
  SAV_OTHER_PLATFORM_COMPETITORS, SAV_OTHER_PLATFORM_CONNECTED, SAV_OTHER_PLATFORM_LIMOVA, SAV_OTHER_PLATFORM_THIRD_PARTIES, savOtherPlatformClauses,
  savOtherPlatformCompares, savOtherPlatformCustomerTools, savOtherPlatformEndorses, savOtherPlatformOrients, savOtherPlatformRedirect, savOtherPlatformSubstitutes,
} from "../../other-platform";
import { SAV_CARD_OFFICIAL_LINKS } from "@/lib/knowledge/card-safety";
import { requestsCredential } from "../decision-validator";
import type { SmartCheckCode, SmartDecision, SmartReading } from "./smart-contract";
import { smartRepeatCodes, type SmartCaseMemory } from "./smart-memory";
import { SAV_SMART_RESOURCES } from "./smart-prompt";
import type { SmartAcademyEvidence } from "./smart-tools";

/*
 * Agent SAV intelligent, lot D3, server part (20/11): the checks WITHOUT any model on one decision. Pure: no model, network, database or clock.
 * They cannot be talked out of by the prompt nor by the counter-read: any code here refuses the reply (a lying counter-read changes nothing).
 *
 *   facts      each card fact cites a card retrieved FOR THAT NEED (id + version) and its excerpt is in the card
 *              word for word; a customer fact's excerpt is in the customer's own text; a fact about another vendor has no source in this scope;
 *   links      every link or domain of the reply comes from the resources or from a card given for the mail;
 *   platform   a sentence sending the customer to a Limova COMPETITOR (recommended, praised, signed up for, compared favourably), or framing another
 *              tool as a replacement of Limova, is refused even without a link and even when the customer named it (Ugo: « Yonos fait des agents
 *              téléphoniques, inscrivez-vous » is never acceptable); a mail host, a connected integration or a cited card's name is no redirection
 *              (bench 22/11); a known third-party name absent from the customer's words and from the cited cards is refused (`third_party_named`);
 *   secret     the existing V2 tripwire (`requestsCredential`) on the reply;
 *   promise    a delay, a price, a gift or a future feature that no card given for the mail carries;
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
  /** Kept by the lexical recall only (`knowledge_lexical_recall`): shown to the model as low relevance, to verify before citing. */
  lowRelevance?: boolean;
}>;
/** What the model reads on a card the lexical recall kept (data on the card, never a change of the prompts). */
export const SMART_LOW_RELEVANCE_NOTE = "faible : fiche retrouvée seulement par des mots du mail, pas par le sens. Vérifie qu'elle répond vraiment au besoin avant de la citer ; sinon ne la cite pas.";
/** The model's view of a card's relevance: the note on a low-relevance card, nothing otherwise (every other card is shown as before). */
export const smartRelevanceView = (card: Pick<SmartSource, "lowRelevance">) => card.lowRelevance ? { pertinence: SMART_LOW_RELEVANCE_NOTE } : {};
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
  /**
   * Smart images (`SAV_V2_SMART_ATTACHMENT_IMAGES=on`), ONLY when the files were really sent to the model this turn: the files by their id (`pj1`...),
   * with V1's earlier reading when stored. A customer fact marked with one of these ids (`toolCallId`) is read on that file: its excerpt must be in
   * the stored reading when there is one; without a reading the marker of an admitted file is accepted. Absent: the exact previous checks.
   */
  files?: readonly Readonly<{ id: string; reading: string | null }>[];
  /**
   * 26/11 (`SAV_V2_SMART_COMMERCIAL_SPLIT=on` only, absent otherwise): the needs the reading marked commercial. The reply must say nothing of them: a fact
   * written for one, or a sentence taking up its own words (same comparison as the injected instruction, no word list), refuses (`commercial_in_reply`).
   */
  commercial?: ReadonlyArray<Readonly<{ id: string; ask: string }>>;
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

// A sentence that invites to switch to another product, no name needed (bench 22/11: « je vous recommande l'application… » / « un outil comme… » are gone,
// they caught connected integrations; a sign-up is judged per clause by the named tool: PORTE 1J).
const SWITCH = /\b(?:je vous (?:recommande|conseille|suggere|propose) (?:de vous tourner vers|un autre|une autre|plutot)|utilisez plutot|tournez-vous vers|passez (?:plutot )?(?:par|chez) (?:un|une) (?:autre|outil|service|prestataire|plateforme)|(?:outil|plateforme|solution|logiciel|service) (?:alternati(?:f|ve)|concurrente?))\b/;
// SAV-122: « fait » alone is no praise (« votre site fait avec Yonos » describes the customer's tool); « Yonos fait des agents » still is.
const PRAISE = /\b(?:(?:propose(?:nt)?|offre(?:nt)?|permet(?:tent)?|dispose(?:nt)?|gere(?:nt)?|integre(?:nt)?|fournit|fournissent)\b|(?:fait|font) (?:aussi |egalement |deja |tres bien |mieux |des |du |de l'|de la |ca |cela ))/;
const namesIn = (names: readonly string[], folded: string) => names.filter(name => new RegExp(String.raw`(?<![\p{L}\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\p{L}\p{N}])`, "u").test(folded));

/*
 * OUR reply sends the customer to a Limova COMPETITOR (bench 22/11, Ugo's rule: naming another app, a connected tool, an integration, the customer's
 * CRM or mail host is fine; the fault is only a redirection to a tool that would replace Limova, or conceding that a competitor is better). Per sentence:
 *   - substitution framing (« à la place de Limova », « un autre outil », « Limova ne le fait pas », alternative, competitor): every named tool counts,
 *     except a name of the cited card; a generic invitation to switch counts with or without a name;
 *   - a favourable comparison (« plus simple », « meilleur »): every named tool counts except a mail host, a connected tool or a cited card's name;
 *   - otherwise: only a known competitor (or a list name nobody brought into the case) recommended, praised or signed up for; a name of the cited card,
 *     of the customer's message or a mail host / connected integration never fires (OVH and `imap.ovh.net`, Calendly with its card).
 * Unknown competitors the customer names (a fictional « Botario » recommended without comparison) are left to the counter-read (`other_platform`).
 * Never reads the inbound mail as a filter: the customer's text only tells which names he brought.
 */
export function smartOtherPlatformSentences(reply: string, customerText: string, citedCardText = ""): string[] {
  const customer = fold(customerText), cards = fold(citedCardText);
  const customerTools = savOtherPlatformCustomerTools(customerText, fold);
  const all = [...new Set([...SAV_OTHER_PLATFORM_THIRD_PARTIES, ...SAV_OTHER_PLATFORM_COMPETITORS, ...customerTools])];
  const fromCards = new Set(namesIn(all, cards)), connected = new Set<string>(SAV_OTHER_PLATFORM_CONNECTED), competitors = new Set<string>(SAV_OTHER_PLATFORM_COMPETITORS);
  const fromCustomer = new Set([...customerTools, ...namesIn(all, customer)]);
  const exempt = [...fromCards, ...connected, ...[...fromCustomer].filter(name => !competitors.has(name))];
  return sentencesOf(reply).filter(sentence => {
    const folded = fold(sentence), substitutes = savOtherPlatformSubstitutes(folded), compares = savOtherPlatformCompares(folded);
    const names = substitutes ? all.filter(name => !fromCards.has(name))
      : compares ? all.filter(name => !fromCards.has(name) && !connected.has(name))
      : all.filter(name => !fromCards.has(name) && !connected.has(name) && (competitors.has(name) || !fromCustomer.has(name)));
    // A generic invitation to switch: refused, unless the sentence is about Limova or a tool the case legitimately names, without substitution framing.
    const generic = SWITCH.test(folded) || savOtherPlatformRedirect(folded);
    const anchored = SAV_OTHER_PLATFORM_LIMOVA.test(folded) || namesIn(exempt, folded).length > 0;
    if (generic && (substitutes || !anchored)) return true;
    if (!names.length) return false;
    const known = new RegExp(String.raw`(?<![\p{L}\p{N}])(${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\p{L}\p{N}])`, "u");
    // PORTE 1J: per clause, the named third party decides; a « Limova » word elsewhere in the sentence exempts nothing.
    return savOtherPlatformOrients(folded, names) || savOtherPlatformEndorses(folded, names)
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
/*
 * PR #339 review (send gate aligned on the 22/11 rule): « Je vous recommande d'utiliser Calendly » or « Connectez Calendly dans Intégrations » passed the
 * agent's check but were cancelled here. The mail hosts and connected tools (`SAV_OTHER_PLATFORM_CONNECTED`) are no longer names this gate orients or
 * endorses on, UNLESS the sentence frames the tool as a replacement of Limova (`savOtherPlatformSubstitutes`: « à la place de Limova », « un autre
 * outil »...), where every named tool counts again. A generic redirection (`savOtherPlatformRedirect`, « à la place de Limova » included) is still
 * refused with no name at all.
 */
const SEND_GATE_ALL = [...new Set([...SAV_OTHER_PLATFORM_THIRD_PARTIES, ...SAV_OTHER_PLATFORM_COMPETITORS])];
const SEND_GATE_NAMES = SEND_GATE_ALL.filter(name => !(SAV_OTHER_PLATFORM_CONNECTED as readonly string[]).includes(name));
export const smartOtherPlatformInvite = (reply: string) => sentencesOf(reply).some(sentence => {
  const folded = fold(sentence);
  if (savOtherPlatformRedirect(folded)) return true;
  if (savOtherPlatformSubstitutes(folded)) return savOtherPlatformEndorses(folded, SEND_GATE_ALL) || savOtherPlatformOrients(folded, SEND_GATE_ALL);
  if (savOtherPlatformEndorses(folded, SEND_GATE_NAMES)) return true;
  return integrationParts(folded).some(part => !INTEGRATIONS_MENU.test(part) && savOtherPlatformOrients(part, SEND_GATE_NAMES));
});

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/giu;
const DOMAIN = /(?<![\p{L}\p{N}@./-])(?:www\.)?[a-z0-9][a-z0-9-]{1,62}(?:\.[a-z0-9-]{1,62})*\.(?:com|fr|io|ai|net|org|co|app|eu|be|ch|ca|me|so|dev)(?![\p{L}\p{N}-])/giu;

// 25/11: Markdown or French quoting glued to a link (« **https://…** », « https://… » ») is not part of it: the link is read without it.
const stripUrl = (value: string) => value.replace(/[.,;:!?*`»”’]+$/u, "");
const hostOf = (url: string) => { try { return new URL(url).host.toLowerCase(); } catch { return ""; } };

/** The official Limova sites (card-safety's reviewed list, Limova hosts only) and the public site: their home page is always a valid link. */
const SMART_OFFICIAL_LIMOVA_HOSTS: ReadonlySet<string> = new Set(["limova.ai", ...SAV_CARD_OFFICIAL_LINKS.map(row => row.host).filter(host => host.endsWith(".limova.ai"))]);

const BARE_PATH = /^\/[^\s<>"')\]«»]*/u;

/*
 * The links and domains of a text (lower case, trailing punctuation removed). v17 (22/11): a link written without its scheme (« bienvenue.limova.ai/
 * inscription ») is read as the same https link, so its PATH is checked exactly like a full link: an invented page on an allowed host is refused
 * whether or not the model wrote « https:// » (before, only its host was checked).
 */
function linksOf(text: string) {
  const urls = [...text.matchAll(URL_RE)].map(match => stripUrl(match[0]));
  const rest = text.replace(URL_RE, " ");
  const domains: string[] = [];
  for (const match of rest.matchAll(DOMAIN)) {
    const host = match[0].toLowerCase().replace(/^www\./, "");
    domains.push(host);
    const path = stripUrl(rest.slice((match.index ?? 0) + match[0].length).match(BARE_PATH)?.[0] ?? "");
    if (path.length > 1) urls.push(`https://${host}${path}`);
  }
  return { urls, domains };
}

/*
 * The comparison of an excerpt with its source: no list number, no final punctuation, and the case of the FIRST letter only (PORTE 2E, P2:
 * « AbC123 » is not « abc123 », a value the customer must copy stays exact).
 */
const sentenceKey = (value: string) => normalizeSavEvidenceText(value).replace(/^(?:\d+[.)]|[-•*])\s+/, "").replace(/[\s.!?;:…]+$/u, "").trim();
const firstLetterForms = (key: string) => key ? [...new Set([key, key.charAt(0).toLocaleLowerCase("fr") + key.slice(1), key.charAt(0).toLocaleUpperCase("fr") + key.slice(1)])] : [];
/**
 * SAV-122 (bench v7, pareil-02, plateforme-04-v2: `excerpt_not_found`): a card's steps are joined by line breaks without final punctuation
 * and start with a capital, so an excerpt copied as « épingler l'extension via l'icône puzzle. » or « 2. Recharger la page » was refused.
 * The excerpt must STILL be in the source: only its list number, its final punctuation and the case of its FIRST letter are ignored, with
 * the word boundaries of `savEvidenceContains` (no fuzzy match, no accent removal, no word dropped).
 */
export function smartExcerptInSource(source: string, excerpt: string): boolean {
  if (savEvidenceContains(source, excerpt)) return true;
  return firstLetterForms(sentenceKey(excerpt)).some(form => savEvidenceContains(source, form));
}

/*
 * SAV-122 (prod bench 21/11, 98 conversations: 12 turns `fact_source_invalid`, dominant shape `fait_limova:fiche:card_n:excerpt_y`, then
 * `fait_limova:aucune:card_n:excerpt_y` and `fait_limova:academy:card_n:excerpt_y`): a Limova fact WITH its word-for-word excerpt but
 * without the reference of its source (card id, version, or Academy call id). The server fills the reference ONLY when it is unambiguous:
 * exactly one card retrieved FOR THAT NEED (or one Academy result of that need) contains the excerpt, or the named card has exactly one
 * version retrieved for the need. The repaired fact then goes through every check unchanged (card retrieved for the need, excerpt in the
 * source): nothing is weakened, only the model's missing label is filled. Zero or several candidates: left as is (refused).
 */
export function smartRepairFactSources(decision: SmartDecision, sources: readonly SmartSource[], academy: readonly SmartAcademyEvidence[] = []): { decision: SmartDecision; repaired: number } {
  let repaired = 0;
  const facts = decision.facts.map(fact => {
    if (fact.type !== "fait_limova" && fact.type !== "fait_temporaire") return fact;
    const excerpt = fact.excerpt?.trim();
    if (!excerpt || fact.sourceKind === "client") return fact;
    if (fact.sourceKind === "fiche" && fact.cardId && fact.version) return fact;
    if (fact.sourceKind === "academy" && fact.toolCallId) return fact;
    const forNeed = sources.filter(source => source.needIds.includes(fact.needId));
    if (fact.sourceKind === "fiche" && fact.cardId) {
      const versions = forNeed.filter(source => source.cardId === fact.cardId);
      if (versions.length !== 1 || !smartExcerptInSource(cardText(versions[0]!), excerpt)) return fact;
      repaired++;
      return { ...fact, version: versions[0]!.version };
    }
    const cards = forNeed.filter(source => smartExcerptInSource(cardText(source), excerpt));
    const calls = academy.filter(row => row.needId === fact.needId && smartExcerptInSource(row.text, excerpt));
    if (cards.length + calls.length !== 1) return fact;
    repaired++;
    return cards.length
      ? { ...fact, sourceKind: "fiche" as const, cardId: cards[0]!.cardId, version: cards[0]!.version, toolCallId: null }
      : { ...fact, sourceKind: "academy" as const, toolCallId: calls[0]!.callId, cardId: null, version: null };
  });
  return { decision: repaired ? { ...decision, facts } : decision, repaired };
}

/**
 * SAV-122 diagnostic: CLOSED codes describing the shape of each fact that breaks the `fact_source_invalid` rule, never its text:
 * `fact_shape:<type>:<sourceKind>:card_<y|n>:excerpt_<y|n>:need_<known|unknown>`.
 */
export function smartFactDiagnostics(decision: SmartDecision | null, needIds: readonly string[]): string[] {
  if (!decision) return [];
  const out: string[] = [];
  for (const fact of decision.facts) {
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
  // The fact named to the correction: its sentence hint, else its excerpt (the sentence is optional since SAV-122).
  const factLabel = (fact: SmartDecision["facts"][number]) => fact.sentence.trim() || (fact.excerpt?.trim() ? `extrait : « ${fact.excerpt.trim()} »` : `fait du besoin ${fact.needId}`);
  const flag = (code: SmartCheckCode, sentence: string) => { codes.add(code); factProblems.push({ code, sentence: String(sentence ?? "").slice(0, 300) }); };
  /** Smart images: what the customer showed on a file the model saw (accepted file facts, V1's readings of the sent files); empty without files. */
  const fileTexts: string[] = (input.files ?? []).flatMap(row => row.reading ? [row.reading] : []);
  for (const fact of decision.facts) {
    // SAV-122 (prod bench 21/11): no `fact_sentence_missing` any more. It only checked that a DECLARED fact's sentence was copied into the
    // reply (never an undeclared invention) and refused good replies the model had reworded. A fact's `sentence` is a hint for the
    // counter-read; the excerpt in its source, the card retrieved for the need and the counter-read's `unlisted_claim` / `source_mismatch` stay.
    if (!needIds.has(fact.needId)) { flag("fact_source_invalid", factLabel(fact)); continue; }
    if (fact.type === "fait_tiers") { flag("third_party_fact_unsourced", factLabel(fact)); continue; }
    if ((fact.type === "fait_limova" || fact.type === "fait_temporaire") && fact.sourceKind === "academy") {
      const evidence = (input.academy ?? []).find(row => row.callId === fact.toolCallId);
      if (!fact.toolCallId || !fact.excerpt?.trim()) { flag("fact_source_invalid", factLabel(fact)); continue; }
      if (!evidence || evidence.needId !== fact.needId) { flag("card_not_retrieved_for_need", factLabel(fact)); continue; }
      citedAcademy.set(evidence.callId, evidence);
      if (!smartExcerptInSource(evidence.text, fact.excerpt)) flag("excerpt_not_found", factLabel(fact));
      continue;
    }
    if (fact.type === "fait_limova" || fact.type === "fait_temporaire") {
      if (fact.sourceKind !== "fiche" || !fact.cardId || !fact.version || !fact.excerpt?.trim()) { flag("fact_source_invalid", factLabel(fact)); continue; }
      const source = input.sources.find(row => row.cardId === fact.cardId && row.version === fact.version);
      if (!source || !source.needIds.includes(fact.needId)) { flag("card_not_retrieved_for_need", factLabel(fact)); continue; }
      cited.set(`${source.cardId}:${source.version}`, source);
      if (!smartExcerptInSource(cardText(source), fact.excerpt)) flag("excerpt_not_found", factLabel(fact));
      continue;
    }
    if (fact.type === "dit_par_le_client") {
      if (fact.sourceKind !== "client" || !fact.excerpt?.trim()) { flag("fact_source_invalid", factLabel(fact)); continue; }
      if (smartExcerptInSource(input.customerText, fact.excerpt)) continue;
      // Smart images: a fact read on a file the model really saw (its id as marker), checked against V1's stored reading of it when there is one.
      const file = fact.toolCallId ? input.files?.find(row => row.id === fact.toolCallId) : undefined;
      if (file && (!file.reading || smartExcerptInSource(file.reading, fact.excerpt))) { fileTexts.push(fact.excerpt); continue; }
      flag("excerpt_not_found", factLabel(fact));
      continue;
    }
    // conseil: no source by definition; a source given to advice is ignored.
  }
  const citedText = [...[...cited.values()].map(source => fold(cardText(source))), ...[...citedAcademy.values()].map(row => fold(row.text))].join("\n");
  const allCardText = input.sources.map(source => cardText(source)).join("\n");

  // Links: resources, a link written in a card given for the mail, or an OFFICIAL Limova link (limova.ai or a subdomain) given by an Academy result
  // of this turn. v17 (22/11): the decide prompt (rule 6) allows an Academy result's link; the check now allows the same official links (before, only
  // those under the Academy resource passed). An Academy result's link to another site stays refused: Academy results are untrusted data.
  const academyText = (input.academy ?? []).map(row => row.text).join("\n");
  const officialLimova = (url: string) => { const host = hostOf(url).replace(/^www\./, ""); return host === "limova.ai" || host.endsWith(".limova.ai"); };
  // PR #340 review: an Academy link is matched EXACTLY (same host, same path; trailing slash, query and fragment ignored), never as a prefix, so an
  // Academy result giving a host root (« https://limova.ai ») does not open every page of that host.
  const exactKey = (url: string) => { try { const parsed = new URL(url); return `${parsed.host.toLowerCase().replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`; } catch { return null; } };
  const cardLinks = linksOf(allCardText), academyKeys = new Set(linksOf(academyText).urls.filter(officialLimova).map(exactKey).filter((key): key is string => Boolean(key)));
  const allowedUrls = [...SAV_SMART_RESOURCES.map(row => row.url), ...cardLinks.urls].map(url => url.toLowerCase());
  const allowedHosts = new Set([...allowedUrls.map(hostOf), ...[...academyKeys].map(key => key.split("/")[0]!), ...cardLinks.domains].filter(Boolean).map(host => host.replace(/^www\./, "")));
  const { urls, domains } = linksOf(reply);
  // 25/11 (owner: customers MUST get links): an official Limova site named by its home page (« https://new.limova.ai », « academy.limova.ai ») is always allowed.
  // A deeper page still has to be written in a card given for the mail, a resource or an Academy result: an invented page is never sent.
  // https only, no user, port, query or fragment, the exact host (a lookalike « limova.ai.exemple.invalid » is another host), the home page only.
  const officialRoot = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash && !/[?#]/.test(url)
        && (parsed.pathname === "/" || parsed.pathname === "") && SMART_OFFICIAL_LIMOVA_HOSTS.has(parsed.hostname.toLowerCase().replace(/^www\./, ""));
    } catch { return false; }
  };
  const linkAllowed = (url: string) => allowedUrls.some(allowed => url.toLowerCase() === allowed || url.toLowerCase().startsWith(`${allowed.replace(/\/$/, "")}/`))
    || academyKeys.has(exactKey(url) ?? "") || officialRoot(url);
  // The refused links are NAMED to the correction (`factProblems`), so it removes those and keeps every allowed link. Before, it got the code alone and
  // could not tell which link to drop: on 25/11 the corrected reply had lost the cited card's Academy link, which this check always allowed.
  const refusedLinks = [...new Set([...urls.filter(url => !linkAllowed(url)),
    ...domains.filter(domain => !allowedHosts.has(domain) && !SMART_OFFICIAL_LIMOVA_HOSTS.has(domain))])].slice(0, 5);
  for (const link of refusedLinks) flag("link_not_allowed", `Lien non autorisé, à retirer seul (garder les autres liens) : ${link}`);

  // Other platforms: an invitation or a praise is refused even when the customer named it; a name is allowed only from the customer or a cited card.
  // Smart images: a tool the customer showed on a file (« Yahoo », « Nylas » on a screenshot) counts as named by the customer; without files, unchanged.
  const customerSeen = fileTexts.length ? [input.customerText, ...fileTexts].join("\n") : input.customerText;
  const customer = fold(customerSeen);
  const citedCardText = [...cited.values()].map(source => cardText(source)).join("\n");
  if (smartOtherPlatformSentences(reply, customerSeen, citedCardText).length) codes.add("other_platform_recommended");
  for (const sentence of sentencesOf(reply)) {
    for (const name of [...fold(sentence).matchAll(THIRD_PARTY)].map(match => match[1]!)) if (!customer.includes(name) && !citedText.includes(name)) codes.add("third_party_named");
  }

  if (reply && requestsCredential(reply)) codes.add("credential_request");
  // Bench 22/11 (Calendly reply refused with its card cited): a promise is sourced by ANY card given for this mail or a cited Academy result, not only
  // by a card a fact cites (the statement is often written as advice or carried by another fact of the same card); spacing is ignored (« 15 € » / « 15€ »).
  const squash = (value: string) => value.replace(/\s+/g, "");
  const promiseSupport = squash([citedText, fold(allCardText)].join("\n"));
  for (const pattern of PROMISES) {
    const match = foldedReply.match(new RegExp(pattern.source, "g")) ?? [];
    if (match.some(hit => !promiseSupport.includes(squash(hit)))) { codes.add("promise_unsourced"); break; }
  }
  if (ACCOUNT_ACTION.test(foldedReply) || (decision.outcome !== "handoff" && HANDOFF_CLAIM.test(foldedReply))) codes.add("account_action_claimed");
  if (reply && smartSensitiveCommitment(reply)) codes.add("sensitive_commitment");
  if (input.memory) for (const code of smartRepeatCodes(input.memory, decision)) codes.add(code);
  // SAV-122 (PORTE 2E, P1): a sentence of OUR reply that takes up the instruction found in the mail (never a word list on the mail).
  for (const sentence of smartInstructionEchoes(reply, input.instruction ?? reading.instructionText ?? null)) {
    codes.add("instruction_followed"); factProblems.push({ code: "instruction_followed", sentence: sentence.slice(0, 300) });
  }
  for (const need of input.commercial ?? []) {
    for (const fact of decision.facts.filter(row => row.needId === need.id)) flag("commercial_in_reply", factLabel(fact));
    for (const sentence of smartInstructionEchoes(reply, need.ask)) flag("commercial_in_reply", sentence);
  }
  return { ok: codes.size === 0, codes: [...codes], factProblems };
}
