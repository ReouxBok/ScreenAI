import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savActions, savDecisions, savMessages, savProposalReviews, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { savV0EligibleMessageFilter } from "./cutover";
import { encryptSavPayload } from "./crypto";

const requestSchema = z.object({ threadId: z.uuid(), reviewId: z.uuid(), kind: z.enum(["create_ticket", "link_ticket"]), ticketId: z.string().regex(/^\d{1,30}$/).optional(), distinctIssueReason: z.string().trim().max(2_000).default("") });
export async function queueSavManualTicket(raw: unknown, actorEmail: string) {
  assertSavActor(actorEmail);
  const input = requestSchema.parse(raw);
  if (input.kind === "link_ticket" && !input.ticketId) throw new Error("SAV_LINK_TICKET_ID_REQUIRED");
  return requireDb().transaction(async (tx) => {
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, input.threadId)).for("update");
    if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
    if (thread.hubspotTicketId) throw new Error("SAV_TICKET_ALREADY_LINKED");
    const [message] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, thread.id), eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter())).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    if (!message) throw new Error("SAV_MESSAGE_BEFORE_CUTOVER");
    const [review] = await tx.select().from(savProposalReviews).where(and(eq(savProposalReviews.id, input.reviewId), eq(savProposalReviews.messageId, message.id), eq(savProposalReviews.isCurrent, true), eq(savProposalReviews.status, "approved"))).limit(1);
    const [decision] = review ? await tx.select().from(savDecisions).where(and(eq(savDecisions.id, review.decisionId), eq(savDecisions.isCurrent, true))).limit(1) : [];
    if (!review || !decision) throw new Error("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");
    const key = `hubspot:manual-ticket:${thread.id}`;
    const [existing] = await tx.select().from(savActions).where(eq(savActions.idempotencyKey, key)).limit(1);
    if (existing) {
      // A dispatch with unknown outcome is never turned into a fresh command.
      if (existing.payload.ticketCreateDispatchedAt && !existing.payload.hubspotTicketId) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
      if (!["failed", "cancelled"].includes(existing.status)) {
        if (existing.kind !== input.kind || (input.ticketId && existing.payload.ticketId !== input.ticketId)) throw new Error("SAV_TICKET_ACTION_ALREADY_QUEUED");
        if (existing.payload.savReviewId === review.id) return existing;
        if (existing.status !== "pending") throw new Error("SAV_TICKET_ACTION_IN_PROGRESS");
      }
      if (existing.payload.hubspotTicketId) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
    }
    const values = { threadId: thread.id, messageId: message.id, decisionId: review.decisionId, kind: input.kind, status: "pending" as const,
      payload: { savReviewId: review.id, ...(input.ticketId ? { ticketId: input.ticketId } : {}), ...(input.distinctIssueReason ? { distinctIssueReasonCiphertext: encryptSavPayload({ text: input.distinctIssueReason }) } : {}) }, actorType: "human" as const, actorEmail, errorCode: null, scheduledAt: null, updatedAt: new Date() };
    const [action] = existing ? await tx.update(savActions).set(values).where(eq(savActions.id, existing.id)).returning()
      : await tx.insert(savActions).values({ ...values, idempotencyKey: key }).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_manual_ticket_requested", entityType: "sav_action", entityId: action.id, technicalMetadata: { reviewId: review.id, messageId: message.id, kind: input.kind, ticketId: input.ticketId ?? null, distinctIssueConfirmed: input.distinctIssueReason.length >= 20 } });
    return action;
  });
}

export async function assertSavCurrentTicketReview(action: typeof savActions.$inferSelect) {
  if (!action.messageId || !action.decisionId || typeof action.payload.savReviewId !== "string") throw new Error("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");
  const db = requireDb();
  const [review] = await db.select().from(savProposalReviews).where(and(eq(savProposalReviews.id, action.payload.savReviewId), eq(savProposalReviews.messageId, action.messageId), eq(savProposalReviews.decisionId, action.decisionId), eq(savProposalReviews.isCurrent, true), eq(savProposalReviews.status, "approved"))).limit(1);
  const [decision] = await db.select().from(savDecisions).where(and(eq(savDecisions.id, action.decisionId), eq(savDecisions.isCurrent, true))).limit(1);
  const [latest] = await db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, action.threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  if (!review || !decision || latest?.id !== action.messageId) throw new Error("SAV_PROPOSAL_STALE");
  return review;
}
