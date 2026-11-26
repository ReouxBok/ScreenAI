import { savCustomerProcedureSteps, savRetrievalCardSizeFixOn } from "../../request-retrieval";
import { caseRequestSearchText, type CaseEvent, type CaseSnapshot } from "../case-types";
import type { CaseDecisionProposal } from "../decision-contract";
import { SAV_CASE_LEXICAL_RECALL } from "../investigation-knowledge";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import type { CaseV2ModelTransport, CaseV2SpendUsage } from "../investigation-v2-spend";
import { SAV_SMART_ENTRY_ADMISSION, savV2EntrySmartOn } from "../smart-entry-switch";
import { runSmartTurn, type SmartKnowledgePort, type SmartThreadMessage, type SmartTurnInput, type SmartTurnPorts, type SmartTurnResult } from "./smart-agent";
import { SAV_SMART_ATTACHMENT_TRACE_CODES, smartCaseAttachments, type SmartFilesBudget } from "./smart-attachments";
import type { SmartSource } from "./smart-checks";
import type { SmartFact, SmartTeamNote } from "./smart-contract";
import { savV2SmartLiveSearchOn, smartLiveKnowledge, type SmartLiveSearch } from "./smart-live-search";
import { smartEmptyMemory, type SmartCaseMemory } from "./smart-memory";
import type { SmartModelPort } from "./smart-model";
import { smartCommercialForwardOn, smartCommercialSet } from "./smart-switch";
import { smartNoRepeatOn, smartWithCardGuidance, type SmartNoRepeat, type SmartSentReply } from "./smart-no-repeat";
import { buildSmartCaseTrace, traceSmartKnowledge, type SmartCaseTraceSink, type SmartTraceSearch } from "./smart-trace";

/*
 * SAV-123 (N8): the smart brain (`runSmartTurn`) as the V2 circuit's decision provider, behind `SAV_V2_ENTRY_SMART=on` and ONLY for a case admitted
 * `smart_support`. Same port as the Gemini provider (`CaseV2ModelTransport`): the runner, its ledger, the V2 money gate, `validateDecision` and
 * everything after it are unchanged. We replace the brain, not the body. Pure: no database, no network of its own, no effect (the model port is injected).
 *
 *   input      the case's latest customer mail and dated thread (`customerContext`, already masked and bounded by the circuit), the memory DERIVED from what
 *              the case already stores (questions asked, trials and their outcome): no new storage, no migration;
 *   knowledge  the cards the circuit's budgeted search already retrieved for this input (`request.knowledge`): the brain searches no index of its own and
 *              pays no embedding, and every card it can cite is one the validator knows (provenance);
 *   feedback   a validator refusal is given back to the brain ONCE, as failed server checks in its decide payload; on the second refusal no brain runs:
 *              the case goes to the team (`repeated_failure`), never a loop;
 *   output     `SmartTurnResult` → `CaseDecisionProposal`: reply → answer (cited cards = steps and citations), ask → question, handoff / team_sensitive →
 *              handoff with the smart note in the report, failed / interrupted → a provider failure (technical wait, never a reply), unknown → handoff.
 * The reply text is the brain's RAW reply: the AI footer is added once, by the circuit's outbound preparation, never here.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Whether this decision call is the smart brain's: switch on AND a case admitted by the smart entry. Anything else keeps the Gemini provider. */
export const isSmartCaseRequest = (request: Pick<CaseInvestigationModelRequest, "snapshot">, env: Env) =>
  savV2EntrySmartOn(env) && request.snapshot.admission?.admission === SAV_SMART_ENTRY_ADMISSION;

const openRequests = (snapshot: CaseSnapshot) => snapshot.body.openRequests.filter(row => row.status === "open");

/**
 * The case memory as the brain reads it, derived from the case's own store (no smart memory is persisted): the customer mails before the latest one
 * (exchanges), the questions we asked (answered when the case recorded an answer) and the trials with their outcome.
 */
export function smartMemoryFromCase(snapshot: CaseSnapshot, events: readonly CaseEvent[], options: Readonly<{ answeredByLaterMail?: boolean }> = {}): SmartCaseMemory {
  const customerMails = events.filter(event => event.direction === "customer_inbound").length;
  // `SAV_V2_SMART_NO_REPEAT=on`: a question is also answered when the customer wrote after it was sent (the case sets `answeredBy` only for a batch of
  // questions with fact keys, never for the brain's single question nor for the follow-up of an answer).
  const answered = (row: CaseSnapshot["body"]["questions"][number]) => Boolean(row.answeredBy)
    || (options.answeredByLaterMail === true && events.some(event => event.direction === "customer_inbound" && Date.parse(event.occurredAt) > Date.parse(row.askedAt)));
  const body = snapshot.body, needOf = (requestId: string) => `n${Math.max(1, Math.min(9, openRequests(snapshot).findIndex(row => row.id === requestId) + 1))}`;
  return {
    ...smartEmptyMemory(Math.max(0, customerMails - 1)),
    questions: body.questions.slice(-4).map((row, index) => ({ needId: "n1", text: row.text, turn: index + 1, answered: answered(row) })),
    trials: body.trials.slice(-6).map((row, index) => ({ id: row.id.slice(0, 10), needId: needOf(row.requestId), what: `Procédure ${row.procedure.knowledgeId}`, cardId: row.procedure.knowledgeId,
      turn: index + 1, result: row.outcome === "succeeded" ? "worked" as const : row.outcome === "failed" ? "failed" as const : "pending" as const })),
  };
}

/** `SmartTurnInput` from the circuit's request: the latest customer mail, the thread before it, the memory derived from the case. Null: no mail to read. */
export function smartTurnInputFromCase(request: CaseInvestigationModelRequest, options: Readonly<{ answeredByLaterMail?: boolean }> = {}): SmartTurnInput | null {
  const latest = request.customerContext?.latestMessage;
  if (!latest?.text.trim()) return null;
  const thread: SmartThreadMessage[] = (request.customerContext?.thread ?? []).map(row => ({ from: row.from, at: row.at, text: row.text }));
  return { subject: latest.subject ?? "", body: latest.text, thread, memory: smartMemoryFromCase(request.snapshot, request.events, options) };
}

/**
 * The brain's knowledge port on the cards the circuit already retrieved: no index, no embedding. Each card may serve every need of this mail.
 * A card the circuit kept by its lexical recall only (`knowledge_lexical_recall` on its request's coverage) is marked low relevance: the model reads
 * « verify before citing » on it (`SMART_LOW_RELEVANCE_NOTE`), and the trace gets the code `lexical_recall`.
 */
export function smartCaseKnowledge(request: Pick<CaseInvestigationModelRequest, "knowledge"> & Partial<Pick<CaseInvestigationModelRequest, "coverage">>): SmartKnowledgePort {
  const recalled = new Set((request.coverage ?? []).filter(row => row.limitations.includes(SAV_CASE_LEXICAL_RECALL))
    .flatMap(row => row.knowledge.map(ref => `${ref.knowledgeId}:${ref.contentVersionId}`)));
  return async needs => {
    const needIds = needs.map(need => need.id);
    const sources: SmartSource[] = request.knowledge.map(card => ({
      ...(recalled.has(`${card.id}:${card.contentVersionId}`) ? { lowRelevance: true } : {}),
      cardId: card.id, version: card.contentVersionId, title: card.title, content: card.content,
      // SAV_RETRIEVAL_CARD_SIZE_FIX on: a procedure card's customer steps, as the V1 planner reads them (never an internal step).
      steps: (savRetrievalCardSizeFixOn() ? savCustomerProcedureSteps(card.resolution) : null)
        ?? (Array.isArray(card.resolution?.steps) ? (card.resolution!.steps as unknown[]).filter((step): step is string => typeof step === "string") : []),
      needIds, validUntil: typeof card.resolution?.validUntil === "string" && card.resolution.validUntil ? card.resolution.validUntil : null,
    }));
    return { status: "ok", sources, codes: [...(sources.length ? ["circuit_cards"] : ["no_circuit_card"]), ...(sources.some(card => card.lowRelevance) ? ["lexical_recall"] : [])] };
  };
}

/** A validator refusal, given to the brain as failed server checks in its decide and correct payloads (codes and our own labels only). */
export function smartModelWithFeedback(model: SmartModelPort, feedback: CaseInvestigationModelRequest["feedback"]): SmartModelPort {
  if (!feedback.length) return model;
  const serverRefusals = feedback.map(row => ({ code: row.code, label: row.label }));
  return call => model(call.kind === "decide" || call.kind === "correct"
    ? { ...call, payload: { ...(call.payload as Record<string, unknown>), serverRefusals } } : call);
}

const cut = (value: string, max: number) => value.trim().slice(0, max);
/** The team note of a thank-you / confirmation mail without request (PR #339 review). Fixed words, the brain's proposed courtesy text when there is one. */
export const SMART_COURTESY_NEED = "Message de remerciement / confirmation, aucune demande.";
export const smartCourtesyNote = (proposed: string | null): SmartTeamNote => ({
  raison: "other", besoin: SMART_COURTESY_NEED,
  compris: proposed ? cut(`Réponse de courtoisie proposée par l'assistant (non envoyée) : ${proposed}`, 800) : "Aucune réponse proposée par l'assistant.",
  verifie: [], essaye: [], hypotheses: [],
  prochaineVerification: "Rien à traiter : clore le dossier ou répondre par une formule de politesse.", ditAuClient: null,
});
const HANDOFF_REASON: Readonly<Record<string, Extract<CaseDecisionProposal["nextAction"], { kind: "handoff" }>["reason"]>> = {
  wants_human: "explicit_human_request", sensitive: "sensitive_request", no_source: "knowledge_missing", pas_de_progres: "repeated_failure", trop_d_echanges: "repeated_failure",
};

/** The handoff proposal: every open request to the team, the smart note in the report (the team notice reads it). */
export function smartHandoffProposal(request: Pick<CaseInvestigationModelRequest, "snapshot" | "knowledge">, input: Readonly<{
  reason: Extract<CaseDecisionProposal["nextAction"], { kind: "handoff" }>["reason"]; note: SmartTeamNote | null; noteText: string | null; cited?: ReadonlyArray<{ cardId: string; version: string }>;
}>): CaseDecisionProposal {
  const open = openRequests(request.snapshot), note = input.note;
  const hypotheses = note ? [
    ...note.hypotheses.map(row => `${row.texte} (${row.statut})`),
    ...note.verifie.map(row => `Vérifié : ${row.fait}${row.source ? ` (source : ${row.source})` : ""}`),
    ...note.essaye.map(row => `Essayé : ${row.quoi} → ${row.resultat || "résultat inconnu"}`),
  ].filter(Boolean).slice(0, 10).map(text => cut(text, 600)) : [];
  const knowledge = (input.cited ?? []).filter(ref => request.knowledge.some(card => card.id === ref.cardId && card.contentVersionId === ref.version))
    .map(ref => ({ knowledgeId: ref.cardId, contentVersionId: ref.version })).slice(0, 10);
  return {
    caseVersion: request.snapshot.version,
    understanding: { requests: open.map(row => ({ id: row.id, summary: cut(caseRequestSearchText(row) || "Demande du client", 600) || "Demande du client", family: row.family, status: "open" as const })), newFacts: [] },
    nextAction: { kind: "handoff", reason: input.reason, requestIds: open.map(row => row.id).slice(0, 6), report: {
      need: cut(note?.besoin || input.noteText || "Demande du client à reprendre par l'équipe.", 1000),
      expected: null, observed: note?.compris?.trim() ? cut(note.compris, 600) : null, trialIds: [], hypotheses,
      missingInformation: [], expectedIntervention: cut(note?.prochaineVerification || "À définir par l'équipe.", 600), knowledge,
    } },
  };
}

/**
 * `SmartTurnResult` → `CaseDecisionProposal`, or null for a technical end (`failed` / `interrupted`: the circuit waits and retries, never a reply).
 * A reply that hands one of its needs to the team, or rests on no card the circuit retrieved, becomes a handoff with the brain's note: the circuit's
 * proposal has one action for the whole mail, and an answer must show a card the validator knows.
 */
export function smartProposalFromTurn(result: SmartTurnResult, request: Pick<CaseInvestigationModelRequest, "snapshot" | "knowledge">): CaseDecisionProposal | null {
  if (result.outcome === "failed" || result.outcome === "interrupted") return null;
  const open = openRequests(request.snapshot), decision = result.decision;
  const handoff = (reason: Extract<CaseDecisionProposal["nextAction"], { kind: "handoff" }>["reason"], note = result.teamNote) =>
    smartHandoffProposal(request, { reason, note, noteText: result.teamNoteText, cited: result.sources });
  if (result.outcome === "team_sensitive") return handoff("sensitive_request");
  const noteReason = (result.teamNote?.raison && HANDOFF_REASON[result.teamNote.raison]) || "diagnosis_out_of_tools";
  if (result.outcome !== "reply" && result.outcome !== "ask") return handoff(noteReason);
  const text = decision?.reply?.trim();
  // PR #339 review: a thank-you or a confirmation without request (the brain's courtesy reply, `understand:no_need`) still goes to the team in production (the
  // circuit has no closing outcome, Ugo decides later between closing silently, a polite reply or the team), but its note says what it is, never « aucune
  // fiche retrouvée ». The proposed courtesy text is given to the team, not sent.
  if (result.reasons.includes("understand:no_need") && !result.reading?.needs.length) return handoff("diagnosis_out_of_tools", smartCourtesyNote(text ?? null));
  // 26/11 (`SAV_V2_SMART_COMMERCIAL_FORWARD`): the turn says every other need is answered or asked; its commercial needs are the only ones handed and
  // leave with the proposal (`commercialPart`), forwarded to sales by the reply passage. Without it, one handed need still hands the whole mail over.
  const commercial = result.commercialForward ? new Set((result.reading?.needs ?? []).filter(need => need.commercial === true).map(need => need.id)) : null;
  const asks = commercial?.size ? (result.commercialForward?.asks ?? []).map(ask => cut(ask, 600)).filter(Boolean).slice(0, 4) : [];
  const commercialPart = asks.length ? { commercialPart: { asks } } : {};
  if (commercial && !asks.length) return handoff(noteReason);
  if (!decision || !text || !open.length || decision.coverage.some(row => row.status === "handed" && !commercial?.has(row.needId))) return handoff(noteReason);
  const understanding = { requests: open.map(row => ({ id: row.id, summary: cut(caseRequestSearchText(row) || "Demande du client", 600) || "Demande du client", family: row.family, status: "open" as const })), newFacts: [] };
  /*
   * SAV-122 (contract v5: a fact's sentence is optional): the step's text, required non-empty by the decision contract. It is INTERNAL only (the
   * team note `caseDecisionNoteText` and the validator; the customer receives `reply.text`, the model's reply untouched): the sentence hint,
   * else the fact's excerpt copied word for word from the card, else the card's title.
   */
  const stepText = (fact: SmartFact) =>
    cut(fact.sentence || fact.excerpt || "", 1000) || cut(request.knowledge.find(card => card.id === fact.cardId && card.contentVersionId === fact.version)?.title ?? "", 1000) || "Étape de la fiche citée";
  const known = (cardId: string | null, version: string | null) => request.knowledge.some(card => card.id === cardId && card.contentVersionId === version);
  const cited = [...new Map(decision.facts.filter(fact => fact.sourceKind === "fiche" && known(fact.cardId, fact.version))
    .map(fact => [`${fact.cardId}:${fact.version}`, { knowledgeId: fact.cardId!, contentVersionId: fact.version!, sentence: stepText(fact) }])).values()];
  const reply = { text: cut(text, 6000), citations: cited.slice(0, 10).map(({ knowledgeId, contentVersionId }) => ({ knowledgeId, contentVersionId })), impossibilityClaims: [], accountAdvice: "none" as const };
  if (result.outcome === "ask") {
    const question = cut(decision.memory.question || text, 600);
    return { caseVersion: request.snapshot.version, understanding, reply, ...commercialPart,
      nextAction: { kind: "ask", questions: open.slice(0, 5).map(row => ({ text: question, requestId: row.id, reducesUncertainty: "Préciser la situation du client avant de répondre.", seeks: [{ kind: "other" as const }] })) } };
  }
  if (!cited.length) return handoff("knowledge_missing", result.teamNote ?? { raison: "no_source", besoin: cut(text, 600) || "Réponse sans fiche retrouvée", compris: "", verifie: [], essaye: [], hypotheses: [],
    prochaineVerification: "La réponse proposée ne s'appuie sur aucune fiche retrouvée par le circuit : vérifier et répondre.", ditAuClient: null });
  return { caseVersion: request.snapshot.version, understanding, reply, ...commercialPart,
    nextAction: { kind: "answer", requestIds: open.map(row => row.id).slice(0, 6), steps: cited.slice(0, 8).map(row => ({ text: row.sentence, knowledge: { knowledgeId: row.knowledgeId, contentVersionId: row.contentVersionId }, newFactIds: [] })),
      expectedResult: "Le client peut reprendre son usage avec les étapes indiquées." } };
}

/** The usage of a whole turn: the sum of its calls, only when every sent call reported a complete usage (otherwise null: the reservation is kept). */
export function smartTurnUsage(result: Pick<SmartTurnResult, "calls">): CaseV2SpendUsage | null {
  const sent = result.calls.filter(call => call.sent);
  if (sent.some(call => !call.usage)) return null;
  return { inputTokens: sent.reduce((sum, call) => sum + call.usage!.inputTokens, 0), outputTokens: sent.reduce((sum, call) => sum + call.usage!.outputTokens, 0) };
}

export type SmartCaseProviderDeps = Readonly<{
  /** The model port of ONE call (production: `smartGeminiModel` on V2's key, model and bounds). */
  model: SmartModelPort;
  env: () => Env; now: () => Date;
  /** The per-call byte cap (`smartInputCap`); null refuses before any call. */
  maxInputBytes: () => number | null;
  academy?: SmartTurnPorts["academy"];
  maxExchanges?: number;
  /** Measurement only (tests, bench): the turn just run. */
  observe?: (result: SmartTurnResult) => void;
  /**
   * Recording only (production: `writeSmartCaseTrace`, an encrypted row with the case): the trace of each real turn (needs, searches, decision,
   * texts, checks, verdicts, calls). Called after the turn; its failure or slowness (bounded) never changes the turn's result.
   */
  trace?: SmartCaseTraceSink;
  /**
   * Smart images: the model, the token allowance of the files one call may carry and the turn's reservation (production: `SAV_V2_MODEL`,
   * `smartAttachmentTokenRoom`, `smartFilesBudget`). Read only for a context the reader granted (`SAV_V2_SMART_ATTACHMENT_IMAGES=on`, smart case);
   * absent: no file is sent (`input_budget`).
   */
  attachmentFit?: () => Readonly<{ model: string; mediaTokens: number; budget: SmartFilesBudget | null }>;
  /**
   * Live search (`SAV_V2_SMART_LIVE_SEARCH=on`, read at each call): the live search of this input for `chercher_fiches` (smart-live-search.ts), and where
   * the cards it found are given to the runner (proven again there at their exact version). Off or absent: the circuit's cards, as before.
   */
  liveSearch?: (request: CaseInvestigationModelRequest) => SmartLiveSearch;
  liveFound?: (callKey: string, refs: ReadonlyArray<{ knowledgeId: string; contentVersionId: string }>) => void;
  /** `SAV_V2_SMART_NO_REPEAT=on` only (production: `readSmartSentReplies`, read only): the confirmed reply mails of the case. Never read when off. */
  sentReplies?: (caseId: string) => Promise<readonly SmartSentReply[]>;
}>;

/**
 * Upper bound of the wait on the trace sink: past it the turn returns, the write is abandoned. A bounded await, not fire-and-forget: on the
 * serverless runtime a promise left running after the response may be frozen or killed, so the write would be lost silently.
 */
export const SAV_SMART_TRACE_WAIT_MS = 1_500;
async function recordSmartTrace(sink: SmartCaseTraceSink | undefined, build: () => Parameters<SmartCaseTraceSink>[0]): Promise<void> {
  if (!sink) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(() => sink(build())), new Promise<void>(resolve => { timer = setTimeout(resolve, SAV_SMART_TRACE_WAIT_MS); })]);
  } catch { /* recording only: never alters the turn */ } finally { if (timer) clearTimeout(timer); }
}

/** `SAV_V2_SMART_NO_REPEAT=on`: the circuit's cards, each with the escalation and exceptions of its structured resolution when its text lacks them. */
function smartCaseKnowledgeWithGuidance(request: Pick<CaseInvestigationModelRequest, "knowledge"> & Partial<Pick<CaseInvestigationModelRequest, "coverage">>): SmartKnowledgePort {
  const port = smartCaseKnowledge(request);
  return async needs => {
    const found = await port(needs);
    return { ...found, sources: found.sources.map(source => smartWithCardGuidance(source, request.knowledge.find(card => card.id === source.cardId && card.contentVersionId === source.version)?.resolution ?? null)) };
  };
}

/** Upper bound of the read of the sent replies; past it, or on a failure, the turn goes on with the thread's own support messages only. */
export const SAV_SMART_SENT_REPLIES_WAIT_MS = 1_500;
async function readSentReplies(read: SmartCaseProviderDeps["sentReplies"], caseId: string): Promise<readonly SmartSentReply[]> {
  if (!read) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(caseId), new Promise<readonly SmartSentReply[]>(resolve => { timer = setTimeout(() => resolve([]), SAV_SMART_SENT_REPLIES_WAIT_MS); })]);
  } catch (error) {
    console.warn("sav_smart_sent_replies_unavailable", { caseId, code: error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message) ? error.message : "read_failed" });
    return [];
  } finally { if (timer) clearTimeout(timer); }
}

/** Validator refusals of one input after which no brain runs again: the second refusal goes to the team (Ugo, 14/11, `SAV_CASE_REFUSALS_BEFORE_HANDOFF`). */
const SECOND_REFUSAL_CALL = 3;

/** The smart brain as the circuit's provider (same port as `caseGeminiDecisionProvider`). A resolution check is never the brain's: it is refused, nothing sent. */
export function smartCaseDecisionProvider(deps: SmartCaseProviderDeps): CaseV2ModelTransport {
  return async request => {
    const none = { inputTokens: 0, outputTokens: 0 };
    if (request.purpose !== "decision") return { result: { status: "failed", uncertain: false, diagnostic: { stage: "preflight", code: "policy_invalid", networkAttempted: false } }, usage: none };
    // Second refusal of the validator for this input: the team, with the refusal codes; no brain, no model call.
    if (request.feedback.length && request.call >= SECOND_REFUSAL_CALL) {
      const output = smartHandoffProposal(request, { reason: "repeated_failure", note: null,
        noteText: `Décision refusée deux fois par le contrôle du serveur (${[...new Set(request.feedback.map(row => row.code))].sort().join(", ")}) : à reprendre par l'équipe.` });
      await recordSmartTrace(deps.trace, () => buildSmartCaseTrace({ request, result: null, proposal: output, searches: [], at: deps.now() }));
      return { result: { status: "ok", output }, usage: none };
    }
    const noRepeatOn = smartNoRepeatOn(deps.env());
    const input = smartTurnInputFromCase(request, noRepeatOn ? { answeredByLaterMail: true } : {}), cap = deps.maxInputBytes();
    if (!input || cap === null) return { result: { status: "failed", uncertain: false, diagnostic: { stage: "preflight", code: input ? "policy_invalid" : "empty_response", networkAttempted: false } }, usage: none };
    const searches: SmartTraceSearch[] = [];
    // Smart images: null unless the reader granted this context (flag on, smart case); then the admitted files, or text only with the reasons.
    const files = smartCaseAttachments(request.customerContext, deps.attachmentFit ?? (() => ({ model: "", mediaTokens: 0, budget: null })));
    const noRepeat: SmartNoRepeat | null = noRepeatOn ? { sent: await readSentReplies(deps.sentReplies, request.caseId) } : null;
    const circuit = noRepeat ? smartCaseKnowledgeWithGuidance(request) : smartCaseKnowledge(request);
    const live = deps.liveSearch && savV2SmartLiveSearchOn(deps.env()) ? smartLiveKnowledge({ circuit, circuitCards: request.knowledge, search: deps.liveSearch(request) }) : null;
    const knowledge = live?.port ?? circuit;
    const result = await runSmartTurn(input, {
      model: smartModelWithFeedback(deps.model, request.feedback), knowledge: deps.trace ? traceSmartKnowledge(knowledge, searches, { query: Boolean(live) }) : knowledge, maxInputBytes: cap, ...(noRepeat ? { noRepeat } : {}),
      today: deps.now().toISOString().slice(0, 10), recordOwn: true, ...(deps.academy ? { academy: deps.academy } : {}), ...(deps.maxExchanges ? { maxExchanges: deps.maxExchanges } : {}),
      ...(files?.turn ? { attachments: files.turn } : {}), ...smartCommercialSet(deps.env()),
      ...(smartCommercialForwardOn(deps.env()) ? { commercialForward: true } : {}),
    });
    deps.observe?.(result);
    // Live search (26/11): the cards a live search found are known to the proposal (citable, titles) and given to the runner, which proves them before validating.
    const found = live?.found() ?? [], seen = found.length ? { ...request, knowledge: [...request.knowledge, ...found] } : request;
    if (found.length) deps.liveFound?.(request.callKey, found.map(card => ({ knowledgeId: card.id, contentVersionId: card.contentVersionId })));
    const usage = smartTurnUsage(result), proposal = smartProposalFromTurn(result, seen);
    const attachments = files ? { admitted: files.trace.admitted, sentWith: result.attachments?.sentWith ?? [],
      refused: [...files.trace.refused, ...(result.attachments?.dropped ?? [])].slice(0, SAV_SMART_ATTACHMENT_TRACE_CODES) } : null;
    await recordSmartTrace(deps.trace, () => buildSmartCaseTrace({ request: seen, result, proposal, searches, at: deps.now(), ...(attachments ? { attachments } : {}) }));
    if (!proposal) return { result: { status: "failed", uncertain: result.calls.some(call => call.uncertain),
      diagnostic: { stage: "content", code: "empty_response", networkAttempted: result.calls.some(call => call.sent) } }, usage };
    return { result: { status: "ok", output: proposal }, usage };
  };
}
