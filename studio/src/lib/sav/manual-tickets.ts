import "server-only";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savActions, savDecisions, savMessages, savProposalReviews, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { savV0EligibleMessageFilter } from "./cutover";
import { loadSavDossierReviewContext } from "./draft-verdicts";
import {savStructuredProposalSchema} from "./proposal";
import type { SavDossierContext } from "./dossier-context";
import { savTicketReturnPlan } from "./ticket-lifecycle";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { assertSavTicketPreview } from "./manual-ticket-preview";
import { SAV_TICKET_RETURN_NOTE_VERSION } from "./ticket-return-note";
import { resolveSavCustomerIdentity } from "./forwarded-identity";

const requestSchema = z.object({ threadId: z.uuid(), reviewId: z.uuid(), kind: z.enum(["create_ticket", "link_ticket"]), ticketId: z.string().regex(/^\d{1,30}$/).optional(), returnOperation: z.enum(["keep", "reactivate", "create"]).optional(), previewToken: z.string().max(40_000).optional(), distinctIssueReason: z.string().trim().max(2_000).default("") });
export async function queueSavManualTicket(raw: unknown, actorEmail: string, verifiedContext?: SavDossierContext) {
  assertSavActor(actorEmail);
  const input = requestSchema.parse(raw);
  if (input.kind === "link_ticket" && !input.ticketId) throw new Error("SAV_LINK_TICKET_ID_REQUIRED");
  return requireDb().transaction(async (tx) => {
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, input.threadId)).for("update");
    if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
    const [message] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, thread.id), eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter())).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    if (!message) throw new Error("SAV_MESSAGE_BEFORE_CUTOVER");
    const messageBody = decryptSavPayload<{ text: string }>(message.bodyCiphertext);
    const customerIdentity = resolveSavCustomerIdentity({ fromEmail: message.fromEmail, body: messageBody.text });
    if (!customerIdentity.email) throw new Error("SAV_FORWARDED_CUSTOMER_UNRESOLVED");
    const [review] = await tx.select().from(savProposalReviews).where(and(eq(savProposalReviews.id, input.reviewId), eq(savProposalReviews.messageId, message.id), eq(savProposalReviews.isCurrent, true), eq(savProposalReviews.status, "approved"))).limit(1);
    const c = review?.reviewScope === "dossier" ? await loadSavDossierReviewContext(message.id, tx) : null;
    const [legacyDecision] = c ? [] : await tx.select().from(savDecisions).where(and(eq(savDecisions.id, review?.decisionId ?? input.reviewId),eq(savDecisions.isCurrent,true))).limit(1);
    const decision = c?.decision ?? legacyDecision;
    if (c?.proposal.humanProcess && !input.previewToken) throw new Error("SAV_TICKET_PREVIEW_EXPIRED");
    if (c && (c.review?.id !== review?.id || !["ticket_pending", "human_review_required"].includes(c.proposal.decision.kind))) throw new Error("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");
    if (!review || !decision || !["ticket_pending","human_review_required"].includes(savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext)).decision.kind)) throw new Error("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");
    const preview = input.previewToken ? assertSavTicketPreview(input.previewToken, actorEmail, input, {
      threadId: thread.id, linkedTicketId: thread.hubspotTicketId, messageId: message.id, receivedAt: message.receivedAt,
      fromEmail: message.fromEmail, subject: message.subject, text: messageBody.text, reviewId: review.id,
      proposal: c?.proposal ?? savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext)),
      context: verifiedContext ?? decryptSavPayload<{ supportContext?: SavDossierContext }>(message.bodyCiphertext).supportContext,
    }) : null;
    let ticketReturn: { ticketId: string; operation: "keep" | "reactivate" | "create"; replacesClosedTicketId?: string; stageId: string | null | undefined; closedAt: string | null | undefined; ownerId?: string } | undefined;
    if (input.returnOperation) {
      const context = verifiedContext ?? decryptSavPayload<{ supportContext?: SavDossierContext }>(message.bodyCiphertext).supportContext;
      if (context?.messageId !== message.id || context.customerIdentity?.email !== customerIdentity.email || context.crm.status !== "ready" || !context.crm.data?.contactId) throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
      const match = context.crm.data.routing;
      const selected = context.crm.data.tickets.find(ticket => ticket.id === input.ticketId);
      if (match.kind !== "matched" || !selected || match.ticketId !== selected.id) throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
      const plan = savTicketReturnPlan(selected, message.receivedAt);
      if (plan.operation !== input.returnOperation || (plan.operation === "create" ? input.kind !== "create_ticket" : input.kind !== "link_ticket")) throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
      if ((plan.operation === "reactivate" || plan.operation === "create") && !selected.ownerId) throw new Error("SAV_TICKET_OWNER_REQUIRED");
      const predecessor = thread.hubspotTicketId && thread.hubspotTicketId !== selected.id
        ? context.crm.data.tickets.find(ticket => ticket.id === thread.hubspotTicketId) : null;
      if (thread.hubspotTicketId && thread.hubspotTicketId !== selected.id && (predecessor?.status !== "closed" || selected.status !== "open")) throw new Error("SAV_TICKET_ALREADY_LINKED");
      ticketReturn = { ...(predecessor ? { replacesClosedTicketId: predecessor.id } : {}), ticketId: selected.id, operation: input.returnOperation, stageId: selected.stageId, closedAt: selected.closedAt,
        ...(selected.ownerId ? { ownerId: selected.ownerId } : {}) };
    }
    if (thread.hubspotTicketId && (!ticketReturn || (ticketReturn.ticketId !== thread.hubspotTicketId && ticketReturn.replacesClosedTicketId !== thread.hubspotTicketId))) throw new Error("SAV_TICKET_ALREADY_LINKED");
    const key = `hubspot:manual-ticket:${thread.id}:${message.id}`;
    // Serialize all intake actions for this thread, including older commands.
    const prior = await tx.select().from(savActions).where(eq(savActions.threadId, thread.id));
    for (const action of prior.filter(a => a.actorType === "human" && ["create_ticket", "link_ticket"].includes(a.kind))) {
      if (action.payload.ticketReturnDispatchedAt && !action.payload.ticketReturnCompletedAt) throw new Error("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED");
      if (action.payload.ticketCreateDispatchedAt && !action.payload.hubspotTicketId) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
      if ((action.messageId !== message.id || action.idempotencyKey !== key) && ["pending", "running"].includes(action.status)) throw new Error("SAV_TICKET_ACTION_IN_PROGRESS");
      if (action.messageId === message.id && action.status === "succeeded") return action;
    }
    const [existing] = await tx.select().from(savActions).where(eq(savActions.idempotencyKey, key)).limit(1);
    if (existing) {
      // A dispatch with unknown outcome is never turned into a fresh command.
      if (existing.payload.ticketCreateDispatchedAt && !existing.payload.hubspotTicketId) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
      if (!["failed", "cancelled"].includes(existing.status)) {
        if (existing.kind !== input.kind || (input.ticketId && existing.payload.ticketId !== input.ticketId) || !isDeepStrictEqual(existing.payload.ticketReturn ?? null, JSON.parse(JSON.stringify(ticketReturn ?? null)))) throw new Error("SAV_TICKET_ACTION_ALREADY_QUEUED");
        if (existing.payload.savReviewId === review.id) return existing;
        if (existing.status !== "pending") throw new Error("SAV_TICKET_ACTION_IN_PROGRESS");
      }
      if (existing.payload.hubspotTicketId) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
    }
    const values = { threadId: thread.id, messageId: message.id, decisionId: decision.id, kind: input.kind, status: "pending" as const,
      payload: { ticketReturnNoteVersion: SAV_TICKET_RETURN_NOTE_VERSION, ...(preview ? { ticketPreviewConfirmed: true, ticketPreviewSnapshotCiphertext: encryptSavPayload(preview.details) } : {}), savReviewId: review.id, previousTicketId: thread.hubspotTicketId, ...(ticketReturn ? { ticketReturn } : {}), ticketReviewSnapshotCiphertext: encryptSavPayload({ reviewId: review.id, decisionId: decision.id, messageId: message.id, threadId: thread.id,
        customerEmail: customerIdentity.email, customerIdentityKind: customerIdentity.kind, proposal: savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext)) }), ...(input.ticketId ? { ticketId: input.ticketId } : {}), ...(input.distinctIssueReason ? { distinctIssueReasonCiphertext: encryptSavPayload({ text: input.distinctIssueReason }) } : {}) }, actorType: "human" as const, actorEmail, errorCode: null, scheduledAt: null, updatedAt: new Date() };
    const [action] = existing ? await tx.update(savActions).set(values).where(eq(savActions.id, existing.id)).returning()
      : await tx.insert(savActions).values({ ...values, idempotencyKey: key }).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_manual_ticket_requested", entityType: "sav_action", entityId: action.id, technicalMetadata: { reviewId: review.id, messageId: message.id, kind: input.kind, ticketId: input.ticketId ?? null, distinctIssueConfirmed: input.distinctIssueReason.length >= 20 } });
    return action;
  });
}

export async function assertSavCurrentTicketReview(action: typeof savActions.$inferSelect) {
  if (!action.messageId || !action.decisionId || typeof action.payload.savReviewId !== "string") throw new Error("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");
  const db = requireDb();
  const [review] = await db.select().from(savProposalReviews).where(and(eq(savProposalReviews.id, action.payload.savReviewId), eq(savProposalReviews.messageId, action.messageId), eq(savProposalReviews.isCurrent, true), eq(savProposalReviews.status, "approved"))).limit(1);
  const [decision] = await db.select().from(savDecisions).where(and(eq(savDecisions.id, action.decisionId), eq(savDecisions.isCurrent, true))).limit(1);
  const [latest] = await db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, action.threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const c = review?.reviewScope === "dossier" ? await loadSavDossierReviewContext(action.messageId) : null;
  if (c?.proposal.humanProcess && action.payload.ticketPreviewConfirmed !== true) throw new Error("SAV_TICKET_PREVIEW_EXPIRED");
  if (!review || !decision || (c ? c.review?.id !== review.id : review.decisionId !== decision.id) || latest?.id !== action.messageId) throw new Error("SAV_PROPOSAL_STALE");
  if(!["ticket_pending","human_review_required"].includes(savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext)).decision.kind))throw new Error("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");
  return review;
}
