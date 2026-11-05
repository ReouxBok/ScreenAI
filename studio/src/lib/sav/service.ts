import { intakeConsoleInstalled } from "./intake/console-capability";
import { intakeMessageHistorical, readIntakeLaunch } from "./intake/launch-boundary";
import { enqueueConfiguredSavIntake } from "./intake/runtime";
import { SAV_V0_ANALYSIS_RETIRED } from "./action-policy";
import { refuseRetiredSavV0Command } from "./v0-command-retirement";
import { enqueueSavTranslation } from "./translations";
import { savResolutionObservations } from "@/db/schema";
import "server-only";

import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import {
  auditLogs,
  savActions,
  savAgentRuns,
  savDecisions,
  savGmailQuarantine,
  savLearningCandidates,
  savMailboxes,
  savMessages,
  savPilotBatches,
  savPilotItems,
  savProposalReviews,
  savThreads,
  savWebhookReceipts,
} from "@/db/schema";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { analyzeSavMessage } from "./intelligence";
import { withSavAiBudget } from "./gemini-transport";
import { acquireSavAttachmentRead } from "./attachment-store";
import { savAttachmentMetadataSchema, savAttachmentInventorySchema, type SavAttachmentInventory, type SavAttachmentMetadata, type SavAttachmentRead } from "./attachment-contract";
import { collectSavDossierContext, type SavDossierContext } from "./dossier-context";
import { savStructuredProposalSchema, type SavStructuredProposal } from "./proposal";
import { buildSavInboxSummary, type SavInboxPartnershipStatus } from "./inbox-summary";
import { savReviewMatchesProposal } from "./review-contract";
import { redactSavLearningText } from "./learning-extraction";
import { invalidateSavReplies } from "./invalidation";
import { savReleaseStage } from "./config";
import { getSavV0Cutover, isSavMessageEligible, savV0EligibleMessageFilter } from "./cutover";
import {
  decisionKindSchema,
  humanDueAt,
  assertSavPilotReplyApprovalAllowed,
  normalizeEmailAddress,
  sanitizeInboundText,
} from "./policy";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";

export type SavMessageBody = { text: string; html?: string; headers?: Record<string, string>; attachments?: SavAttachmentMetadata[]; attachmentInventory?: SavAttachmentInventory; attachmentRead?: SavAttachmentRead; supportContext?: SavDossierContext };

export const inboundMessageSchema = z.object({
  mailboxEmail: z.email(),
  gmailMessageId: z.string().trim().min(1).max(200),
  gmailThreadId: z.string().trim().min(1).max(200),
  from: z.string().trim().min(3).max(500),
  to: z.array(z.string().trim().min(3).max(500)).max(50).default([]),
  subject: z.string().trim().max(1_000).default("Sans objet"),
  bodyText: z.string().max(100_000).default(""),
  bodyHtml: z.string().max(300_000).optional(),
  attachments: z.array(savAttachmentMetadataSchema).max(100).default([]),
  attachmentInventory: savAttachmentInventorySchema.optional(),
  headers: z.record(z.string(), z.string().max(2_000)).optional(),
  autoSubmitted: z.string().trim().max(200).optional(),
  receivedAt: z.coerce.date(),
});
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

const correctedDecisionSchema = z.object({
  kind: decisionKindSchema.exclude(["ticket_pending"]),
  reasonCode: z.string().trim().min(3).max(100),
  explanation: z.string().trim().min(10).max(2_000),
});

const pilotReviewSchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect", "critical"]),
  dimensions: z.object({
    classification: z.enum(["correct", "partial", "incorrect", "critical"]),
    routing: z.enum(["correct", "partial", "incorrect", "critical"]),
    grounding: z.enum(["correct", "partial", "incorrect", "critical"]),
    tone: z.enum(["correct", "partial", "incorrect", "critical"]),
    escalation: z.enum(["correct", "partial", "incorrect", "critical"]),
  }),
  feedbackCodes: z.array(z.enum([
    "wrong_classification",
    "wrong_ticket_decision",
    "wrong_ticket_link",
    "wrong_priority",
    "unsupported_claim",
    "wrong_tone",
    "missing_information",
    "unsafe_action",
    "good_without_change",
  ])).max(9).default([]),
  comment: z.string().trim().max(4_000).default(""),
  correctedDraft: z.string().trim().max(10_000).default(""),
  reusability: z.enum(["none", "tone_only", "customer_specific", "reusable"]).default("none"),
  justification: z.string().trim().max(2_000).default(""),
});

function safeErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return value.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 160);
}

export async function recordWebhookReceipt(provider: "gmail" | "hubspot", externalId: string, payload: Record<string, unknown>) {
  const db = requireDb();
  const [receipt] = await db.insert(savWebhookReceipts).values({
    provider,
    externalId,
    payloadHash: savContentHash(payload),
    payload,
  }).onConflictDoNothing().returning();
  if (receipt) return { receipt, duplicate: false };
  const [existing] = await db.select().from(savWebhookReceipts)
    .where(and(eq(savWebhookReceipts.provider, provider), eq(savWebhookReceipts.externalId, externalId))).limit(1);
  if (!existing) throw new Error("WEBHOOK_RECEIPT_NOT_FOUND");
  return { receipt: existing, duplicate: true };
}

export async function markWebhookReceipt(receiptId: string, status: "processing" | "processed" | "failed", error?: unknown) {
  await requireDb().update(savWebhookReceipts).set({
    status,
    errorCode: error ? safeErrorCode(error) : null,
    processedAt: status === "processed" ? new Date() : null,
  }).where(eq(savWebhookReceipts.id, receiptId));
}

export async function claimWebhookReceipt(receiptId: string, provider: "gmail" | "hubspot") {
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000);
  const [receipt] = await requireDb().update(savWebhookReceipts).set({
    status: "processing",
    attempts: sql`${savWebhookReceipts.attempts} + 1`,
    errorCode: null,
    lastAttemptAt: new Date(),
  }).where(and(
    eq(savWebhookReceipts.id, receiptId),
    eq(savWebhookReceipts.provider, provider),
    or(
      inArray(savWebhookReceipts.status, ["pending", "failed"]),
      and(eq(savWebhookReceipts.status, "processing"), or(isNull(savWebhookReceipts.lastAttemptAt), lt(savWebhookReceipts.lastAttemptAt, staleBefore))),
    ),
  )).returning();
  return receipt ?? null;
}

export async function ensureSavMailbox(email: string) {
  const normalized = normalizeEmailAddress(email);
  const db = requireDb();
  const [created] = await db.insert(savMailboxes).values({ email: normalized })
    .onConflictDoNothing().returning();
  if (created) return created;
  const [existing] = await db.select().from(savMailboxes).where(eq(savMailboxes.email, normalized)).limit(1);
  if (!existing) throw new Error("SAV_MAILBOX_NOT_FOUND");
  return existing;
}

export async function updateMailboxWatch(email: string, _historyId: string, expiration: Date) {
  const mailbox = await ensureSavMailbox(email);
  const [updated] = await requireDb().update(savMailboxes).set({
    // A watch head is not a consumed cursor. Keep the existing cursor (even
    // null) so renewal cannot skip mail whose notification has not arrived.
    watchExpiration: expiration,
    watchStatus: "active",
    updatedAt: new Date(),
  }).where(eq(savMailboxes.id, mailbox.id)).returning();
  return updated;
}

export async function updateMailboxCursor(mailboxId: string, historyId: string) {
  if (!/^\d{1,100}$/.test(historyId)) throw new Error("GMAIL_HISTORY_ID_INVALID");
  await requireDb().update(savMailboxes).set({ historyId, updatedAt: new Date() })
    .where(and(eq(savMailboxes.id, mailboxId), or(isNull(savMailboxes.historyId),
      sql`${savMailboxes.historyId}::numeric < ${historyId}::numeric`)));
}

export async function ingestInboundMessage(rawInput: unknown, source?: "gmail_full") {
  const input = inboundMessageSchema.parse(rawInput);
  const db = requireDb();
  const mailbox = await ensureSavMailbox(input.mailboxEmail);
  const cutover = await getSavV0Cutover();
  const eligible = Boolean(cutover && mailbox.email === cutover.mailboxEmail && input.receivedAt.getTime() > Date.parse(cutover.receivedAfter));
  const normalizedFrom = normalizeEmailAddress(input.from);
  const bodyText = sanitizeInboundText(input.bodyText);
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLocaleLowerCase("en"), value]));
  if (source !== "gmail_full") {
    delete headers["x-studio-automation-headers"];
    delete headers["x-studio-automation-body"];
  }
  if (input.autoSubmitted !== undefined) headers["auto-submitted"] = input.autoSubmitted;

  const result = await db.transaction(async (tx) => {
    let [thread] = await tx.select().from(savThreads)
      .where(and(eq(savThreads.mailboxId, mailbox.id), eq(savThreads.gmailThreadId, input.gmailThreadId))).limit(1);
    if (!thread) {
      const [createdThread] = await tx.insert(savThreads).values({
        mailboxId: mailbox.id,
        gmailThreadId: input.gmailThreadId,
        subject: input.subject || "Sans objet",
        customerEmail: normalizedFrom,
        lastMessageAt: input.receivedAt,
      }).onConflictDoNothing().returning();
      [thread] = createdThread ? [createdThread] : await tx.select().from(savThreads)
        .where(and(eq(savThreads.mailboxId, mailbox.id), eq(savThreads.gmailThreadId, input.gmailThreadId))).limit(1);
      if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
    }

    const [created] = await tx.insert(savMessages).values({
      mailboxId: mailbox.id,
      threadId: thread.id,
      gmailMessageId: input.gmailMessageId,
      direction: "inbound",
      fromEmail: normalizedFrom,
      toEmails: input.to.map(normalizeEmailAddress),
      subject: input.subject || "Sans objet",
      preview: redactSavLearningText(bodyText.replace(/\s+/g, " ")).slice(0, 280),
      bodyCiphertext: encryptSavPayload({ text: bodyText, ...(input.bodyHtml ? { html: input.bodyHtml } : {}), headers, attachments: input.attachments, ...(input.attachmentInventory ? { attachmentInventory: input.attachmentInventory } : {}) }),
      receivedAt: input.receivedAt,
    }).onConflictDoNothing().returning();
    const [message] = created ? [created] : await tx.select().from(savMessages)
      .where(and(eq(savMessages.mailboxId, mailbox.id), eq(savMessages.gmailMessageId, input.gmailMessageId))).limit(1);
    if (!message) throw new Error("SAV_MESSAGE_NOT_FOUND");
    await tx.update(savThreads).set({
      subject: input.receivedAt >= thread.lastMessageAt ? input.subject || thread.subject : thread.subject,
      // A forwarded/multi-party reply must not silently replace the ticket owner.
      lastMessageAt: input.receivedAt > thread.lastMessageAt ? input.receivedAt : thread.lastMessageAt,
      updatedAt: new Date(),
    }).where(eq(savThreads.id, thread.id));
    if (created && eligible) {
      const now = new Date();
      await invalidateSavReplies(tx, thread.id, "SAV_REPLY_OBSOLETE", now);
      await tx.update(savResolutionObservations).set({nextSyncAt:now,closedCatchupUntil:null,sourceErrors:["new_inbound_awaiting_sync"]}).where(eq(savResolutionObservations.threadId,thread.id));
      // Any incoming message invalidates approvals immediately.
    }
    return { mailbox, thread, message, duplicate: !created };
  });

  if (result.duplicate) return result;
  if (!eligible) return { ...result, excludedFromProposals: true as const, proposalSkipReason: cutover ? "before_cutover" : "cutover_not_active" };
  if (await intakeMessageHistorical(result.message.id)) return { ...result, archivedFromAutomation: true as const };
  await enqueueSavTranslation(result.message.id).catch(()=>undefined);
  const intake = await enqueueConfiguredSavIntake(result.message.id).catch(() => ({ deferred: true as const }));
  if (("runId" in intake && intake.runId) || "deferred" in intake || "archived" in intake || "held" in intake) return { ...result, queuedForIntake: true as const };
  // The old V0 analysis is retired (SAV-9): the message stays pending for the intake catch-up and the monitor; nothing analyses it here.
  return { ...result, v0AnalysisRetired: true as const };
}

/** Collection can call ticket matching before analysis; both consume one budget. */
export function analyzeStoredSavMessage(input: Parameters<typeof analyzeSavMessage>[0], context: Parameters<typeof analyzeSavMessage>[1] & { messageId: string }) {
  return withSavAiBudget(async () => {
    const dossierContext = await collectSavDossierContext(context.messageId);
    const attachmentRead = context.pilotBatchId || context.evaluation ? null : await acquireSavAttachmentRead(context.messageId);
    return analyzeSavMessage({ ...input, dossierContext, attachmentRead }, context);
  });
}

/**
 * Retired with the old V0 analysis (SAV-9): a stored message is never analysed, decided on or marked processed here. It stays untouched, so
 * the intake catch-up (`catchupSavIntake`) and the monitor still see it. There is deliberately no switch that brings the analysis back.
 */
export async function processStoredSavMessage(messageId: string): Promise<null> {
  void messageId;
  return null;
}

/** Retired with the old V0 analysis (SAV-9): inert. It reads and writes nothing; the intake catch-up owns pending mail. */
export async function processPendingSavMessages(limit = 4) {
  void limit;
  return { retired: true as const, processed: [] as Array<Record<string, unknown>> };
}

/** Retired with the old V0 analysis (SAV-9): a pilot item is never claimed or analysed; it stays as it is. */
export async function processSavPilotItem(itemId: string): Promise<{ itemId: string; status: "ready" | "error"; errorCode?: string } | null> {
  void itemId;
  return null;
}

export async function listSavPilotCandidates(limit = 80) {
  return requireDb().select({
    id: savMessages.id,
    threadId: savMessages.threadId,
    receivedAt: savMessages.receivedAt,
    fromEmail: savMessages.fromEmail,
    subject: savMessages.subject,
    preview: savMessages.preview,
  }).from(savMessages)
    .leftJoin(savPilotItems, eq(savPilotItems.messageId, savMessages.id))
    .where(and(
      eq(savMessages.direction, "inbound"),
      isNull(savMessages.processedAt),
      isNull(savPilotItems.id),
      savV0EligibleMessageFilter(),
    ))
    .orderBy(asc(savEffectiveReceivedAt))
    .limit(Math.min(100, Math.max(10, limit)));
}

/** Retired with the old V0 analysis (SAV-9): no new pilot batch can start, so no mail is analysed for review. */
export async function startSavPilotBatch(actorEmail: string, selection: number | string[] = 10): Promise<typeof savPilotBatches.$inferSelect> {
  void actorEmail; void selection;
  throw new Error(SAV_V0_ANALYSIS_RETIRED);
}

export async function listSavPilotBatchItems(batchId: string) {
  const db = requireDb();
  const items = await db.select({
    id: savPilotItems.id,
    batchId: savPilotItems.batchId,
    status: savPilotItems.status,
    verdict: savPilotItems.verdict,
    classificationVerdict: savPilotItems.classificationVerdict,
    routingVerdict: savPilotItems.routingVerdict,
    groundingVerdict: savPilotItems.groundingVerdict,
    toneVerdict: savPilotItems.toneVerdict,
    escalationVerdict: savPilotItems.escalationVerdict,
    feedbackCodes: savPilotItems.feedbackCodes,
    errorCode: savPilotItems.errorCode,
    messageId: savMessages.id,
    threadId: savMessages.threadId,
    receivedAt: savMessages.receivedAt,
    fromEmail: savMessages.fromEmail,
    subject: savMessages.subject,
    preview: savMessages.preview,
    decisionKind: savDecisions.kind,
    explanation: savDecisions.explanation,
    confidence: savDecisions.confidence,
    model: savDecisions.model,
  }).from(savPilotItems)
    .innerJoin(savMessages, eq(savMessages.id, savPilotItems.messageId))
    .leftJoin(savDecisions, eq(savDecisions.id, savPilotItems.decisionId))
    .where(eq(savPilotItems.batchId, batchId))
    .orderBy(asc(savEffectiveReceivedAt));
  if (!items.length) return [];
  const actions = await db.select({
    messageId: savActions.messageId,
    kind: savActions.kind,
    status: savActions.status,
  }).from(savActions).where(eq(savActions.pilotBatchId, batchId));
  return items.map((item) => {
    const proposed = actions.filter((action) => action.messageId === item.messageId);
    return {
      ...item,
      ticketProposed: proposed.some((action) => ["create_ticket", "link_ticket"].includes(action.kind)),
      draftPrepared: proposed.some((action) => action.kind === "draft_reply"),
      noteProposed: proposed.some((action) => action.kind === "create_note"),
      humanProposed: proposed.some((action) => action.kind === "request_human"),
      externalWrites: proposed.filter((action) => ["create_ticket", "link_ticket", "log_email", "create_note"].includes(action.kind) && action.status === "succeeded").length,
    };
  });
}

export async function listPendingSavPilotItemIds(batchId: string) {
  const db = requireDb();
  const items = await db.select({ id: savPilotItems.id }).from(savPilotItems)
    .innerJoin(savPilotBatches, eq(savPilotBatches.id, savPilotItems.batchId))
    .where(and(
      eq(savPilotItems.batchId, batchId),
      eq(savPilotBatches.status, "processing"),
      eq(savPilotItems.status, "pending"),
    ))
    .orderBy(asc(savPilotItems.createdAt));
  return items.map((item) => item.id);
}

export async function finalizeSavPilotBatchIfReady(batchId: string) {
  const db = requireDb();
  const [remaining] = await db.select({ count: sql<number>`count(*)::int` }).from(savPilotItems)
    .where(and(eq(savPilotItems.batchId, batchId), inArray(savPilotItems.status, ["pending", "processing"])));
  if ((remaining?.count ?? 0) > 0) return { batchId, status: "processing" as const, remaining: remaining?.count ?? 0 };
  const [batch] = await db.update(savPilotBatches).set({ status: "reviewing", readyAt: new Date(), updatedAt: new Date() })
    .where(and(eq(savPilotBatches.id, batchId), eq(savPilotBatches.status, "processing"))).returning({ id: savPilotBatches.id });
  return batch
    ? { batchId, status: "reviewing" as const, remaining: 0 }
    : { batchId, status: "unchanged" as const, remaining: 0 };
}

/** SAV-9/SAV-60: retired V0 command, refused before any read or effect (v0-command-retirement.ts). The archived body below stays for the tests of the worker paths that still run; no source file may import it. */
export async function cancelSavPilotBatch(...args: Parameters<typeof cancelSavPilotBatchArchived>) {
  refuseRetiredSavV0Command("cancelPilotBatchAction");
  return cancelSavPilotBatchArchived(...args);
}
export async function cancelSavPilotBatchArchived(batchId: string, actorEmail: string, reason: string) {
  const cleanReason = reason.trim().slice(0, 1_000);
  if (cleanReason.length < 3) throw new Error("SAV_PILOT_CANCEL_REASON_REQUIRED");
  const db = requireDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-pilot-batch'))`);
    const now = new Date();
    const [batch] = await tx.update(savPilotBatches).set({ status: "cancelled", updatedAt: now })
      .where(and(eq(savPilotBatches.id, batchId), inArray(savPilotBatches.status, ["processing", "reviewing"]))).returning();
    if (!batch) throw new Error("SAV_PILOT_BATCH_NOT_ACTIVE");
    await tx.update(savPilotItems).set({ status: "error", errorCode: "SAV_PILOT_BATCH_CANCELLED", updatedAt: now })
      .where(and(eq(savPilotItems.batchId, batch.id), inArray(savPilotItems.status, ["pending", "processing"])));
    await tx.update(savActions).set({
      status: "cancelled",
      errorCode: "SAV_PILOT_BATCH_CANCELLED",
      executedAt: now,
      updatedAt: now,
    }).where(and(
      eq(savActions.pilotBatchId, batch.id),
      inArray(savActions.status, ["pending", "running"]),
    ));
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "sav_pilot_batch_cancelled",
      entityType: "sav_pilot_batch",
      entityId: batch.id,
      technicalMetadata: { reason: cleanReason },
    });
    return batch;
  });
}

/** Retired with the old V0 analysis (SAV-9): inert. It reads and writes nothing, whatever calls it and however often. */
export async function processPendingSavPilotItems(limit = 10) {
  void limit;
  return { retired: true as const, processed: [] as Array<Record<string, unknown>> };
}

export async function listSavInbox(limit = 100, options: { offset?: number; query?: string; view?: string } = {}) {
  const db = requireDb();
  // Existing messages may have had their diagnostic cleared after a fallback.
  // Read the run of the current decision, never a shadow run or an old attempt.
  const analysisErrorCode = sql<string | null>`coalesce(${savMessages.analysisErrorCode}, case when ${savAgentRuns.status} in ('fallback', 'failed') then coalesce(${savAgentRuns.errorCode}, 'SAV_AI_GENERATION_FAILED') end)`;
  const technical = ["spam", "automatic_reply", "bounce", "internal_notification", "duplicate"] as const;
  const query = options.query?.trim().slice(0, 200).replace(/[\\%_]/g, "\\$&");
  const viewFilter = options.view === "technical" ? inArray(savDecisions.kind, technical)
    : options.view === "human" ? eq(savThreads.aiPaused, true)
    : options.view === "reviewed" ? undefined
    : options.view === "errors" ? or(isNotNull(analysisErrorCode), eq(savMessages.analysisStatus, "failed"))
    : options.view === "pending" ? eq(savMessages.analysisStatus, "done") : undefined;
  const readBatch = (offset: number) => db.select({
    _review: savProposalReviews, _proposal: savAgentRuns.proposalCiphertext, _body: savMessages.bodyCiphertext, _runId: savAgentRuns.id,
    // Scalar journal read keeps pagination stable and excludes customer replies
    // and transfers of another email in the same conversation.
    _partnershipStatus: sql<SavInboxPartnershipStatus | null>`(select case
      when ${savActions.status} = 'succeeded' then 'succeeded'
      when ${savActions.payload}->>'forwardDispatchedAt' is not null then 'uncertain'
      when ${savActions.status} in ('pending', 'running') then 'pending'
      else 'failed' end
      from ${savActions} where ${savActions.messageId} = ${savMessages.id}
        and ${savActions.threadId} = ${savThreads.id}
        and ${savActions.kind} = 'send_reply' and ${savActions.actorType} = 'human'
        and ${savActions.payload}->>'purpose' = 'partnership_forward'
      order by ${savActions.updatedAt} desc, ${savActions.id} desc limit 1)`,
    messageId: savMessages.id,
    threadId: savThreads.id,
    receivedAt: savMessages.receivedAt,
    fromEmail: savMessages.fromEmail,
    subject: savMessages.subject,
    preview: savMessages.preview,
    analysisStatus: savMessages.analysisStatus,
    analysisErrorCode,
    reviewStatus: savProposalReviews.status,
    reviewId: savProposalReviews.id,
    threadStatus: savThreads.status,
    hubspotTicketId: savThreads.hubspotTicketId,
    aiPaused: savThreads.aiPaused,
    humanDueAt: savThreads.humanDueAt,
    decisionId: savDecisions.id,
    decisionKind: savDecisions.kind,
    reasonCode: savDecisions.reasonCode,
    explanation: savDecisions.explanation,
    confidence: savDecisions.confidence,
    actorType: savDecisions.actorType,
    pilotBatchId: savPilotItems.batchId,
    pilotItemStatus: savPilotItems.status,
    pilotVerdict: savPilotItems.verdict,
  }).from(savMessages)
    .innerJoin(savThreads, eq(savThreads.id, savMessages.threadId))
    .leftJoin(savDecisions, and(eq(savDecisions.messageId, savMessages.id), eq(savDecisions.isCurrent, true)))
    .leftJoin(savAgentRuns, eq(savAgentRuns.id, savDecisions.agentRunId))
    .leftJoin(savPilotItems, eq(savPilotItems.messageId, savMessages.id))
    .leftJoin(savProposalReviews, and(eq(savProposalReviews.messageId, savMessages.id), eq(savProposalReviews.isCurrent, true)))
    .where(and(eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter(), viewFilter,
      options.view === "technical" ? undefined : or(isNull(savDecisions.kind), notInArray(savDecisions.kind, [...technical])),
      query ? or(ilike(savMessages.fromEmail, `%${query}%`), ilike(savMessages.subject, `%${query}%`), ilike(savMessages.preview, `%${query}%`)) : undefined))
    .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.id))
    .limit(250).offset(offset);
  const normalize = (row: Awaited<ReturnType<typeof readBatch>>[number]) => {
    const { _review: review, _proposal: ciphertext, _body: bodyCiphertext, _runId: runId, _partnershipStatus: partnershipTransferStatus, ...entry } = row;
    let matches = false;
    let originalProposal: SavStructuredProposal | null = null;
    let proposal: SavStructuredProposal | null = null;
    try {
      originalProposal = ciphertext ? savStructuredProposalSchema.parse(decryptSavPayload(ciphertext)) : null;
      proposal = originalProposal;
      matches = Boolean(entry.decisionId && runId && originalProposal && savReviewMatchesProposal(review, { decisionId: entry.decisionId, agentRunId: runId,
        proposal: originalProposal, message: { bodyCiphertext, subject: entry.subject, fromEmail: entry.fromEmail } }));
      // Same contract as the detail: current human corrections win, while the
      // understanding and draft still belong to the current generation.
      if (matches && review && originalProposal) proposal = { ...savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext)),
        understanding: originalProposal.understanding, replyDraft: originalProposal.replyDraft, replyAssessment: originalProposal.replyAssessment };
    } catch { matches = false; proposal = originalProposal; /* An unreadable proposal cannot retain a verdict. */ }
    const reviewStatus = matches ? entry.reviewStatus : null;
    return { ...entry, reviewId: matches ? entry.reviewId : null, reviewStatus,
      summary: buildSavInboxSummary({ subject: entry.subject, analysisStatus: entry.analysisStatus, analysisErrorCode: entry.analysisErrorCode,
        hubspotTicketId: entry.hubspotTicketId, proposal, originalProposal, reviewStatus, partnershipTransferStatus }) };
  };
  const pageSize = Math.min(250, Math.max(1, limit));
  const offset = Math.max(0, Math.min(100_000, options.offset ?? 0));
  const rows: ReturnType<typeof normalize>[] = [];
  const contentFiltered = options.view === "reviewed" || options.view === "pending";
  let rawOffset = contentFiltered ? 0 : offset, matched = contentFiltered ? 0 : offset;
  // Filter by the shared decrypted-content contract before paginating; stale
  // reviews must not consume page slots or hide later reviewed dossiers.
  while (rows.length < pageSize) {
    const batch = await readBatch(rawOffset);
    for (const row of batch) {
      const entry = normalize(row);
      if (options.view === "reviewed" && !entry.reviewId || options.view === "pending" && entry.reviewId) continue;
      if (matched++ < offset) continue;
      rows.push(entry);
      if (rows.length === pageSize) break;
    }
    if (batch.length < 250) break;
    rawOffset += batch.length;
  }
  return rows;
}

/** Retired with the old V0 analysis (SAV-9): a failed analysis is not requeued, so nothing hands the message back to a worker. */
export async function retrySavAnalysis(messageId: string, actorEmail: string): Promise<never> {
  void messageId; void actorEmail;
  throw new Error(SAV_V0_ANALYSIS_RETIRED);
}

/** Retired with the old V0 analysis (SAV-9): no proposal is generated or repaired any more. */
export async function repairSavProposal(messageId: string, actorEmail: string): Promise<never> {
  void messageId; void actorEmail;
  throw new Error(SAV_V0_ANALYSIS_RETIRED);
}

export async function listSavPilotBatches(limit = 20) {
  const db = requireDb();
  const batches = await db.select().from(savPilotBatches)
    .orderBy(desc(savPilotBatches.createdAt)).limit(Math.min(50, Math.max(1, limit)));
  if (!batches.length) return [];
  const rows = await db.select({
    batchId: savPilotItems.batchId,
    status: savPilotItems.status,
    verdict: savPilotItems.verdict,
    classificationVerdict: savPilotItems.classificationVerdict,
    routingVerdict: savPilotItems.routingVerdict,
    groundingVerdict: savPilotItems.groundingVerdict,
    toneVerdict: savPilotItems.toneVerdict,
    escalationVerdict: savPilotItems.escalationVerdict,
  }).from(savPilotItems).where(inArray(savPilotItems.batchId, batches.map((batch) => batch.id)));
  const actionRows = await db.select({
    batchId: savActions.pilotBatchId,
    kind: savActions.kind,
    status: savActions.status,
  }).from(savActions).where(inArray(savActions.pilotBatchId, batches.map((batch) => batch.id)));
  return batches.map((batch) => {
    const items = rows.filter((item) => item.batchId === batch.id);
    const actions = actionRows.filter((action) => action.batchId === batch.id);
    const reviewed = items.filter((item) => item.status === "reviewed").length;
    const correct = items.filter((item) => item.verdict === "correct").length;
    const partial = items.filter((item) => item.verdict === "partial").length;
    const incorrect = items.filter((item) => item.verdict === "incorrect").length;
    const critical = items.filter((item) => item.verdict === "critical").length;
    return {
      ...batch,
      total: items.length,
      ready: items.filter((item) => ["ready", "reviewed"].includes(item.status)).length,
      reviewed,
      correct,
      partial,
      incorrect,
      critical,
      ticketsProposed: actions.filter((action) => ["create_ticket", "link_ticket"].includes(action.kind) && !["cancelled", "failed"].includes(action.status)).length,
      notesProposed: actions.filter((action) => action.kind === "create_note" && !["cancelled", "failed"].includes(action.status)).length,
      draftsPrepared: actions.filter((action) => action.kind === "draft_reply" && action.status === "succeeded").length,
      externalWrites: actions.filter((action) => ["create_ticket", "link_ticket", "log_email", "create_note"].includes(action.kind) && action.status === "succeeded").length,
      actionFailures: actions.filter((action) => action.status === "failed").length,
      acceptanceRate: reviewed ? Math.round(((correct + partial * 0.5) / reviewed) * 100) : null,
    };
  });
}

export async function getSavDashboard() {
  const db = requireDb();
  const [totals] = await db.select({
    total: sql<number>`count(*)::int`,
    withoutDecision: sql<number>`count(*) filter (where ${savDecisions.id} is null)::int`,
    tickets: sql<number>`count(*) filter (where ${savDecisions.kind} in ('ticket_pending', 'ticket_created', 'attached_to_existing_ticket'))::int`,
    human: sql<number>`count(*) filter (where ${savThreads.status} in ('human_requested', 'human_processing'))::int`,
    closedNoAction: sql<number>`count(*) filter (where ${savThreads.status} = 'closed_no_action')::int`,
    pilotQueued: sql<number>`count(*) filter (where ${savMessages.processedAt} is null and ${savPilotItems.id} is null)::int`,
  }).from(savMessages)
    .innerJoin(savThreads, eq(savThreads.id, savMessages.threadId))
    .leftJoin(savDecisions, and(eq(savDecisions.messageId, savMessages.id), eq(savDecisions.isCurrent, true)))
    .leftJoin(savPilotItems, eq(savPilotItems.messageId, savMessages.id))
    .where(eq(savMessages.direction, "inbound"));
  const [pendingLearning] = await db.select({ count: sql<number>`count(*)::int` }).from(savLearningCandidates)
    .where(eq(savLearningCandidates.status, "pending"));
  const [failedActions] = await db.select({ count: sql<number>`count(*)::int` }).from(savActions)
    .where(eq(savActions.status, "failed"));
  const [scheduledRetries] = await db.select({ count: sql<number>`count(*)::int` }).from(savActions)
    .where(and(eq(savActions.status, "pending"), isNotNull(savActions.scheduledAt)));
  const [analysisFailures] = await db.select({ count: sql<number>`count(*)::int` }).from(savMessages)
    .where(eq(savMessages.analysisStatus, "failed"));
  const [degradedRuns] = await db.select({ count: sql<number>`count(*)::int` }).from(savAgentRuns)
    .where(inArray(savAgentRuns.status, ["failed", "fallback"]));
  const [gmailReceiptCounts] = await db.select({
    pending: sql<number>`count(*) filter (where ${savWebhookReceipts.status} in ('pending', 'processing'))::int`,
    failed: sql<number>`count(*) filter (where ${savWebhookReceipts.status} = 'failed')::int`,
  }).from(savWebhookReceipts).where(eq(savWebhookReceipts.provider, "gmail"));
  const [gmailQuarantine] = await db.select({ count: sql<number>`count(*)::int` }).from(savGmailQuarantine)
    .where(eq(savGmailQuarantine.status, "quarantined"));
  return {
    ...(totals ?? { total: 0, withoutDecision: 0, tickets: 0, human: 0, closedNoAction: 0, pilotQueued: 0 }),
    pendingLearning: pendingLearning?.count ?? 0,
    failedActions: failedActions?.count ?? 0,
    scheduledRetries: scheduledRetries?.count ?? 0,
    analysisFailures: analysisFailures?.count ?? 0,
    degradedRuns: degradedRuns?.count ?? 0,
    gmailPending: gmailReceiptCounts?.pending ?? 0,
    gmailFailed: gmailReceiptCounts?.failed ?? 0,
    gmailQuarantined: gmailQuarantine?.count ?? 0,
  };
}

export async function listSavAgentPerformance(limit = 2_000) {
  const rows = await requireDb().select({
    runtime: savAgentRuns.runtime,
    mode: savAgentRuns.mode,
    status: savAgentRuns.status,
    model: savAgentRuns.model,
    promptRevision: savAgentRuns.promptRevision,
    durationMs: savAgentRuns.durationMs,
    totalTokens: savAgentRuns.totalTokens,
    verdict: savPilotItems.verdict,
    reviewedAt: savPilotItems.reviewedAt,
    classificationVerdict: savPilotItems.classificationVerdict,
    routingVerdict: savPilotItems.routingVerdict,
    groundingVerdict: savPilotItems.groundingVerdict,
    toneVerdict: savPilotItems.toneVerdict,
    escalationVerdict: savPilotItems.escalationVerdict,
    createdAt: savAgentRuns.createdAt,
  }).from(savAgentRuns)
    .leftJoin(savPilotItems, eq(savPilotItems.agentRunId, savAgentRuns.id))
    .orderBy(desc(savAgentRuns.createdAt))
    .limit(Math.min(5_000, Math.max(1, limit)));

  const groups = new Map<string, {
    runtime: string;
    mode: string;
    model: string;
    promptRevision: string;
    runs: number;
    reviewed: number;
    correct: number;
    partial: number;
    incorrect: number;
    critical: number;
    degraded: number;
    durationTotalMs: number;
    tokenTotal: number;
    latestAt: Date;
    dimensionPoints: Record<string, number>;
    dimensionCounts: Record<string, number>;
  }>();
  for (const row of rows) {
    const key = `${row.runtime}\u0000${row.mode}\u0000${row.model}\u0000${row.promptRevision}`;
    const group = groups.get(key) ?? {
      runtime: row.runtime,
      mode: row.mode,
      model: row.model,
      promptRevision: row.promptRevision,
      runs: 0,
      reviewed: 0,
      correct: 0,
      partial: 0,
      incorrect: 0,
      critical: 0,
      degraded: 0,
      durationTotalMs: 0,
      tokenTotal: 0,
      latestAt: row.createdAt,
      dimensionPoints: {},
      dimensionCounts: {},
    };
    group.runs += 1;
    group.durationTotalMs += row.durationMs;
    group.tokenTotal += row.totalTokens;
    if (["failed", "fallback"].includes(row.status)) group.degraded += 1;
    if (row.reviewedAt && row.verdict) {
      group.reviewed += 1;
      group[row.verdict] += 1;
    }
    for (const [dimension, verdict] of Object.entries({ classification: row.classificationVerdict, routing: row.routingVerdict, grounding: row.groundingVerdict, tone: row.toneVerdict, escalation: row.escalationVerdict })) {
      if (!verdict) continue;
      group.dimensionCounts[dimension] = (group.dimensionCounts[dimension] ?? 0) + 1;
      group.dimensionPoints[dimension] = (group.dimensionPoints[dimension] ?? 0) + (verdict === "correct" ? 1 : verdict === "partial" ? 0.5 : 0);
    }
    groups.set(key, group);
  }

  return [...groups.values()].map(({ durationTotalMs, tokenTotal, dimensionPoints, dimensionCounts, ...group }) => ({
    ...group,
    acceptanceRate: group.reviewed
      ? Math.round(((group.correct + group.partial * 0.5) / group.reviewed) * 100)
      : null,
    degradedRate: group.runs ? Math.round((group.degraded / group.runs) * 100) : 0,
    averageDurationMs: group.runs ? Math.round(durationTotalMs / group.runs) : 0,
    averageTokens: group.runs ? Math.round(tokenTotal / group.runs) : 0,
    dimensions: Object.fromEntries(Object.keys(dimensionCounts).map((dimension) => [dimension, Math.round((dimensionPoints[dimension] / dimensionCounts[dimension]) * 100)])),
  })).sort((left, right) => right.latestAt.getTime() - left.latestAt.getTime());
}

export async function getSavImprovementSignals(limit = 5_000) {
  const rows = await requireDb().select({
    verdict: savPilotItems.verdict,
    classificationVerdict: savPilotItems.classificationVerdict,
    routingVerdict: savPilotItems.routingVerdict,
    groundingVerdict: savPilotItems.groundingVerdict,
    toneVerdict: savPilotItems.toneVerdict,
    escalationVerdict: savPilotItems.escalationVerdict,
    feedbackCodes: savPilotItems.feedbackCodes,
    correctedDraftCiphertext: savPilotItems.correctedDraftCiphertext,
  }).from(savPilotItems)
    .where(isNotNull(savPilotItems.reviewedAt))
    .orderBy(desc(savPilotItems.reviewedAt))
    .limit(Math.min(10_000, Math.max(1, limit)));
  const feedback = new Map<string, { code: string; count: number; critical: number }>();
  for (const row of rows) {
    for (const code of row.feedbackCodes) {
      const current = feedback.get(code) ?? { code, count: 0, critical: 0 };
      current.count += 1;
      if (row.verdict === "critical") current.critical += 1;
      feedback.set(code, current);
    }
  }
  return {
    reviewed: rows.length,
    correct: rows.filter((row) => row.verdict === "correct").length,
    partial: rows.filter((row) => row.verdict === "partial").length,
    incorrect: rows.filter((row) => row.verdict === "incorrect").length,
    critical: rows.filter((row) => row.verdict === "critical").length,
    correctedDrafts: rows.filter((row) => Boolean(row.correctedDraftCiphertext)).length,
    dimensions: Object.fromEntries(["classification", "routing", "grounding", "tone", "escalation"].map((dimension) => {
      const verdicts = rows.map((row) => row[`${dimension}Verdict` as keyof typeof row]).filter((value): value is "correct" | "partial" | "incorrect" | "critical" => typeof value === "string");
      const score = verdicts.length ? Math.round((verdicts.reduce((sum, verdict) => sum + (verdict === "correct" ? 1 : verdict === "partial" ? 0.5 : 0), 0) / verdicts.length) * 100) : null;
      return [dimension, { reviewed: verdicts.length, score }];
    })),
    feedback: [...feedback.values()].sort((left, right) => right.critical - left.critical || right.count - left.count || left.code.localeCompare(right.code)),
  };
}

export async function listSavActionIncidents(limit = 50) {
  return requireDb().select({
    id: savActions.id,
    threadId: savActions.threadId,
    kind: savActions.kind,
    errorCode: savActions.errorCode,
    updatedAt: savActions.updatedAt,
    subject: savThreads.subject,
  }).from(savActions)
    .innerJoin(savThreads, eq(savThreads.id, savActions.threadId))
    .where(eq(savActions.status, "failed"))
    .orderBy(desc(savActions.updatedAt))
    .limit(Math.min(100, Math.max(1, limit)));
}

export async function listSavWebhookIncidents(limit = 50) {
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000);
  return requireDb().select({
    id: savWebhookReceipts.id,
    provider: savWebhookReceipts.provider,
    status: savWebhookReceipts.status,
    attempts: savWebhookReceipts.attempts,
    errorCode: savWebhookReceipts.errorCode,
    receivedAt: savWebhookReceipts.receivedAt,
    lastAttemptAt: savWebhookReceipts.lastAttemptAt,
  }).from(savWebhookReceipts)
    .where(or(
      eq(savWebhookReceipts.status, "failed"),
      and(eq(savWebhookReceipts.status, "processing"), or(isNull(savWebhookReceipts.lastAttemptAt), lt(savWebhookReceipts.lastAttemptAt, staleBefore))),
    ))
    .orderBy(desc(savWebhookReceipts.receivedAt))
    .limit(Math.min(100, Math.max(1, limit)));
}

export async function retrySavWebhookReceipt(receiptId: string, actorEmail: string) {
  const db = requireDb();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000);
  const [receipt] = await db.update(savWebhookReceipts).set({
    status: "pending",
    attempts: 0,
    errorCode: null,
    lastAttemptAt: null,
    processedAt: null,
  }).where(and(
    eq(savWebhookReceipts.id, receiptId),
    or(
      eq(savWebhookReceipts.status, "failed"),
      and(eq(savWebhookReceipts.status, "processing"), or(isNull(savWebhookReceipts.lastAttemptAt), lt(savWebhookReceipts.lastAttemptAt, staleBefore))),
    ),
  )).returning();
  if (!receipt) throw new Error("SAV_WEBHOOK_RECEIPT_NOT_FAILED");
  await db.insert(auditLogs).values({
    actorEmail,
    action: "sav_webhook_retried",
    entityType: "sav_webhook_receipt",
    entityId: receipt.id,
    technicalMetadata: { provider: receipt.provider },
  });
  return receipt;
}

export async function getSavThreadDetail(threadId: string) {
  const db = requireDb();
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId)).limit(1);
  if (!thread) return null;
  const messages = await db.select().from(savMessages).where(eq(savMessages.threadId, threadId)).orderBy(savMessages.receivedAt, savMessages.createdAt, savMessages.id);
  const messageIds = messages.map((message) => message.id);
  const decisions = messageIds.length
    ? await db.select().from(savDecisions).where(inArray(savDecisions.messageId, messageIds)).orderBy(savDecisions.createdAt)
    : [];
  const actions = await db.select().from(savActions).where(eq(savActions.threadId, threadId)).orderBy(savActions.createdAt);
  const agentRuns = messageIds.length
    ? await db.select().from(savAgentRuns).where(inArray(savAgentRuns.messageId, messageIds)).orderBy(savAgentRuns.createdAt)
    : [];
  const [pilotItem] = messages.length ? await db.select({
    id: savPilotItems.id,
    batchId: savPilotItems.batchId,
    status: savPilotItems.status,
    verdict: savPilotItems.verdict,
    classificationVerdict: savPilotItems.classificationVerdict,
    routingVerdict: savPilotItems.routingVerdict,
    groundingVerdict: savPilotItems.groundingVerdict,
    toneVerdict: savPilotItems.toneVerdict,
    escalationVerdict: savPilotItems.escalationVerdict,
    feedbackCodes: savPilotItems.feedbackCodes,
    reviewerComment: savPilotItems.reviewerComment,
    correctedDraftCiphertext: savPilotItems.correctedDraftCiphertext,
    reviewedBy: savPilotItems.reviewedBy,
    reviewedAt: savPilotItems.reviewedAt,
    errorCode: savPilotItems.errorCode,
  }).from(savPilotItems).where(inArray(savPilotItems.messageId, messages.map((message) => message.id))).limit(1) : [];
  return {
    thread,
    messages: messages.map((message) => ({ ...message, body: decryptSavPayload<SavMessageBody>(message.bodyCiphertext), bodyCiphertext: undefined })),
    decisions,
    agentRuns,
    pilotItem: pilotItem ? {
      ...pilotItem,
      correctedDraft: pilotItem.correctedDraftCiphertext
        ? decryptSavPayload<{ text: string }>(pilotItem.correctedDraftCiphertext).text
        : null,
      correctedDraftCiphertext: undefined,
    } : null,
    actions: actions.map((action) => {
      const bodyCiphertext = action.payload.bodyCiphertext;
      let draftText: string | null = null;
      let noteText: string | null = null;
      if (typeof bodyCiphertext === "string") {
        try {
          const text = decryptSavPayload<{ text: string }>(bodyCiphertext).text;
          if (action.kind === "draft_reply") draftText = text;
          if (action.kind === "create_note") noteText = text;
        } catch {
          draftText = null;
          noteText = null;
        }
      }
      const { bodyCiphertext: _privateBody, previewCiphertext: _privatePreview, ...safePayload } = action.payload;
      void _privateBody; void _privatePreview;
      return { ...action, payload: safePayload, draftText, noteText };
    }),
  };
}

/** SAV-9/SAV-60: retired V0 command, refused before any read or effect (v0-command-retirement.ts). The archived body below stays for the tests of the worker paths that still run; no source file may import it. */
export async function reviewSavPilotItem(...args: Parameters<typeof reviewSavPilotItemArchived>) {
  refuseRetiredSavV0Command("reviewPilotItemAction");
  return reviewSavPilotItemArchived(...args);
}
export async function reviewSavPilotItemArchived(itemId: string, rawInput: unknown, actorEmail: string) {
  const input = pilotReviewSchema.parse(rawInput);
  const db = requireDb();
  const [item] = await db.select().from(savPilotItems).where(eq(savPilotItems.id, itemId)).limit(1);
  if (!item || !["ready", "reviewed"].includes(item.status)) throw new Error("SAV_PILOT_ITEM_NOT_REVIEWABLE");
  const correctedDraftCiphertext = input.correctedDraft ? encryptSavPayload({ text: input.correctedDraft }) : null;
  const now = new Date();
  const [updated] = await db.update(savPilotItems).set({
    status: "reviewed",
    verdict: input.verdict,
    classificationVerdict: input.dimensions.classification,
    routingVerdict: input.dimensions.routing,
    groundingVerdict: input.dimensions.grounding,
    toneVerdict: input.dimensions.tone,
    escalationVerdict: input.dimensions.escalation,
    feedbackCodes: input.feedbackCodes,
    reviewerComment: input.comment,
    correctedDraftCiphertext,
    reviewedBy: actorEmail,
    reviewedAt: now,
    updatedAt: now,
  }).where(eq(savPilotItems.id, item.id)).returning();
  await db.insert(auditLogs).values({
    actorEmail,
    action: "sav_pilot_item_reviewed",
    entityType: "sav_pilot_item",
    entityId: item.id,
    technicalMetadata: {
      verdict: input.verdict, classificationVerdict: input.dimensions.classification,
      routingVerdict: input.dimensions.routing, groundingVerdict: input.dimensions.grounding,
      toneVerdict: input.dimensions.tone, escalationVerdict: input.dimensions.escalation,
      batchId: item.batchId, feedbackCount: input.feedbackCodes.length,
    },
  });
  if (input.reusability === "reusable" && input.justification.length >= 20 && item.agentRunId && input.correctedDraft.length >= 20) {
    const [context] = await db.select({
      threadId: savThreads.id,
      hubspotTicketId: savThreads.hubspotTicketId,
      subject: savThreads.subject,
    }).from(savMessages)
      .innerJoin(savThreads, eq(savThreads.id, savMessages.threadId))
      .where(eq(savMessages.id, item.messageId))
      .limit(1);
    if (context) {
      const sourceContentHash = savContentHash({
        source: "pilot_human_review",
        pilotItemId: item.id,
        agentRunId: item.agentRunId,
        correctedDraft: input.correctedDraft,
      });
      await db.insert(savLearningCandidates).values({
        threadId: context.threadId,
        hubspotTicketId: context.hubspotTicketId,
        sourceRef: context.hubspotTicketId ? `hubspot:${context.hubspotTicketId}` : `thread:${context.threadId}`,
        sourceContentHash,
        proposedPatch: {
          ciphertext: encryptSavPayload({
            subject: redactSavLearningText(context.subject),
            finalHumanResolution: redactSavLearningText(input.correctedDraft),
            sourceSnapshotId: `pilot:${item.id}`,
            agentRunId: item.agentRunId,
            reusabilityJustification: redactSavLearningText(input.justification),
            provenance: "pilot_human_review",
            customerConfirmed: false,
          }),
        },
        explanation: "Un humain a corrigé la réponse proposée pendant le pilote. Cette correction doit encore être relue et approuvée avant de devenir une fiche de résolution.",
        evidenceTicketIds: context.hubspotTicketId ? [context.hubspotTicketId] : [],
        createdBy: "human",
      }).onConflictDoNothing();
    }
  }
  const [remaining] = await db.select({ count: sql<number>`count(*) filter (where ${savPilotItems.status} <> 'reviewed')::int` })
    .from(savPilotItems).where(eq(savPilotItems.batchId, item.batchId));
  if ((remaining?.count ?? 0) === 0) await db.update(savPilotBatches).set({ status: "completed", completedAt: now, updatedAt: now })
    .where(eq(savPilotBatches.id, item.batchId));
  return updated;
}

/** SAV-9/SAV-60: retired V0 command, refused before any read or effect (v0-command-retirement.ts). The archived body below stays for the tests of the worker paths that still run; no source file may import it. */
export async function requestHumanIntervention(...args: Parameters<typeof requestHumanInterventionArchived>) {
  refuseRetiredSavV0Command("requestHumanAction");
  return requestHumanInterventionArchived(...args);
}
export async function requestHumanInterventionArchived(threadId: string, actorEmail: string, reason: string) {
  const cleanReason = reason.trim().slice(0, 1_000);
  if (cleanReason.length < 3) throw new Error("HUMAN_REQUEST_REASON_REQUIRED");
  const db = requireDb();
  return db.transaction(async (tx) => {
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, threadId)).for("update");
    if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
    const localHold = await intakeConsoleInstalled(tx) && Boolean(await readIntakeLaunch(thread.mailboxId, tx));
    const now = new Date(), dueAt = thread.humanDueAt ?? humanDueAt(now);
    await invalidateSavReplies(tx, threadId, "SAV_THREAD_PAUSED", now);
    const [updated] = await tx.update(savThreads).set({
      status: "human_requested",
      aiPaused: true,
      humanRequestedAt: thread.humanRequestedAt ?? now,
      humanDueAt: dueAt,
      updatedAt: now,
    }).where(eq(savThreads.id, threadId)).returning();
    await tx.insert(savActions).values({
      threadId,
      kind: "request_human",
      // The hold is already effective locally. Intake must never queue a legacy send.
      status: localHold ? "succeeded" : "pending",
      idempotencyKey: localHold ? `human:intake-hold:${threadId}` : `human:admin-request:${threadId}`,
      payload: { reason: cleanReason, dueAt: dueAt.toISOString(), ...(localHold ? { localHold: true } : {}) },
      actorType: "human",
      actorEmail,
    }).onConflictDoNothing();
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "sav_human_requested",
      entityType: "sav_thread",
      entityId: threadId,
      technicalMetadata: { dueAt: dueAt.toISOString(), localHold },
    });
    return updated;
  });
}

/** SAV-9/SAV-60: retired V0 command, refused before any read or effect (v0-command-retirement.ts). The archived body below stays for the tests of the worker paths that still run; no source file may import it. */
export async function correctSavDecision(...args: Parameters<typeof correctSavDecisionArchived>) {
  refuseRetiredSavV0Command("correctDecisionAction");
  return correctSavDecisionArchived(...args);
}
export async function correctSavDecisionArchived(decisionId: string, rawInput: unknown, actorEmail: string) {
  const input = correctedDecisionSchema.parse(rawInput);
  const db = requireDb();
  const [current] = await db.select().from(savDecisions).where(eq(savDecisions.id, decisionId)).limit(1);
  if (!current || !current.isCurrent) throw new Error("SAV_DECISION_NOT_CURRENT");
  if (!await isSavMessageEligible(current.messageId)) throw new Error("SAV_MESSAGE_BEFORE_CUTOVER");
  return db.transaction(async (tx) => {
    const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, current.messageId)).for("update");
    if (!message) throw new Error("SAV_MESSAGE_NOT_FOUND");
    const [stillCurrent] = await tx.select({ id: savDecisions.id }).from(savDecisions)
      .where(and(eq(savDecisions.id, current.id), eq(savDecisions.isCurrent, true))).limit(1);
    if (!stillCurrent) throw new Error("SAV_DECISION_NOT_CURRENT");
    await invalidateSavReplies(tx, message.threadId, "SAV_REPLY_OBSOLETE");
    // Keep the old proposal for audit, but it must no longer be executable.
    await tx.update(savActions).set({ status: "cancelled", errorCode: "SAV_DECISION_SUPERSEDED", updatedAt: new Date() })
      .where(and(eq(savActions.decisionId, current.id), eq(savActions.status, "pending")));
    if (input.kind === "human_review_required") {
      const now = new Date();
      await tx.update(savThreads).set({ aiPaused: true, status: "human_requested", humanRequestedAt: now, humanDueAt: humanDueAt(now), updatedAt: now })
        .where(eq(savThreads.id, message.threadId));
    }
    await tx.update(savDecisions).set({ isCurrent: false }).where(eq(savDecisions.id, current.id));
    const [replacement] = await tx.insert(savDecisions).values({
      messageId: current.messageId,
      kind: input.kind,
      reasonCode: input.reasonCode,
      explanation: input.explanation,
      confidence: 1_000,
      evidence: current.evidence,
      model: current.model,
      actorType: "human",
      actorEmail,
      supersedesDecisionId: current.id,
    }).returning();
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "sav_decision_corrected",
      entityType: "sav_decision",
      entityId: replacement.id,
      technicalMetadata: { previousDecisionId: current.id, kind: input.kind },
    });
    return replacement;
  });
}

/** SAV-9/SAV-60: retired V0 command, refused before any read or effect (v0-command-retirement.ts). The archived body below stays for the tests of the worker paths that still run; no source file may import it. */
export async function approveSavDraft(...args: Parameters<typeof approveSavDraftArchived>) {
  refuseRetiredSavV0Command("approveDraftAction");
  return approveSavDraftArchived(...args);
}
export async function approveSavDraftArchived(draftActionId: string, actorEmail: string) {
  const db = requireDb();
  const [draft] = await db.select().from(savActions)
    .where(and(eq(savActions.id, draftActionId), eq(savActions.kind, "draft_reply"), eq(savActions.status, "succeeded"))).limit(1);
  if (!draft || !draft.payload.bodyCiphertext) throw new Error("SAV_DRAFT_NOT_FOUND");
  assertSavPilotReplyApprovalAllowed(draft.pilotBatchId);
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, draft.threadId)).limit(1);
  if (!thread || thread.aiPaused) throw new Error("SAV_THREAD_PAUSED");
  const [latest] = await db.select({ id: savMessages.id }).from(savMessages)
    .where(and(eq(savMessages.threadId, draft.threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  if (!draft.messageId || draft.messageId !== latest?.id) throw new Error("SAV_REPLY_OBSOLETE");
  const [action] = await db.insert(savActions).values({
    threadId: draft.threadId,
    messageId: draft.messageId,
    decisionId: draft.decisionId,
    kind: "send_reply",
    idempotencyKey: `reply:admin-send:${draft.id}`,
    payload: { bodyCiphertext: draft.payload.bodyCiphertext, approvedDraftId: draft.id },
    actorType: "human",
    actorEmail,
  }).onConflictDoNothing().returning();
  await db.insert(auditLogs).values({
    actorEmail,
    action: "sav_reply_approved",
    entityType: "sav_action",
    entityId: action?.id ?? draft.id,
    technicalMetadata: { draftActionId: draft.id },
  });
  return action;
}

export async function queueSavTicketCreation(threadId: string, actorEmail: string) {
  if (savReleaseStage() === "v0") throw new Error("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");
  const db = requireDb();
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId)).limit(1);
  if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
  if (thread.hubspotTicketId) return null;
  const [message] = await db.select().from(savMessages)
    .where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savEffectiveReceivedAt)).limit(1);
  if (!message) throw new Error("SAV_MESSAGE_NOT_FOUND");
  const [action] = await db.insert(savActions).values({
    threadId,
    messageId: message.id,
    kind: "create_ticket",
    idempotencyKey: `hubspot:admin-create-ticket:${threadId}`,
    payload: { requestedBy: actorEmail },
    actorType: "human",
    actorEmail,
  }).onConflictDoNothing().returning();
  return action;
}

/** SAV-9/SAV-60: retired V0 command, refused before any read or effect (v0-command-retirement.ts). The archived body below stays for the tests of the worker paths that still run; no source file may import it. */
export async function retrySavAction(...args: Parameters<typeof retrySavActionArchived>) {
  refuseRetiredSavV0Command("retryAction");
  return retrySavActionArchived(...args);
}
export async function retrySavActionArchived(actionId: string, actorEmail: string) {
  const db = requireDb();
  const [current] = await db.select().from(savActions).where(eq(savActions.id, actionId)).limit(1);
  if (current?.errorCode === "SAV_PROPOSAL_STALE" || current?.errorCode === "SAV_REVIEW_STALE") throw new Error(current.errorCode);
  if (current?.payload.purpose === "partnership_forward") throw new Error(current.payload.forwardDispatchedAt ? "SAV_PARTNERSHIP_RECONCILIATION_REQUIRED" : "SAV_PARTNERSHIP_CONFIRMATION_REQUIRED");
  if (current?.errorCode === "SAV_TICKET_ACK_CONTEXT_CHANGED") throw new Error(current.errorCode);
  if (current?.errorCode?.startsWith("SAV_TICKET_PREVIEW_")) throw new Error("SAV_TICKET_PREVIEW_CHANGED");
  if (current?.payload.ticketReturnDispatchedAt && !current.payload.ticketReturnCompletedAt) throw new Error("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED");
  if ((current?.errorCode === "SAV_MANUAL_RECONCILIATION_REQUIRED" || current?.payload.ticketCreateDispatchedAt) && !current?.payload.hubspotTicketId) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
  const [action] = await db.update(savActions).set({ status: "pending", attemptCount: 0, scheduledAt: null, errorCode: null, updatedAt: new Date() })
    .where(and(eq(savActions.id, actionId), eq(savActions.status, "failed"))).returning();
  if (!action) throw new Error("SAV_FAILED_ACTION_NOT_FOUND");
  await db.insert(auditLogs).values({
    actorEmail,
    action: "sav_action_retried",
    entityType: "sav_action",
    entityId: action.id,
    technicalMetadata: { kind: action.kind },
  });
  return action;
}
