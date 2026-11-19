import { reportsRestoredAccess } from "./restored-access";
import { caseBlockResolutionProof } from "./case-block-resolution";
import { SAV_CASE_ACCESS_BLOCK_ID } from "./case-types";
import { assessSavKnowledgeValidity, type SavRetrievalCandidate } from "../request-retrieval";
import {
  caseAdmissionRefusalCode, caseDecisionAttachmentMail, caseDecisionProposalSchema, caseDecisionRejectionLabels, caseDecisionSignalLabels, caseDecisionUnverifiedLabels,
  isSensitiveCaseFamily, SAV_CASE_ACCESS_URL, SAV_CASE_DECISION_CONTRACT_REVISION, SAV_CASE_TEAM_PART_MENTION,
  type CaseDecisionKnowledgeRef, type CaseDecisionRejection, type CaseDecisionRejectionCode, type CaseDecisionSignal,
  type CaseDecisionSourceRef, type CaseDecisionUnverifiedJudgment, type CaseDecisionValidation,
  type CaseDecisionProposal, type CaseDecisionValidationContext, type CaseResolutionEvidence, type SavCaseSensitiveFamily,
} from "./decision-contract";
import { caseAccessSourceProblem } from "./investigation-access-scope";
import { caseAskBeforeHandoffEnabled, caseReaskBeforeHandoff } from "./ask-before-handoff";
import { accessSkillKernelHits } from "./access-skill/access-skill-kernel";
import { readAccessSkillMode } from "./access-skill/access-skill-mode";
import { at, latestCustomerMail, LOGIN_DOUBT, LOGIN_STATED, LOGIN_WORKS, normalize, ownCustomerWords, QUOTED, sentencesOf, smartValidator, sourceKey, squash, strings } from "./decision-validator-text";
import {
  accessLinkMissing, accessLinks, accessLoginCodeFirstReply, cardVersionSays, isAccessClarification, LOGIN_PATH_KEY, LOGIN_QUESTION_KEY, LOGIN_SPAM_KEY,
  loginCardStep, loginScreenAsked, readLoginOutgoing, readLoginThread,
} from "./decision-validator-access";
export { caseModelLoginHistory } from "./decision-validator-access";

/*
 * Pure and deterministic: no model, network, database, clock or effect. `now` is an argument.
 * Rejections cover structural invariants only; what free text means is listed as unverified, never claimed.
 */

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
function repeatedSteps(reply: string, card: SavRetrievalCandidate, context: CaseDecisionValidationContext, unusedSentStep?: number): number[] {
  const steps = strings(card.resolution?.steps).map(stepOf), lastMail = Math.max(-Infinity, ...context.sources.filter(row => row.direction === "customer_inbound").map(row => at(row.at)));
  const instructed = sentencesOf(normalize(reply)).filter(sentence => !/^(?:vous avez|merci|comme vous)\b/.test(sentence));
  const restated = steps.flatMap((step, index) => step.object.length >= 2 && step.verb && instructed.some(sentence => sentence.includes(step.verb) && overlap(step.object, sentence) >= 0.7) ? [index] : []);
  if (!restated.length) return [];
  const sent = context.trials.some(trial => trial.knowledge.knowledgeId === card.id && at(trial.askedAt) < lastMail);
  const repeatedSent = restated.filter(index => index !== unusedSentStep);
  if (sent && repeatedSent.length && restated.length >= Math.ceil(steps.length / 2)) return repeatedSent;
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

/**
 * SAV-92: the text rules of the automatic path that a reply's TEXT alone can be judged on, for a text a person corrected in the Studio. The same primitives as `validate`
 * below (no copy): no request for a secret, and, when an Access request is open and the reply answers or asks,
 * the official Access link present and no other link or look-alike brand name. Rules that need the whole decision (citations, impossibility sources, repeated steps on the
 * pilot ledgers) are not re-run here: the correction keeps the decision's own citations and purpose, and its provenance is proven again at every look.
 */
export type CaseReplyTextSafetyProblem = Readonly<{ code: "credential_request_pattern" | "access_link_missing" | "access_link_invalid"; detail?: string }>;
export function caseReplyTextSafetyProblems(text: string, options: Readonly<{ accessOpen: boolean; answersOrAsks: boolean; loginProcedure?: boolean }>): CaseReplyTextSafetyProblem[] {
  const problems: CaseReplyTextSafetyProblem[] = [];
  if (requestsCredential(text)) problems.push({ code: "credential_request_pattern" });
  if (options.accessOpen && options.answersOrAsks) {
    const links = accessLinks(text);
    if (accessLinkMissing(text, options.loginProcedure)) problems.push({ code: "access_link_missing" });
    for (const link of links.invalid) problems.push({ code: "access_link_invalid", detail: link.slice(0, 200) });
  }
  return problems;
}

/** A clarification cites both stored references in its reason. The source itself must explain the doubt;
 * a model merely calling a fact incomplete is not evidence. One original question plus one reconfirmation,
 * including duplicates in this proposal. Unknown history fails closed. No new wire/storage fields. */
function legitimateReconfirmation(question: Extract<CaseDecisionProposal["nextAction"], { kind: "ask" }>["questions"][number], key: string,
  context: CaseDecisionValidationContext, now: Date) {
  const previous = context.questions.filter(row => row.factKeys.includes(key));
  if (previous.length !== 1 || !question.reducesUncertainty.includes(previous[0]!.id)) return false;
  const facts = context.facts.filter(fact => fact.key === key);
  return facts.some(fact => {
    const source = context.sources.find(row => sourceKey(row.ref) === sourceKey(fact.source) && row.direction === "customer_inbound");
    const raw = source && context.customerTexts[sourceKey(source.ref)];
    if (!source || !raw || !question.reducesUncertainty.includes(sourceKey(source.ref))
      || !previous[0]!.answeredBy || sourceKey(previous[0]!.answeredBy) !== sourceKey(fact.source) || at(previous[0]!.askedAt) >= at(fact.at)) return false;
    const reason = normalize(question.reducesUncertainty), own = ownCustomerWords(raw).replace(QUOTED, " ");
    const incomplete = /\b(?:incomplet|imprecis|manque)\b/.test(reason) && /\b(?:je ne sais pas|pas sur|pas certain|peut-etre|environ|je crois)\b/.test(own);
    const contradictory = /\bcontradic\w*\b/.test(reason) && /\b(?:je me suis trompe|contrairement|rectification|en fait)\b/.test(own);
    const old = /\b(?:ancien|ancienne|obsolete)\b/.test(reason) && now.getTime() - at(fact.at) >= 30 * 24 * 60 * 60 * 1000;
    return incomplete || contradictory || old;
  });
}

/** The current ledger stores a card, not its sent steps. Consequently an alternative needs explicit,
 * latest customer evidence: one exact failed card step and one exact, explicitly untried step, after
 * the single recorded failure. Missing/ambiguous history cannot establish an unused branch. The
 * reason cites the trial and source; expectedResult states a stop/relay condition. Max two trials per
 * request across ALL cards, even with new facts. Exact version/steps only, never a guessed branch. */
function unusedAlternative(action: Extract<CaseDecisionProposal["nextAction"], { kind: "answer" }>, context: CaseDecisionValidationContext, reply: string | undefined) {
  if (action.requestIds.length !== 1 || action.steps.length !== 1) return false;
  const trials = context.trials.filter(row => row.requestId === action.requestIds[0]);
  const trial = trials[0], step = action.steps[0]!;
  if (trials.length !== 1 || !trial || trial.outcome !== "failed" || !trial.resultAt
    || trial.knowledge.knowledgeId !== step.knowledge.knowledgeId || trial.knowledge.contentVersionId !== step.knowledge.contentVersionId) return false;
  const card = context.knowledge.find(row => row.id === step.knowledge.knowledgeId && row.contentVersionId === step.knowledge.contentVersionId);
  const steps = strings(card?.resolution?.steps);
  // The wire has no step id: exact text + exact card/version identifies the structured
  // step. The entire reply must be that step, optionally followed by the fixed access
  // URL. No free prose can smuggle an unlisted/rephrased instruction into the reply.
  if (!steps.includes(step.text) || steps.filter(text => text === step.text).length !== 1 || !reply
    || ![step.text, `${step.text}\n\n${SAV_CASE_ACCESS_URL}`].includes(reply)) return false;
  // A later claim of "untried" cannot erase an earlier explicit report of having tried this step.
  if (context.sources.some(row => row.direction === "customer_inbound" &&
    ownCustomerWords(context.customerTexts[sourceKey(row.ref)] ?? "").replace(QUOTED, " ").split(/[.!?\n]/)
      .some(sentence => /\bj'ai (?:deja )?essaye\b/.test(sentence) && squash(sentence).includes(squash(step.text))))) return false;
  const latest = context.sources.filter(row => row.direction === "customer_inbound" || row.direction === "human_outbound").sort((a, b) => b.order - a.order)[0];
  if (!latest || latest.direction !== "customer_inbound" || at(latest.at) <= at(trial.resultAt)) return false;
  const raw = context.customerTexts[sourceKey(latest.ref)];
  if (!raw) return false;
  const own = ownCustomerWords(raw).replace(QUOTED, " ");
  const untried = /je n'ai pas (?:encore )?essaye(?: de | d')?\s*:?\s*([^.!?\n]+)/g;
  const unused = [...own.matchAll(untried)].map(match => squash(match[1]!));
  const failed = [...own.matchAll(/j'ai (?:deja )?essaye(?: de | d')?\s*:?\s*([^.!?\n]+?)(?:[.!?]|, mais)?\s*(?:cela|ca) a echoue/g)].map(match => squash(match[1]!));
  const reason = normalize(action.expectedResult);
  return unused.includes(squash(step.text)) && !failed.includes(squash(step.text))
    && steps.some(text => text !== step.text && failed.includes(squash(text)))
    && action.expectedResult.includes(trial.id) && action.expectedResult.includes(sourceKey(latest.ref))
    && /\balternative\b/.test(reason) && /\bsi\b/.test(reason) && /\b(?:echec|echoue)\b/.test(reason) && /\b(?:equipe|humain)\b/.test(reason);
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

export const validateCaseDecision = (input: unknown, context: CaseDecisionValidationContext, now: Date): CaseDecisionValidation => withTeamPartMention(validate(input, context, now, false), context);

/**
 * SAV-92 (Ugo 14/11): part of this mail is the team's (`context.teamParts`). An accepted answer or question, whatever composed its text (the model, the
 * Access template or the login step), ends with our fixed sentence saying the rest was passed to the team: ONE reply covers the customer's whole message.
 * Idempotent (a stored text already ending with it is kept as is); a text that would exceed the contract is refused, never cut.
 */
function withTeamPartMention(result: CaseDecisionValidation, context: CaseDecisionValidationContext): CaseDecisionValidation {
  if (result.outcome !== "accepted" || !context.teamParts?.length) return result;
  const { decision } = result, reply = decision.reply;
  if (!reply || (decision.nextAction.kind !== "answer" && decision.nextAction.kind !== "ask") || reply.text.trimEnd().endsWith(SAV_CASE_TEAM_PART_MENTION)) return result;
  const text = `${reply.text.trimEnd()}\n\n${SAV_CASE_TEAM_PART_MENTION}`;
  if (text.length > 6000) return { outcome: "needs_review", contractRevision: result.contractRevision, unverified: result.unverified, signals: result.signals,
    rejections: [{ code: "proposal_schema_invalid", label: caseDecisionRejectionLabels.proposal_schema_invalid, path: "reply.text", detail: "team_part_mention_too_long" }] };
  return { ...result, decision: { ...decision, reply: { ...reply, text } } };
}

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
    for (const issue of parsed.error.issues.slice(0, 10)) {
      const tooManyQuestions = issue.path.join(".") === "nextAction.questions" && issue.code === "too_big";
      reject(tooManyQuestions ? "too_many_questions" : "proposal_schema_invalid", issue.path.join("."), tooManyQuestions ? "too_many_questions:max_5" : issue.code);
    }
    return needsReview();
  }
  const proposal = parsed.data, action = proposal.nextAction;
  // SAV-92 (Ugo 17/11): a repeat without new facts is not handed over before ONE re-ask, composed from the case's records and checked like any other
  // proposal. Anything that keeps it from being accepted leaves the hand-over to the rules below, exactly as on main.
  if (action.kind === "handoff" && caseAskBeforeHandoffEnabled()) {
    const reask = caseReaskBeforeHandoff(proposal, context);
    const composedAsk = reask ? validate(reask, context, now, true) : null;
    if (composedAsk?.outcome === "accepted") return { ...composedAsk, signals: ordered(new Set<CaseDecisionSignal>([...composedAsk.signals, "handoff_reask_composed"]), caseDecisionSignalLabels) };
  }

  if (proposal.caseVersion !== context.caseVersion) reject("case_version_stale", "caseVersion", `${proposal.caseVersion}<>${context.caseVersion}`);
  if (context.owner !== "agent" && action.kind !== "observe_only") reject("case_not_agent_owned", "nextAction.kind", context.owner);
  // Owning the case is not enough: an agent action also needs a positive admission for this very version.
  if (action.kind !== "observe_only") {
    const refused = caseAdmissionRefusalCode(context.admission);
    if (refused) reject(refused, "nextAction.kind", context.admission?.admitted === false ? context.admission.reason : undefined);
  }
  if (action.kind === "observe_only" && proposal.reply) reject("observe_only_with_reply", "reply");

  const sources = new Map(context.sources.map(row => [sourceKey(row.ref), row]));
  // The block of a request, for its block's own rules: `access` for the family `access` (the Access block's alone); otherwise the block the multi-block
  // context names, or the one other block whose scope the case is decided under. Null: no block known (no scope given), today's generic checks only.
  const singleBlock = context.accessScope && "blockId" in context.accessScope ? context.accessScope.blockId : null;
  const requestBlockOf = (requestId: string): string | null => {
    if (context.requests.some(request => request.id === requestId && request.family === "access")) return SAV_CASE_ACCESS_BLOCK_ID;
    return context.blockScopes?.requestBlocks[requestId] ?? singleBlock;
  };
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
  // handoff is allowed), never another ordinary one, which would leave the pilot's scope. Treatment blocks (11/11): the same rule
  // with the family of the block's own scope; no scope (null) keeps `access`, so a request of another block is still refused.
  const pilotFamily = context.accessScope?.family ?? "access";
  // SAV-92 (15/11, multi-block): each request keeps the family of ITS block's scope; a request no block names (a team part) one of the mail's block families.
  const blockScopes = context.blockScopes;
  const blockScopeOf = (requestId: string) => { const blockId = blockScopes?.requestBlocks[requestId]; return blockId ? blockScopes!.scopes[blockId] ?? null : null; };
  const allowedFamilies = (requestId: string): readonly string[] => !blockScopes ? [pilotFamily]
    : blockScopeOf(requestId) ? [blockScopeOf(requestId)!.family] : [...new Set(Object.values(blockScopes.scopes).map(scope => scope.family))];
  if (context.accessScope !== undefined) proposal.understanding.requests.forEach((request, index) => {
    if (!allowedFamilies(request.id).includes(request.family) && !isSensitiveCaseFamily(request.family)) reject("pilot_family_out_of_scope", `understanding.requests.${index}.family`, request.family);
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
  // SAV-92 (multi-block): a source shown for these requests must be an `answer` source of the scope of one of them, AND linked to that very request: block A's
  // card never supports block B's request, even when the step or the reply also covers a request of A.
  const requireInScope = (ref: CaseDecisionKnowledgeRef, path: string, requestIds: readonly string[]) => {
    if (blockScopes) {
      const problems = requestIds.map(requestId => {
        const problem = caseAccessSourceProblem(blockScopeOf(requestId), ref);
        if (problem) return problem;
        const linked = !context.coverage || context.coverage.some(row => row.requestId === requestId
          && row.knowledge.some(card => card.knowledgeId === ref.knowledgeId && card.contentVersionId === ref.contentVersionId));
        return linked ? null : "access_source_out_of_scope" as const;
      });
      if (!problems.length || problems.every(Boolean)) reject(problems.find(Boolean) ?? "access_source_out_of_scope", path, ref.knowledgeId);
      return;
    }
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
    // Resolution proof per block (19/11, `case-block-resolution.ts`): a request of a known block is closed only under the proof that block declares, on the
    // customer's latest mail. Access's is its former check, same codes. A block without a proof (or without automatic closure) never closes here.
    const blockId = requestBlockOf(requestId);
    if (blockId !== null) {
      const proof = caseBlockResolutionProof(blockId);
      if (!proof) return reject("resolution_evidence_invalid", path, "block_resolution_proof_missing");
      if (!proof.autoClosure) return reject("resolution_evidence_invalid", path, "block_auto_closure_off");
      const latest = latestCustomerMail(context);
      if (!latest || sourceKey(latest.source) !== sourceKey(source.ref) || !proof.confirms(latest.quote)
        || !proof.confirms(evidence.quote) || !squash(latest.quote).includes(squash(evidence.quote)))
        return reject("resolution_evidence_invalid", path, blockId === SAV_CASE_ACCESS_BLOCK_ID ? "latest_customer_login_not_confirmed" : "latest_customer_not_confirmed");
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

  const smart = smartValidator();
  const alternative = smart && action.kind === "answer" && unusedAlternative(action, context, proposal.reply?.text);
  const reconfirmed = new Set<string>();
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
        if (context.facts.some(fact => fact.key === key) || proposal.understanding.newFacts.some(fact => fact.key === key)) {
          if (!smart || reconfirmed.has(key) || proposal.understanding.newFacts.some(fact => fact.key === key)
            || !legitimateReconfirmation(question, key, context, now)) return reject("question_already_answered", `${seekPath}.factKey`, key);
          reconfirmed.add(key);
        }
        const pending = context.questions.find(row => row.answeredBy === null && row.factKeys.includes(key)
          && !context.sources.some(source => source.direction === "customer_inbound" && at(source.at) > at(row.askedAt)));
        if (pending) reject("question_already_pending", `${seekPath}.factKey`, pending.id);
      });
    });
  }

  if (action.kind === "answer") {
    unverified.add("answer_relevance");
    action.requestIds.forEach((requestId, index) => requireOpenRequest(requestId, `nextAction.requestIds.${index}`));
    // SAV-92 (multi-block): every request the answer covers rests on at least one step whose card is an `answer` source of ITS block, linked to it. A step
    // names no request of its own, so this is what keeps block A's card from answering block B's request inside one combined answer.
    if (blockScopes) action.requestIds.forEach((requestId, index) => {
      const own = action.steps.some(step => !caseAccessSourceProblem(blockScopeOf(requestId), step.knowledge) && (!context.coverage || context.coverage.some(row => row.requestId === requestId
        && row.knowledge.some(card => card.knowledgeId === step.knowledge.knowledgeId && card.contentVersionId === step.knowledge.contentVersionId))));
      if (!own) reject("knowledge_not_linked_to_request", `nextAction.requestIds.${index}`, requestId);
    });
    action.steps.forEach((step, index) => {
      const path = `nextAction.steps.${index}`;
      citeKnowledge(step.knowledge, `${path}.knowledge`);
      requireLink(step.knowledge, action.requestIds, `${path}.knowledge`);
      if (pilot) requireInScope(step.knowledge, `${path}.knowledge`, action.requestIds);
      const attempts = context.trials.filter(trial => action.requestIds.includes(trial.requestId));
      if (smart && (attempts.length >= 2 || (attempts.length > 0 && !alternative)))
        reject("repeated_failed_procedure", `${path}.knowledge`, step.knowledge.knowledgeId);
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
      if (!newer && !alternative) reject("repeated_failed_procedure", `${path}.knowledge`, step.knowledge.knowledgeId);
    });
  }

  // SAV-92 review P2-3: a reply covers EVERY request still open in the case. Each one is answered (`requestIds`), asked about (a question names it), or
  // resolved with evidence in the same proposal; a team part is already `handed_off` by the admission (notice queued, fixed sentence appended), so it is
  // not open here. Otherwise refused: nothing is sent, and the model can correct on its next turn.
  if (action.kind === "answer" || action.kind === "ask") {
    const covered = new Set(action.kind === "answer" ? action.requestIds : action.questions.map(question => question.requestId));
    for (const request of context.requests)
      if (request.status === "open" && status.get(request.id) !== "resolved" && !covered.has(request.id)) reject("proposal_request_uncovered", "nextAction", request.id);
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
  if (!composed && !alternative && !reconfirmed.size && loginRef && outgoing && restates && aboutLogin && thread.complete && thread.scope === "login" && thread.noCode !== false && (confirmedAny || exchanged)) {
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
        return routed.outcome === "accepted" && routed.decision.nextAction.kind === "handoff" ? { ...routed, signals: ordered(new Set<CaseDecisionSignal>([...routed.signals, "login_procedure_refused_routed"]), caseDecisionSignalLabels) } : routed;
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
    // SAV-92 (multi-block): a first-reply template would replace the one reply of several blocks by one request's procedure.
    const template = context.blockScopes ? undefined : context.accessScope?.sources.find(ref => matches(ref) && ref.use === "answer" && ref.firstReply !== undefined);
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
          // Access only (`login_code_steps` is a schema no other block's scope can carry): its template, the login address passed as data.
          reply.text = accessLoginCodeFirstReply({ url: SAV_CASE_ACCESS_URL, spamAdvice: says.spamFolder && thread.spam !== true });
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
      if (pilot) requireInScope(ref, `reply.citations.${index}`, openIds);
    });
    reply.impossibilityClaims.forEach((claim, index) => {
      const path = `reply.impossibilityClaims.${index}`;
      unverified.add("impossibility_statement_support");
      if (!status.has(claim.requestId)) reject("request_reference_unknown", `${path}.requestId`);
      const issue = knowledgeProblem(claim.knowledge);
      if (issue) reject("impossibility_without_valid_source", `${path}.knowledge`, issue.code);
      else requireLink(claim.knowledge, [claim.requestId], `${path}.knowledge`);
      if (pilot) requireInScope(claim.knowledge, `${path}.knowledge`, [claim.requestId]);
    });
    if (reply.accountAdvice === "new_subscription" || reply.accountAdvice === "new_account") reject("account_advice_forbidden", "reply.accountAdvice", reply.accountAdvice);
    if (requestsCredential(reply.text)) reject("credential_request_pattern", "reply.text");
    // SAV-97 (`SAV_V2_ACCESS_SKILL=on` only): the exclude-only kernel on OUR outgoing text; a hit is refused, so the case goes to the team, never to the customer.
    // 19/11: the same kernel, always, when the reply covers a request of a block other than Access (« le noyau dans notre réponse », every block).
    const otherBlock = singleBlock !== null || Object.keys(context.blockScopes?.scopes ?? {}).some(id => id !== SAV_CASE_ACCESS_BLOCK_ID);
    if ((action.kind === "answer" || action.kind === "ask") && (readAccessSkillMode(process.env) === "on" || otherBlock)) {
      const kernel = accessSkillKernelHits(reply.text);
      if (kernel.length) reject("reply_sensitive_wording", "reply.text", kernel.join(","));
    }
    // Pilot: an instruction the case already gave, or a step the customer states they did, is not given again. Our own composition reads the same ledgers and is not re-read.
    if (pilot && !composed && (action.kind === "ask" || action.kind === "answer")) for (const card of context.knowledge) {
      // Only the proven unused step is exempt from the sent-procedure check, never the whole card.
      const unusedSentStep = alternative && action.kind === "answer" && action.steps[0]!.knowledge.knowledgeId === card.id
        ? strings(card.resolution?.steps).indexOf(action.steps[0]!.text) : undefined;
      const repeated = repeatedSteps(reply.text, card, context, unusedSentStep);
      if (repeated.length) reject("procedure_step_repeated", "reply.text", `${card.id}:${repeated.join(",")}`);
    }
    const accessOpen = [...status].some(([requestId, value]) => value === "open" && families.get(requestId) === "access");
    // No context is not proof of a harmless clarification. Only fully recognised
    // observational questions (both action and reply) may omit the destination.
    const clarificationOnly = action.kind === "ask" && reply.citations.length === 0
      && !context.accessScope?.sources.some(source => source.firstReply === "login_code_steps")
      && isAccessClarification(reply.text) && action.questions.every(question => isAccessClarification(question.text));
    if (accessOpen && (action.kind === "ask" || action.kind === "answer")) {
      // Same fail-closed primitive as the shared text control. An exemption must
      // be positively proven; absence of citations or scope alone proves nothing.
      if (accessLinkMissing(reply.text, !clarificationOnly)) reject("access_link_missing", "reply.text");
      for (const link of accessLinks(reply.text).invalid) reject("access_link_invalid", "reply.text", link);
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
