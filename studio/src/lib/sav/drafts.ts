import "server-only";
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, savAgentRuns, savDecisions, savMessages, savProposalReviews, savReplyDrafts, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { savV0EligibleMessageFilter } from "./cutover";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";

const inputSchema = z.object({ threadId: z.uuid(), messageId: z.uuid(), decisionId: z.uuid(), agentRunId: z.uuid(),
  reviewId: z.uuid().nullable(), knowledgeRevision: z.string().nullable(), expectedDraftId: z.uuid().nullable(),
  status: z.enum(["draft", "validated", "abandoned"]), text: z.string().trim().min(1).max(10_000),
}).strict();

// A Studio artefact, deliberately unrelated to the executable actions queue.
export async function saveSavReplyDraft(raw: unknown, actorEmail: string) {
  assertSavActor(actorEmail);
  const input = inputSchema.parse(raw);
  return requireDb().transaction(async (tx) => {
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, input.threadId)).for("update");
    if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
    const [message] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, thread.id), eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter())).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    const [decision] = await tx.select().from(savDecisions).where(and(eq(savDecisions.id, input.decisionId), eq(savDecisions.isCurrent, true))).limit(1);
    const [run] = await tx.select().from(savAgentRuns).where(eq(savAgentRuns.id, input.agentRunId)).limit(1);
    const [review] = message ? await tx.select().from(savProposalReviews).where(and(eq(savProposalReviews.messageId, message.id), eq(savProposalReviews.decisionId, input.decisionId), eq(savProposalReviews.isCurrent, true))).limit(1) : [];
    const [knowledge] = await tx.select().from(activeKnowledge).limit(1);
    if (!message || message.id !== input.messageId || decision?.messageId !== message.id || decision.agentRunId !== input.agentRunId || run?.messageId !== message.id || !run.proposalCiphertext
      || (review?.id ?? null) !== input.reviewId || (knowledge?.revisionId ?? null) !== input.knowledgeRevision) throw new Error("SAV_DRAFT_CONTEXT_CHANGED");
    const proposal = decryptSavPayload<{ knowledgeRevision: string }>(run.proposalCiphertext);
    if (!["not_consulted", "unavailable"].includes(proposal.knowledgeRevision) && proposal.knowledgeRevision !== knowledge?.revisionId) throw new Error("SAV_KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED");
    if (input.status === "validated" && review?.status !== "approved") throw new Error("SAV_DRAFT_PROCESS_APPROVAL_REQUIRED");
    const [current] = await tx.select().from(savReplyDrafts).where(and(eq(savReplyDrafts.threadId, thread.id), eq(savReplyDrafts.isCurrent, true))).limit(1);
    if ((current?.id ?? null) !== input.expectedDraftId) throw new Error("SAV_DRAFT_VERSION_CHANGED");
    const [{ revision }] = await tx.select({ revision: max(savReplyDrafts.revision) }).from(savReplyDrafts).where(eq(savReplyDrafts.threadId, thread.id));
    if (current) await tx.update(savReplyDrafts).set({ isCurrent: false }).where(eq(savReplyDrafts.id, current.id));
    const [draft] = await tx.insert(savReplyDrafts).values({ threadId: thread.id, messageId: message.id, decisionId: decision.id, agentRunId: run.id,
      reviewId: input.reviewId, knowledgeRevision: input.knowledgeRevision, revision: (revision ?? 0) + 1,
      status: input.status, bodyCiphertext: encryptSavPayload({ text: input.text }), createdBy: actorEmail }).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_studio_draft_versioned", entityType: "sav_reply_draft", entityId: draft.id,
      technicalMetadata: { revision: draft.revision, status: draft.status, messageId: message.id, agentRunId: run.id, reviewId: input.reviewId, knowledgeRevision: input.knowledgeRevision, bodyHash: savContentHash(input.text) } });
    return { id: draft.id };
  });
}

export async function getSavReplyDrafts(threadId: string) {
  const db = requireDb();
  const [rows, messages, decisions, reviews, knowledge] = await Promise.all([
    db.select().from(savReplyDrafts).where(eq(savReplyDrafts.threadId, threadId)).orderBy(desc(savReplyDrafts.revision)).limit(50),
    db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1),
    db.select({ id: savDecisions.id }).from(savDecisions).innerJoin(savMessages, eq(savMessages.id, savDecisions.messageId)).where(and(eq(savMessages.threadId, threadId), eq(savDecisions.isCurrent, true))),
    db.select({ id: savProposalReviews.id }).from(savProposalReviews).innerJoin(savMessages, eq(savMessages.id, savProposalReviews.messageId)).where(and(eq(savMessages.threadId, threadId), eq(savProposalReviews.isCurrent, true))),
    db.select({ revisionId: activeKnowledge.revisionId }).from(activeKnowledge).limit(1),
  ]);
  return { knowledgeRevision: knowledge[0]?.revisionId ?? null, versions: rows.map((row) => ({ id: row.id, revision: row.revision, status: row.status, createdAt: row.createdAt, createdBy: row.createdBy,
    text: decryptSavPayload<{ text: string }>(row.bodyCiphertext).text, isCurrent: row.isCurrent,
    stale: row.messageId !== messages[0]?.id || !decisions.some((d) => d.id === row.decisionId) || (row.reviewId ? !reviews.some((r) => r.id === row.reviewId) : reviews.length > 0) || row.knowledgeRevision !== (knowledge[0]?.revisionId ?? null),
  })) };
}
