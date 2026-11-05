import type { CaseEvent, KnowledgeRef } from "./case-types";
import { inboundInteractionId, type CaseReplyProposal } from "./case-effects";
import type { CaseDecisionProposal } from "./decision-contract";
import { caseAccessScopeStampProblem, type CaseAccessScopeStamp } from "./investigation-access-scope";
import type { CaseInvestigationStoredRecord } from "./investigation-record";

/*
 * Contract B → C (SAV-7 → SAV-10), local and OFF: what an accepted, recorded decision proposes, in pole C's own shapes.
 * B fills only what the decision decides: the purpose, the reply text, the question and the team note text. C completes
 * the recipient, subject, inbound message and case version from the stored thread, a person validates C's payload hash
 * as is (SAV-38: accepted or refused, never rewritten here), and C's `decideCaseEffect` gate decides dispatch, hold or
 * cancel on the one existing executor. Pure: nothing is planned, sent or written here.
 */

export type CaseDecisionReplyDraft = Pick<CaseReplyProposal, "purpose" | "text" | "question" | "procedures">;

export type CaseDecisionDraft = {
  caseId: string; inputKey: string;
  /**
   * C's `triggerEventId`, canonical: `inbound:<Gmail id>` of the STORED customer mail the reply answers (C's `inboundInteractionId`), the mail of the
   * input (`in:<event>`) or, after a hand back (`back:<event>`), the last customer mail before it. Never the input key itself: two producers of a reply to
   * the same mail get the same key, a new mail a new one. Null when no stored mail is answered: then there is no reply.
   */
  triggerEventId: string | null;
  /** Case version of the recorded decision, and the decision contract it passed. */
  decidedOn: number; decisionContract: string;
  /** Null when the decision has no reply C can send today; `replyLimit` says why. */
  reply: CaseDecisionReplyDraft | null;
  /** `access_scope_unknown` / `access_scope_changed` (pilot ACCÈS): the scope the decision was validated under is not known, or not the one in force. */
  replyLimit: "no_reply" | "several_questions" | "purpose_not_supported" | "inbound_unknown" | "access_scope_unknown" | "access_scope_changed" | null;
  /** Team note of this interaction (C `buildCaseNoteIntent`), deterministic from the decision. */
  noteText: string;
  /** `reply.citations` only: NOT the list an answer rests on (an answer may cite its sources in its steps alone). */
  citations: KnowledgeRef[];
  /**
   * Every source shown to the customer by this decision (C §13): the knowledge of an answer's steps, the reply's citations
   * and its impossibility claims; one entry per exact version, sorted. The list the pilot scope checks (B-5) and the one C
   * proves at its last look. Empty for a decision that shows no source (a question without advice).
   */
  shownSources: KnowledgeRef[];
  decidedWhileActionsPaused: boolean;
  /** Pilot ACCÈS: the scope the decision was validated under, for C to compare again at its last check before sending. */
  accessScope?: CaseAccessScopeStamp;
};

/** The stored customer mail an input answers, as C's canonical trigger; null when the input names no stored mail. */
export function caseReplyTriggerOf(events: readonly Pick<CaseEvent, "id" | "direction" | "sourceRef">[], inputKey: string): string | null {
  const mail = (event: Pick<CaseEvent, "direction" | "sourceRef"> | undefined) => event?.direction === "customer_inbound" && event.sourceRef.type === "email" ? inboundInteractionId(event.sourceRef.id) : null;
  const [kind, id] = [inputKey.slice(0, inputKey.indexOf(":")), inputKey.slice(inputKey.indexOf(":") + 1)];
  const at = events.findIndex(event => event.id === id);
  if (at < 0) return null;
  if (kind === "in") return mail(events[at]);
  if (kind === "back") return mail(events.slice(0, at).findLast(event => mail(event) !== null));
  return null;
}

/**
 * The draft of the latest recorded decision of one input, on the case's stored events. None for a refused decision or an observation.
 * `pilot`: a consumer in the ACCÈS pilot passes the scope in force now (null when it cannot read one).
 */
export function caseDecisionDraft(caseId: string, stored: CaseInvestigationStoredRecord, events: readonly Pick<CaseEvent, "id" | "direction" | "sourceRef">[],
  pilot?: { accessScope: CaseAccessScopeStamp | null }): CaseDecisionDraft | null {
  const decision = stored.decision;
  if (!decision || decision.validation.outcome !== "accepted") return null;
  const proposal = decision.validation.decision, action = proposal.nextAction;
  if (action.kind === "observe_only") return null;
  let reply: CaseDecisionReplyDraft | null = null, replyLimit: CaseDecisionDraft["replyLimit"] = null;
  const triggerEventId = caseReplyTriggerOf(events, stored.inputKey);
  if (!proposal.reply) replyLimit = "no_reply";
  // C's executor sends a question or an answer; a closing or handoff message waits for its own purpose there.
  else if (action.kind === "answer") {
    const procedures = caseAnswerProcedures(action, decision.coverage);
    reply = { purpose: "answer", text: proposal.reply.text, ...(procedures.length ? { procedures } : {}) };
  }
  else if (action.kind !== "ask") replyLimit = "purpose_not_supported";
  // C records one question per sent reply (its J2 follows it): several questions would leave some untracked and asked again.
  else if (action.questions.length !== 1) replyLimit = "several_questions";
  else {
    const [question] = action.questions;
    reply = { purpose: "question", text: proposal.reply.text,
      question: { id: `${stored.inputKey}:q1`, text: question!.text, factKeys: question!.seeks.flatMap(seek => seek.factKey ? [seek.factKey] : []) } };
  }
  // A reply always answers one stored mail: without it there is nothing C could key or send.
  if (reply && !triggerEventId) { reply = null; replyLimit = "inbound_unknown"; }
  // Pilot ACCÈS (ROOT 3/11): a verdict is used only under the scope it was validated with, still in force. A decision the
  // pilot stamped, or any decision a pilot consumer reads (an older one has no stamp), gives no reply when either is unknown.
  const stamp = decision.accessScope;
  if (stamp !== undefined || pilot !== undefined) {
    const problem = caseAccessScopeStampProblem(stamp, pilot?.accessScope ?? null);
    if (problem) { reply = null; replyLimit = problem; }
  }
  return { caseId, inputKey: stored.inputKey, triggerEventId, decidedOn: decision.caseVersion,
    decisionContract: decision.validation.contractRevision, reply, replyLimit, noteText: caseDecisionNoteText(proposal.nextAction, decision.knowledge),
    citations: proposal.reply ? [...proposal.reply.citations] : [], shownSources: caseShownSources(proposal), decidedWhileActionsPaused: decision.actionsPaused, ...(stamp ? { accessScope: stamp } : {}) };
}

/**
 * What an answer asks the customer to try: one entry per (request, exact card version) of its steps, in the order of the steps. When the record holds the coverage, a card
 * is only tried for the requests it was retrieved for: a step for one request is no attempt on the other. Pure: C records them once the send is confirmed.
 */
export function caseAnswerProcedures(action: Extract<CaseDecisionProposal["nextAction"], { kind: "answer" }>,
  coverage: ReadonlyArray<Readonly<{ requestId: string; knowledge: readonly KnowledgeRef[] }>> | null | undefined): NonNullable<CaseReplyProposal["procedures"]> {
  const covers = (requestId: string, ref: KnowledgeRef) => !coverage || coverage.some(row => row.requestId === requestId
    && row.knowledge.some(card => card.knowledgeId === ref.knowledgeId && card.contentVersionId === ref.contentVersionId));
  const unique = new Map<string, { requestId: string; procedure: KnowledgeRef }>();
  for (const step of action.steps) for (const requestId of action.requestIds) {
    const { knowledgeId, contentVersionId } = step.knowledge;
    if (covers(requestId, step.knowledge)) unique.set(`${requestId}\u0000${knowledgeId}\u0000${contentVersionId}`, { requestId, procedure: { knowledgeId, contentVersionId } });
  }
  return [...unique.values()];
}

/** The sources a decision shows the customer (answer steps, reply citations, impossibility claims), deduplicated by exact version, sorted. */
export function caseShownSources(proposal: Pick<CaseDecisionProposal, "nextAction" | "reply">): KnowledgeRef[] {
  const refs = [...(proposal.nextAction.kind === "answer" ? proposal.nextAction.steps.map(step => step.knowledge) : []),
    ...(proposal.reply?.citations ?? []), ...(proposal.reply?.impossibilityClaims.map(claim => claim.knowledge) ?? [])];
  const unique = new Map(refs.map(ref => [`${ref.knowledgeId}\u0000${ref.contentVersionId}`, { knowledgeId: ref.knowledgeId, contentVersionId: ref.contentVersionId }]));
  return [...unique.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, ref]) => ref);
}

type Action = CaseDecisionProposal["nextAction"];

const ACTION_LABELS: Record<Action["kind"], string> = {
  ask: "Question au client", answer: "Procédure proposée au client", confirm_resolution: "Résolution confirmée par le client",
  handoff: "Transfert à l'équipe", observe_only: "Observation",
};

/** French, deterministic, internal: what the agent decided and on which cards. No text of the customer's message. */
export function caseDecisionNoteText(action: Action, knowledge: readonly KnowledgeRef[]): string {
  const lines = [`Agent SAV V2 — ${ACTION_LABELS[action.kind]} (décision supervisée, à valider).`];
  if (action.kind === "ask") action.questions.forEach(question => lines.push(`Question : ${question.text}`));
  if (action.kind === "answer") action.steps.forEach((step, index) => lines.push(`Étape ${index + 1} : ${step.text} [fiche ${step.knowledge.knowledgeId}@${step.knowledge.contentVersionId}]`));
  if (action.kind === "handoff") {
    lines.push(`Motif : ${action.reason}`, `Besoin : ${action.report.need}`, `Intervention attendue : ${action.report.expectedIntervention}`);
    action.report.missingInformation.forEach(item => lines.push(`Manque : ${item}`));
    action.report.hypotheses.forEach(item => lines.push(`Hypothèse : ${item}`));
  }
  if (knowledge.length) lines.push(`Fiches fournies : ${knowledge.map(ref => `${ref.knowledgeId}@${ref.contentVersionId}`).join(", ")}`);
  return lines.join("\n");
}
