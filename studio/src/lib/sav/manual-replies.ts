import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, savActions, savAgentRuns, savDecisions, savMessages, savProposalReviews, savReplyDrafts, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { savAutomationMode, savReleaseStage } from "./config";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { savV0EligibleMessageFilter } from "./cutover";
import { buildSavInboundContext } from "./message-context";
import { renderSavOutboundReply, SAV_REPLY_FORMAT_REVISION } from "./reply-format";

const requestSchema = z.object({ threadId: z.uuid(), draftId: z.uuid() }).strict();

export function assertSavManualReplyEnabled() {
  if (savReleaseStage() !== "v0") throw new Error("SAV_REPLY_MANUAL_INVALID_STAGE");
  if (savAutomationMode() === "shadow" || process.env.SAV_WRITES_DISABLED === "true") throw new Error("SAV_WRITES_DISABLED");
}

/** Send authorization is separate from process/knowledge approval. Never publishes knowledge. */
export async function queueSavManualReply(raw: unknown, actorEmail: string) {
  assertSavActor(actorEmail);
  assertSavManualReplyEnabled();
  const input = requestSchema.parse(raw);
  return requireDb().transaction(async (tx) => {
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, input.threadId)).for("update");
    if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
    // V0 is human-only: pausing the agent must not prevent its owner replying.
    // Keep aiPaused unchanged; this confirmation never resumes automation.
    const [draft] = await tx.select().from(savReplyDrafts).where(and(eq(savReplyDrafts.id, input.draftId), eq(savReplyDrafts.threadId, thread.id), eq(savReplyDrafts.isCurrent, true))).limit(1);
    if (!draft || draft.status === "abandoned") throw new Error("SAV_REPLY_MANUAL_DRAFT_REQUIRED");
    const key = `gmail:manual-reply:${draft.messageId}`;
    const [existing] = await tx.select().from(savActions).where(eq(savActions.idempotencyKey, key)).limit(1);
    // One manual answer per inbound. Unknown delivery must never become another POST.
    // A pending pre-rule action can only be upgraded by a NEW explicit send
    // confirmation. Workers never silently add a footer to an old approval.
    const reconfirmOldPending = existing?.status === "pending" && existing.payload.replyFormatRevision !== SAV_REPLY_FORMAT_REVISION && !existing.payload.replySendDispatchedAt;
    if (existing && !["failed", "cancelled"].includes(existing.status) && !reconfirmOldPending) return existing;
    if (existing?.payload.replySendDispatchedAt) throw new Error("SAV_REPLY_MANUAL_RECONCILIATION_REQUIRED");
    const [source] = await tx.select().from(savMessages).where(eq(savMessages.id, draft.messageId)).limit(1);
    if (!source) throw new Error("SAV_REPLY_MANUAL_CONTEXT_CHANGED");
    const language = buildSavInboundContext({ subject: source.subject, body: decryptSavPayload<{ text: string }>(source.bodyCiphertext).text }).language;
    const outboundText = renderSavOutboundReply(decryptSavPayload<{ text: string }>(draft.bodyCiphertext).text, language);
    const values = { threadId: thread.id, messageId: draft.messageId, decisionId: draft.decisionId,
      kind: "send_reply", actorType: "human", actorEmail, status: "pending", errorCode: null, scheduledAt: null,
      payload: { manualReplyConfirmed: true, studioDraftId: draft.id, bodyCiphertext: draft.bodyCiphertext,
        outboundBodyCiphertext: encryptSavPayload({ text: outboundText }), outboundBodyHash: savContentHash(outboundText), replyFormatRevision: SAV_REPLY_FORMAT_REVISION }, updatedAt: new Date() } as const;
    const [action] = existing ? await tx.update(savActions).set(values).where(eq(savActions.id, existing.id)).returning()
      : await tx.insert(savActions).values({ ...values, idempotencyKey: key }).returning();
    await assertSavCurrentManualReply(action, tx);
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_manual_reply_requested", entityType: "sav_action", entityId: action.id,
      technicalMetadata: { draftId: draft.id, messageId: draft.messageId, reviewId: draft.reviewId, bodyHash: savContentHash(decryptSavPayload<{ text: string }>(draft.bodyCiphertext).text), outboundBodyHash: savContentHash(outboundText), replyFormatRevision: SAV_REPLY_FORMAT_REVISION } });
    return action;
  });
}

/** Re-check immutable body, author and current context just before the Gmail mutation. */
export async function assertSavCurrentManualReply(action: typeof savActions.$inferSelect, db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) {
  if (action.actorType !== "human" || !action.actorEmail || action.payload.manualReplyConfirmed !== true || typeof action.payload.studioDraftId !== "string" || action.payload.followupSequence) throw new Error("SAV_REPLY_MANUAL_APPROVAL_REQUIRED");
  assertSavActor(action.actorEmail);
  const [draft] = await db.select().from(savReplyDrafts).where(and(eq(savReplyDrafts.id, action.payload.studioDraftId), eq(savReplyDrafts.isCurrent, true))).limit(1);
  if (!draft || draft.status === "abandoned" || draft.threadId !== action.threadId || draft.messageId !== action.messageId || draft.decisionId !== action.decisionId || draft.createdBy !== action.actorEmail || draft.bodyCiphertext !== action.payload.bodyCiphertext) throw new Error("SAV_REPLY_MANUAL_DRAFT_CHANGED");
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, action.threadId), eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter())).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const [decision] = await db.select().from(savDecisions).where(and(eq(savDecisions.id, draft.decisionId), eq(savDecisions.isCurrent, true))).limit(1);
  const [run] = await db.select().from(savAgentRuns).where(eq(savAgentRuns.id, draft.agentRunId)).limit(1);
  const [review] = await db.select().from(savProposalReviews).where(and(eq(savProposalReviews.messageId, draft.messageId), eq(savProposalReviews.isCurrent, true))).limit(1);
  const [knowledge] = await db.select().from(activeKnowledge).limit(1);
  if (!message || message.id !== draft.messageId || !message.gmailMessageId || decision?.messageId !== message.id || decision.agentRunId !== draft.agentRunId || run?.messageId !== message.id || run.pilotBatchId || !run.proposalCiphertext || (review?.id ?? null) !== draft.reviewId || (knowledge?.revisionId ?? null) !== draft.knowledgeRevision) throw new Error("SAV_REPLY_MANUAL_CONTEXT_CHANGED");
  const proposal = decryptSavPayload<{ knowledgeRevision: string }>(run.proposalCiphertext);
  if (!["not_consulted", "unavailable"].includes(proposal.knowledgeRevision) && proposal.knowledgeRevision !== knowledge?.revisionId) throw new Error("SAV_KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED");
  const body = decryptSavPayload<{ text: string; headers?: Record<string, string> }>(message.bodyCiphertext);
  if (!/^<[^<>\s]+@[^<>\s]+>$/.test(body.headers?.["message-id"] ?? "")) throw new Error("SAV_REPLY_MANUAL_THREAD_HEADERS_MISSING");
  if (action.payload.replyFormatRevision !== SAV_REPLY_FORMAT_REVISION || typeof action.payload.outboundBodyCiphertext !== "string") throw new Error("SAV_REPLY_MANUAL_FORMAT_RECONFIRM_REQUIRED");
  const outboundText = decryptSavPayload<{ text: string }>(action.payload.outboundBodyCiphertext).text;
  const language = buildSavInboundContext({ subject: message.subject, body: body.text }).language;
  if (outboundText !== renderSavOutboundReply(decryptSavPayload<{ text: string }>(draft.bodyCiphertext).text, language) || action.payload.outboundBodyHash !== savContentHash(outboundText)) throw new Error("SAV_REPLY_MANUAL_OUTBOUND_CHANGED");
  return { draft, message, outboundText };
}
