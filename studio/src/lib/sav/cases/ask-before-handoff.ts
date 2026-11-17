import { splitSavMessageText } from "../message-context";
import { loginCustomerStatement } from "./restored-access";
import {
  caseDecisionAttachmentMail, isSensitiveCaseFamily, SAV_CASE_ACCESS_URL,
  type CaseDecisionProposal, type CaseDecisionSourceRef, type CaseDecisionValidationContext,
} from "./decision-contract";

/*
 * SAV-92 (Ugo 17/11, real Access case): a customer who only repeats « je n'arrive pas à me connecter » without answering our questions is not
 * handed to the team at once. Before a `repeated_failure` or `diagnosis_out_of_tools` hand-over, the agent sends ONE re-ask, composed here from
 * the case's own records (never the model's wording): the still-open questions verbatim in send order, a screenshot of the error, and the notice
 * that without them the request goes to an advisor. After that single re-ask, a new empty repeat is handed over as before.
 * Pure: no clock, model or store. Behind `SAV_V2_ASK_BEFORE_HANDOFF` (exact "on"); off, nothing here runs and the path is main's.
 */

export const SAV_V2_ASK_BEFORE_HANDOFF_ENV = "SAV_V2_ASK_BEFORE_HANDOFF";
export const caseAskBeforeHandoffEnabled = (env: Readonly<Record<string, string | undefined>> = process.env) => env[SAV_V2_ASK_BEFORE_HANDOFF_ENV] === "on";

/** The fact key of the re-ask's screenshot question: its presence on a stored question is what proves the single re-ask was sent. */
export const SAV_CASE_REASK_SCREENSHOT_KEY = "handoff_reask_screenshot";
export const SAV_CASE_REASK_SCREENSHOT_QUESTION = "Pouvez-vous aussi m’envoyer une capture d’écran de l’erreur qui s’affiche ?";
export const SAV_CASE_REASK_ADVISOR_NOTICE = "Sans ces éléments, si la situation reste bloquée, je transmettrai votre demande à un conseiller de notre équipe, qui reviendra vers vous.";

/** Sent to the model only when the switch is on, so the off prompt keeps its exact bytes. */
export const SAV_CASE_ASK_BEFORE_HANDOFF_INSTRUCTION = "Relance avant transfert : si le dernier mail du client répète seulement sa demande, sans répondre aux questions encore ouvertes ni apporter de fait nouveau, le transfert repeated_failure ou diagnosis_out_of_tools n'est pas encore accepté. Une simple répétition n'apporte aucun fait : n'enregistre pas de newFacts pour elle. Ne rédige pas toi-même cette relance : propose le transfert, le serveur le remplace par UNE relance (questions ouvertes reprises mot pour mot, capture d'écran de l'erreur, annonce du passage à un conseiller). Après cette relance, un nouveau message sans fait nouveau permet le transfert. Les autres motifs de transfert sont inchangés.";

const REASK_REASONS = new Set(["repeated_failure", "diagnosis_out_of_tools"]);
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[’`]/g, "'");
const SCREEN_TEXT = /\b(?:captures? d'ecran|copies? d'ecran|screenshots?|message d'erreur|quel(?:le)? (?:message|erreur)|ce qui s'affiche)\b/;
const SCREEN_KEY = /screenshot|capture|error_message|erreur/;
const HUMAN_REQUEST = /\b(?:parler|echanger|discuter|etre (?:mise? en relation|rappelee?|contactee?)|joindre|contacter|avoir)\b[^.!?\n]{0,40}\b(?:conseill\w+|humains?|personnes?|quelqu'un|agents?|techniciens?|responsables?|interlocut\w+|vrai\w*)\b|\b(?:rappelez|appelez|contactez)[- ]moi\b|\bun (?:conseiller|humain|etre humain)\b/;
const at = (value: string) => Date.parse(value);
const keyOf = (ref: CaseDecisionSourceRef) => `${ref.type}:${ref.id}`;

type Question = Extract<CaseDecisionProposal["nextAction"], { kind: "ask" }>["questions"][number];

/**
 * The single re-ask that replaces a premature hand-over, or null when the hand-over stands (another reason, a sensitive case, open requests on different topics,
 * new facts in the latest mail, the re-ask already sent, or a record we cannot read). Null always means: main's behaviour.
 */
export function caseReaskBeforeHandoff(proposal: CaseDecisionProposal, context: CaseDecisionValidationContext): CaseDecisionProposal | null {
  const action = proposal.nextAction;
  if (action.kind !== "handoff" || !REASK_REASONS.has(action.reason)) return null;
  if (context.sensitiveCategories.length || [...context.requests, ...proposal.understanding.requests].some(row => isSensitiveCaseFamily(row.family))) return null;
  const open = context.requests.filter(row => row.status === "open");
  // Several open requests are one problem told again (Ugo's real case: the same login trouble relayed from 3 mails) only when they share one family
  // and, in a multi-block case, one block. Different topics keep main's hand-over.
  if (!open.length || open.length > 5 || new Set(open.map(row => row.family)).size !== 1) return null;
  if (context.blockScopes && new Set(open.map(row => context.blockScopes!.requestBlocks[row.id] ?? null)).size !== 1) return null;
  if (!action.requestIds.length || action.requestIds.some(requestId => !open.some(row => row.id === requestId))) return null;

  // A repeat needs an earlier exchange: at least two customer mails, and something we already sent (a procedure or a question).
  const inbound = context.sources.filter(row => row.direction === "customer_inbound" && row.ref.type === "email").sort((a, b) => a.order - b.order);
  const latest = inbound.at(-1);
  if (!latest || inbound.length < 2 || (!context.trials.length && !context.questions.length)) return null;
  if (context.sources.some(row => row.direction === "human_outbound" && row.order > latest.order)) return null;

  // The single re-ask was already sent (our marker), or the same information was already asked twice: the hand-over is allowed.
  // Two questions of one mail may share a key; the same key in two different mails is a re-ask.
  if (context.questions.some(row => row.factKeys.includes(SAV_CASE_REASK_SCREENSHOT_KEY)
    || context.questions.some(other => other.askedAt !== row.askedAt && other.factKeys.some(key => row.factKeys.includes(key))))) return null;

  // A file in the latest mail (a screenshot, perhaps) is new material for the team: no re-ask.
  if (context.sources.some(row => row.ref.type === "attachment" && caseDecisionAttachmentMail(row.ref) === latest.ref.id)) return null;

  const timeOf = (ref: CaseDecisionSourceRef) => { const row = context.sources.find(source => keyOf(source.ref) === keyOf(ref)); return row ? at(row.at) : NaN; };
  const facts = [...context.facts.map(fact => ({ key: fact.key, source: fact.source, at: at(fact.at) })),
    ...proposal.understanding.newFacts.map(fact => ({ key: fact.key, source: fact.source, at: timeOf(fact.source) }))];
  const fromLatest = (ref: CaseDecisionSourceRef) => keyOf(ref) === keyOf(latest.ref) || (ref.type === "attachment" && caseDecisionAttachmentMail(ref) === latest.ref.id);
  // Our questions, not the procedure follow-up the case records after an answer (`procedure:<effect>`), asked before the latest mail.
  const asked = context.questions.map((row, index) => ({ row, index })).filter(({ row }) => !row.id.startsWith("procedure:") && at(row.askedAt) < at(latest.at));
  // Review Astra P1 (17/11): only a mail that brings NOTHING new is re-asked. Any fact read from it (an answer, a new diagnostic detail, a request for a
  // person), recorded before or proposed now, leaves the model's decision unchanged.
  if (facts.some(fact => fromLatest(fact.source))) return null;
  // A request for a person or an advisor in the customer's own words (quoted history and signature set aside) keeps the hand-over, whatever reason the model gave.
  // The V2 path has no other detector than the model's own `explicit_human_request`: this narrow reading backs it up. An unreadable mail proves nothing: no re-ask.
  const raw = context.customerTexts[keyOf(latest.ref)];
  if (!raw || HUMAN_REQUEST.test(normalize(loginCustomerStatement(splitSavMessageText(raw))))) return null;

  const answered = (row: CaseDecisionValidationContext["questions"][number]) => row.answeredBy !== null
    || (row.factKeys.length ? row.factKeys.some(key => facts.some(fact => fact.key === key && fact.at > at(row.askedAt))) : false);
  const stillOpen = asked.filter(({ row }) => !answered(row)).sort((a, b) => at(a.row.askedAt) - at(b.row.askedAt) || a.index - b.index).map(({ row }) => row);
  // The wording must be the one we sent: a question whose text the record does not carry cannot be restated verbatim.
  if (stillOpen.some(row => typeof row.text !== "string" || !row.text.trim())) return null;
  const screenshotAsked = context.questions.some(row => SCREEN_TEXT.test(normalize(row.text ?? "")) || row.factKeys.some(key => SCREEN_KEY.test(key)));
  if (!stillOpen.length && screenshotAsked) return null;

  // Every open request must be named by a question (validator rule `proposal_request_uncovered`), assigned below; the mail shows each question once.
  const requestId = open[0]!.id;
  const restated = stillOpen.slice(0, 4);
  const screenIn = restated.findIndex(row => SCREEN_TEXT.test(normalize(row.text!)) && /\b(?:captures?|copies? d'ecran|screenshots?)\b/.test(normalize(row.text!)));
  const questions: Question[] = restated.map((row, index) => ({
    text: row.text!.trim(), requestId, reducesUncertainty: `Relance unique avant transfert : la question ${row.id} est restée sans réponse.`,
    seeks: [...(row.factKeys.length ? row.factKeys.slice(0, 4).map(key => ({ kind: "other" as const, factKey: key })) : [{ kind: "other" as const }]),
      ...(index === screenIn ? [{ kind: "screenshot" as const, factKey: SAV_CASE_REASK_SCREENSHOT_KEY }] : [])],
  }));
  if (screenIn < 0) questions.push({ text: SAV_CASE_REASK_SCREENSHOT_QUESTION, requestId, reducesUncertainty: "Relance unique avant transfert : une capture de l’erreur permet à l’équipe de diagnostiquer.",
    seeks: [{ kind: "screenshot", factKey: SAV_CASE_REASK_SCREENSHOT_KEY }] });
  // One request per question, in order, the last question taking the rest; a request left over gets the screenshot question again (metadata only).
  questions.forEach((question, index) => { question.requestId = open[Math.min(index, open.length - 1)]!.id; });
  const screenshotQuestion = questions.find(question => question.seeks.some(seek => seek.factKey === SAV_CASE_REASK_SCREENSHOT_KEY))!;
  for (const row of open.slice(questions.length)) questions.push({ ...screenshotQuestion, requestId: row.id });
  if (questions.length > 5) return null;

  const intro = restated.length ? (restated.length === 1 ? "Pour pouvoir avancer, j’ai besoin de votre réponse à cette question, restée sans réponse :" : "Pour pouvoir avancer, j’ai besoin de votre réponse à ces questions, restées sans réponse :")
    : "Pour pouvoir avancer, j’ai besoin d’un élément de votre part :";
  const asks = [...new Set(questions.map(question => question.text))];
  const body = ["Bonjour,", `Merci pour votre message. ${intro}`, ...asks];
  // The Access path always recalls the official link (validator rule `access_link_missing`); the restated wording may already carry it.
  if (open[0]!.family === "access" && ![...body].join("\n").includes(SAV_CASE_ACCESS_URL)) body.push(`La page de connexion reste ${SAV_CASE_ACCESS_URL}.`);
  body.push(SAV_CASE_REASK_ADVISOR_NOTICE);
  const text = body.join("\n\n");
  if (text.length > 6000) return null;
  return { caseVersion: proposal.caseVersion, understanding: proposal.understanding, nextAction: { kind: "ask", questions },
    reply: { text, citations: [], impossibilityClaims: [], accountAdvice: "none" } };
}
