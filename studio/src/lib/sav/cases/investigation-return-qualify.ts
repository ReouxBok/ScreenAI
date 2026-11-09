import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { splitSavMessageText } from "../message-context";
import { savOutsidePersonalAccessScope, savPersonalAccessIntent } from "../request-retrieval";
import { admissionPolicyPort, type AdmissionPolicyRecord } from "./admission-runtime";
import { SAV_CASE_SENSITIVE_FAMILIES, type CaseAdmissionQualification, type CaseRequestFamily } from "./case-types";
import { relayQualification } from "./intake-boundary";
import { loginCustomerStatement, reportsOngoingLoginFailure, reportsRestoredAccess } from "./restored-access";
import { caseLatestCustomerMail } from "./investigation-runner";
import type { CaseInvestigationStoreDeps } from "./investigation-store-ports";
import { CaseQualificationUnavailableError, type CaseQualificationCauseCode } from "./qualification-diagnostic";

/*
 * V2 customer return (contract A-B, 4/11), LOCAL and OFF: a mail V2 consumed on an open case BEFORE V1 has, by construction, no V1 decision.
 * Its content is qualified again here, on its own words, by the approved return rules (an injected port; none is approved, so production
 * admits nobody on a return), with the case's identity carried only when the same stored sender wrote it. Never the admission of an older
 * mail copied over: a qualification that does not name the current input does not let the investigation answer it. Reads the database only.
 */

/** What an approved return rule is given: the case's open requests and the return mail's own words. It answers with `qualified_rule` requests. */
export type CaseReturnRulePort = (input: Readonly<{
  caseId: string; messageId: string; text: string; changedSubject?: string;
  requests: ReadonlyArray<Readonly<{ requestId: string; family: CaseRequestFamily }>>;
}>) => Promise<CaseAdmissionQualification["requests"]>;

export type CaseReturnQualifyDeps = Readonly<{
  readPolicyRecord(): Promise<AdmissionPolicyRecord | null>;
  now(): Date;
  /** Approved return rules. Absent (production today): hints only, so nobody is admitted on a return and the case goes to the team. */
  returnRules?: CaseReturnRulePort;
}>;

const sensitive = (family: string) => (SAV_CASE_SENSITIVE_FAMILIES as readonly string[]).includes(family);
const lower = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/**
 * B's `qualify` with the dedicated return path: a customer return is qualified here, anything else goes to `v1Qualify` (A's canonical V1 path)
 * unchanged. Refusals are A6's typed ones (technical: retried later, nothing written; contract: never retried as is).
 */
export function caseInvestigationReturnAwareQualify(v1Qualify: CaseInvestigationStoreDeps["qualify"], deps: CaseReturnQualifyDeps): CaseInvestigationStoreDeps["qualify"] {
  const policyPort = admissionPolicyPort({ read: deps.readPolicyRecord, now: deps.now });
  return async (snapshot, events) => {
    const latest = caseLatestCustomerMail(events);
    if (!latest?.customerReturn) return v1Qualify(snapshot, events);
    const { inputKey, event } = latest, inputVersion = snapshot.admissionInputVersion;
    const refuse = (code: "relay_proof_invalid" | "rule_unavailable" | "rule_invalid" | "policy_unavailable", causeCode: CaseQualificationCauseCode | null = null) =>
      new CaseQualificationUnavailableError({ code, inputKey, inputVersion, causeCode });
    // The return must be the current input, recorded by the return route for this stored mail.
    const messageId = event.detail?.messageId, relay = event.detail?.relay as { messageId?: unknown } | undefined;
    if (event.kind !== "inbound_confirmed" || event.caseVersion !== inputVersion || typeof messageId !== "string" || relay?.messageId !== messageId) throw refuse("relay_proof_invalid");
    const db = requireDb();
    let text: string, sender: string, subject: string;
    try {
      const [mail] = await db.select().from(savMessages).where(eq(savMessages.id, messageId));
      if (!mail || mail.direction !== "inbound" || mail.gmailMessageId !== latest.gmail || !snapshot.threadIds.includes(mail.threadId)) throw refuse("relay_proof_invalid");
      const body = decryptSavPayload<{ text?: unknown }>(mail.bodyCiphertext);
      if (typeof body.text !== "string" || !body.text.trim()) throw refuse("rule_unavailable");
      text = body.text; sender = lower(mail.fromEmail); subject = mail.subject;
    } catch (error) {
      if (error instanceof CaseQualificationUnavailableError) throw error;
      throw refuse("rule_unavailable");
    }
    // Identity and CRM context are carried from the case's own admission only for the same stored sender as the mail V1 relayed; anyone else is unknown.
    const prior = snapshot.admission?.qualification;
    const relayed = [...events].reverse().find(row => row.direction === "customer_inbound" && (row.detail?.relay as { kind?: unknown } | undefined)?.kind === "intake_effects_confirmed");
    const relayedId = relayed?.detail?.messageId;
    const [origin] = typeof relayedId === "string" ? await db.select({ fromEmail: savMessages.fromEmail, subject: savMessages.subject }).from(savMessages).where(eq(savMessages.id, relayedId)) : [];
    const sameSender = Boolean(origin && sender && lower(origin.fromEmail) === sender);
    const identity: CaseAdmissionQualification["identity"] = sameSender && prior?.identity.status === "confirmed" ? prior.identity : { status: "unknown" };
    const crmContext: CaseAdmissionQualification["crmContext"] = sameSender && prior ? prior.crmContext : "unknown";
    // The return continues the case's open requests; its own words decide their families again. A model hint never admits.
    const open = snapshot.body.openRequests.filter(row => row.status === "open").map(row => ({ requestId: row.id, family: row.family as CaseRequestFamily }));
    if (!open.length) return null;
    const hints: CaseAdmissionQualification = { requests: open.map(row => ({ requestId: row.requestId, family: row.family, provenance: { kind: "intake_hint", source: event.sourceRef } })),
      identity, crmContext, teamSignals: [] };
    let qualification = hints;
    if (deps.returnRules) {
      let ruled: CaseAdmissionQualification["requests"];
      // A reply prefix alone does not establish that the subject is old: compare it to the
      // subject on the original stored mail. A new subject may veto a continuation.
      const topic = (raw: string) => lower(raw).replace(/^(?:(?:re|rép|aw|sv)\s*:\s*)+/u, "").replace(/\s+/gu, " ").trim();
      const changedSubject = origin && topic(subject) === topic(origin.subject) ? undefined : subject;
      try { ruled = await deps.returnRules({ caseId: snapshot.caseId, messageId, text, changedSubject, requests: open }); } catch { throw refuse("rule_unavailable"); }
      const ids = new Set(open.map(row => row.requestId)), mailAt = Date.parse(event.occurredAt);
      // Only rules that read THIS mail: dated on or after it, on the case's open requests.
      if (ruled.some(row => row.provenance.kind !== "qualified_rule" || !ids.has(row.requestId) || !(Date.parse(row.provenance.at) >= mailAt))) throw refuse("rule_invalid");
      try {
        qualification = relayQualification(hints, { ...hints, requests: ruled }, open.map(row => ({ requestId: row.requestId, kind: row.family })));
      } catch { throw refuse("rule_invalid"); }
      // A sensitive family the rules found stays, whatever the earlier access request was.
      qualification = { ...qualification, requests: qualification.requests.filter(row => row.provenance.kind === "qualified_rule" || sensitive(row.family) || !ruled.some(r => r.requestId === row.requestId)) };
    }
    let policy: unknown;
    try { policy = await policyPort(); } catch { throw refuse("policy_unavailable"); }
    return { admission: { policy, qualification }, sourceRef: event.sourceRef };
  };
}

const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`]/g, "'");
// Read on the customer's own new words (quoted history and signature removed). Any sensitive word wins: a sensitive or mixed return stops.
const SENSITIVE: ReadonlyArray<readonly [CaseRequestFamily, RegExp]> = [
  ["cancellation", /\b(?:resili\w*|desabonn\w*|annuler (?:mon|l'|notre) (?:abonnement|compte|offre)|supprimer (?:mon|notre) compte|fermer (?:mon|notre) compte)\b/],
  ["finance", /\b(?:rembours\w*|factur\w*|paiement\w*|pay(?:er|e|ee|es|ees|ant|ante)|prelev\w*|debit\w*|carte bancaire|avoirs?|litige|impaye\w*|tarif\w*|prix)\b/],
  ["subscription", /\b(?:abonnement|changer d'offre|changement d'offre|upgrade|downgrade|essai gratuit|forfait)\b/],
  ["rights", /\b(?:rgpd|donnees personnelles|droit d'acces|suppression de (?:mes|nos) donnees)\b/],
  ["identity", /\b(?:changer (?:le|de) (?:proprietaire|titulaire)|transferer (?:le|mon) compte|usurp\w*|pirat\w*|compte (?:vole|hacke))\b/],
];
// Leave ambiguous "avoir" under the financial fence. Only an infinitive with an explicit
// login object or a reported check is removed from the sensitive scan; other words still count.
const LOGIN_INFINITIVE = /(?<!\b(?:un |cet |mon |ton |son |notre |votre |leur |l'))\bavoir(?=\s+(?:(?:le|mon|un|ce) (?:bon )?(?:code|lien)|acces|(?:bien |deja )?(?:verifie|consulte|regarde|essaye))\b)/g;
// A mail provider may be the inbox checked for a login code. Remove just that reference
// before the scope check; a separate request about an integration or an invite still wins.
const INBOX_PROVIDER = /\b(spams?|courriers indesirables|boite (?:mail|de reception)) (?:de |sur )?(?:mon |ma )?(?:gmail|outlook)\b/g;
const SENDER_ADDRESS = /[\w.+%-]+@[\w.-]+\.[a-z]{2,}\b/g;
// A plain continuation of the same access trouble: still no code, still blocked, what the screen shows.
const ACCESS_CONTINUATION = /\b(?:(?:aucun|pas de|pas le) code|pas (?:encore |toujours )?(?:recu|eu) (?:le|de|mon|aucun) code|(?:le|mon|un|aucun) code (?:ne m'|n')?(?:arrive|est arrive|parvient)(?: toujours| jamais)? ?(?:pas|plus)?|(?:avoir|obtenir|recevoir) (?:le|mon|un) code|identifiant (?:introuvable|inconnu|invalide)|message d'erreur|l'ecran affiche|je n'arrive (?:toujours )?pas a me connecter|(?:toujours|encore) bloquee?)\b/;
const BARE_REMINDER = /^(?:(?:bonjour|bonsoir)[\s,.!;-]+)?(?:merci(?: (?:de|pour) (?:votre|le) (?:retour|message|conseil))?[\s,.!;-]+)?(?:je suis |c'est )?(?:toujours (?:pas|rien|bloquee?|le meme probleme)|ca ne (?:marche|fonctionne) (?:toujours )?pas|(?:je n'ai |j'ai )?(?:toujours )?rien recu|meme probleme)[\s,.!;-]*(?:merci[\s,.!;-]*)?$/;
const CHECKED_INBOX = /\b(?:j'ai|nous avons|apres avoir|avoir) (?:bien |deja |aussi )?(?:verifie|regarde|consulte) (?:dans )?(?:mes |nos |les )?(?:spams?|courriers indesirables)\b|\bmalgre (?:mes|les) (?:spams?|courriers indesirables) verifies\b|^(?:meme |ni |et )?(?:dans|parmi) (?:les|mes|nos) (?:spams?|courriers? indesirables?)(?: non plus)?$/;

/*
 * Review F3/F5 (7/11): the WHOLE statement must be the customer's own login trouble. One login phrase anywhere used to carry the rest of the mail, so « toujours pas
 * de code, je veux qu'on me rende mon argent » was qualified `access` and the second request vanished. Now every sentence, and every clause of it, must be
 * accounted for: a courtesy or a known neutral context (a try on another browser, a request for help, urgency), or the login trouble itself with nothing
 * else asked in the same clause. Anything else, worded however, is unaccounted for and leaves the mail to the team. A statement that says both « it works » and
 * « it still fails » is contradictory and is left to the team as well. This is a reading of the words, not an understanding: see the report for its limits.
 */
const COURTESY_CLAUSE = /^(?:bonjour|bonsoir|hello|salut|madame|monsieur|madame, monsieur|re|ok|d'accord|merci(?: beaucoup| encore)?(?: d'avance| par avance)?|merci (?:de|pour) (?:votre|ton|le|la) (?:retour|reponse|message|aide|conseil|suivi)|(?:bien |tres )?cordialement|(?:bien )?a vous|bonne (?:journee|soiree)|belle journee|a bientot|svp|s'il vous plait)$/;
const LINK = String.raw`(?:le (?:bon )?lien(?: de connexion)?(?: (?:https?:\/\/)?new_limova_ai\/?)?|(?:https?:\/\/)?new_limova_ai\/?|(?:la bonne|mon|ma) adresse(?: e-?mail| mail)?(?: habituelle| d'inscription)?)`;
const NEUTRAL_CLAUSE = new RegExp([
  // Asking for help with this very trouble, or saying it is urgent.
  String.raw`^(?:(?:pouvez|pourriez)-? ?vous m'aider(?: svp| s'il vous plait| rapidement)?|(?:que|qu'est-ce que je) dois(?:-je| je)? faire|(?:j'ai|nous avons) besoin d'aide|aidez-moi|je ne sais (?:plus|pas) quoi faire|(?:c'est|c'est assez|c'est tres) urgent|je ne peux (?:pas|plus) travailler|je suis (?:bloquee?|coincee?) depuis \w+(?: \w+)?)$`,
  // What was already tried for the login: again, on another browser or device, after clearing the cache.
  String.raw`^(?:(?:j'ai|nous avons) (?:pourtant |deja |bien |aussi |encore )*(?:essaye|teste|reessaye|retente|vide (?:le |mon )?cache|redemarre(?: mon \w+)?|change de navigateur)(?: plusieurs fois| a nouveau| encore)?(?: (?:sur|avec|depuis|dans) (?:un autre navigateur|un autre appareil|(?:mon|ma|le|la|un|une) (?:navigateur|telephone|portable|ordinateur|pc|mac|tablette|mobile)|chrome|firefox|safari|edge|opera|brave)(?: (?:et|ou) (?:sur |avec )?(?:chrome|firefox|safari|edge|opera|brave|mon \w+))*)?)$`,
  // The procedure we sent was followed (the failure itself is read in the next clause).
  String.raw`^(?:j'ai|nous avons) (?:bien |pourtant |deja )*(?:suivi|applique|refait|fait) (?:toutes |chacune des |)?(?:les etapes|vos etapes|la procedure|votre procedure|vos instructions|vos conseils|ce que vous m'avez dit)(?: (?:indiquees|envoyees|une par une|a la lettre))?$`,
  // Device or time context on its own.
  String.raw`^(?:(?:et |aussi |meme |pareil )?(?:sur|avec|depuis|dans) (?:un autre navigateur|un autre appareil|(?:mon|ma|le|la|un|une) (?:navigateur|telephone|portable|ordinateur|pc|mac|tablette|mobile)|chrome|firefox|safari|edge)(?: comme (?:sur|avec) (?:mon|ma|le|la) (?:navigateur|telephone|portable|ordinateur|pc|mac|tablette|mobile))?|depuis (?:hier|ce matin|ce soir|cet apres-midi|quelques jours|plusieurs jours|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?: soir| matin)?)$`,
  // The link and the address the customer says they used (domains are read with their dots protected, see `protectDomains`).
  String.raw`^(?:(?:j'utilise|(?:j'ai|nous avons) (?:bien |pourtant |toujours |deja )*utilise|je passe par|via|avec) (?:bien |pourtant |toujours )?)?${LINK}(?: (?:et|avec) ${LINK})*$`,
  // A screenshot is attached; « nothing », « still nothing », « same ».
  String.raw`^(?:ci-joint|vous trouverez ci-joint|je vous joins|voici) (?:une |la |ma )?capture(?: d'ecran)?(?: (?:en piece jointe|ci-jointe?|jointe?))?$`,
  String.raw`^(?:toujours )?(?:rien|aucun|pareil|idem|meme chose|rien du tout|toujours pareil)$`,
].join("|"));
// The access trouble may be described, never alongside another subject or another thing asked in the same clause.
const OTHER_TOPIC = /\b(?:aussi|egalement|par ailleurs|d'ailleurs|au passage|en plus|de plus|par contre|autre (?:chose|question|demande|souci|probleme|sujet)|combien|argent|sommes?|rib|montant|offre|contrat|engage\w*|devis|concurrent|rappel\w*|export\w*|prompt|agents?|appels?|telephonie|sms|whatsapp|routines?|campagnes?|publications?|documents?|fichiers?|historique|mails? automatiques?)\b/;
const REQUEST_VERB = /\b(?:je (?:veux|voudrais|souhaite|souhaiterais|aimerais|demande)|(?:pouvez|pourriez)-? ?vous|merci de|envoyez|rappelez|changez|modifiez|ajoutez|supprimez|faites)\b/;
const ACCESS_REQUEST = /\b(?:je (?:veux|voudrais|souhaite|souhaiterais|aimerais)|(?:pouvez|pourriez)-? ?vous|merci de) (?:juste |simplement |bien )?(?:me (?:re)?connecter|(?:acceder|avoir acces|retrouver (?:l')?acces) a (?:mon|notre) (?:compte|espace)|recevoir (?:le|mon|un) code|m'aider(?: a me (?:re)?connecter)?|me (?:renvoyer|envoyer|redonner) (?:le|un|mon) (?:code|lien)|(?:me )?debloquer (?:mon|notre) (?:compte|acces))\b/;
// An error at login, or an account the customer says they already have: context for the personal login trouble on a first mail.
const LOGIN_ERROR_CLAUSE = /^(?:(?:une )?erreur (?:\d{3} )?(?:lors de|pendant|au moment de) (?:ma|notre|la) (?:re)?connexion(?: a limova)?|(?:lors de|pendant|au moment de) (?:ma|notre) (?:re)?connexion,? (?:une |un code d')?erreur(?: \d{3})? (?:apparait|s'affiche))$/;
const EXISTING_ACCOUNT_CLAUSE = /^(?:j'ai|nous avons) (?:deja |bien |toujours )?(?:un|mon|notre) compte(?: limova)?$|^je suis (?:deja )?client(?:e)?(?: depuis [\w ]{1,30})?$/;
const NOT_LOGIN_CONTEXT = /\b(?:internet|wi-?fi|reseau|vpn|serveur|banque|bancaire)\b/;
// Review F5: another person's account is not the customer's own access. « je suis cliente » or « mon espace client » is still the customer.
const THIRD_PARTY = /(?<!\b(?:suis|sommes|etant|en tant que|espace|compte|service) )\b(?:(?:mon|ma|mes|notre|nos|son|sa|ses|leur|leurs|un|une|des|cette|ce|cet)\s(?:collegues?|clients?|clientes?|salarie(?:e)?s?|employe(?:e)?s?|associe(?:e)?s?|stagiaires?|assistante?s?|secretaires?|patron(?:ne)?s?|superieur(?:e)?s?|managers?|equipes?|epouse|mari|femme|conjoint(?:e)?|fils|filles?|enfants?|ami(?:e)?s?|partenaires?|benevoles?|adherent(?:e)?s?|eleves?|utilisat(?:eur|rice)s?)|quelqu'un d'autre|une autre personne|un autre utilisateur|d'autres utilisateurs|pour (?:lui|elle|eux|elles)|(?:son|sa|leur|leurs) (?:compte|comptes|espace|espaces|acces|code|codes|connexion|session))\b|\b(?:le|au|du) compte (?:de|d') ?(?!(?:connexion|utilisateur|test|demo|l'entreprise|la societe|notre|mon)\b)(?:mon|ma|un|une|\w+)/;

// A dot inside a web address is not the end of a sentence: « new.limova.ai » is read as one word.
const protectDomains = (value: string) => value.replace(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:ai|fr|com|io|net|org|eu|be|ch|app)\b(?:\/[^\s]*)?/g, domain => domain.replace(/\./g, "_"));
type StatementReading = Readonly<{ accounted: boolean; restored: boolean; trouble: boolean }>;
const connectors = /^(?:et|mais|pourtant|ah|oh|bon|or|donc|puis|alors|sinon|enfin|bref|du coup)\b[\s,]*/;
/** Reads every sentence and clause of the customer's own words (normalised, signature set aside). */
function readAccessStatement(value: string, first = false): StatementReading {
  let restored = false, trouble = false;
  const sentences = protectDomains(value).match(/[^.!?;\n]+[.!?;]*|[.!?;]+/g) ?? [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence || /^[.!?;]+$/.test(sentence)) continue;
    // A whole sentence that is one known form is read as such before any split (« nous avons retrouvé notre historique et l'usage de Limova »).
    if (reportsRestoredAccess(sentence)) { restored = true; continue; }
    if (reportsOngoingLoginFailure(sentence) || BARE_REMINDER.test(sentence)) { trouble = true; continue; }
    const asks = /\?\s*$/.test(sentence);
    // Commas and the conjunctions that join two statements; « pourtant » or « puis » inside a clause stay with it.
    const clauses = sentence.replace(/[.!?;]+$/, "").split(/,|\s(?:et|mais|car|donc|sinon|alors que)\s/);
    for (let index = 0; index < clauses.length; index++) {
      let clause = clauses[index]!.trim();
      while (connectors.test(clause) && clause.replace(connectors, "") !== clause) clause = clause.replace(connectors, "").trim();
      if (!clause) continue;
      const withMark = asks && index === clauses.length - 1 ? `${clause} ?` : clause;
      // « toujours rien » is the trouble itself, not a neutral word: read it first.
      if (BARE_REMINDER.test(clause)) { trouble = true; continue; }
      if (COURTESY_CLAUSE.test(clause) || NEUTRAL_CLAUSE.test(clause)) continue;
      if (THIRD_PARTY.test(clause)) return { accounted: false, restored, trouble };
      if (!asks && (reportsRestoredAccess(clause) || /^c'est bon$/.test(clause))) { restored = true; continue; }
      if (OTHER_TOPIC.test(clause) || (REQUEST_VERB.test(clause) && !ACCESS_REQUEST.test(clause))) return { accounted: false, restored, trouble };
      const loginContext = first && !NOT_LOGIN_CONTEXT.test(clause) && (LOGIN_ERROR_CLAUSE.test(clause) || EXISTING_ACCOUNT_CLAUSE.test(clause));
      if (savPersonalAccessIntent(clause) || ACCESS_CONTINUATION.test(clause) || BARE_REMINDER.test(clause) || CHECKED_INBOX.test(clause) || reportsOngoingLoginFailure(withMark) || loginContext) { trouble = true; continue; }
      return { accounted: false, restored, trouble };
    }
  }
  return { accounted: (restored || trouble) && !(restored && trouble), restored, trouble };
}

// A title can describe an older topic. Only the inbound customer's own request can admit a new ticket.
export function firstPersonalLoginRequest(text: string, subject: string): boolean {
  const parts = splitSavMessageText(text);
  const all = normalize([subject, parts.currentText, parts.signatureText].join("\n")).replace(LOGIN_INFINITIVE, "");
  const changeAccount = /\b(?:creer|ouvrir) (?:un|mon|notre) compte\b|\b(?:chang\w*|modifi\w*) (?:mon |notre |l'|d')?adresse (?:e-?mail|mail)\b|\b(?:mfa|2fa|droits? administrateur)\b/;
  if (changeAccount.test(all) || SENSITIVE.some(([, pattern]) => pattern.test(all))) return false;
  const own = normalize(loginCustomerStatement(parts)).replace(SENDER_ADDRESS, "").replace(INBOX_PROVIDER, "$1");
  const title = normalize(subject).replace(SENDER_ADDRESS, "").replace(INBOX_PROVIDER, "$1");
  if (savOutsidePersonalAccessScope(title) || THIRD_PARTY.test(title) || THIRD_PARTY.test(own) || !savPersonalAccessIntent(own)) return false;
  // The whole first mail must be the login trouble: a second request, a restored access or a contradiction is not admitted on a fragment.
  const reading = readAccessStatement(own, true);
  return reading.accounted && reading.trouble;
}

/**
 * A REAL return rule on the current content (contract A-B): it reads the return mail's own words, never V1's analysis of an older mail.
 * Sensitive words (finance, cancellation, subscription, rights, identity) qualify every open request with that family, so a sensitive or
 * mixed return is withdrawn to the team; a return whose WHOLE statement is the access trouble (F3, 7/11) stays `access`; anything else, a
 * second request worded without any listed word included, is not qualified (the team). The rule id and revision are given by the caller from the approved policy: a rule the policy does not approve admits nobody.
 */
export function caseReturnContentRule(rule: Readonly<{ ruleId: string; revision: string }>, now: () => Date): CaseReturnRulePort {
  return async ({ text, changedSubject, requests }) => {
    const parts = splitSavMessageText(text), value = normalize(loginCustomerStatement(parts)).trim();
    if (!value.trim()) return [];
    const at = now().toISOString(), provenance = { kind: "qualified_rule" as const, ruleId: rule.ruleId, revision: rule.revision, at };
    // Some mail clients leave a new line of customer text after a sign-off. A sensitive
    // request there must still stop the case; quoted correspondence is historical.
    const sensitiveText = normalize([changedSubject, parts.currentText, parts.signatureText].join("\n")).replace(LOGIN_INFINITIVE, "");
    const sensitive = SENSITIVE.find(([, pattern]) => pattern.test(sensitiveText));
    if (sensitive) return requests.map(row => ({ requestId: row.requestId, family: sensitive[0], provenance }));
    const scopeText = value.replace(SENDER_ADDRESS, "").replace(INBOX_PROVIDER, "$1");
    if (savOutsidePersonalAccessScope(scopeText) || (changedSubject && savOutsidePersonalAccessScope(changedSubject))) return [];
    if (requests.length && requests.every(row => row.family === "access") && !THIRD_PARTY.test(scopeText) && readAccessStatement(scopeText).accounted)
      return requests.map(row => ({ requestId: row.requestId, family: "access" as const, provenance }));
    return [];
  };
}
