import "server-only";
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, savActions, savAgentRuns, savDecisions, savMessages, savMessageTranslations, savProposalReviews, savReplyDrafts, savThreads } from "@/db/schema";
import { SAV_TRANSLATOR_REVISION } from "./translations";
import { assertSavActor } from "./access";
import { assertSavAcceptedDraft, loadSavDraftContext, loadSavDossierReviewContext } from "./draft-verdicts";
import { isSavCaseLearningFrozen, savAutomationMode, savReleaseStage } from "./config";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { savV0EligibleMessageFilter } from "./cutover";
import { savDraftSourceHash, savReplyForbidden } from "./review-contract";
import { savReplyLanguage } from "./reply-language";
import { renderSavOutboundReply, SAV_REPLY_FORMAT_REVISION, savManualReplyMode } from "./reply-format";

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
  return requireDb().transaction(tx => queueSavManualReplyTx(input,actorEmail,tx));
}
type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
async function queueSavManualReplyTx(input:z.infer<typeof requestSchema>,actorEmail:string,tx:Tx,confirmation?:{hash:string;recipient:string}) {
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
    const context = await assertSavAcceptedDraft(draft, tx);
    const source = context.message;
    if (!source) throw new Error("SAV_REPLY_MANUAL_CONTEXT_CHANGED");
    const language = savReplyLanguage(context.proposal, decryptSavPayload<{ text: string }>(source.bodyCiphertext).text);
    const outboundText = renderSavOutboundReply(decryptSavPayload<{ text: string }>(draft.bodyCiphertext).text, language, savManualReplyMode(decryptSavPayload<{ origin?: string }>(draft.bodyCiphertext).origin));
    const values = { threadId: thread.id, messageId: draft.messageId, decisionId: context.decision.id,
      kind: "send_reply", actorType: "human", actorEmail, status: "pending", errorCode: null, scheduledAt: null,
      payload: { ...(confirmation ? {confirmationHash:confirmation.hash,confirmedRecipient:confirmation.recipient,confirmedAt:new Date().toISOString()} : {}), manualReplyConfirmed: true, studioDraftId: draft.id, bodyCiphertext: draft.bodyCiphertext,
        outboundBodyCiphertext: encryptSavPayload({ text: outboundText }), outboundBodyHash: savContentHash(outboundText), replyFormatRevision: SAV_REPLY_FORMAT_REVISION }, updatedAt: new Date() } as const;
    const [action] = existing ? await tx.update(savActions).set(values).where(eq(savActions.id, existing.id)).returning()
      : await tx.insert(savActions).values({ ...values, idempotencyKey: key }).returning();
    await assertSavCurrentManualReply(action, tx);
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_manual_reply_requested", entityType: "sav_action", entityId: action.id,
      technicalMetadata: { draftId: draft.id, messageId: draft.messageId, reviewId: draft.reviewId, bodyHash: savContentHash(decryptSavPayload<{ text: string }>(draft.bodyCiphertext).text), outboundBodyHash: savContentHash(outboundText), replyFormatRevision: SAV_REPLY_FORMAT_REVISION } });
    return action;
}

const confirmationSchema = z.object({ threadId:z.uuid(),messageId:z.uuid(),decisionId:z.uuid(),agentRunId:z.uuid(),sourceHash:z.string().length(43),
  expectedDraftId:z.uuid().nullable(),text:z.string().trim().min(1).max(10000),recipient:z.email(),outboundHash:z.string().length(43),origin:z.enum(["ai","human"]) }).strict();
/** Exact displayed text and recipient become a version and a send authorization in
 * the same transaction. Neither a dossier review nor copying a suggestion sends. */
export async function confirmSavSuggestedReply(raw:unknown,actorEmail:string) {
  assertSavActor(actorEmail); assertSavManualReplyEnabled();
  if(isSavCaseLearningFrozen())throw new Error("SAV_CASE_LEARNING_FROZEN");
  const input=confirmationSchema.parse(raw);
  return requireDb().transaction(async tx=>{
    const [thread]=await tx.select().from(savThreads).where(eq(savThreads.id,input.threadId)).for("update");
    if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
    const context=await (input.origin==="human" ? loadSavDossierReviewContext(input.messageId,tx) : loadSavDraftContext(input.messageId,tx));
    if (context.message.threadId!==thread.id || context.decision.id!==input.decisionId || context.run.id!==input.agentRunId || context.sourceHash!==input.sourceHash || context.message.fromEmail!==input.recipient || savReplyForbidden(context.proposal)) throw new Error("SAV_REPLY_MANUAL_CONTEXT_CHANGED");
    const [eligible]=await tx.select({id:savMessages.id}).from(savMessages).where(and(eq(savMessages.id,input.messageId),savV0EligibleMessageFilter())).limit(1);
    if (!eligible || !context.message.gmailMessageId) throw new Error("SAV_MESSAGE_BEFORE_CUTOVER");
    const [translation]=await tx.select({language:savMessageTranslations.language}).from(savMessageTranslations).where(and(eq(savMessageTranslations.messageId,input.messageId),eq(savMessageTranslations.sourceHash,savContentHash(decryptSavPayload<{text:string}>(context.message.bodyCiphertext).text)),eq(savMessageTranslations.translatorRevision,SAV_TRANSLATOR_REVISION)));
    if (input.origin==="ai" && translation && !["fr","en","unknown"].includes(translation.language)) throw new Error("SAV_REPLY_LANGUAGE_HUMAN_REQUIRED");
    if (input.origin==="ai" && input.text!==context.proposal.replyDraft?.trim()) throw new Error("SAV_REPLY_MANUAL_OUTBOUND_CHANGED");
    const outbound=renderSavOutboundReply(input.text,savReplyLanguage(context.proposal,decryptSavPayload<{text:string}>(context.message.bodyCiphertext).text),savManualReplyMode(input.origin));
    if(savContentHash(outbound)!==input.outboundHash) throw new Error("SAV_REPLY_MANUAL_OUTBOUND_CHANGED");
    const [existing]=await tx.select().from(savActions).where(eq(savActions.idempotencyKey,`gmail:manual-reply:${input.messageId}`));
    const confirmationHash=savContentHash(input);
    if(existing?.payload.confirmationHash===confirmationHash && !["failed","cancelled"].includes(existing.status)) return existing;
    if(existing && (["pending","running","succeeded"].includes(existing.status)||existing.payload.replySendDispatchedAt)) throw new Error("SAV_REPLY_MANUAL_RECONCILIATION_REQUIRED");
    const [current]=await tx.select().from(savReplyDrafts).where(and(eq(savReplyDrafts.threadId,thread.id),eq(savReplyDrafts.isCurrent,true)));
    if((current?.id??null)!==input.expectedDraftId) throw new Error("SAV_DRAFT_VERSION_CHANGED");
    const [{revision}]=await tx.select({revision:max(savReplyDrafts.revision)}).from(savReplyDrafts).where(eq(savReplyDrafts.threadId,thread.id));
    if(current) await tx.update(savReplyDrafts).set({isCurrent:false}).where(eq(savReplyDrafts.id,current.id));
    const [draft]=await tx.insert(savReplyDrafts).values({threadId:thread.id,messageId:input.messageId,decisionId:context.decision.id,agentRunId:context.run.id,reviewId:context.review?.id??null,knowledgeRevision:context.knowledgeRevision,revision:(revision??0)+1,status:"send_confirmed",sourceHash:savDraftSourceHash({...context.proposal,replyDraft:input.text},context.message,context.knowledgeRevision),bodyCiphertext:encryptSavPayload({text:input.text,origin:input.origin}),createdBy:actorEmail}).returning();
    const action=await queueSavManualReplyTx({threadId:thread.id,draftId:draft.id},actorEmail,tx,{hash:confirmationHash,recipient:input.recipient});
    await tx.update(savActions).set({payload:{...action.payload,confirmationHash,confirmedRecipient:input.recipient,confirmedAt:new Date().toISOString()}}).where(eq(savActions.id,action.id));
    return {...action,payload:{...action.payload,confirmationHash}};
  });
}

/** Re-check immutable body, author and current context just before the Gmail mutation. */
export async function assertSavCurrentManualReply(action: typeof savActions.$inferSelect, db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) {
  if (action.actorType !== "human" || !action.actorEmail || action.payload.manualReplyConfirmed !== true || typeof action.payload.studioDraftId !== "string" || action.payload.followupSequence) throw new Error("SAV_REPLY_MANUAL_APPROVAL_REQUIRED");
  assertSavActor(action.actorEmail);
  const [draft] = await db.select().from(savReplyDrafts).where(and(eq(savReplyDrafts.id, action.payload.studioDraftId), eq(savReplyDrafts.isCurrent, true))).limit(1);
  if (!draft || draft.status === "abandoned" || draft.threadId !== action.threadId || draft.messageId !== action.messageId || draft.createdBy !== action.actorEmail || draft.bodyCiphertext !== action.payload.bodyCiphertext) throw new Error("SAV_REPLY_MANUAL_DRAFT_CHANGED");
  const context = await assertSavAcceptedDraft(draft, db);
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, action.threadId), eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter())).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const [decision] = await db.select().from(savDecisions).where(and(eq(savDecisions.id, context.decision.id), eq(savDecisions.isCurrent, true))).limit(1);
  const [run] = await db.select().from(savAgentRuns).where(eq(savAgentRuns.id, context.run.id)).limit(1);
  const [review] = await db.select().from(savProposalReviews).where(and(eq(savProposalReviews.messageId, draft.messageId), eq(savProposalReviews.isCurrent, true))).limit(1);
  const [knowledge] = await db.select().from(activeKnowledge).limit(1);
  if (!message || message.id !== draft.messageId || !message.gmailMessageId || decision?.messageId !== message.id || decision.agentRunId !== context.run.id || decision.id !== action.decisionId || run?.messageId !== message.id || run.pilotBatchId || !run.proposalCiphertext || (!draft.sourceHash && (review?.id ?? null) !== draft.reviewId) || (knowledge?.revisionId ?? null) !== draft.knowledgeRevision) throw new Error("SAV_REPLY_MANUAL_CONTEXT_CHANGED");
  const proposal = context.proposal;
  const authored=decryptSavPayload<{origin?:string}>(draft.bodyCiphertext).origin === "human";
  if (!authored && !["not_consulted", "unavailable"].includes(proposal.knowledgeRevision) && proposal.knowledgeRevision !== knowledge?.revisionId) throw new Error("SAV_KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED");
  if (draft.status==="send_confirmed" && (typeof action.payload.confirmationHash!=="string" || action.payload.confirmedRecipient!==message.fromEmail)) throw new Error("SAV_REPLY_MANUAL_APPROVAL_REQUIRED");
  const body = decryptSavPayload<{ text: string; headers?: Record<string, string> }>(message.bodyCiphertext);
  if (!/^<[^<>\s]+@[^<>\s]+>$/.test(body.headers?.["message-id"] ?? "")) throw new Error("SAV_REPLY_MANUAL_THREAD_HEADERS_MISSING");
  if (action.payload.replyFormatRevision !== SAV_REPLY_FORMAT_REVISION || typeof action.payload.outboundBodyCiphertext !== "string") throw new Error("SAV_REPLY_MANUAL_FORMAT_RECONFIRM_REQUIRED");
  const outboundText = decryptSavPayload<{ text: string }>(action.payload.outboundBodyCiphertext).text;
  const language = savReplyLanguage(context.proposal, body.text);
  if (outboundText !== renderSavOutboundReply(decryptSavPayload<{ text: string }>(draft.bodyCiphertext).text, language, savManualReplyMode(decryptSavPayload<{ origin?: string }>(draft.bodyCiphertext).origin)) || action.payload.outboundBodyHash !== savContentHash(outboundText)) throw new Error("SAV_REPLY_MANUAL_OUTBOUND_CHANGED");
  return { draft, message, outboundText };
}
