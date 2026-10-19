import { ensureSavCaseObservationTx } from "./case-learning";
import "server-only";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, savActions, savAgentRuns, savDecisions, savDraftVerdicts, savMessages, savProposalReviews, savReplyDrafts, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { isSavMessageEligible } from "./cutover";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { savStructuredProposalSchema, mergeSavReviewedProposal } from "./proposal";
import { savReviewMatchesProposal, savDossierSourceHash, savDraftSourceHash, savDraftNotApplicable, savReplyForbidden, savReviewReasonsSchema, savStoredReviewReasons } from "./review-contract";
import { savReleaseStage } from "./config";
import { normalizeSavConfirmationText, SAV_REPLY_CONFIRMATION_TEXT_REVISION } from "./reply-confirmation-text";
type Reader = Pick<ReturnType<typeof requireDb>, "select">;
/** Called under the thread lock for mutations; exact IDs prevent stale forms,
 * content hashes allow only unchanged verdicts to survive a new generation. */
export async function loadSavDossierReviewContext(messageId: string, db: Reader = requireDb()) {
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
    const proposal = matches ? mergeSavReviewedProposal(original, savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext))) : original;
    // Apply sensitive-topic restrictions to the effective human qualification.
    if (savReplyForbidden(proposal)) proposal.replyDraft = null;
    const [knowledge] = await db.select().from(activeKnowledge).limit(1);
    return { message, decision, run, proposal, knowledgeRevision: knowledge?.revisionId ?? null, sourceHash: savDraftSourceHash(proposal, message, knowledge?.revisionId), review: matches ? review : null };
}
/** Ticket intake uses the current human dossier review. Drafts additionally
 * require current knowledge before a verdict or send can be authorized. */
export async function loadSavDraftContext(messageId: string, db: Reader = requireDb()) {
    const context = await loadSavDossierReviewContext(messageId, db);
    if (!["not_consulted", "unavailable"].includes(context.proposal.knowledgeRevision) && context.proposal.knowledgeRevision !== context.knowledgeRevision)
        throw new Error("SAV_KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED");
    return context;
}
const request = z.object({ threadId: z.uuid(), messageId: z.uuid(), decisionId: z.uuid(), agentRunId: z.uuid(), sourceHash: z.string().length(43), expectedVerdictId: z.uuid().nullable(), draftId:z.uuid().optional(), status: z.enum(["accepted", "rejected"]), reason: z.string().trim().max(500).default(""), reasons: savReviewReasonsSchema }).strict();
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
        const [sent] = await tx.select().from(savActions).where(and(eq(savActions.messageId, input.messageId), eq(savActions.kind, "send_reply"), sql`coalesce(${savActions.payload}->>'purpose', '') <> 'partnership_forward'`)).limit(1);
        if (sent?.status === "succeeded" || sent?.payload.replySendDispatchedAt)
            throw new Error("SAV_DRAFT_ALREADY_DISPATCHED");
        const [manual] = input.draftId ? await tx.select().from(savReplyDrafts).where(and(eq(savReplyDrafts.id,input.draftId),eq(savReplyDrafts.threadId,thread.id),eq(savReplyDrafts.messageId,input.messageId),eq(savReplyDrafts.isCurrent,true))) : [];
        const manualBody = manual ? decryptSavPayload<{text:string;origin?:string}>(manual.bodyCiphertext) : null;
        if(input.draftId && (!manual || manualBody?.origin!=="human")) throw new Error("SAV_DRAFT_CONTEXT_CHANGED");
        const c = manual ? await loadSavDossierReviewContext(input.messageId,tx) : await loadSavDraftContext(input.messageId, tx);
        const replyText = manualBody?.text ?? c.proposal.replyDraft;
        const currentHash = manual ? savDraftSourceHash({...c.proposal,replyDraft:replyText},c.message,c.knowledgeRevision) : c.sourceHash;
        if (c.message.threadId !== thread.id || c.decision.id !== input.decisionId || c.run.id !== input.agentRunId || currentHash !== input.sourceHash || manual && manual.sourceHash!==currentHash)
            throw new Error("SAV_DRAFT_CONTEXT_CHANGED");
        if (savReplyForbidden(c.proposal) || !replyText?.trim())
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
                revision: (revision ?? 0) + 1, status: "validated", sourceHash: currentHash, bodyCiphertext: encryptSavPayload({ text: replyText.trim(), ...(manual ? {origin:"human",sourceDraftId:manual.id} : {}) }), createdBy: actorEmail }).returning();
            draftId = draft.id;
        }
        else {
            await tx.update(savReplyDrafts).set({ status: "abandoned" }).where(and(eq(savReplyDrafts.messageId, input.messageId), eq(savReplyDrafts.sourceHash, currentHash), eq(savReplyDrafts.isCurrent, true)));
        }
        const [result] = await tx.insert(savDraftVerdicts).values({ threadId: thread.id, messageId: c.message.id, decisionId: c.decision.id, agentRunId: c.run.id, draftId, sourceHash: currentHash, status: input.status,
            snapshotCiphertext: encryptSavPayload({ proposal: c.proposal, body: replyText, origin:manual ? "human" : "ai", dossierReviewId: c.review?.id ?? null, dossierHash: savDossierSourceHash(c.proposal) }), reasonCiphertext: encryptSavPayload({ text: input.reason, reasons: input.reasons }), reviewedBy: actorEmail }).returning();
        if (input.status === "rejected") await ensureSavCaseObservationTx(tx,c.message.id,"draft_feedback");
        await tx.insert(auditLogs).values({ actorEmail, action: "sav_draft_verdict_recorded", entityType: "sav_draft_verdict", entityId: result.id, technicalMetadata: { status: result.status, reasons: input.reasons.join(","), sourceHash: currentHash, messageId: c.message.id, decisionId: c.decision.id, agentRunId: c.run.id } });
        return result;
    });
}
export async function assertSavAcceptedDraft(draft: typeof savReplyDrafts.$inferSelect, db: Reader = requireDb()) {
    const body=decryptSavPayload<{text:string;origin?:string;confirmationTextRevision?:string}>(draft.bodyCiphertext);
    const manual=body.origin==="human";
    const c = manual ? await loadSavDossierReviewContext(draft.messageId,db) : await loadSavDraftContext(draft.messageId, db);
    const sourceHash=manual ? savDraftSourceHash({...c.proposal,replyDraft:body.text},c.message,c.knowledgeRevision) : c.sourceHash;
    const [verdict] = await db.select().from(savDraftVerdicts).where(and(eq(savDraftVerdicts.messageId, draft.messageId), eq(savDraftVerdicts.isCurrent, true))).limit(1);
    const expectedText = manual ? body.text : draft.status === "send_confirmed" && body.confirmationTextRevision === SAV_REPLY_CONFIRMATION_TEXT_REVISION ? normalizeSavConfirmationText(c.proposal.replyDraft??"") : c.proposal.replyDraft??"";
    if (!draft.sourceHash || (draft.status!=="send_confirmed" && (draft.status!=="validated" || verdict?.status !== "accepted" || verdict.draftId !== draft.id || verdict.sourceHash !== sourceHash)) || draft.sourceHash !== sourceHash || savReplyForbidden(c.proposal) || (!manual && savDraftNotApplicable(c.proposal))
        || savContentHash(decryptSavPayload<{
            text: string;
        }>(draft.bodyCiphertext).text) !== savContentHash(expectedText.trim()))
        throw new Error("SAV_DRAFT_ACCEPTANCE_REQUIRED");
    return c;
}
