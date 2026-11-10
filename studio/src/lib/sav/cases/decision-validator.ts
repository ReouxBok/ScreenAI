import { loginCustomerStatement, reportsOngoingLoginFailure, reportsRestoredAccess } from "./restored-access";
import { splitSavMessageText } from "../message-context";
import { assessSavKnowledgeValidity, type SavRetrievalCandidate } from "../request-retrieval";
import {
  caseAdmissionRefusalCode, caseDecisionAttachmentMail, caseDecisionProposalSchema, caseDecisionRejectionLabels, caseDecisionSignalLabels, caseDecisionUnverifiedLabels,
  isSensitiveCaseFamily, SAV_CASE_ACCESS_URL, SAV_CASE_DECISION_CONTRACT_REVISION,
  type CaseDecisionKnowledgeRef, type CaseDecisionRejection, type CaseDecisionRejectionCode, type CaseDecisionSignal,
  type CaseDecisionSourceRef, type CaseDecisionUnverifiedJudgment, type CaseDecisionValidation,
  type CaseDecisionValidationContext, type CaseResolutionEvidence, type SavCaseSensitiveFamily,
} from "./decision-contract";
import { caseAccessSourceProblem } from "./investigation-access-scope";

/*
 * Pure and deterministic: no model, network, database, clock or effect. `now` is an argument.
 * Rejections cover structural invariants only; what free text means is listed as unverified, never claimed.
 */

const at = (value: string) => Date.parse(value);
const sourceKey = (ref: CaseDecisionSourceRef) => `${ref.type}:${ref.id}`;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`]/g, "'");
const squash = (value: string) => normalize(value).replace(/[«»“”"]/g, "").replace(/\s+/g, " ").trim();

/*
 * A login blockage as the customer tells it (review A09), never as a diagnosis: read on their own words (quoted history, signature and inline quotations set aside), latest mail first.
 * For each point the latest mail that speaks of it decides, with that mail as its source; a mail that says both is no proof. A doubt is no check. A bare reminder (« Toujours rien. »)
 * confirms nothing and hides nothing: the reading goes on through it. The problem's scope ends at a mail reporting the connection works. A mail on another subject stops the reading when
 * it is the latest thing said; older than a mail back on the login, it hides nothing. An unreadable mail or a person's reply after the last mail leaves nothing proven.
 * What WE advised is never read here: see `readLoginOutgoing`, on the case's own trials and questions.
 */
type LoginPoint = "link" | "address" | "spam";
type LoginThread = { complete: boolean; link: boolean | null; address: boolean | null; noCode: boolean | null; spam: boolean | null; screen: "told" | "attached" | "nothing" | null; displayed: string | null;
  /** `other`: the latest thing said is not about this login. */ scope: "login" | "other"; /** The latest mail is a bare reminder, with nothing new. */ bareReminder: boolean;
  /** Date of the mail that ended the previous problem: what we advised before it belongs to that problem. */ since: number; sources: Partial<Record<LoginPoint, CaseDecisionSourceRef>> };
const LOGIN_DOUBT = /\b(?:peut-etre|si|doute|pas sure?|pas certaine?|je ne sais pas|je crois|il me semble|vais|faut-il|dois-je)\b/;
const LOGIN_STATED = /\b(?:j'ai (?:bien |deja |aussi |meme )*(?:essaye|utilise|verifie|ouvert|saisi|renseigne|entre|tape)|je suis (?:bien |deja )*passee? par)\b/;
const LOGIN_TOPIC = /\b(?:code|connexion|connecter|connecte|lien|adresse|e-?mail|mail|spams?|indesirables?|erreur|message|ecran|affiche|identifiant|introuvable|bloquee?)\b/;
const LOGIN_WORKS = /\b(?:je suis (?:bien )?connectee?|j'ai (?:pu|reussi a) me connecter|ca (?:re)?(?:marche|fonctionne)(?! pas| plus| toujours)|c'est (?:bon|regle|resolu)|probleme (?:est )?resolu)\b/;
// The same word `connecter` about another service is another subject, as the login card itself says; a code or an address in the sentence keeps it on the login.
const LOGIN_OTHER_SERVICE = /\b(?:connecter|relier|brancher|lier|integrer|synchroniser|connexion|integration)\b[^.!?\n]{0,40}\b(?:gmail|outlook|google|hubspot|calendrier|agenda|whatsapp|telephon\w*|linkedin|instagram|facebook)\b/;
const LOGIN_REMINDER = /\b(?:toujours (?:rien|pas|bloquee?|le meme|la meme|aucun\w*)|rien (?:de (?:nouveau|plus)|recu|ne (?:change|marche|fonctionne|se passe))|ne (?:marche|fonctionne) (?:toujours |plus )?pas|(?:meme|la meme) (?:chose|probleme)|aucun changement|pas mieux)\b/;
const LOGIN_NEW_ASK = /\b(?:comment|ajouter|changer|supprimer|modifier|creer|installer|configurer)\b/;
// The address was NOT the customer's own: refused, denied or withdrawn, in this mail or a later one. Someone else's address is not « mon adresse », even called « d'inscription ».
const LOGIN_ADDRESS_NOT_OWN = /\b(?:mauvaise adresse|autre adresse|trompee? d'adresse|pas (?:(?:avec|sur|utilise|saisi|renseigne|entre|la|ma|mon|une|cette|bonne|bien|vraiment) ){0,3}(?:l')?adresse|celle (?:de (?:mon|ma|notre|son|sa|leur)|du|d'une?) |(?:adresse|e-?mail|mail)(?: d'inscription| e-?mail| mail)? (?:de (?:mon|ma|notre|son|sa|leur)|du|de la|d'une?) (?!inscription\b|compte\b|espace\b|boite\b|messagerie\b)\S)/;
const LOGIN_QUESTION_KEY = "login_error_message", LOGIN_PATH_KEY = "login_path_checked", LOGIN_SPAM_KEY = "login_spam_checked";
const QUOTED = /[«"“][^»"”]*[»"”]/g;
/** The customer's own new words of a stored mail: never what they quote from us or from earlier mails. Review Q1 (8/11): read like the latest mail, a proven
 * signature (courtesy, name, phone, address, footer) set aside and anything else kept, so the history and the closure read the same words. */
const ownCustomerWords = (raw: string) => normalize(loginCustomerStatement(splitSavMessageText(raw)));
// Q3 (9/11): the customer says a screenshot is attached. The agent cannot read an image: the screen is reported as attached, never as words it saw.
const SCREENSHOT = /\b(?:captures? d'ecran|copies? d'ecran|screenshots?|photos? de l'ecran|captures?)\b/;
const ATTACHED = /\b(?:ci-jointe?s?|en pieces? jointes?|jointe?s?|attachee?s?|voici|je vous (?:envoie|transmets|joins))\b/;
// Contre-recette Q3-4/5/6 (9/11): a dot inside a web address (« le bon lien new.limova.ai et la bonne adresse ») does not end the sentence, or the address
// confirmed in the same sentence was lost and the step already done was given again.
const sentencesOf = (text: string) => text.split(/[!?;\n]+|\.+(?![a-z0-9])/).map(sentence => sentence.trim()).filter(Boolean);
/** The yes and no of one mail on one point: any `no` wins over a `yes` (a contradiction proves nothing), silence is null. */
const saidInMail = (sentences: readonly string[], yes: (sentence: string) => boolean, no: (sentence: string) => boolean): boolean | null =>
  sentences.some(no) ? false : sentences.some(yes) ? true : null;
function screenInMail(sentences: readonly string[]): { screen: "told" | "attached" | "nothing" | "conflict" | null; displayed: string | null } {
  let told = false, nothing = false, attached = false, displayed: string | null = null;
  for (const sentence of sentences) {
    if (LOGIN_DOUBT.test(sentence) || /\b(?:quel|quelle|quels|quelles|est-ce que)\b/.test(sentence)) continue;
    if (SCREENSHOT.test(sentence) && ATTACHED.test(sentence) && !/\b(?:pas|aucune?|sans)\b[^.!?\n]{0,30}\b(?:captures?|copies?|screenshots?|photos?)\b/.test(sentence)) { attached = true; continue; }
    if (/\b(?:aucune? (?:message|erreur)|pas (?:de |d')(?:message|erreur)|sans (?:message|erreur)|rien ne s'affiche|n'affiche rien|rien a l'ecran)\b/.test(sentence)) { nothing = true; continue; }
    if (!/\b(?:erreur|message|ecran|page|affiche|indique)\b/.test(sentence)) continue;
    // A concrete wording only: « j'ai une erreur » says nothing of what is displayed, so the question stays useful.
    const wording = /[«"“]\s*([^»"”]{2,200}?)\s*[»"”]/.exec(sentence)?.[1] ?? /\b(?:erreur|message)\s*:\s*(\S.{1,199})/.exec(sentence)?.[1]
      ?? /\b(?:affiche|indique)\s+(?:l'erreur |le message |que )?(\S.{1,199})/.exec(sentence)?.[1];
    if (!wording || /^(?:(?:une?|des|l'|le|la) ?)?(?:erreur|message|ecran|page)(?: d'erreur)?\s*$/.test(wording.trim())) continue;
    told = true;
    // Never carries what may be a code: the fact is kept, not the wording.
    displayed ??= /\d{4,}/.test(wording) ? null : wording.trim();
  }
  return { screen: told && nothing ? "conflict" : told ? "told" : attached ? "attached" : nothing ? "nothing" : null, displayed };
}
function readLoginThread(context: CaseDecisionValidationContext, askedAlready: boolean): LoginThread {
  const thread: LoginThread = { complete: true, link: null, address: null, noCode: null, spam: null, screen: null, displayed: null, scope: "login", bareReminder: false, since: -Infinity, sources: {} };
  const none = { ...thread, complete: false };
  const inbound = context.sources.filter(row => row.direction === "customer_inbound" && row.ref.type === "email").sort((a, b) => b.order - a.order);
  if (!inbound.length || context.sources.some(row => row.direction === "human_outbound" && row.order > inbound[0]!.order)) return none;
  let screenRead = false, backOnLogin = false;
  const keep = (point: LoginPoint, said: boolean | null, source: CaseDecisionSourceRef) => {
    if (thread[point] !== null || said === null) return;
    thread[point] = said;
    if (said) thread.sources[point] = source;
  };
  for (const row of inbound) {
    const latest = row === inbound[0];
    const raw = context.customerTexts[sourceKey(row.ref)];
    if (!raw) return none;
    const own = ownCustomerWords(raw), stated = own.replace(QUOTED, " ");
    if (LOGIN_WORKS.test(stated) || reportsRestoredAccess(own)) {
      if (latest) return none;
      thread.since = at(row.at);
      return thread;
    }
    const otherService = sentencesOf(stated).some(s => LOGIN_OTHER_SERVICE.test(s) && !/\b(?:code|adresse)\b/.test(s));
    const reminder = !otherService && !LOGIN_TOPIC.test(stated) && !/[«"“]/.test(own) && !LOGIN_NEW_ASK.test(stated) && stated.split(/\s+/).length <= 15 && (!stated.trim() || LOGIN_REMINDER.test(stated));
    if (reminder) { if (latest) thread.bareReminder = true; continue; }
    if (otherService || (!LOGIN_TOPIC.test(own) && !/[«"“]/.test(own) && !askedAlready)) {
      if (backOnLogin) continue;
      thread.scope = "other"; thread.since = at(row.at);
      return thread;
    }
    backOnLogin = true;
    const sentences = sentencesOf(stated);
    const doubted = (mention: RegExp) => (sentence: string) => mention.test(sentence) && LOGIN_DOUBT.test(sentence);
    keep("link", saidInMail(sentences, s => LOGIN_STATED.test(s) && /\b(?:bon lien|lien officiel)\b/.test(s),
      s => /\b(?:mauvais lien|autre lien|trompee? de lien|pas (?:\w+ )?le bon lien)\b/.test(s) || doubted(/\blien\b/)(s)), row.ref);
    keep("address", saidInMail(sentences, s => LOGIN_STATED.test(s) && /\b(?:bonne adresse|bon (?:e-?mail|mail)|adresse d'inscription)\b/.test(s),
      s => LOGIN_ADDRESS_NOT_OWN.test(s) || doubted(/\badresse\b/)(s)), row.ref);
    const noCode = (s: string) => !LOGIN_DOUBT.test(s) && /\b(?:aucun code|pas (?:de|le|mon) code|pas recu (?:de |le |mon )?code|rien recu)\b/.test(s);
    thread.noCode ??= saidInMail(sentences, noCode, s => !noCode(s) && /\b(?:j'ai (?:bien )?recu (?:le|un|mon) code|code (?:est )?(?:recu|refuse|expire|invalide|incorrect))\b/.test(s));
    keep("spam", saidInMail(sentences, s => !LOGIN_DOUBT.test(s)
      && (/\b(?:j'ai|nous avons|on a) (?:\w+ ){0,3}(?:verifie|regarde|fouille|consulte|cherche)\b.*\b(?:spams?|courriers? indesirables?|indesirables)\b/.test(s)
        || /\b(?:rien|pas|aucun code|toujours rien) (?:non plus )?(?:dans|parmi) (?:les|mes|le dossier(?: des)?) ?(?:spams?|courriers? indesirables?|indesirables)\b/.test(s)),
      s => /\b(?:je n'ai pas|pas encore) (?:\w+ ){0,2}(?:verifie|regarde)\b.*\b(?:spams?|indesirables?)\b/.test(s)), row.ref);
    if (!screenRead) {
      const seen = screenInMail(sentencesOf(own));
      if (seen.screen) {
        screenRead = true;
        if (seen.screen !== "conflict") { thread.screen = seen.screen; thread.displayed = seen.displayed; }
      }
    }
  }
  return thread;
}

/** Login evidence shared by the response composer and the model, with the same chronology and quotation rules. */
function loginScreenAsked(context: CaseDecisionValidationContext) {
  return context.questions.some(question => question.factKeys.includes(LOGIN_QUESTION_KEY)
    && context.sources.some(source => source.direction === "customer_inbound" && at(source.at) > at(question.askedAt)));
}

/** Only closed, customer-reported signals go on the model wire. Displayed text may contain a secret. */
function latestLoginMail(context: CaseDecisionValidationContext) {
  const latest = context.sources.filter(row => row.direction === "customer_inbound").sort((a, b) => b.order - a.order)[0];
  if (!latest || latest.ref.type !== "email" || context.sources.some(row => row.direction === "human_outbound" && row.order > latest.order)) return null;
  const raw = context.customerTexts[sourceKey(latest.ref)];
  if (!raw || raw.length > 100_000) return null;
  const parts = splitSavMessageText(raw);
  return { source: latest.ref, quote: loginCustomerStatement(parts) };
}
export function caseModelLoginHistory(context: CaseDecisionValidationContext) {
  const open = context.requests.filter(request => request.status === "open");
  if (context.sensitiveCategories.length || !open.length || open.some(request => request.family !== "access")) return null;
  const latest = latestLoginMail(context);
  if (latest && reportsRestoredAccess(latest.quote)) return { restoredAccessReported: latest };
  const thread = readLoginThread(context, loginScreenAsked(context));
  const stillBlocked = latest && reportsOngoingLoginFailure(normalize(latest.quote)) ? { stillBlockedReported: { source: latest.source } } : null;
  if (!thread.complete || thread.scope !== "login") return stillBlocked;
  return {
    ...stillBlocked,
    correctLinkReported: thread.link === true, ownAddressReported: thread.address === true,
    missingCodeReported: thread.noCode === true, spamCheckedReported: thread.spam === true,
    screenReport: thread.screen, latestIsReminder: thread.bareReminder,
  };
}

/**
 * What the agent has already put to the customer on this login, in this problem's scope, read on the case's own records (the trials of a sent answer, the questions of a sent reply),
 * never on the customer's words: advised is not done. The spam folder only counts on a sent version that says it.
 */
function readLoginOutgoing(context: CaseDecisionValidationContext, ref: CaseDecisionKnowledgeRef, sentVersionAdvisesSpam: boolean, since: number) {
  const after = (date: string) => at(date) > since;
  const trials = context.trials.filter(trial => trial.knowledge.knowledgeId === ref.knowledgeId && after(trial.askedAt));
  // A question counts once a customer mail came after it: until then it is only pending.
  const lastMail = Math.max(-Infinity, ...context.sources.filter(row => row.direction === "customer_inbound").map(row => at(row.at)));
  const asked = (key: string) => context.questions.some(question => question.factKeys.includes(key) && after(question.askedAt) && lastMail > at(question.askedAt));
  const pathAsked = asked(LOGIN_PATH_KEY), spamAsked = asked(LOGIN_SPAM_KEY);
  return { pathAsked, spamAsked, screenAsked: asked(LOGIN_QUESTION_KEY), pathGiven: trials.length > 0 || pathAsked,
    spamGiven: spamAsked || (sentVersionAdvisesSpam && trials.some(trial => trial.knowledge.contentVersionId === ref.contentVersionId)) };
}

/** The card's own step for one check, its official host written as the link, or null when the version has no such step. */
function loginCardStep(card: CaseDecisionValidationContext["knowledge"][number] | undefined, kind: LoginPoint): string | null {
  const listed: unknown = card?.resolution?.steps;
  const steps = Array.isArray(listed) ? listed.filter((step): step is string => typeof step === "string" && step.trim().length > 0 && step.length <= 400) : [];
  const spam = (step: string) => /\bspams?\b|\bindesirables?\b/.test(normalize(step)), host = (step: string) => normalize(step).includes(ACCESS_HOST);
  const found = kind === "spam" ? steps.find(spam) : kind === "link" ? steps.find(host) : steps.find(step => /\badresse\b/.test(normalize(step)) && !spam(step) && !host(step));
  return found?.trim().replace(new RegExp(String.raw`(?<![\w./@-])${ACCESS_HOST.replaceAll(".", "\\.")}(?=$|[\s.,;!?])`, "g"), SAV_CASE_ACCESS_URL) ?? null;
}

/*
 * Any card (SAV pilot, second subject included): a procedure already sent, or a step the customer states they did, is not given again as an instruction. Read on the version's own steps, with
 * the customer's own words, never a subject's vocabulary; narrow on purpose (a reworded step can pass, see `reply_semantics`), it refuses for correction and never rewrites.
 */
const STEP_NOISE = new Set(["dans", "avec", "pour", "votre", "cette", "vous", "puis", "depuis", "sur", "les", "des", "une", "que", "qui", "sans", "tout", "bien", "aussi", "alors", "limova"]);
const stepOf = (step: string) => {
  const words = normalize(sentencesOf(step)[0] ?? "").match(/[a-z0-9-]{4,}/g) ?? [];
  return { verb: (words[0] ?? "").slice(0, 4), object: [...new Set(words.slice(1))].filter(word => !STEP_NOISE.has(word)) };
};
const overlap = (object: readonly string[], sentence: string) => object.length ? object.filter(word => sentence.includes(word)).length / object.length : 0;
function repeatedSteps(reply: string, card: SavRetrievalCandidate, context: CaseDecisionValidationContext): number[] {
  const steps = strings(card.resolution?.steps).map(stepOf), lastMail = Math.max(-Infinity, ...context.sources.filter(row => row.direction === "customer_inbound").map(row => at(row.at)));
  const instructed = sentencesOf(normalize(reply)).filter(sentence => !/^(?:vous avez|merci|comme vous)\b/.test(sentence));
  const restated = steps.flatMap((step, index) => step.object.length >= 2 && step.verb && instructed.some(sentence => sentence.includes(step.verb) && overlap(step.object, sentence) >= 0.7) ? [index] : []);
  if (!restated.length) return [];
  const sent = context.trials.some(trial => trial.knowledge.knowledgeId === card.id && at(trial.askedAt) < lastMail);
  if (sent && restated.length >= Math.ceil(steps.length / 2)) return restated;
  const customer = context.sources.filter(row => row.direction === "customer_inbound").sort((a, b) => b.order - a.order);
  const done = new Map<number, boolean>();
  for (const row of customer) {
    const raw = context.customerTexts[sourceKey(row.ref)];
    if (!raw) break;
    const own = ownCustomerWords(raw);
    const stated = sentencesOf(own.replace(QUOTED, " "));
    if (reportsRestoredAccess(own) || stated.some(sentence => LOGIN_WORKS.test(sentence))) break;
    steps.forEach((step, index) => {
      if (done.has(index) || step.object.length < 2) return;
      const said = stated.filter(sentence => overlap(step.object, sentence) >= 0.6);
      if (said.length) done.set(index, said.every(sentence => LOGIN_STATED.test(sentence) && !LOGIN_DOUBT.test(sentence)));
    });
  }
  return restated.filter(index => done.get(index) === true);
}

// What the authorized card version itself says (its content and procedure steps), never what a template would like it to say:
// the login-code template only quotes the official link and the spam folder advice when that very version carries them.
function cardVersionSays(card: CaseDecisionValidationContext["knowledge"][number] | undefined) {
  const listed: unknown = card?.resolution?.steps;
  const steps = Array.isArray(listed) ? listed.filter((step): step is string => typeof step === "string") : [];
  const text = card ? normalize([card.content, ...steps].join("\n")) : "";
  // The exact host, not a prefix of another one (`new.limova.ai.other`) nor a look-alike (`new.limova.io`).
  return { officialLink: card !== undefined && new RegExp(String.raw`(?<![\w.@-])${ACCESS_HOST.replaceAll(".", "\\.")}(?![\w-]|\.[\w-])`).test(text),
    spamFolder: /\bspams?\b|\bcourriers? indesirables?\b/.test(text),
    // The version's own next step once the customer's checks are done: a relay it does not state is never assumed.
    relay: typeof card?.resolution?.escalation === "string" && /\b(?:transmettre|transferer|escalader|remonter)\b.*\b(?:equipe|support|humain)\b/.test(normalize(card.resolution.escalation)) };
}

// Narrow, non-exhaustive tripwire on the agent's own outgoing text: a request addressed to the customer whose object is a secret.
// It never reads customer messages. A miss is possible; the declared `credential` seek kind is the structural rule.
const SECRET = String.raw`(?:mots? de passe|mdp|password|passcode|identifiants? de connexion|codes? (?:de |d')?(?:verification|confirmation|securite|validation|connexion|acces|activation|authentification)|codes? (?:recus?|envoyes?|sms|otp|2fa|temporaires?|a usage unique|a \d+ chiffres)|otp|jetons?(?: d'acces)?|tokens?|cles? (?:api|secretes?|d'api)|api keys?)`;
const DET = String.raw`(?:(?:votre|vos|le|la|les|ce|cet|cette|ces|ton|ta|tes|un|une|des|du) |l')?(?:nouveau |nouvel |dernier )?`;
const INF = "(?:envoyer|renvoyer|transmettre|communiquer|donner|indiquer|partager|fournir|ecrire|preciser|copier|coller)";
const IMP = "(?:envoyez|renvoyez|transmettez|communiquez|donnez|indiquez|partagez|fournissez|ecrivez|precisez|copiez|collez)";
// English too (night 29→30/10), for a reply to an English-speaking customer. A negation before the verb ("never send",
// "do not share") is a warning, not a request, and entering a code on our own page is not a request to us.
const SECRET_EN = String.raw`(?:passwords?|passcodes?|pin(?: codes?)?|(?:verification|confirmation|security|login|sign-in|one-time|2fa|two-factor|sms|otp|authentication|access|activation|reset) codes?|(?:\d+|six)-digit codes?|codes? (?:you (?:received|got)|received|sent to you|by (?:sms|text|e-?mail))|otps?|(?:access |api |auth )?tokens?|api keys?|secret keys?|credentials|login details)`;
const DET_EN = String.raw`(?:(?:your|the|this|that|a|an|any) )?(?:new |latest |current |temporary )?`;
const credentialPatterns = [
  new RegExp(String.raw`(?:pouvez-vous|pourriez-vous|merci de|veuillez|vous pouvez|peux-tu|pourrais-tu|je vous invite a)(?: nous| me)? ${INF}(?: nous| moi)? ${DET}${SECRET}\b`),
  new RegExp(String.raw`(?<!(?:\bne |\bn')(?:nous |me )?)\b${IMP}(?:-nous|-moi)? ${DET}${SECRET}\b`),
  new RegExp(String.raw`(?<!\b(?:never|not|don't|dont|no need to) )\b(?:send|resend|share|give|provide|tell|forward|email|reply with|paste|communicate|disclose)(?: (?:it|them))?(?: (?:to )?(?:us|me))? ${DET_EN}${SECRET_EN}\b`),
];
export const requestsCredential = (text: string) => credentialPatterns.some(pattern => pattern.test(normalize(text)));

// Access path (review B 28/10): a link is read by the URL parser, never by a prefix, so `new.limova.ai.other.host` or
// `new.limova.ai@other.host` is not the canonical one. Only https, the exact host, no user info, no port, and no query or
// fragment (a redirect could hide there) count; any other link in an access reply, and any bare name of the brand other
// than the host itself or a limova.ai address (`limova.com`, `app.limova.fr`, full-width letters...), is invalid.
// Sentence punctuation around a link is set aside for the check only: the text is never rewritten.
const ACCESS_HOST = new URL(SAV_CASE_ACCESS_URL).hostname;
const LINK = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const WRAP_START = /^[([{<«"'“‘]+/, WRAP_END = /[)\]}>»"'”’.,;:!?…]+$/;
const LIMOVA_ADDRESS = /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*limova\.ai$/i;
const unwrap = (token: string) => token.replace(WRAP_START, "").replace(WRAP_END, "");
function canonicalAccessLink(link: string) {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === ACCESS_HOST && url.username === "" && url.password === "" && url.port === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  } catch { return false; }
}
function accessLinks(text: string) {
  // A Markdown autolabel can show exactly the same official address twice.
  // Only collapse this exact pair; other labels and destinations remain subject to both checks.
  text = text.replaceAll(`[${ACCESS_HOST}](${SAV_CASE_ACCESS_URL})`, SAV_CASE_ACCESS_URL);
  let present = false; const invalid: string[] = [];
  for (const match of text.matchAll(LINK)) {
    const link = unwrap(match[0]);
    if (canonicalAccessLink(link)) present = true;
    else invalid.push(link);
  }
  for (const word of text.replace(LINK, " ").split(/\s+/)) {
    const token = unwrap(word);
    if (/limova[a-z0-9-]*\.[a-z]/i.test(token.normalize("NFKC")) && !LIMOVA_ADDRESS.test(token) && token.toLowerCase() !== ACCESS_HOST) invalid.push(token);
  }
  return { present, invalid };
}
const IMPOSSIBILITY_WORDING = /\b(?:impossible|pas possible|ne permet pas|ne peut pas|n'est pas (?:disponible|prevue?|prise? en charge))\b/;
const ACCOUNT_WORDING = /\b(?:nouve(?:au|l) (?:compte|abonnement)|souscri\w*|creer un (?:autre |second |nouveau )?compte)\b/;

function contextProblem(context: CaseDecisionValidationContext, now: Date) {
  if (!Number.isFinite(now.getTime())) return "now";
  if (!Number.isInteger(context.caseVersion) || context.caseVersion < 0) return "caseVersion";
  if (context.admission && typeof context.admission.admitted !== "boolean") return "admission";
  const unique = (values: string[]) => new Set(values).size === values.length;
  const groups: Array<[string, string[]]> = [
    ["requests", context.requests.map(row => row.id)], ["facts", context.facts.map(row => row.id)],
    ["questions", context.questions.map(row => row.id)], ["trials", context.trials.map(row => row.id)],
    ["knowledge", context.knowledge.map(row => row.id)], ["sources", context.sources.map(row => sourceKey(row.ref))],
  ];
  for (const [name, values] of groups) if (!unique(values)) return `${name}.duplicate`;
  const dates = [...context.sources.map(row => row.at), ...context.facts.map(row => row.at), ...context.questions.map(row => row.askedAt),
    ...context.trials.flatMap(row => [row.askedAt, ...(row.resultAt ? [row.resultAt] : [])]), ...context.handoffs.map(row => row.at)];
  if (dates.some(value => !Number.isFinite(at(value)))) return "date";
  const order = (value: number | null) => value === null || (Number.isInteger(value) && value >= 0);
  if (!context.sources.every(row => row.order !== null && order(row.order)) || !context.handoffs.every(row => order(row.order))) return "order";
  if (!unique(context.sources.map(row => String(row.order)))) return "order.duplicate";
  const requestIds = new Set(context.requests.map(row => row.id));
  if (context.trials.some(row => !requestIds.has(row.requestId))) return "trials.requestId";
  return null;
}

export const validateCaseDecision = (input: unknown, context: CaseDecisionValidationContext, now: Date): CaseDecisionValidation => validate(input, context, now, false);

/** `composed`: the proposal is this validator's own next step on the login, checked like any other but not composed again. */
function validate(input: unknown, context: CaseDecisionValidationContext, now: Date, composed: boolean): CaseDecisionValidation {
  const rejections: CaseDecisionRejection[] = [];
  const unverified = new Set<CaseDecisionUnverifiedJudgment>(["request_classification"]);
  const signals = new Set<CaseDecisionSignal>();
  const reject = (code: CaseDecisionRejectionCode, path: string, detail?: string) => {
    if (!rejections.some(row => row.code === code && row.path === path && row.detail === detail))
      rejections.push({ code, label: caseDecisionRejectionLabels[code], path, ...(detail === undefined ? {} : { detail }) });
  };
  const ordered = <K extends string>(set: Set<K>, labels: Record<K, string>) => (Object.keys(labels) as K[]).filter(key => set.has(key));
  const needsReview = (): CaseDecisionValidation => ({ outcome: "needs_review", contractRevision: SAV_CASE_DECISION_CONTRACT_REVISION,
    rejections, unverified: ordered(unverified, caseDecisionUnverifiedLabels), signals: ordered(signals, caseDecisionSignalLabels) });

  const problem = contextProblem(context, now);
  if (problem) { reject("context_invalid", "context", problem); return needsReview(); }
  const parsed = caseDecisionProposalSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 10)) reject("proposal_schema_invalid", issue.path.join("."), issue.code);
    return needsReview();
  }
  const proposal = parsed.data, action = proposal.nextAction;

  if (proposal.caseVersion !== context.caseVersion) reject("case_version_stale", "caseVersion", `${proposal.caseVersion}<>${context.caseVersion}`);
  if (context.owner !== "agent" && action.kind !== "observe_only") reject("case_not_agent_owned", "nextAction.kind", context.owner);
  // Owning the case is not enough: an agent action also needs a positive admission for this very version.
  if (action.kind !== "observe_only") {
    const refused = caseAdmissionRefusalCode(context.admission);
    if (refused) reject(refused, "nextAction.kind", context.admission?.admitted === false ? context.admission.reason : undefined);
  }
  if (action.kind === "observe_only" && proposal.reply) reject("observe_only_with_reply", "reply");

  const sources = new Map(context.sources.map(row => [sourceKey(row.ref), row]));
  const knownSource = (ref: CaseDecisionSourceRef) => {
    const row = sources.get(sourceKey(ref));
    return row && (ref.revision === undefined || row.ref.revision === undefined || row.ref.revision === ref.revision) ? row : null;
  };

  // Facts: every new fact has a known source; a customer's email or one of its attachments is a statement, not an
  // observation (Q8, pole A v7 refuses it at write time too). An attachment `<mail>:<part>` belongs to its mail.
  const fromCustomer = (ref: CaseDecisionSourceRef, direction: string) => {
    if (ref.type !== "email" && ref.type !== "attachment") return false;
    if (direction === "customer_inbound") return true;
    const mail = caseDecisionAttachmentMail(ref);
    return mail !== undefined && sources.get(sourceKey({ type: "email", id: mail }))?.direction === "customer_inbound";
  };
  const newFactTimes = new Map<string, number>();
  proposal.understanding.newFacts.forEach((fact, index) => {
    const source = knownSource(fact.source), path = `understanding.newFacts.${index}`;
    if (!source) return reject("source_reference_unknown", `${path}.source`);
    newFactTimes.set(fact.id, at(source.at));
    if (fact.kind === "observed" && fromCustomer(fact.source, source.direction)) reject("customer_statement_as_observed", `${path}.kind`);
  });

  // Requests: none dropped, none duplicated, sensitive ones never downgraded, resolution only with evidence.
  const contextRequests = new Map(context.requests.map(row => [row.id, row]));
  const status = new Map<string, "open" | "resolved" | "handed_off">(context.requests.map(row => [row.id, row.status]));
  const families = new Map(context.requests.map(row => [row.id, row.family]));
  const seen = new Set<string>();
  proposal.understanding.requests.forEach((request, index) => {
    const path = `understanding.requests.${index}`, previous = contextRequests.get(request.id);
    if (seen.has(request.id)) reject("request_duplicate", `${path}.id`);
    seen.add(request.id);
    if (previous && isSensitiveCaseFamily(previous.family) && request.family !== previous.family) reject("sensitive_request_downgraded", `${path}.family`, previous.family);
    if (request.status === "resolved" && (!previous || previous.status === "open")) {
      if (!request.resolvedBy) reject("request_resolved_without_evidence", `${path}.resolvedBy`);
      else checkEvidence(request.id, request.resolvedBy, `${path}.resolvedBy`);
    }
    status.set(request.id, request.status);
    if (!families.has(request.id) || !isSensitiveCaseFamily(families.get(request.id)!)) families.set(request.id, request.family);
  });
  for (const request of context.requests) if (request.status === "open" && !seen.has(request.id)) reject("open_request_omitted", "understanding.requests", request.id);
  const requireOpenRequest = (requestId: string, path: string) => {
    // The case's own status wins: a proposal cannot reopen a request the case handed off or resolved.
    const recorded = context.requests.find(row => row.id === requestId)?.status;
    if (!status.has(requestId)) reject("request_reference_unknown", path);
    else if (recorded !== undefined && recorded !== "open") reject("request_not_open", path, recorded);
    else if (status.get(requestId) !== "open") reject("request_not_open", path, status.get(requestId));
  };
  // Pilot ACCÈS (ROOT 3/11): `access` is the only admissible family; a proposal may name a sensitive family (then only a
  // handoff is allowed), never another ordinary one, which would leave the pilot's scope.
  if (context.accessScope !== undefined) proposal.understanding.requests.forEach((request, index) => {
    if (request.family !== "access" && !isSensitiveCaseFamily(request.family)) reject("pilot_family_out_of_scope", `understanding.requests.${index}.family`, request.family);
  });

  const sensitive = new Set<SavCaseSensitiveFamily>(context.sensitiveCategories);
  for (const family of [...families.values(), ...proposal.understanding.requests.map(row => row.family)]) if (isSensitiveCaseFamily(family)) sensitive.add(family);
  if (sensitive.size && (action.kind === "ask" || action.kind === "answer" || action.kind === "confirm_resolution"))
    reject("sensitive_requires_human", "nextAction.kind", [...sensitive].sort().join(","));

  // Knowledge: known, same revision, valid now (existing SAV72 rule), not superseded, not contradicted.
  const eligible = context.knowledge.filter(card => assessSavKnowledgeValidity(card, context.locale, context.audience, now).eligible);
  const conflicts = (a: SavRetrievalCandidate, b: SavRetrievalCandidate) =>
    a.id !== b.id && (strings(a.resolution?.conflictsWith).includes(b.id) || strings(b.resolution?.conflictsWith).includes(a.id));
  const knowledgeProblem = (ref: CaseDecisionKnowledgeRef): { code: CaseDecisionRejectionCode; detail?: string } | null => {
    const card = context.knowledge.find(row => row.id === ref.knowledgeId);
    if (!card) return { code: "knowledge_reference_unknown" };
    if (card.contentVersionId !== ref.contentVersionId) return { code: "knowledge_revision_mismatch" };
    const validity = assessSavKnowledgeValidity(card, context.locale, context.audience, now);
    if (!validity.eligible) return { code: "knowledge_not_valid", detail: validity.reason };
    const successor = eligible.find(row => row.id !== card.id && strings(row.resolution?.supersedes).includes(card.id));
    if (successor) return { code: "knowledge_superseded", detail: successor.id };
    return null;
  };
  // Per-request retrieval (when given): a card supports only the requests it was retrieved for, as in intake
  // (`assertSavRequestCandidateLinks`). A valid card cited for another request is refused with its own code.
  const requireLink = (ref: CaseDecisionKnowledgeRef, requestIds: readonly string[], path: string) => {
    if (!context.coverage || knowledgeProblem(ref)) return;
    const linked = context.coverage.some(row => requestIds.includes(row.requestId)
      && row.knowledge.some(card => card.knowledgeId === ref.knowledgeId && card.contentVersionId === ref.contentVersionId));
    if (!linked) reject("knowledge_not_linked_to_request", path, ref.knowledgeId);
  };
  // Pilot ACCÈS: in the pilot every source shown to the customer (answer step, reply citation, impossibility) must be listed
  // by the approved scope for answers, at that version, whatever family a request is given; a handoff report, read by the
  // team only, is not limited.
  const pilot = context.accessScope !== undefined;
  const requireInScope = (ref: CaseDecisionKnowledgeRef, path: string) => {
    const problem = caseAccessSourceProblem(context.accessScope ?? null, ref);
    if (problem) reject(problem, path, ref.knowledgeId);
  };
  const cited: SavRetrievalCandidate[] = [];
  const citeKnowledge = (ref: CaseDecisionKnowledgeRef, path: string) => {
    const issue = knowledgeProblem(ref);
    if (issue) return reject(issue.code, path, issue.detail);
    cited.push(context.knowledge.find(row => row.id === ref.knowledgeId)!);
  };

  function checkEvidence(requestId: string, evidence: CaseResolutionEvidence, path: string) {
    const source = knownSource(evidence.source);
    if (!source) return reject("source_reference_unknown", `${path}.source`);
    if (source.direction !== "customer_inbound") return reject("resolution_evidence_invalid", path, "source_not_customer");
    // Word for word only (case, accents, quotes and spacing ignored): it proves the words exist, never what they mean.
    const message = context.customerTexts[sourceKey(source.ref)];
    if (message === undefined) return reject("resolution_quote_unverifiable", `${path}.quote`);
    if (!squash(message).includes(squash(evidence.quote))) return reject("resolution_quote_not_found", `${path}.quote`);
    if (context.requests.some(request => request.id === requestId && request.family === "access")) {
      const latest = latestLoginMail(context);
      if (!latest || sourceKey(latest.source) !== sourceKey(source.ref) || !reportsRestoredAccess(latest.quote)
        || !reportsRestoredAccess(evidence.quote) || !squash(latest.quote).includes(squash(evidence.quote)))
        return reject("resolution_evidence_invalid", path, "latest_customer_login_not_confirmed");
    }
    // Messages and human replies are ordered by arrival in our store, not by their clocks. A handoff known only
    // by its date counts as an intervention unless its date is strictly after the evidence (ambiguous => no closure).
    const answeredAt = at(source.at), answeredOrder = source.order;
    const humanBefore = (after: (row: { at: string }) => boolean) =>
      context.handoffs.some(row => after(row) && (row.order === null ? at(row.at) <= answeredAt : row.order < answeredOrder))
      || context.sources.some(row => row.direction === "human_outbound" && after(row) && row.order < answeredOrder);
    if (evidence.trialId === null) {
      // Spontaneous resolution: the opening message cannot be its own resolution, and any human involvement may explain it.
      const first = Math.min(...context.sources.filter(row => row.direction === "customer_inbound").map(row => row.order));
      if (answeredOrder <= first) return reject("resolution_evidence_invalid", path, "evidence_is_initial_message");
      if (humanBefore(() => true)) return reject("resolution_evidence_invalid", path, "human_intervened_before_evidence");
      unverified.add("resolution_semantics");
      return;
    }
    const trial = context.trials.find(row => row.id === evidence.trialId);
    if (!trial || trial.requestId !== requestId) return reject("resolution_evidence_invalid", path, "trial_unknown");
    const asked = at(trial.askedAt);
    if (answeredAt <= asked) return reject("resolution_evidence_invalid", path, "evidence_before_trial");
    if (trial.outcome === "failed" && trial.resultAt && at(trial.resultAt) >= answeredAt) return reject("resolution_evidence_invalid", path, "trial_failed");
    // A thanks that follows a transfer or a human reply may be about that intervention, not about the step.
    if (humanBefore(row => at(row.at) > asked)) return reject("resolution_evidence_invalid", path, "human_intervened_after_trial");
    unverified.add("resolution_semantics");
  }

  if (action.kind === "ask") {
    unverified.add("question_overlap_semantics");
    action.questions.forEach((question, index) => {
      const path = `nextAction.questions.${index}`;
      requireOpenRequest(question.requestId, `${path}.requestId`);
      if (requestsCredential(question.text)) reject("credential_request_pattern", `${path}.text`);
      question.seeks.forEach((seek, seekIndex) => {
        const seekPath = `${path}.seeks.${seekIndex}`;
        if (seek.kind === "credential") reject("credential_requested", `${seekPath}.kind`);
        if (!seek.factKey) return;
        const key = seek.factKey;
        if (context.facts.some(fact => fact.key === key) || proposal.understanding.newFacts.some(fact => fact.key === key)) return reject("question_already_answered", `${seekPath}.factKey`, key);
        const pending = context.questions.find(row => row.answeredBy === null && row.factKeys.includes(key)
          && !context.sources.some(source => source.direction === "customer_inbound" && at(source.at) > at(row.askedAt)));
        if (pending) reject("question_already_pending", `${seekPath}.factKey`, pending.id);
      });
    });
  }

  if (action.kind === "answer") {
    unverified.add("answer_relevance");
    action.requestIds.forEach((requestId, index) => requireOpenRequest(requestId, `nextAction.requestIds.${index}`));
    action.steps.forEach((step, index) => {
      const path = `nextAction.steps.${index}`;
      citeKnowledge(step.knowledge, `${path}.knowledge`);
      requireLink(step.knowledge, action.requestIds, `${path}.knowledge`);
      if (pilot) requireInScope(step.knowledge, `${path}.knowledge`);
      const failed = context.trials.filter(trial => trial.outcome === "failed" && action.requestIds.includes(trial.requestId) && trial.knowledge.knowledgeId === step.knowledge.knowledgeId);
      if (!failed.length) return;
      const since = Math.max(...failed.map(trial => at(trial.resultAt ?? trial.askedAt)));
      let newer = 0;
      for (const factId of step.newFactIds) {
        const time = context.facts.find(fact => fact.id === factId)?.at;
        const factAt = time === undefined ? newFactTimes.get(factId) : at(time);
        if (factAt === undefined || factAt <= since) reject("new_fact_reference_invalid", `${path}.newFactIds`, factId);
        else newer += 1;
      }
      if (!newer) reject("repeated_failed_procedure", `${path}.knowledge`, step.knowledge.knowledgeId);
    });
  }

  if (action.kind === "confirm_resolution") {
    unverified.add("resolution_semantics");
    action.requestIds.forEach((requestId, index) => {
      const path = `nextAction.requestIds.${index}`;
      if (!status.has(requestId)) return reject("request_reference_unknown", path);
      if (!action.evidence.some(row => row.requestId === requestId)) reject("resolution_evidence_invalid", path, "evidence_missing");
    });
    action.evidence.forEach((evidence, index) => {
      const path = `nextAction.evidence.${index}`;
      if (!action.requestIds.includes(evidence.requestId)) return reject("resolution_evidence_invalid", `${path}.requestId`, "request_not_confirmed");
      checkEvidence(evidence.requestId, evidence, path);
    });
    for (const [requestId, value] of status) if (value === "open" && !action.requestIds.includes(requestId)) reject("other_requests_open", "nextAction.requestIds", requestId);
  }

  if (action.kind === "handoff") {
    action.requestIds.forEach((requestId, index) => requireOpenRequest(requestId, `nextAction.requestIds.${index}`));
    action.report.trialIds.forEach((trialId, index) => {
      if (!context.trials.some(trial => trial.id === trialId)) reject("handoff_report_reference_invalid", `nextAction.report.trialIds.${index}`, trialId);
    });
    const reported: SavRetrievalCandidate[] = [];
    action.report.knowledge.forEach((ref, index) => {
      const card = context.knowledge.find(row => row.id === ref.knowledgeId && row.contentVersionId === ref.contentVersionId);
      if (!card) reject("handoff_report_reference_invalid", `nextAction.report.knowledge.${index}`, ref.knowledgeId);
      else reported.push(card);
    });
    // Measured, not refused: retrieval ranking does not prove a card fits the request (`answer_relevance`).
    if (action.reason === "knowledge_missing" && context.coverage
      && action.requestIds.every(requestId => context.coverage!.find(row => row.requestId === requestId)?.status === "covered"))
      signals.add("handoff_knowledge_missing_with_cards");
    if (action.reason === "knowledge_conflict" && !reported.some(a => reported.some(b => conflicts(a, b))))
      reject("handoff_conflict_sources_missing", "nextAction.report.knowledge");
  }

  // Review A09, extended to every exchange (5/11): what the customer confirmed and what we already advised are two ledgers. Once nothing is left to tell or to ask, restarting the procedure or
  // asking again is refused and the case follows the card's own relay, decided here without a paid call and without any cause: what the screen says is reported as the customer's words, never
  // interpreted. Otherwise the next step is composed from the version's own steps: acknowledged what is confirmed, told what was not, asked once what we advised and nobody confirmed.
  const screenQuestions = loginScreenAsked(context);
  const thread = readLoginThread(context, screenQuestions);
  const loginSource = context.accessScope?.sources.find(source => source.use === "answer" && source.firstReply === "login_code_steps"
    && context.knowledge.some(row => row.id === source.knowledgeId && row.contentVersionId === source.contentVersionId));
  const loginRef = loginSource && !knowledgeProblem(loginSource) ? { knowledgeId: loginSource.knowledgeId, contentVersionId: loginSource.contentVersionId } : null;
  const loginCard = loginRef ? context.knowledge.find(row => row.id === loginRef.knowledgeId && row.contentVersionId === loginRef.contentVersionId) : undefined;
  const loginSays = cardVersionSays(loginCard);
  const outgoing = loginRef ? readLoginOutgoing(context, loginRef, loginSays.spamFolder, thread.since) : null;
  const screenKnown = thread.screen !== null || (outgoing?.screenAsked ?? false);
  const proposedText = normalize([proposal.reply?.text ?? "", ...(action.kind === "ask" ? action.questions.map(question => question.text) : [])].join("\n"));
  // Any procedure: on this one open request, another card's steps restart the same path or do not fit it (the source check below would only refuse it, at the price of a call).
  const restates = action.kind === "answer" ? true
    : action.kind === "ask" && (action.questions.some(question => question.seeks.some(seek => (["error_message", "screenshot", "operation_performed", "observed_result", "account_email"] as string[]).includes(seek.kind))
      || /\b(?:quel(?:le)? (?:message|erreur)|ce qui s'affiche|spams?|indesirables?|bonne adresse|bon lien)\b/.test(normalize(question.text)))
      || (thread.link === true && /\b(?:ouvrez|rendez-vous|allez sur|voici le lien|cliquez|connectez-vous|utilisez le lien|avez-vous (?:bien )?utilise le bon lien)\b/.test(proposedText))
      || (thread.address === true && /\b(?:entrez|saisissez|renseignez|verifiez|indiquez|utilisez|confirmez|avez-vous (?:bien )?(?:utilise|saisi|renseigne))\b[^.!?\n]{0,60}\badresse\b/.test(proposedText))
      || (thread.spam === true && /\b(?:verifiez|verifier|regardez|regarder|consultez|consulter|avez-vous (?:\w+ ){0,2}(?:regarde|verifie))\b[^.!?\n]{0,60}\b(?:spams?|indesirables?)\b/.test(proposedText))
      || ((thread.screen === "told" || thread.screen === "attached") && /\b(?:quel(?:le)? (?:message|erreur)|ce qui s'affiche|capture)\b/.test(proposedText)));
  const confirmedAny = thread.link === true || thread.address === true || thread.spam === true;
  const citesLogin = loginRef !== null && ((proposal.reply?.citations ?? []).some(ref => ref.knowledgeId === loginRef.knowledgeId)
    || (action.kind === "answer" && action.steps.some(step => step.knowledge.knowledgeId === loginRef.knowledgeId)));
  const aboutLogin = citesLogin || confirmedAny || screenQuestions || (outgoing?.pathGiven ?? false);
  const exchanged = context.trials.length > 0 || context.questions.length > 0 || context.sources.some(row => row.direction === "agent_outbound")
    || context.sources.filter(row => row.direction === "customer_inbound").length > 1;
  const open = context.requests.filter(row => row.status === "open");
  if (!composed && loginRef && outgoing && restates && aboutLogin && thread.complete && thread.scope === "login" && thread.noCode !== false && (confirmedAny || exchanged)) {
    const spamCheck = loginSays.spamFolder && thread.spam !== true;
    const tell = { link: thread.link === false || (thread.link === null && !outgoing.pathGiven), address: thread.address === false || (thread.address === null && !outgoing.pathGiven),
      spam: spamCheck && (thread.spam === false || !outgoing.spamGiven) };
    const confirm = { path: (thread.link === null || thread.address === null) && outgoing.pathGiven && !outgoing.pathAsked && !tell.link && !tell.address,
      spam: spamCheck && !tell.spam && !outgoing.spamAsked };
    const said = (thread.link === true ? ["bon lien"] : []).concat(thread.address === true ? ["bonne adresse"] : [], thread.spam === true ? ["spams"] : []);
    const unconfirmed = (thread.link === null ? ["lien"] : []).concat(thread.address === null ? ["adresse"] : [], spamCheck && thread.spam === null ? ["spams"] : []);
    // Only the customer's own statements, with their mail as source: the case's records keep who said what.
    const newFacts = [...proposal.understanding.newFacts, ...(["link", "address", "spam"] as const).flatMap(point => thread[point] === true && thread.sources[point] ? [{ id: `login_${point}_confirmed`, key: `login_${point}_confirmed`,
      statement: { link: "Le client dit avoir utilisé le bon lien.", address: "Le client dit avoir utilisé la bonne adresse.", spam: "Le client dit avoir vérifié ses spams." }[point], kind: "customer_statement" as const, source: thread.sources[point]! }] : [])]
      .filter((fact, index, all) => all.findIndex(other => other.id === fact.id) === index);
    const understanding = { ...proposal.understanding, newFacts };
    if (!tell.link && !tell.address && !tell.spam && !confirm.path && !confirm.spam && screenKnown) {
      if (loginSays.relay && open.length === 1) {
        const observed = thread.screen === "told" ? (thread.displayed ? `Message affiché selon le client : « ${thread.displayed} ».` : "Le client rapporte un message affiché (voir son mail).")
          : thread.screen === "attached" ? "Le client indique avoir joint une capture d’écran. L’agent ne lit pas les images : la capture est à consulter par l’équipe dans le mail du client."
          : thread.screen === "nothing" ? "Selon le client, aucun message ne s’affiche." : "Le client n’a pas précisé de message affiché après notre question.";
        const routed = validate({ caseVersion: proposal.caseVersion, understanding, nextAction: { kind: "handoff", reason: "diagnosis_out_of_tools", requestIds: [open[0]!.id], report: {
          need: `${unconfirmed.length ? "Connexion toujours impossible selon le client." : "Connexion impossible malgré les vérifications de la fiche."} Déjà fait selon le client : ${said.length ? said.join(", ") : "rien de confirmé"}.${unconfirmed.length ? ` Conseillé sans confirmation du client : ${unconfirmed.join(", ")}.` : ""}`,
          expected: "Recevoir le code de connexion et accéder à l’espace.", observed,
          trialIds: context.trials.filter(trial => trial.requestId === open[0]!.id).map(trial => trial.id), hypotheses: [], missingInformation: [],
          expectedIntervention: "Vérifier côté équipe pourquoi la connexion reste bloquée : l’agent n’a établi aucune cause.", knowledge: [loginRef],
        } } }, context, now, true);
        return routed.outcome === "accepted" ? { ...routed, signals: ordered(new Set<CaseDecisionSignal>([...routed.signals, "login_procedure_refused_routed"]), caseDecisionSignalLabels) } : routed;
      }
      reject("login_procedure_redundant", "nextAction.kind");
    } else if (loginSays.officialLink && open.length === 1 && families.get(open[0]!.id) === "access" && !sensitive.size && !proposal.reply?.impossibilityClaims.length) {
      const acknowledged = [thread.link === true && thread.address === true ? `Vous avez déjà utilisé le bon lien (${SAV_CASE_ACCESS_URL}) avec votre adresse d’inscription.`
        : thread.link === true ? `Vous avez déjà utilisé le bon lien (${SAV_CASE_ACCESS_URL}).` : thread.address === true ? "Vous avez déjà utilisé votre adresse d’inscription." : "",
      thread.spam === true ? (thread.link === true || thread.address === true ? "Vous avez aussi déjà vérifié vos spams et courriers indésirables." : "Vous avez déjà vérifié vos spams et courriers indésirables.") : ""].filter(Boolean).join(" ");
      const told = [tell.link ? loginCardStep(loginCard, "link") ?? `Le lien de connexion est ${SAV_CASE_ACCESS_URL}.` : "", tell.address ? loginCardStep(loginCard, "address") ?? "Entrez l’adresse e-mail de votre inscription." : "",
        tell.spam ? loginCardStep(loginCard, "spam") ?? "Si le code n’est pas dans votre boîte de réception, regardez dans le dossier « Spams » ou « Courriers indésirables » de cette même adresse." : ""].filter(Boolean);
      const unknownPath = thread.link === null && thread.address === null ? `${SAV_CASE_ACCESS_URL} avec l’adresse e-mail de votre inscription` : thread.link === null ? SAV_CASE_ACCESS_URL : "l’adresse e-mail de votre inscription";
      const asks = [confirm.path ? `Pouvez-vous me confirmer que vous avez bien utilisé ${unknownPath} ?` : "", confirm.spam ? "Avez-vous pu regarder dans le dossier « Spams » ou « Courriers indésirables » de cette adresse ?" : ""].filter(Boolean);
      // Q3 (9/11): the useful information is the exact text displayed, or a screenshot the team will read (the agent does not read images).
      const SCREEN_HOW = " Vous pouvez recopier le texte exact ou joindre une capture d’écran.";
      const screenAsk = screenKnown ? "" : (tell.spam ? "Si vous ne trouvez pas le code dans les spams non plus, quel message s’affiche à l’écran après la saisie de votre adresse e-mail ?"
        : confirm.spam ? "Si le code ne s’y trouve pas, quel message s’affiche à l’écran après la saisie de votre adresse e-mail ?" : "Quel message s’affiche à l’écran après la saisie de votre adresse e-mail ?") + SCREEN_HOW;
      const question = [...asks, screenAsk].filter(Boolean).join(" ") || (tell.spam ? "Le code se trouve-t-il dans ce dossier ?" : "Le code arrive-t-il sur cette adresse ?");
      const reminder = [acknowledged, ...told, question].join(" ").includes(SAV_CASE_ACCESS_URL) ? "" : `La page de connexion reste ${SAV_CASE_ACCESS_URL}.`;
      const seeks = [...(tell.link || tell.address || confirm.path ? [{ kind: "observed_result" as const, factKey: LOGIN_PATH_KEY }] : []), ...(tell.spam || confirm.spam ? [{ kind: "observed_result" as const, factKey: LOGIN_SPAM_KEY }] : []),
        ...(screenKnown ? [] : [{ kind: "error_message" as const, factKey: LOGIN_QUESTION_KEY }])];
      const paragraphs = [`Bonjour,`, thread.bareReminder ? "Merci pour votre retour." : "Merci pour ces précisions.", acknowledged, ...told, reminder, `${question} Si le code arrive entre-temps, saisissez-le uniquement sur la page de connexion et gardez-le pour vous.`];
      return validate({ caseVersion: proposal.caseVersion, understanding, nextAction: { kind: "ask", questions: [{ requestId: open[0]!.id, text: question,
        reducesUncertainty: screenKnown ? "Terminer la vérification indiquée par la fiche." : "Identifier le blocage avant réception du code.", seeks: seeks.length ? seeks : [{ kind: "observed_result" as const }] }] },
      reply: { text: paragraphs.filter(Boolean).join("\n\n"), citations: [loginRef], impossibilityClaims: [], accountAdvice: "none" } }, context, now, true);
    } else if (citesLogin && confirmedAny) reject("login_procedure_redundant", "nextAction.kind");
  }

  const reply = action.kind === "observe_only" ? undefined : proposal.reply;
  // The policy opts one exact card version into a verbatim first answer. Later
  // exchanges keep their diagnostic path and must take past attempts into account.
  if (reply && action.kind === "answer" && action.requestIds.length === 1 && reply.citations.length === 1
    && !reply.impossibilityClaims.length && !context.trials.length && !context.questions.length && !context.facts.length
    && context.sources.filter(row => row.direction === "customer_inbound").length === 1
    && !context.sources.some(row => row.direction.endsWith("_outbound"))) {
    const citation = reply.citations[0]!;
    const matches = (ref: CaseDecisionKnowledgeRef) => ref.knowledgeId === citation.knowledgeId && ref.contentVersionId === citation.contentVersionId;
    const template = context.accessScope?.sources.find(ref => matches(ref) && ref.use === "answer" && ref.firstReply !== undefined);
    if (template && action.steps.every(step => matches(step.knowledge))) {
      const card = context.knowledge.find(row => row.id === citation.knowledgeId && row.contentVersionId === citation.contentVersionId);
      const lines = card?.resolution?.steps;
      if (!Array.isArray(lines) || !lines.length || lines.length > 8 || !lines.every(line => typeof line === "string" && line.trim() && line.length <= 1000)) {
        reject("proposal_schema_invalid", "reply.text", "procedure_steps_invalid");
      } else if (template.firstReply === "login_code_steps" || !card || !repeatedSteps(lines.join("\n"), card, context).length) {
        // A step the customer states they did is not sent verbatim: the proposal stays the model's, checked below.
        const body = lines.map((line: string) => line.replace(/(?<![\w./@-])new\.limova\.ai(?=$|[\s.,;!?])/g, SAV_CASE_ACCESS_URL));
        reply.text = "Bonjour,\n\n" + body.join("\n\n");
        // The approved scope opts this exact version into the login-code template (`firstReply`, the right); the version itself must carry the official
        // link (the provenance). No card or version id lives in code. Keep other procedures verbatim.
        const says = cardVersionSays(card);
        if (template.firstReply === "login_code_steps" && says.officialLink) {
          reply.text = `Bonjour,

Merci pour votre message. Je vais vous guider pour vous connecter à Limova.

Voici le lien de connexion : ${SAV_CASE_ACCESS_URL}. Une fois sur la page, entrez l’adresse e-mail que vous avez utilisée lors de votre inscription à Limova. Si vous utilisez plusieurs adresses, vérifiez que vous avez bien choisi celle de votre inscription : c’est là que vous recevrez votre code de connexion.${says.spamFolder && thread.spam !== true ? " Si vous ne le voyez pas dans votre boîte de réception, pensez à vérifier le dossier « Spams » ou « Courriers indésirables »." : ""}

Il vous suffira ensuite de saisir ce code sur la page pour accéder à votre espace. Gardez-le pour vous : même si vous nous répondez, ne nous communiquez pas ce code.

Si vous restez bloqué, dites-moi simplement à quelle étape${thread.screen === "told" || thread.screen === "attached" ? "" : " et ce qui s’affiche à l’écran"}.`;
        }
        if (reply.text.length > 6000) reject("proposal_schema_invalid", "reply.text", "procedure_too_long");
      }
    }
  }
  if (reply) {
    unverified.add("reply_semantics");
    const replyText = normalize(reply.text);
    const openIds = [...status].filter(([, value]) => value === "open").map(([requestId]) => requestId);
    reply.citations.forEach((ref, index) => {
      citeKnowledge(ref, `reply.citations.${index}`);
      requireLink(ref, openIds, `reply.citations.${index}`);
      if (pilot) requireInScope(ref, `reply.citations.${index}`);
    });
    reply.impossibilityClaims.forEach((claim, index) => {
      const path = `reply.impossibilityClaims.${index}`;
      unverified.add("impossibility_statement_support");
      if (!status.has(claim.requestId)) reject("request_reference_unknown", `${path}.requestId`);
      const issue = knowledgeProblem(claim.knowledge);
      if (issue) reject("impossibility_without_valid_source", `${path}.knowledge`, issue.code);
      else requireLink(claim.knowledge, [claim.requestId], `${path}.knowledge`);
      if (pilot) requireInScope(claim.knowledge, `${path}.knowledge`);
    });
    if (reply.accountAdvice === "new_subscription" || reply.accountAdvice === "new_account") reject("account_advice_forbidden", "reply.accountAdvice", reply.accountAdvice);
    if (requestsCredential(reply.text)) reject("credential_request_pattern", "reply.text");
    // Pilot: an instruction the case already gave, or a step the customer states they did, is not given again. Our own composition reads the same ledgers and is not re-read.
    if (pilot && !composed && (action.kind === "ask" || action.kind === "answer")) for (const card of context.knowledge) {
      const repeated = repeatedSteps(reply.text, card, context);
      if (repeated.length) reject("procedure_step_repeated", "reply.text", `${card.id}:${repeated.join(",")}`);
    }
    const accessOpen = [...status].some(([requestId, value]) => value === "open" && families.get(requestId) === "access");
    if (accessOpen && (action.kind === "ask" || action.kind === "answer")) {
      const links = accessLinks(reply.text);
      if (!links.present) reject("access_link_missing", "reply.text");
      for (const link of links.invalid) reject("access_link_invalid", "reply.text", link);
    }
    if (!reply.impossibilityClaims.length && IMPOSSIBILITY_WORDING.test(replyText)) signals.add("impossibility_wording_without_claim");
    if (reply.accountAdvice === "none" && ACCOUNT_WORDING.test(replyText)) signals.add("account_wording_without_advice");
  }

  // A cited card that contradicts any applicable card means the agent silently picked a side.
  const reportedPairs = new Set<string>();
  for (const card of cited) for (const other of eligible) if (conflicts(card, other)) {
    const pair = [card.id, other.id].sort().join("|");
    if (!reportedPairs.has(pair)) { reportedPairs.add(pair); reject("knowledge_conflict", "knowledge", pair); }
  }

  if (rejections.length) return needsReview();
  return { outcome: "accepted", contractRevision: SAV_CASE_DECISION_CONTRACT_REVISION, decision: proposal,
    unverified: ordered(unverified, caseDecisionUnverifiedLabels), signals: ordered(signals, caseDecisionSignalLabels) };
}
