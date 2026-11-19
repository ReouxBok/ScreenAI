import { loginCustomerStatement, reportsOngoingLoginFailure, reportsRestoredAccess } from "./restored-access";
import { splitSavMessageText } from "../message-context";
import { SAV_CASE_ACCESS_URL, type CaseDecisionKnowledgeRef, type CaseDecisionSourceRef, type CaseDecisionValidationContext } from "./decision-contract";
import {
  at, latestCustomerMail, LOGIN_DOUBT, LOGIN_STATED, LOGIN_WORKS, normalize, ownCustomerWords, QUOTED, sentencesOf, smartValidator, sourceKey, squash,
} from "./decision-validator-text";

/*
 * The decision validator's rules that are the ACCESS block's own (19/11: moved verbatim out of `decision-validator.ts`, nothing changed in them).
 * Pure: no model, network, database or clock. Every one is reached only through Access's data: a request of the family `access` (the Access block's
 * alone), the official login link (`SAV_CASE_ACCESS_URL`), or a source the Access scope marks `login_code_steps` (a schema no other block's scope can carry).
 * Another block never goes through them: its generic rules stay in `decision-validator.ts` (its own scope's `answer` sources at the exact version,
 * `orient_only` orienting only, the kernel on our text) and its resolution proof is the one it declares (`case-block-resolution.ts`).
 * Limova 3.0 (open): the login address is still the constant `SAV_CASE_ACCESS_URL`; it is passed to `accessLoginCodeFirstReply` as data, one place to
 * change when it comes from the sources by version.
 */

/*
 * A login blockage as the customer tells it (review A09), never as a diagnosis: read on their own words (quoted history, signature and inline quotations set aside), latest mail first.
 * For each point the latest mail that speaks of it decides, with that mail as its source; a mail that says both is no proof. A doubt is no check. A bare reminder (« Toujours rien. »)
 * confirms nothing and hides nothing: the reading goes on through it. The problem's scope ends at a mail reporting the connection works. A mail on another subject stops the reading when
 * it is the latest thing said; older than a mail back on the login, it hides nothing. An unreadable mail or a person's reply after the last mail leaves nothing proven.
 * What WE advised is never read here: see `readLoginOutgoing`, on the case's own trials and questions.
 */
export type LoginPoint = "link" | "address" | "spam";
export type LoginThread = { complete: boolean; link: boolean | null; address: boolean | null; noCode: boolean | null; spam: boolean | null; screen: "told" | "attached" | "nothing" | null; displayed: string | null;
  /** `other`: the latest thing said is not about this login. */ scope: "login" | "other"; /** The latest mail is a bare reminder, with nothing new. */ bareReminder: boolean;
  /** Date of the mail that ended the previous problem: what we advised before it belongs to that problem. */ since: number; sources: Partial<Record<LoginPoint, CaseDecisionSourceRef>> };
export const LOGIN_TOPIC = /\b(?:code|connexion|connecter|connecte|lien|adresse|e-?mail|mail|spams?|indesirables?|erreur|message|ecran|affiche|identifiant|introuvable|bloquee?)\b/;
// The same word `connecter` about another service is another subject, as the login card itself says; a code or an address in the sentence keeps it on the login.
export const LOGIN_OTHER_SERVICE = /\b(?:connecter|relier|brancher|lier|integrer|synchroniser|connexion|integration)\b[^.!?\n]{0,40}\b(?:gmail|outlook|google|hubspot|calendrier|agenda|whatsapp|telephon\w*|linkedin|instagram|facebook)\b/;
export const LOGIN_REMINDER = /\b(?:toujours (?:rien|pas|bloquee?|le meme|la meme|aucun\w*)|rien (?:de (?:nouveau|plus)|recu|ne (?:change|marche|fonctionne|se passe))|ne (?:marche|fonctionne) (?:toujours |plus )?pas|(?:meme|la meme) (?:chose|probleme)|aucun changement|pas mieux)\b/;
export const LOGIN_NEW_ASK = /\b(?:comment|ajouter|changer|supprimer|modifier|creer|installer|configurer)\b/;
// The address was NOT the customer's own: refused, denied or withdrawn, in this mail or a later one. Someone else's address is not « mon adresse », even called « d'inscription ».
export const LOGIN_ADDRESS_NOT_OWN = /\b(?:mauvaise adresse|autre adresse|trompee? d'adresse|pas (?:(?:avec|sur|utilise|saisi|renseigne|entre|la|ma|mon|une|cette|bonne|bien|vraiment) ){0,3}(?:l')?adresse|celle (?:de (?:mon|ma|notre|son|sa|leur)|du|d'une?) |(?:adresse|e-?mail|mail)(?: d'inscription| e-?mail| mail)? (?:de (?:mon|ma|notre|son|sa|leur)|du|de la|d'une?) (?!inscription\b|compte\b|espace\b|boite\b|messagerie\b)\S)/;
export const LOGIN_QUESTION_KEY = "login_error_message", LOGIN_PATH_KEY = "login_path_checked", LOGIN_SPAM_KEY = "login_spam_checked";
// Q3 (9/11): the customer says a screenshot is attached. The agent cannot read an image: the screen is reported as attached, never as words it saw.
export const SCREENSHOT = /\b(?:captures? d'ecran|copies? d'ecran|screenshots?|photos? de l'ecran|captures?)\b/;
export const ATTACHED = /\b(?:ci-jointe?s?|en pieces? jointes?|jointe?s?|attachee?s?|voici|je vous (?:envoie|transmets|joins))\b/;
/** The yes and no of one mail on one point: any `no` wins over a `yes` (a contradiction proves nothing), silence is null. */
export const saidInMail = (sentences: readonly string[], yes: (sentence: string) => boolean, no: (sentence: string) => boolean): boolean | null =>
  sentences.some(no) ? false : sentences.some(yes) ? true : null;
export function screenInMail(sentences: readonly string[]): { screen: "told" | "attached" | "nothing" | "conflict" | null; displayed: string | null } {
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
export function readLoginThread(context: CaseDecisionValidationContext, askedAlready: boolean): LoginThread {
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
export function loginScreenAsked(context: CaseDecisionValidationContext) {
  return context.questions.some(question => question.factKeys.includes(LOGIN_QUESTION_KEY)
    && context.sources.some(source => source.direction === "customer_inbound" && at(source.at) > at(question.askedAt)));
}

/** Only closed, customer-reported signals go on the model wire. Displayed text may contain a secret. */
export const latestLoginMail = latestCustomerMail;
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
export function readLoginOutgoing(context: CaseDecisionValidationContext, ref: CaseDecisionKnowledgeRef, sentVersionAdvisesSpam: boolean, since: number) {
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
export function loginCardStep(card: CaseDecisionValidationContext["knowledge"][number] | undefined, kind: LoginPoint): string | null {
  const listed: unknown = card?.resolution?.steps;
  const steps = Array.isArray(listed) ? listed.filter((step): step is string => typeof step === "string" && step.trim().length > 0 && step.length <= 400) : [];
  const spam = (step: string) => /\bspams?\b|\bindesirables?\b/.test(normalize(step)), host = (step: string) => normalize(step).includes(ACCESS_HOST);
  const found = kind === "spam" ? steps.find(spam) : kind === "link" ? steps.find(host) : steps.find(step => /\badresse\b/.test(normalize(step)) && !spam(step) && !host(step));
  return found?.trim().replace(new RegExp(String.raw`(?<![\w./@-])${ACCESS_HOST.replaceAll(".", "\\.")}(?=$|[\s.,;!?])`, "g"), SAV_CASE_ACCESS_URL) ?? null;
}
// What the authorized card version itself says (its content and procedure steps), never what a template would like it to say:
// the login-code template only quotes the official link and the spam folder advice when that very version carries them.
export function cardVersionSays(card: CaseDecisionValidationContext["knowledge"][number] | undefined) {
  const listed: unknown = card?.resolution?.steps;
  const steps = Array.isArray(listed) ? listed.filter((step): step is string => typeof step === "string") : [];
  const text = card ? normalize([card.content, ...steps].join("\n")) : "";
  // The exact host, not a prefix of another one (`new.limova.ai.other`) nor a look-alike (`new.limova.io`).
  return { officialLink: card !== undefined && new RegExp(String.raw`(?<![\w.@-])${ACCESS_HOST.replaceAll(".", "\\.")}(?![\w-]|\.[\w-])`).test(text),
    spamFolder: /\bspams?\b|\bcourriers? indesirables?\b/.test(text),
    // The version's own next step once the customer's checks are done: a relay it does not state is never assumed.
    relay: typeof card?.resolution?.escalation === "string" && /\b(?:transmettre|transferer|escalader|remonter)\b.*\b(?:equipe|support|humain)\b/.test(normalize(card.resolution.escalation)) };
}
// Access path (review B 28/10): a link is read by the URL parser, never by a prefix, so `new.limova.ai.other.host` or
// `new.limova.ai@other.host` is not the canonical one. Only https, the exact host, no user info, no port, and no query or
// fragment (a redirect could hide there) count; any other link in an access reply, and any bare name of the brand other
// than the host itself or a limova.ai address (`limova.com`, `app.limova.fr`, full-width letters...), is invalid.
// Sentence punctuation around a link is set aside for the check only: the text is never rewritten.
export const ACCESS_HOST = new URL(SAV_CASE_ACCESS_URL).hostname;
export const LINK = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
export const WRAP_START = /^[([{<«"'“‘]+/, WRAP_END = /[)\]}>»"'”’.,;:!?…]+$/;
export const LIMOVA_ADDRESS = /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*limova\.ai$/i;
export const unwrap = (token: string) => token.replace(WRAP_START, "").replace(WRAP_END, "");
export function canonicalAccessLink(link: string) {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === ACCESS_HOST && url.username === "" && url.password === "" && url.port === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  } catch { return false; }
}
export function accessLinks(text: string) {
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
// Broad roots are intentional: a doubt about login requires the URL. Its presence
// anywhere in the reply satisfies this requirement, including another paragraph.
export const LOGIN_REFERENCE = /\b(?:re|de|ré|dé)?(?:connect\w*|connexion\w*|identif\w*|authent\w*|mot de passe|espace\w*|compte\w*|acced\w*|accéd\w*|acces|accès|log\w*|sign[ -]?in)\b/;
// Every sentence must ask for information. Greetings and courtesy are framing,
// never an exemption for a second instruction or an unknown statement.
export const INFORMATION_QUESTION = /^(?:(?:quel|quelle|quels|quelles)\b|depuis quand\b|pouvez-vous (?:preciser|indiquer|me dire|m'envoyer une capture)\b|avez-vous\b|est-ce que\b|sur (?:quel|quelle|quels|quelles) (?:appareil|navigateur)\b) .+$/;
// An interrogative form can still prescribe an operation. Deny those verbs even
// inside a longer information question. A past trial question is handled separately below.
export const CLARIFICATION_OPERATION = /\b(?:ouvrir|ouvert\w*|ouvre\w*|session\w*|espace\w*|aller|allez|alliez|rendre|rendez|retourner|retourne\w*|rejoindre|rejoigne\w*|reessay\w*|reessai\w*|essayer|essay\w*|tenter|tente\w*|cliquer|cliqu\w*|saisir|saisiss\w*|entrer|entrez|entriez|fermer|ferme\w*|vider|videz|supprimer|supprime\w*|installer|installe\w*|telecharger|telecharge\w*|actualiser|actualise\w*|rafraich\w*|recommencer|recommence\w*|effectuer|effectue\w*|faire|faites|fait|desactiver|desactive\w*|activer|active\w*|changer|change\w*|utiliser|veuillez)\b/;
export function isAccessClarification(text: string) {
  const value = squash(text);
  if (LOGIN_REFERENCE.test(value)) return false;
  const parts = value.split("?");
  if (parts.length < 2) return false;
  // Only fixed courtesies may follow the final question mark.
  const tail = parts.pop()!.trim();
  if (tail && !/^(?:merci(?: beaucoup| d'avance)?|(?:bien )?cordialement)[.!]?$/.test(tail)) return false;
  return parts.every(part => {
    const question = part.trim().replace(/^(?:bonjour|bonsoir|salut)(?:\s*[,!.]\s*|\s+)/, "")
      .replace(/,?\s*s'il vous plait$/, "").trim();
    // A period, semicolon or newline cannot hide a free-standing instruction.
    // Only the past-tense trial verb is informational. Remaining operations and
    // every login reference still fail closed, even in a question about the past.
    const information = question.replace(/^avez-vous (?:deja )?essaye\b/, "avez-vous");
    return !/[.!;:\n]/.test(question) && !CLARIFICATION_OPERATION.test(information) && INFORMATION_QUESTION.test(question);
  });
}
export function accessLinkMissing(text: string, loginProcedure?: boolean) {
  if (accessLinks(text).present) return false;
  if (!smartValidator()) return true;
  // Corrected text has no card context: unknown procedure is fail-closed.
  return loginProcedure !== false || LOGIN_REFERENCE.test(normalize(text))
    || /\b(?:adresse|e-?mail|code)\b/.test(normalize(text));
}

/** The Access first reply of the `login_code_steps` template (the scope opts one exact card version in; the version must carry the official link). Verbatim
 * from the validator; `url` is the official login address, `spamAdvice` whether the version advises the spam folder and the customer has not checked it yet. */
export function accessLoginCodeFirstReply(input: Readonly<{ url: string; spamAdvice: boolean }>): string {
  return `Bonjour,

Merci pour votre message. Je vais vous guider pour vous connecter à Limova.

Voici le lien de connexion : ${input.url}. Une fois sur la page, entrez l’adresse e-mail que vous avez utilisée lors de votre inscription à Limova. Si vous utilisez plusieurs adresses, vérifiez que vous avez bien choisi celle de votre inscription : c’est là que vous recevrez votre code de connexion.${input.spamAdvice ? " Si vous ne le voyez pas dans votre boîte de réception, pensez à vérifier le dossier « Spams » ou « Courriers indésirables »." : ""}

Il vous suffira ensuite de saisir ce code sur la page pour accéder à votre espace. Gardez-le pour vous : même si vous nous répondez, ne nous communiquez pas ce code.`;
}
