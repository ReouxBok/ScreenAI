import "server-only";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, savAgentRuns, savDecisions, savLearningCandidates, savMessages, savProposalReviews, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { isSavMessageEligible } from "./cutover";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { publicKnowledgeText } from "@/lib/knowledge/conversion";
import { savStructuredProposalSchema, type SavStructuredProposal } from "./proposal";
import { decisionKindSchema } from "./policy";

const verdict = z.enum(["correct", "partial", "incorrect", "critical"]);
export const proposalReviewSchema = z.object({
  messageId: z.uuid(), decisionId: z.uuid(), agentRunId: z.uuid(), expectedReviewId: z.uuid().nullable(),
  status: z.enum(["approved", "rejected"]), verdict,
  dimensions: z.object({ classification: verdict, routing: verdict, grounding: verdict, tone: verdict, escalation: verdict }),
  comment: z.string().trim().min(10).max(4_000),
  reusability: z.enum(["none", "tone_only", "customer_specific", "reusable"]),
  reusableResolution: z.string().trim().max(10_000).default(""), justification: z.string().trim().max(2_000).default(""),
  correction: z.object({ category: savStructuredProposalSchema.shape.category, urgency: savStructuredProposalSchema.shape.urgency,
    decisionKind: decisionKindSchema, reasonCode: z.string().trim().min(3).max(100), explanation: z.string().trim().min(10).max(2_000),
    title: z.string().trim().min(3).max(500), description: z.string().trim().min(1).max(100_000),
    process: savStructuredProposalSchema.shape.process,
    internalNote: z.string().trim().max(10_000), replyDraft: z.string().trim().max(10_000),
    registrationEmail: z.union([z.email(), z.literal("")]).default(""), identityVerified: z.boolean().default(false),
  }),
}).strict().superRefine((value, ctx) => {
  if (value.reusability === "reusable" && (value.reusableResolution.length < 20 || value.justification.length < 20)) ctx.addIssue({ code: "custom", message: "SAV_REUSABILITY_QUALIFICATION_REQUIRED" });
  if (value.correction.registrationEmail && !value.correction.identityVerified) ctx.addIssue({ code: "custom", message: "SAV_CUSTOMER_IDENTITY_VERIFICATION_REQUIRED" });
});

export async function getSavProposalReview(messageId: string) {
  if (!await isSavMessageEligible(messageId)) return null;
  const db = requireDb();
  const [decision] = await db.select().from(savDecisions).where(and(eq(savDecisions.messageId, messageId), eq(savDecisions.isCurrent, true))).limit(1);
  if (!decision?.agentRunId) return null;
  const [run] = await db.select().from(savAgentRuns).where(and(eq(savAgentRuns.id, decision.agentRunId), eq(savAgentRuns.messageId, messageId))).limit(1);
  if (!run?.proposalCiphertext) return null;
  const before = savStructuredProposalSchema.parse(decryptSavPayload(run.proposalCiphertext));
  const [review] = await db.select().from(savProposalReviews).where(and(eq(savProposalReviews.messageId, messageId), eq(savProposalReviews.decisionId, decision.id), eq(savProposalReviews.isCurrent, true))).limit(1);
  return { decisionId: decision.id, agentRunId: run.id, model: run.model, promptRevision: run.promptRevision, before,
    proposal: review ? savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext)) : before,
    review: review ? { id: review.id, status: review.status, verdict: review.verdict, dimensions: review.dimensions, reviewedBy: review.reviewedBy, reviewedAt: review.reviewedAt, comment: decryptSavPayload<{ text: string }>(review.commentCiphertext).text, reusability: review.reusability } : null };
}

export async function getSavReviewSummary() {
  return requireDb().select({ model: savAgentRuns.model, promptRevision: savAgentRuns.promptRevision,
    reviewed: sql<number>`count(*)::int`, correct: sql<number>`count(*) filter (where ${savProposalReviews.verdict} = 'correct')::int`,
    partial: sql<number>`count(*) filter (where ${savProposalReviews.verdict} = 'partial')::int`, incorrect: sql<number>`count(*) filter (where ${savProposalReviews.verdict} = 'incorrect')::int`, critical: sql<number>`count(*) filter (where ${savProposalReviews.verdict} = 'critical')::int`,
    latestAt: max(savProposalReviews.reviewedAt),
  }).from(savProposalReviews).innerJoin(savAgentRuns, eq(savAgentRuns.id, savProposalReviews.agentRunId))
    .where(eq(savProposalReviews.isCurrent, true)).groupBy(savAgentRuns.model, savAgentRuns.promptRevision)
    .orderBy(desc(max(savProposalReviews.reviewedAt))).limit(20);
}

export async function reviewSavProposal(raw: unknown, actorEmail: string) {
  assertSavActor(actorEmail);
  const input = proposalReviewSchema.parse(raw);
  if (!await isSavMessageEligible(input.messageId)) throw new Error("SAV_MESSAGE_BEFORE_CUTOVER");
  return requireDb().transaction(async (tx) => {
    const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, input.messageId)).for("update");
    if (!message) throw new Error("SAV_MESSAGE_NOT_FOUND");
    const [latest] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, message.threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    const [decision] = await tx.select().from(savDecisions).where(and(eq(savDecisions.id, input.decisionId), eq(savDecisions.messageId, message.id), eq(savDecisions.isCurrent, true))).limit(1);
    const [run] = await tx.select().from(savAgentRuns).where(and(eq(savAgentRuns.id, input.agentRunId), eq(savAgentRuns.messageId, message.id))).limit(1);
    if (latest?.id !== message.id || !decision || decision.agentRunId !== run?.id || !run?.proposalCiphertext) throw new Error("SAV_PROPOSAL_STALE");
    const [current] = await tx.select().from(savProposalReviews).where(and(eq(savProposalReviews.messageId, message.id), eq(savProposalReviews.isCurrent, true))).limit(1);
    if ((current?.id ?? null) !== input.expectedReviewId) throw new Error("SAV_REVIEW_STALE");
    const before = savStructuredProposalSchema.parse(decryptSavPayload(run.proposalCiphertext));
    const [knowledge] = await tx.select().from(activeKnowledge).limit(1);
    if (!["not_consulted", "unavailable"].includes(before.knowledgeRevision) && before.knowledgeRevision !== knowledge?.revisionId) throw new Error("SAV_KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED");
    const after: SavStructuredProposal = savStructuredProposalSchema.parse({ ...before, category: input.correction.category, urgency: input.correction.urgency,
      decision: { ...before.decision, kind: input.correction.decisionKind, reasonCode: input.correction.reasonCode, explanation: input.correction.explanation },
      ticket: { title: input.correction.title, description: input.correction.description }, process: input.correction.process,
      replyDraft: input.correction.replyDraft || null, internalNote: input.correction.internalNote || null,
      customerIdentity: { registrationEmail: input.correction.registrationEmail || null, verifiedByHuman: Boolean(input.correction.registrationEmail && input.correction.identityVerified) },
    });
    const sourceIds = new Set(before.sources.map((source) => source.sourceId));
    const reviewedProcess = ({ category, urgency, decision, ticket, process, replyDraft, customerIdentity }: SavStructuredProposal) => ({ category, urgency, decision, ticket, process, replyDraft, customerIdentity });
    if (input.status === "approved" && (input.verdict === "critical" || Object.values(input.dimensions).includes("critical")) && savContentHash(reviewedProcess(before)) === savContentHash(reviewedProcess(after))) throw new Error("SAV_CRITICAL_PROPOSAL_CORRECTION_REQUIRED");
    if (before.routing.kind === "matched") sourceIds.add(before.routing.ticketId);
    if (after.process.some((step) => step.sourceIds.some((id) => !sourceIds.has(id)))) throw new Error("SAV_REVIEW_SOURCE_UNKNOWN");
    const [{ lastRevision }] = await tx.select({ lastRevision: max(savProposalReviews.revision) }).from(savProposalReviews).where(eq(savProposalReviews.messageId, message.id));
    if (current) await tx.update(savProposalReviews).set({ isCurrent: false }).where(eq(savProposalReviews.id, current.id));
    const [review] = await tx.insert(savProposalReviews).values({ messageId: message.id, decisionId: decision.id, agentRunId: run.id, revision: (lastRevision ?? 0) + 1,
      status: input.status, verdict: input.verdict, dimensions: input.dimensions, beforeCiphertext: encryptSavPayload(before), afterCiphertext: encryptSavPayload(after),
      commentCiphertext: encryptSavPayload({ text: input.comment, justification: input.justification }), reusability: input.reusability, reviewedBy: actorEmail }).returning();
    if (input.reusability === "reusable") {
      const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, message.threadId)).limit(1);
      const resolution = publicKnowledgeText(input.reusableResolution);
      await tx.insert(savLearningCandidates).values({ threadId: message.threadId, hubspotTicketId: thread?.hubspotTicketId,
        sourceRef: `sav-review:${review.id}`, sourceContentHash: savContentHash({ reviewId: review.id, resolution }),
        proposedPatch: { ciphertext: encryptSavPayload({ subject: publicKnowledgeText(message.subject), finalHumanResolution: resolution, sourceSnapshotId: `review:${review.id}`, sourceMessageId: message.id,
          provenance: "human_resolution", customerConfirmed: false, agentRunId: run.id, decisionId: decision.id, reviewId: review.id, reusabilityJustification: publicKnowledgeText(input.justification) }) },
        explanation: publicKnowledgeText(input.justification), evidenceTicketIds: thread?.hubspotTicketId ? [thread.hubspotTicketId] : [], createdBy: "human",
      }).onConflictDoNothing();
    }
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_proposal_reviewed", entityType: "sav_proposal_review", entityId: review.id,
      technicalMetadata: { messageId: message.id, decisionId: decision.id, agentRunId: run.id, verdict: review.verdict, status: review.status, reusability: input.reusability, beforeHash: savContentHash(before), afterHash: savContentHash(after) } });
    return { id: review.id };
  });
}
