import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, savActions, savAgentRuns, savDecisions, savDraftVerdicts, savLearningCandidates, savMessages, savObservationCycles, savPilotItems, savProposalReviews, savResolutionObservations, savThreads } from "@/db/schema";
import { decryptSavPayload } from "./crypto";
import { savV0EligibleMessageFilter } from "./cutover";
import { buildSavInboxSummary, type SavInboxPartnershipStatus } from "./inbox-summary";
import { savStructuredProposalSchema, type SavStructuredProposal } from "./proposal";
import { savDraftNotApplicable, savDraftSourceHash, savReviewMatchesProposal } from "./review-contract";
import { classifySavDossier, savDashboardNextAction, type SavDashboardView, type SavLearningProgress, type SavOpeningState, type SavTicketProgress } from "./dashboard-state";
import type { SavDossierContext } from "./dossier-context";

const technicalKinds = new Set(["spam", "automatic_reply", "bounce", "internal_notification", "duplicate"]);
type Action = typeof savActions.$inferSelect;
function uncertain(action: Action) {
  return Boolean(action.payload.ticketCreateDispatchedAt && !action.payload.hubspotTicketId || action.payload.ticketReturnDispatchedAt && !action.payload.ticketReturnCompletedAt);
}
export function savDashboardTicketProgress(actions: Action[], messageId: string, decisionKind: string | undefined, linkedId: string | null): SavTicketProgress {
  const tickets = actions.filter(a => a.actorType === "human" && ["create_ticket", "link_ticket"].includes(a.kind));
  if (tickets.some(uncertain)) return "uncertain";
  if (tickets.some(a => ["pending", "running"].includes(a.status))) return "pending";
  if (decisionKind === "no_ticket_needed") return "not_required";
  const current = tickets.find(a => a.messageId === messageId);
  if (current?.status === "succeeded" && linkedId && (current.payload.hubspotTicketId === linkedId || current.payload.ticketId === linkedId)) return "confirmed";
  if (current && ["failed", "cancelled"].includes(current.status)) return "failed";
  return "required";
}
type Observation = typeof savResolutionObservations.$inferSelect;
type Cycle = typeof savObservationCycles.$inferSelect;
export function savDashboardLearningProgress(observations: Observation[], cycles: Cycle[], candidates: Array<{ id: string; status: string; sourceRef?: string }>): SavLearningProgress {
  const states = observations.map((observation): SavLearningProgress => {
    const cycle = cycles.find(c => c.observationId === observation.id && c.cycle === observation.cycle);
    if (observation.state === "waiting_ticket") return "waiting_ticket";
    if (observation.sourceErrors.length || observation.state === "sources_incomplete" || cycle?.qualification === "insufficient_sources") return "incomplete";
    if (!observation.closed) return "collecting";
    if (!observation.closedCatchupUntil || !observation.lastSyncAt || observation.lastSyncAt < observation.closedCatchupUntil) return "catchup";
    if (!cycle?.qualifiedAt || !cycle.qualification || cycle.qualification === "resolved" && !cycle.candidateId) return "qualification";
    if (cycle.candidateId && !["approved", "rejected"].includes(candidates.find(c => c.id === cycle.candidateId)?.status ?? "")) return "candidate";
    return "none";
  });
  // A reusable human dossier review can create learning without a refused
  // draft/observation. Older observation cycles stay excluded from this path.
  if (candidates.some(candidate => candidate.status === "pending" && candidate.sourceRef && !candidate.sourceRef.startsWith("sav-observation:"))) states.push("candidate");
  return (["incomplete", "qualification", "candidate", "waiting_ticket", "collecting", "catchup"] as const).find(state => states.includes(state)) ?? "none";
}
export type SavDashboardRow = {
  threadId: string; messageId: string; receivedAt: Date; fromEmail: string;
  summary: ReturnType<typeof buildSavInboxSummary>; opening: SavOpeningState; state: SavDashboardView;
  reviewStatus: string | null; draftStatus: string; replyStatus: string; partnershipStatus: SavInboxPartnershipStatus | null; ticketProgress: SavTicketProgress; learning: SavLearningProgress;
  ticket: { id: string; title: string; status: string } | null; crmStatus: "ready" | "partial" | "error" | "unknown";
  nextAction: string; incident: boolean; technical: boolean;
};
/** One snapshot and one classification predicate for counts and page rows. Private
 * proposal content is decrypted on the server and never returned to the browser. */
export async function listSavDossierDashboard(options: { view?: string; query?: string; page?: number; pageSize?: number; sort?: string } = {}) {
  const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 25));
  const query = options.query?.trim().slice(0, 200).toLocaleLowerCase("fr") ?? "";
  const requestedPage = Math.max(1, Math.min(100_000, Math.trunc(options.page ?? 1) || 1));
  const view = ["to_process", "to_validate", "learning", "completed", "technical", "incidents"].includes(options.view ?? "") ? options.view! : "to_process";
  return requireDb().transaction(async (db) => {
    const [knowledge] = await db.select({ revisionId: activeKnowledge.revisionId }).from(activeKnowledge).limit(1);
    const counts = { to_process: 0, to_validate: 0, learning: 0, completed: 0, technical: 0, incidents: 0 };
    const requestedRows: SavDashboardRow[] = [];
    let lastPageRows: SavDashboardRow[] = [], total = 0;
    let offset = 0;
    while (true) {
      const batch = await db.select({ message: savMessages, thread: savThreads, decision: savDecisions, run: savAgentRuns, review: savProposalReviews })
        .from(savMessages).innerJoin(savThreads, eq(savThreads.id, savMessages.threadId))
        .leftJoin(savDecisions, and(eq(savDecisions.messageId, savMessages.id), eq(savDecisions.isCurrent, true)))
        .leftJoin(savAgentRuns, eq(savAgentRuns.id, savDecisions.agentRunId))
        .leftJoin(savProposalReviews, and(eq(savProposalReviews.messageId, savMessages.id), eq(savProposalReviews.isCurrent, true)))
        .leftJoin(savPilotItems, eq(savPilotItems.messageId, savMessages.id))
        .where(and(eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter(), isNull(savPilotItems.id),
          sql`${savMessages.id} = (select latest.id from sav.messages latest where latest.thread_id = ${savThreads.id} and latest.direction = 'inbound' order by latest.received_at desc, latest.created_at desc, latest.id desc limit 1)`))
        .orderBy(options.sort === "oldest" ? asc(savMessages.receivedAt) : desc(savMessages.receivedAt), options.sort === "oldest" ? asc(savMessages.id) : desc(savMessages.id)).limit(250).offset(offset);
      if (!batch.length) break;
      const ids = batch.map(r => r.message.id), threads = batch.map(r => r.thread.id);
      const unrecordedIds = batch.filter(row => !row.message.studioOpenedAt).map(row => row.message.id);
      const [actions, observations, verdicts, openingProofs] = await Promise.all([
        db.select().from(savActions).where(inArray(savActions.threadId, threads)).orderBy(desc(savActions.createdAt), desc(savActions.id)),
        db.select().from(savResolutionObservations).where(inArray(savResolutionObservations.threadId, threads)),
        db.select().from(savDraftVerdicts).where(and(inArray(savDraftVerdicts.messageId, ids), eq(savDraftVerdicts.isCurrent, true))),
        // Legacy writers can still emit an opening audit during a rolling
        // deployment after the additive migration. Such a proof is not unread.
        unrecordedIds.length ? db.select({ messageId: auditLogs.entityId }).from(auditLogs).where(and(inArray(auditLogs.entityId, unrecordedIds), eq(auditLogs.entityType, "sav_message"), inArray(auditLogs.action, ["sav_email_opened", "sav_dossier_opened"]))) : Promise.resolve([]),
      ]);
      const cycles = observations.length ? await db.select().from(savObservationCycles).where(inArray(savObservationCycles.observationId, observations.map(o => o.id))) : [];
      const candidateIds = cycles.flatMap(c => c.candidateId ? [c.candidateId] : []);
      const candidates = await db.select({ id: savLearningCandidates.id, status: savLearningCandidates.status, threadId: savLearningCandidates.threadId, sourceRef: savLearningCandidates.sourceRef }).from(savLearningCandidates).where(sql`(${inArray(savLearningCandidates.threadId, threads)} and ${savLearningCandidates.status} = 'pending') or ${candidateIds.length ? inArray(savLearningCandidates.id, candidateIds) : sql`false`}`);
      const openedIds = new Set(openingProofs.map(proof => proof.messageId));
      for (const { message, thread, decision, run, review } of batch) {
        let original: SavStructuredProposal | null = null, proposal: SavStructuredProposal | null = null, reviewStatus: string | null = null;
        let context: SavDossierContext | null = null, draftStatus = "Non disponible";
        try {
          const body = decryptSavPayload<{ text: string; supportContext?: SavDossierContext }>(message.bodyCiphertext);
          context = body.supportContext?.messageId === message.id ? body.supportContext : null;
          original = run?.proposalCiphertext ? savStructuredProposalSchema.parse(decryptSavPayload(run.proposalCiphertext)) : null;
          proposal = original;
          if (original && decision && run && savReviewMatchesProposal(review, { decisionId: decision.id, agentRunId: run.id, proposal: original, message })) {
            proposal = { ...savStructuredProposalSchema.parse(decryptSavPayload(review!.afterCiphertext)), understanding: original.understanding, replyDraft: original.replyDraft, replyAssessment: original.replyAssessment };
            reviewStatus = review!.status;
          }
          if (proposal) {
            const verdict = verdicts.find(v => v.messageId === message.id);
            const validKnowledge = ["not_consulted", "unavailable"].includes(proposal.knowledgeRevision) || proposal.knowledgeRevision === knowledge?.revisionId;
            const currentVerdict = validKnowledge && verdict?.sourceHash === savDraftSourceHash(proposal, message, knowledge?.revisionId);
            draftStatus = savDraftNotApplicable(original!) ? "Non prévu" : currentVerdict ? verdict.status === "accepted" ? "Accepté" : "Refusé" : verdict ? "À revoir" : "À relire";
          }
        } catch { reviewStatus = null; proposal = original; }
        const threadActions = actions.filter(a => a.threadId === thread.id);
        const reply = threadActions.find(a => a.messageId === message.id && a.kind === "send_reply" && a.payload.purpose !== "partnership_forward");
        const replyStatus = !reply ? "Aucun envoi" : reply.status === "succeeded" ? "Email envoyé" : reply.payload.replySendDispatchedAt ? "Envoi à vérifier" : ["pending", "running"].includes(reply.status) ? "Envoi en attente" : "Envoi non confirmé";
        const partnership = threadActions.find(a => a.messageId === message.id && a.kind === "send_reply" && a.payload.purpose === "partnership_forward");
        const partnershipTransferStatus: SavInboxPartnershipStatus | null = !partnership ? null : partnership.status === "succeeded" ? "succeeded" : partnership.payload.forwardDispatchedAt ? "uncertain" : ["pending", "running"].includes(partnership.status) ? "pending" : "failed";
        const analysisErrorCode = message.analysisErrorCode || (run && ["fallback", "failed"].includes(run.status) ? run.errorCode || "SAV_AI_GENERATION_FAILED" : null);
        const summary = buildSavInboxSummary({ subject: message.subject, analysisStatus: message.analysisStatus, analysisErrorCode, hubspotTicketId: thread.hubspotTicketId, proposal, originalProposal: original, reviewStatus, partnershipTransferStatus });
        const opening: SavOpeningState = message.studioOpenedAt || openedIds.has(message.id) ? "opened" : message.studioOpeningTracked ? "unopened" : "unknown";
        const ticketProgress = savDashboardTicketProgress(threadActions, message.id, proposal?.decision.kind, thread.hubspotTicketId);
        const learning = savDashboardLearningProgress(observations.filter(o => o.threadId === thread.id), cycles, candidates.filter(c => c.threadId === thread.id));
        const state = classifySavDossier({ opening, reviewStatus, ticket: ticketProgress, learning });
        const linkedTicket = context?.crm.data?.tickets.find(t => t.id === thread.hubspotTicketId);
        const incident = Boolean(analysisErrorCode || ["failed", "uncertain"].includes(ticketProgress) || partnershipTransferStatus && ["failed", "uncertain"].includes(partnershipTransferStatus));
        const technical = technicalKinds.has(proposal?.decision.kind ?? decision?.kind ?? "");
        const row: SavDashboardRow = { threadId: thread.id, messageId: message.id, receivedAt: message.receivedAt, fromEmail: message.fromEmail, summary, opening, state, reviewStatus, draftStatus, replyStatus, partnershipStatus: partnershipTransferStatus, ticketProgress, learning, incident, technical,
          ticket: thread.hubspotTicketId ? { id: thread.hubspotTicketId, title: linkedTicket?.subject || `Ticket #${thread.hubspotTicketId}`, status: linkedTicket?.status === "closed" ? "Fermé" : linkedTicket?.status === "open" ? "Ouvert" : "Statut à actualiser" } : null,
          crmStatus: context?.crm.status ?? "unknown", nextAction: state === "completed" && (partnershipTransferStatus || proposal?.understanding?.requests.some(r => r.nature === "partnership")) ? summary.nextAction : savDashboardNextAction({ state, reviewStatus, ticket: ticketProgress, learning, analysisFailed: Boolean(analysisErrorCode) }) };
        if (query && ![row.fromEmail, message.subject, message.preview, summary.title, summary.problem, row.ticket?.title, row.ticket?.id].filter(Boolean).join(" ").toLocaleLowerCase("fr").includes(query)) continue;
        if (technical) counts.technical++; else { counts[state]++; if (incident) counts.incidents++; }
        if (view === "technical" ? technical : view === "incidents" ? !technical && incident : !technical && state === view) {
          if (total % pageSize === 0) lastPageRows = [];
          lastPageRows.push(row);
          if (total >= (requestedPage - 1) * pageSize && total < requestedPage * pageSize) requestedRows.push(row);
          total++;
        }
      }
      if (batch.length < 250) break;
      offset += batch.length;
    }
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    return { rows: page === requestedPage ? requestedRows : lastPageRows, counts, page, pageSize, total, totalPages, view };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
