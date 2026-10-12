import "server-only";
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, savActions, savAgentRuns, savDecisions, savDraftVerdicts, savMessages, savProposalReviews, savReplyDrafts, savResolutionObservations, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { isSavMessageEligible } from "./cutover";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import { savReviewMatchesProposal, savDossierSourceHash, savDraftSourceHash, savDraftNotApplicable, savReviewReasonsSchema, savStoredReviewReasons } from "./review-contract";
import { savReleaseStage } from "./config";
type Reader = Pick<ReturnType<typeof requireDb>, "select">;
/** Called under the thread lock for mutations; exact IDs prevent stale forms,
 * content hashes allow only unchanged verdicts to survive a new generation. */
export async function loadSavDraftContext(messageId: string, db: Reader = requireDb()) {
    const [message] = await db.select().from(savMessages).where(eq(savMessages.id, messageId));
    if (!message)
        throw new Error("SAV_MESSAGE_NOT_FOUND");
    const [latest] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, message.threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    const [decision] = await db.select().from(savDecisions).where(and(eq(savDecisions.messageId, message.id), eq(savDecisions.isCurrent, true))).limit(1);
    const [run] = decision?.agentRunId ? await db.select().from(savAgentRuns).where(eq(savAgentRuns.id, decision.agentRunId)) : [];
    if (latest?.id !== messageId || !decision || run?.messageId !== messageId || run.pilotBatchId || !run.proposalCiphertext)
        throw new Error("SAV_DRAFT_CONTEXT_CHANGED");
    const original = savStructuredProposalSchema.parse(decryptSavPayload(run.proposalCiphertext));
    const [review] = await db.select().from(savProposalReviews).where(and(eq(savProposalReviews.messageId, messageId), eq(savProposalReviews.isCurrent, true))).limit(1);
    const matches = savReviewMatchesProposal(review, { decisionId: decision.id, agentRunId: run.id, proposal: original, message });
    const proposal = matches ? { ...savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext)), replyDraft: original.replyDraft, replyAssessment: original.replyAssessment } : original;
    const [knowledge] = await db.select().from(activeKnowledge).limit(1);
    if (!["not_consulted", "unavailable"].includes(original.knowledgeRevision) && original.knowledgeRevision !== knowledge?.revisionId)
        throw new Error("SAV_KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED");
    return { message, decision, run, proposal, knowledgeRevision: knowledge?.revisionId ?? null, sourceHash: savDraftSourceHash(proposal, message, knowledge?.revisionId), review: matches ? review : null };
}
const request = z.object({ threadId: z.uuid(), messageId: z.uuid(), decisionId: z.uuid(), agentRunId: z.uuid(), sourceHash: z.string().length(43), expectedVerdictId: z.uuid().nullable(), status: z.enum(["accepted", "rejected"]), reason: z.string().trim().max(500).default(""), reasons: savReviewReasonsSchema }).strict();
export async function reviewSavDraft(raw: unknown, actorEmail: string) {
    assertSavActor(actorEmail);
    if (savReleaseStage() !== "v0")
        throw new Error("SAV_DRAFT_INVALID_STAGE");
    const input = request.parse(raw);
    if (!await isSavMessageEligible(input.messageId))
        throw new Error("SAV_MESSAGE_BEFORE_CUTOVER");
    return requireDb().transaction(async (tx) => {
        const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, input.threadId)).for("update");
        if (!thread)
            throw new Error("SAV_THREAD_NOT_FOUND");
        const [sent] = await tx.select().from(savActions).where(and(eq(savActions.messageId, input.messageId), eq(savActions.kind, "send_reply"))).limit(1);
        if (sent?.status === "succeeded" || sent?.payload.replySendDispatchedAt)
            throw new Error("SAV_DRAFT_ALREADY_DISPATCHED");
        const c = await loadSavDraftContext(input.messageId, tx);
        if (c.message.threadId !== thread.id || c.decision.id !== input.decisionId || c.run.id !== input.agentRunId || c.sourceHash !== input.sourceHash)
            throw new Error("SAV_DRAFT_CONTEXT_CHANGED");
        if (savDraftNotApplicable(c.proposal))
            throw new Error("SAV_DRAFT_NOT_APPLICABLE");
        const [current] = await tx.select().from(savDraftVerdicts).where(and(eq(savDraftVerdicts.messageId, input.messageId), eq(savDraftVerdicts.isCurrent, true))).limit(1);
        const same = current?.sourceHash === input.sourceHash && current.status === input.status && current.reviewedBy === actorEmail && decryptSavPayload<{
            text: string;
        }>(current.reasonCiphertext).text === input.reason && JSON.stringify(savStoredReviewReasons(decryptSavPayload<{ reasons?: unknown }>(current.reasonCiphertext).reasons)) === JSON.stringify(input.reasons);
        if (same)
            return current; // exact repeated click: no new version or follow-up
        if ((current?.id ?? null) !== input.expectedVerdictId)
            throw new Error("SAV_DRAFT_VERDICT_STALE");
        if (current)
            await tx.update(savDraftVerdicts).set({ isCurrent: false }).where(eq(savDraftVerdicts.id, current.id));
        let draftId: string | null = null;
        if (input.status === "accepted") {
            const [{ revision }] = await tx.select({ revision: max(savReplyDrafts.revision) }).from(savReplyDrafts).where(eq(savReplyDrafts.threadId, thread.id));
            await tx.update(savReplyDrafts).set({ isCurrent: false }).where(and(eq(savReplyDrafts.threadId, thread.id), eq(savReplyDrafts.isCurrent, true)));
            const [draft] = await tx.insert(savReplyDrafts).values({ threadId: thread.id, messageId: c.message.id, decisionId: c.decision.id, agentRunId: c.run.id, reviewId: c.review?.id ?? null, knowledgeRevision: c.knowledgeRevision,
                revision: (revision ?? 0) + 1, status: "validated", sourceHash: c.sourceHash, bodyCiphertext: encryptSavPayload({ text: c.proposal.replyDraft!.trim() }), createdBy: actorEmail }).returning();
            draftId = draft.id;
        }
        else {
            await tx.update(savReplyDrafts).set({ status: "abandoned" }).where(and(eq(savReplyDrafts.messageId, input.messageId), eq(savReplyDrafts.sourceHash, c.sourceHash), eq(savReplyDrafts.isCurrent, true)));
        }
        const [result] = await tx.insert(savDraftVerdicts).values({ threadId: thread.id, messageId: c.message.id, decisionId: c.decision.id, agentRunId: c.run.id, draftId, sourceHash: c.sourceHash, status: input.status,
            snapshotCiphertext: encryptSavPayload({ proposal: c.proposal, body: c.proposal.replyDraft, dossierReviewId: c.review?.id ?? null, dossierHash: savDossierSourceHash(c.proposal) }), reasonCiphertext: encryptSavPayload({ text: input.reason, reasons: input.reasons }), reviewedBy: actorEmail }).returning();
        if (input.status === "rejected")
            await tx.insert(savResolutionObservations).values({ threadId: thread.id, messageId: c.message.id, verdictId: result.id, hubspotTicketId: thread.hubspotTicketId, state: thread.hubspotTicketId ? "active" : "waiting_ticket" }).onConflictDoNothing();
        await tx.insert(auditLogs).values({ actorEmail, action: "sav_draft_verdict_recorded", entityType: "sav_draft_verdict", entityId: result.id, technicalMetadata: { status: result.status, reasons: input.reasons.join(","), sourceHash: c.sourceHash, messageId: c.message.id, decisionId: c.decision.id, agentRunId: c.run.id } });
        return result;
    });
}
export async function assertSavAcceptedDraft(draft: typeof savReplyDrafts.$inferSelect, db: Reader = requireDb()) {
    const c = await loadSavDraftContext(draft.messageId, db);
    const [verdict] = await db.select().from(savDraftVerdicts).where(and(eq(savDraftVerdicts.messageId, draft.messageId), eq(savDraftVerdicts.isCurrent, true))).limit(1);
    if (!draft.sourceHash || verdict?.status !== "accepted" || verdict.draftId !== draft.id || verdict.sourceHash !== c.sourceHash || draft.sourceHash !== c.sourceHash || savDraftNotApplicable(c.proposal)
        || savContentHash(decryptSavPayload<{
            text: string;
        }>(draft.bodyCiphertext).text) !== savContentHash(c.proposal.replyDraft!.trim()))
        throw new Error("SAV_DRAFT_ACCEPTANCE_REQUIRED");
    return c;
}
