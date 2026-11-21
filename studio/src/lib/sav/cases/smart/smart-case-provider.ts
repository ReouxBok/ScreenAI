import { caseRequestSearchText, type CaseEvent, type CaseSnapshot } from "../case-types";
import type { CaseDecisionProposal } from "../decision-contract";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import type { CaseV2ModelTransport, CaseV2SpendUsage } from "../investigation-v2-spend";
import { SAV_SMART_ENTRY_ADMISSION, savV2EntrySmartOn } from "../smart-entry-switch";
import { runSmartTurn, type SmartKnowledgePort, type SmartThreadMessage, type SmartTurnInput, type SmartTurnPorts, type SmartTurnResult } from "./smart-agent";
import type { SmartSource } from "./smart-checks";
import type { SmartTeamNote } from "./smart-contract";
import { smartEmptyMemory, type SmartCaseMemory } from "./smart-memory";
import type { SmartModelPort } from "./smart-model";

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
export function smartMemoryFromCase(snapshot: CaseSnapshot, events: readonly CaseEvent[]): SmartCaseMemory {
  const customerMails = events.filter(event => event.direction === "customer_inbound").length;
  const body = snapshot.body, needOf = (requestId: string) => `n${Math.max(1, Math.min(9, openRequests(snapshot).findIndex(row => row.id === requestId) + 1))}`;
  return {
    ...smartEmptyMemory(Math.max(0, customerMails - 1)),
    questions: body.questions.slice(-4).map((row, index) => ({ needId: "n1", text: row.text, turn: index + 1, answered: Boolean(row.answeredBy) })),
    trials: body.trials.slice(-6).map((row, index) => ({ id: row.id.slice(0, 10), needId: needOf(row.requestId), what: `Procédure ${row.procedure.knowledgeId}`, cardId: row.procedure.knowledgeId,
      turn: index + 1, result: row.outcome === "succeeded" ? "worked" as const : row.outcome === "failed" ? "failed" as const : "pending" as const })),
  };
}

/** `SmartTurnInput` from the circuit's request: the latest customer mail, the thread before it, the memory derived from the case. Null: no mail to read. */
export function smartTurnInputFromCase(request: CaseInvestigationModelRequest): SmartTurnInput | null {
  const latest = request.customerContext?.latestMessage;
  if (!latest?.text.trim()) return null;
  const thread: SmartThreadMessage[] = (request.customerContext?.thread ?? []).map(row => ({ from: row.from, at: row.at, text: row.text }));
  return { subject: latest.subject ?? "", body: latest.text, thread, memory: smartMemoryFromCase(request.snapshot, request.events) };
}

/** The brain's knowledge port on the cards the circuit already retrieved: no index, no embedding. Each card may serve every need of this mail. */
export function smartCaseKnowledge(request: Pick<CaseInvestigationModelRequest, "knowledge">): SmartKnowledgePort {
  return async needs => {
    const needIds = needs.map(need => need.id);
    const sources: SmartSource[] = request.knowledge.map(card => ({
      cardId: card.id, version: card.contentVersionId, title: card.title, content: card.content,
      steps: Array.isArray(card.resolution?.steps) ? (card.resolution!.steps as unknown[]).filter((step): step is string => typeof step === "string") : [],
      needIds, validUntil: typeof card.resolution?.validUntil === "string" && card.resolution.validUntil ? card.resolution.validUntil : null,
    }));
    return { status: "ok", sources, codes: sources.length ? ["circuit_cards"] : ["no_circuit_card"] };
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
  if (!decision || !text || !open.length || decision.coverage.some(row => row.status === "handed")) return handoff(noteReason);
  const understanding = { requests: open.map(row => ({ id: row.id, summary: cut(caseRequestSearchText(row) || "Demande du client", 600) || "Demande du client", family: row.family, status: "open" as const })), newFacts: [] };
  const known = (cardId: string | null, version: string | null) => request.knowledge.some(card => card.id === cardId && card.contentVersionId === version);
  const cited = [...new Map(decision.facts.filter(fact => fact.sourceKind === "fiche" && known(fact.cardId, fact.version))
    .map(fact => [`${fact.cardId}:${fact.version}`, { knowledgeId: fact.cardId!, contentVersionId: fact.version!, sentence: fact.sentence }])).values()];
  const reply = { text: cut(text, 6000), citations: cited.slice(0, 10).map(({ knowledgeId, contentVersionId }) => ({ knowledgeId, contentVersionId })), impossibilityClaims: [], accountAdvice: "none" as const };
  if (result.outcome === "ask") {
    const question = cut(decision.memory.question || text, 600);
    return { caseVersion: request.snapshot.version, understanding, reply,
      nextAction: { kind: "ask", questions: open.slice(0, 5).map(row => ({ text: question, requestId: row.id, reducesUncertainty: "Préciser la situation du client avant de répondre.", seeks: [{ kind: "other" as const }] })) } };
  }
  if (!cited.length) return handoff("knowledge_missing", result.teamNote ?? { raison: "no_source", besoin: cut(text, 600) || "Réponse sans fiche retrouvée", compris: "", verifie: [], essaye: [], hypotheses: [],
    prochaineVerification: "La réponse proposée ne s'appuie sur aucune fiche retrouvée par le circuit : vérifier et répondre.", ditAuClient: null });
  return { caseVersion: request.snapshot.version, understanding, reply,
    nextAction: { kind: "answer", requestIds: open.map(row => row.id).slice(0, 6), steps: cited.slice(0, 8).map(row => ({ text: cut(row.sentence, 1000), knowledge: { knowledgeId: row.knowledgeId, contentVersionId: row.contentVersionId }, newFactIds: [] })),
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
}>;

/** Validator refusals of one input after which no brain runs again: the second refusal goes to the team (Ugo, 14/11, `SAV_CASE_REFUSALS_BEFORE_HANDOFF`). */
const SECOND_REFUSAL_CALL = 3;

/** The smart brain as the circuit's provider (same port as `caseGeminiDecisionProvider`). A resolution check is never the brain's: it is refused, nothing sent. */
export function smartCaseDecisionProvider(deps: SmartCaseProviderDeps): CaseV2ModelTransport {
  return async request => {
    const none = { inputTokens: 0, outputTokens: 0 };
    if (request.purpose !== "decision") return { result: { status: "failed", uncertain: false, diagnostic: { stage: "preflight", code: "policy_invalid", networkAttempted: false } }, usage: none };
    // Second refusal of the validator for this input: the team, with the refusal codes; no brain, no model call.
    if (request.feedback.length && request.call >= SECOND_REFUSAL_CALL)
      return { result: { status: "ok", output: smartHandoffProposal(request, { reason: "repeated_failure", note: null,
        noteText: `Décision refusée deux fois par le contrôle du serveur (${[...new Set(request.feedback.map(row => row.code))].sort().join(", ")}) : à reprendre par l'équipe.` }) }, usage: none };
    const input = smartTurnInputFromCase(request), cap = deps.maxInputBytes();
    if (!input || cap === null) return { result: { status: "failed", uncertain: false, diagnostic: { stage: "preflight", code: input ? "policy_invalid" : "empty_response", networkAttempted: false } }, usage: none };
    const result = await runSmartTurn(input, {
      model: smartModelWithFeedback(deps.model, request.feedback), knowledge: smartCaseKnowledge(request), maxInputBytes: cap,
      today: deps.now().toISOString().slice(0, 10), recordOwn: true, ...(deps.academy ? { academy: deps.academy } : {}), ...(deps.maxExchanges ? { maxExchanges: deps.maxExchanges } : {}),
    });
    deps.observe?.(result);
    const usage = smartTurnUsage(result), proposal = smartProposalFromTurn(result, request);
    if (!proposal) return { result: { status: "failed", uncertain: result.calls.some(call => call.uncertain),
      diagnostic: { stage: "content", code: "empty_response", networkAttempted: result.calls.some(call => call.sent) } }, usage };
    return { result: { status: "ok", output: proposal }, usage };
  };
}
