import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, savActions, savAgentRuns, savDecisions, savLearningCandidates, savMessages, savObservationCycles, savPilotItems, savProposalReviews, savReplyDrafts, savResolutionObservations, savThreads } from "@/db/schema";
import { decryptSavPayload } from "./crypto";
import { savV0EligibleMessageFilter } from "./cutover";
import { buildSavInboxSummary, type SavInboxPartnershipStatus } from "./inbox-summary";
import { savStructuredProposalSchema, mergeSavReviewedProposal, type SavStructuredProposal } from "./proposal";
import { savDraftNotApplicable, savReviewMatchesProposal } from "./review-contract";
import { classifySavDossier, savDashboardNextAction, type SavDossierState, type SavLearningProgress, type SavOpeningState, type SavTicketProgress } from "./dashboard-state";
import type { SavDossierContext } from "./dossier-context";
import { findSavExternalCompletion, hasUnsettledSavHumanAction, savExternalCompletionEvents, savExternalDisposition } from "./external-completion";
import { savDashboardLearningProgress } from "./learning-progress";
import { observeSavOther, readSavOtherConfiguration, type SavOtherObservation } from "./other-observation";
import type { SavMessageBody } from "./service";
import { countSavRead } from "./read-metrics";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";

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
export { savDashboardLearningProgress } from "./learning-progress";
export type SavDashboardRow = {
  threadId: string; messageId: string; receivedAt: Date; fromEmail: string;
  summary: ReturnType<typeof buildSavInboxSummary>; opening: SavOpeningState; state: SavDossierState;
  reviewStatus: string | null; draftStatus: string; replyStatus: string; partnershipStatus: SavInboxPartnershipStatus | null; ticketProgress: SavTicketProgress; learning: SavLearningProgress;
  ticket: { id: string; title: string; status: string } | null; crmStatus: "ready" | "partial" | "error" | "unknown";
  nextAction: string; incident: boolean; technical: boolean;
  handledExternally?: boolean;
  otherObservation?: SavOtherObservation | null;
};
/** One snapshot and one classification predicate for counts and page rows. Private
 * proposal content is decrypted on the server and never returned to the browser. */
export type SavDashboardOptions = { view?: string; query?: string; page?: number; pageSize?: number; sort?: string; threadId?: string };
export type SavDashboardDb = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
/** Reference classifier and bounded projection builder share exactly this code. */
export async function listSavDossierDashboardReference(options: SavDashboardOptions & {
  threadIds?: string[]; db?: SavDashboardDb; capture?: (row: SavDashboardRow, searchText: string) => void;
} = {}) {
  // Internal operator selection; public route parameters do not expose this option.
  if (options.threadId !== undefined && !/^[a-f0-9-]{36}$/i.test(options.threadId)) throw new Error("SAV_THREAD_ID_INVALID");
  const pageSize = Math.min(50, Math.max(1, options.pageSize ?? 25));
  const query = options.query?.trim().slice(0, 200).toLocaleLowerCase("fr") ?? "";
  const requestedPage = Math.max(1, Math.min(100_000, Math.trunc(options.page ?? 1) || 1));
  const view = ["to_process", "to_validate", "learning", "completed", "other", "technical", "incidents"].includes(options.view ?? "") ? options.view! : "to_process";
  const otherConfiguration = readSavOtherConfiguration();
  const read = async (db: SavDashboardDb) => {
    countSavRead("queries");
    const [knowledge] = await db.select({ revisionId: activeKnowledge.revisionId }).from(activeKnowledge).limit(1);
    countSavRead("relatedRows", knowledge ? 1 : 0);
    const counts = { to_process: 0, to_validate: 0, learning: 0, completed: 0, other: 0, technical: 0, incidents: 0 };
    const requestedRows: SavDashboardRow[] = [];
    let lastPageRows: SavDashboardRow[] = [], total = 0;
    let offset = 0;
    while (true) {
      countSavRead("queries");
      const batch = await db.select({ message: savMessages, thread: savThreads, decision: savDecisions, run: savAgentRuns, review: savProposalReviews,
        hasProtectedHistory: otherConfiguration.registry ? sql<boolean>`exists (select 1 from sav.messages correspondence where correspondence.thread_id = ${savThreads.id} and (correspondence.direction <> 'inbound' or lower(btrim(correspondence.from_email)) <> lower(btrim(${savMessages.fromEmail})) or exists (select 1 from sav.proposal_reviews historical_review where historical_review.message_id = correspondence.id)))` : sql<boolean>`true`,
      })
        .from(savMessages).innerJoin(savThreads, eq(savThreads.id, savMessages.threadId))
        .leftJoin(savDecisions, and(eq(savDecisions.messageId, savMessages.id), eq(savDecisions.isCurrent, true)))
        .leftJoin(savAgentRuns, eq(savAgentRuns.id, savDecisions.agentRunId))
        .leftJoin(savProposalReviews, and(eq(savProposalReviews.messageId, savMessages.id), eq(savProposalReviews.isCurrent, true)))
        .leftJoin(savPilotItems, eq(savPilotItems.messageId, savMessages.id))
        .where(and(eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter(), isNull(savPilotItems.id), options.threadId ? eq(savThreads.id, options.threadId) : undefined,
          options.threadIds ? options.threadIds.length ? inArray(savThreads.id, options.threadIds) : sql`false` : undefined,
          sql`${savMessages.id} = (select latest.id from sav.messages latest where latest.thread_id = ${savThreads.id} and latest.direction = 'inbound' order by least(latest.received_at,latest.created_at) desc, latest.created_at desc, latest.id desc limit 1)`))
        .orderBy(options.sort === "oldest" ? asc(savEffectiveReceivedAt) : desc(savEffectiveReceivedAt), options.sort === "oldest" ? asc(savMessages.id) : desc(savMessages.id)).limit(250).offset(offset);
      if (!batch.length) break;
      countSavRead("sourceRows", batch.length);
      const ids = batch.map(r => r.message.id), threads = batch.map(r => r.thread.id);
      const unrecordedIds = batch.filter(row => !row.message.studioOpenedAt).map(row => row.message.id);
      countSavRead("queries", unrecordedIds.length ? 5 : 4);
      const [actions, observations, openingProofs, currentDrafts, completionProofs] = await Promise.all([
        db.select().from(savActions).where(inArray(savActions.threadId, threads)).orderBy(desc(savActions.createdAt), desc(savActions.id)),
        db.select().from(savResolutionObservations).where(inArray(savResolutionObservations.threadId, threads)),
        // Legacy writers can still emit an opening audit during a rolling
        // deployment after the additive migration. Such a proof is not unread.
        unrecordedIds.length ? db.select({ messageId: auditLogs.entityId }).from(auditLogs).where(and(inArray(auditLogs.entityId, unrecordedIds), eq(auditLogs.entityType, "sav_message"), inArray(auditLogs.action, ["sav_email_opened", "sav_dossier_opened"]))) : Promise.resolve([]),
        db.select().from(savReplyDrafts).where(and(inArray(savReplyDrafts.messageId,ids),eq(savReplyDrafts.isCurrent,true))),
        db.select().from(auditLogs).where(and(inArray(auditLogs.entityId, ids), eq(auditLogs.entityType, "sav_message"), inArray(auditLogs.action, savExternalCompletionEvents))),
      ]);
      countSavRead("relatedRows", actions.length + observations.length + openingProofs.length + currentDrafts.length + completionProofs.length);
      if (observations.length) countSavRead("queries");
      const cycles = observations.length ? await db.select().from(savObservationCycles).where(inArray(savObservationCycles.observationId, observations.map(o => o.id))) : [];
      countSavRead("relatedRows", cycles.length);
      const candidateIds = cycles.flatMap(c => c.candidateId ? [c.candidateId] : []);
      const ticketIds = batch.flatMap(row => row.thread.hubspotTicketId ? [row.thread.hubspotTicketId] : []);
      countSavRead("queries");
      const candidates = await db.select({ id: savLearningCandidates.id, status: savLearningCandidates.status, threadId: savLearningCandidates.threadId, hubspotTicketId: savLearningCandidates.hubspotTicketId, sourceRef: savLearningCandidates.sourceRef }).from(savLearningCandidates).where(sql`((${inArray(savLearningCandidates.threadId, threads)} or ${ticketIds.length ? inArray(savLearningCandidates.hubspotTicketId, ticketIds) : sql`false`}) and ${savLearningCandidates.status} = 'pending') or ${candidateIds.length ? inArray(savLearningCandidates.id, candidateIds) : sql`false`}`);
      countSavRead("relatedRows", candidates.length);
      const openedIds = new Set(openingProofs.map(proof => proof.messageId));
      for (const { message, thread, decision, run, review, hasProtectedHistory } of batch) {
        countSavRead("classifiedRows");
        let original: SavStructuredProposal | null = null, proposal: SavStructuredProposal | null = null, reviewStatus: string | null = null;
        let context: SavDossierContext | null = null, draftStatus = "Non disponible";
        let messageBody: SavMessageBody | null = null;
        try {
          const body = decryptSavPayload<SavMessageBody>(message.bodyCiphertext);
          messageBody = body;
          context = body.supportContext?.messageId === message.id ? body.supportContext : null;
          original = run?.proposalCiphertext ? savStructuredProposalSchema.parse(decryptSavPayload(run.proposalCiphertext)) : null;
          proposal = original;
          if (original && decision && run && savReviewMatchesProposal(review, { decisionId: decision.id, agentRunId: run.id, proposal: original, message })) {
            proposal = mergeSavReviewedProposal(original,savStructuredProposalSchema.parse(decryptSavPayload(review!.afterCiphertext)));
            reviewStatus = review!.status;
          }
          if (proposal) {
            const draft = currentDrafts.find(d => d.messageId === message.id);
            const body = draft ? decryptSavPayload<{text:string;origin?:string}>(draft.bodyCiphertext) : null;
            const effective = body?.origin === "human" ? {...proposal,replyDraft:body.text} : proposal;
            const validKnowledge = body?.origin === "human" ? draft!.knowledgeRevision === (knowledge?.revisionId ?? null) : ["not_consulted", "unavailable"].includes(proposal.knowledgeRevision) || proposal.knowledgeRevision === knowledge?.revisionId;
            draftStatus = savDraftNotApplicable(effective) ? "Non prévu" : effective.replyDraft && validKnowledge ? "Suggestion disponible" : "Aucune suggestion";
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
        const ticketProgress = proposal?.humanProcess?.action === "partnership" && partnershipTransferStatus !== "succeeded" ? partnershipTransferStatus === "uncertain" ? "uncertain" : partnershipTransferStatus === "failed" ? "failed" : partnershipTransferStatus === "pending" ? "pending" : "required" : savDashboardTicketProgress(threadActions, message.id, proposal?.decision.kind, thread.hubspotTicketId);
        const learning = savDashboardLearningProgress(observations.filter(o => o.threadId === thread.id), cycles, candidates.filter(c => c.threadId === thread.id || cycles.some(cycle => cycle.candidateId === c.id && observations.some(observation => observation.id === cycle.observationId && observation.threadId === thread.id))));
        const administrative = findSavExternalCompletion(message, completionProofs);
        const handledExternally = !hasUnsettledSavHumanAction(threadActions) && Boolean(administrative && savExternalDisposition(administrative).view === "completed");
        const state = handledExternally ? "completed" : classifySavDossier({ opening, reviewStatus, ticket: ticketProgress, learning });
        const linkedTicket = context?.crm.data?.tickets.find(t => t.id === thread.hubspotTicketId);
        const incident = Boolean(analysisErrorCode || ["failed", "uncertain"].includes(ticketProgress) || partnershipTransferStatus && ["failed", "uncertain"].includes(partnershipTransferStatus));
        const technical = technicalKinds.has(proposal?.decision.kind ?? decision?.kind ?? "");
        const otherObservation = observeSavOther({
          mailboxId: message.mailboxId, fromEmail: message.fromEmail, subject: message.subject, gmailMessageId: message.gmailMessageId, body: messageBody,
          protectedContext: hasProtectedHistory !== false || Boolean(thread.hubspotTicketId || thread.aiPaused || thread.humanRequestedAt
            || review || threadActions.length || observations.some(o => o.threadId === thread.id)
            || candidates.some(c => c.threadId === thread.id) || context?.crm.data?.tickets.length
            || proposal?.routing.kind === "matched" || proposal?.routing.kind === "new"
            || proposal?.humanProcess?.action === "partnership" || ["high", "critical"].includes(proposal?.urgency ?? "")
            || proposal?.understanding?.customerRelationship?.kind === "existing_customer"
            || proposal?.understanding?.requests.some(r => !["non_support", "unknown"].includes(r.nature))),
        }, otherConfiguration.registry);
        const row: SavDashboardRow = { threadId: thread.id, messageId: message.id, receivedAt: message.receivedAt, fromEmail: message.fromEmail, summary, opening, state, reviewStatus, draftStatus, replyStatus, partnershipStatus: partnershipTransferStatus, ticketProgress, learning, incident, technical, handledExternally, otherObservation,
          ticket: thread.hubspotTicketId ? { id: thread.hubspotTicketId, title: linkedTicket?.subject || "Ticket HubSpot", status: linkedTicket?.status === "closed" ? "Fermé" : linkedTicket?.status === "open" ? "Ouvert" : "Statut à actualiser" } : null,
          crmStatus: context?.crm.status ?? "unknown", nextAction: handledExternally ? "Traité hors Studio" : proposal?.humanProcess?.action === "partnership" ? summary.nextAction : state === "completed" && (partnershipTransferStatus || proposal?.understanding?.requests.some(r => r.nature === "partnership")) ? summary.nextAction : savDashboardNextAction({ state, reviewStatus, ticket: ticketProgress, learning, analysisFailed: Boolean(analysisErrorCode) }) };
        const searchText = [row.fromEmail, message.subject, message.preview, summary.title, summary.problem, row.ticket?.title, row.ticket?.id].filter(Boolean).join(" ").toLocaleLowerCase("fr");
        options.capture?.(row, searchText);
        if (query && !searchText.includes(query)) continue;
        if (technical) counts.technical++; else { counts[state]++; if (incident) counts.incidents++; }
        // Observation is additive: business/technical counts and predicates above
        // remain unchanged. A candidate is never removed from its current view.
        if (otherObservation) counts.other++;
        if (view === "other" ? Boolean(otherObservation) : view === "technical" ? technical : view === "incidents" ? !technical && incident : !technical && state === view) {
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
    return { rows: page === requestedPage ? requestedRows : lastPageRows, counts, page, pageSize, total, totalPages, view, otherConfigurationStatus: otherConfiguration.status };
  };
  return options.db ? read(options.db) : requireDb().transaction(read, { isolationLevel: "repeatable read", accessMode: "read only" });
}
