import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import {
  auditLogs,
  savActions,
  savAgentRuns,
  savDecisions,
  savFollowups,
  savGmailQuarantine,
  savLearningCandidates,
  savMailboxes,
  savMessages,
  savPilotBatches,
  savPilotItems,
  savThreads,
  savWebhookReceipts,
  type SavDecisionEvidence,
} from "@/db/schema";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { analyzeSavMessage } from "./intelligence";
import { isSavPilotMode } from "./config";
import {
  decisionKindSchema,
  humanDueAt,
  assertSavPilotReplyApprovalAllowed,
  normalizeEmailAddress,
  sanitizeInboundText,
  type DecisionProposal,
} from "./policy";

export type SavMessageBody = { text: string; html?: string; headers?: Record<string, string> };

export const inboundMessageSchema = z.object({
  mailboxEmail: z.email(),
  gmailMessageId: z.string().trim().min(1).max(200),
  gmailThreadId: z.string().trim().min(1).max(200),
  from: z.string().trim().min(3).max(500),
  to: z.array(z.string().trim().min(3).max(500)).max(50).default([]),
  subject: z.string().trim().max(1_000).default("Sans objet"),
  bodyText: z.string().max(100_000).default(""),
  bodyHtml: z.string().max(300_000).optional(),
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

export async function updateMailboxWatch(email: string, historyId: string, expiration: Date) {
  const mailbox = await ensureSavMailbox(email);
  const [updated] = await requireDb().update(savMailboxes).set({
    historyId,
    watchExpiration: expiration,
    watchStatus: "active",
    updatedAt: new Date(),
  }).where(eq(savMailboxes.id, mailbox.id)).returning();
  return updated;
}

export async function updateMailboxCursor(mailboxId: string, historyId: string) {
  await requireDb().update(savMailboxes).set({ historyId, updatedAt: new Date() })
    .where(eq(savMailboxes.id, mailboxId));
}

async function createDecision(
  message: typeof savMessages.$inferSelect,
  proposal: DecisionProposal,
  evidence: SavDecisionEvidence[] = [],
  model = "rules-v1",
  pilotBatchId?: string,
) {
  const db = requireDb();
  const [existing] = await db.select().from(savDecisions)
    .where(and(eq(savDecisions.messageId, message.id), eq(savDecisions.isCurrent, true))).limit(1);
  if (existing) return existing;

  return db.transaction(async (tx) => {
    const [decision] = await tx.insert(savDecisions).values({
      messageId: message.id,
      kind: proposal.kind,
      reasonCode: proposal.reasonCode,
      explanation: proposal.explanation,
      confidence: proposal.confidence,
      evidence,
      model,
      actorType: "ai",
    }).returning();

    const now = new Date();
    if (proposal.kind === "ticket_pending") {
      if (!pilotBatchId) await tx.update(savThreads).set({ status: "ai_processing", updatedAt: now }).where(eq(savThreads.id, message.threadId));
      await tx.insert(savActions).values({
        threadId: message.threadId,
        messageId: message.id,
        decisionId: decision.id,
        pilotBatchId,
        kind: "create_ticket",
        idempotencyKey: `hubspot:create-ticket:${message.id}`,
        payload: { reasonCode: proposal.reasonCode },
        actorType: "ai",
      }).onConflictDoNothing();
    } else if (proposal.kind === "human_review_required") {
      if (!pilotBatchId) {
        await tx.update(savThreads).set({
          status: "human_requested",
          aiPaused: true,
          humanRequestedAt: now,
          humanDueAt: humanDueAt(now),
          updatedAt: now,
        }).where(eq(savThreads.id, message.threadId));
      }
      await tx.insert(savActions).values({
        threadId: message.threadId,
        messageId: message.id,
        decisionId: decision.id,
        pilotBatchId,
        kind: "create_ticket",
        idempotencyKey: `hubspot:create-ticket:${message.id}`,
        payload: { reasonCode: proposal.reasonCode, humanRequired: true },
        actorType: "ai",
      }).onConflictDoNothing();
      await tx.insert(savActions).values({
        threadId: message.threadId,
        messageId: message.id,
        decisionId: decision.id,
        pilotBatchId,
        kind: "request_human",
        status: "pending",
        idempotencyKey: `human:request:${message.id}`,
        payload: { reasonCode: proposal.reasonCode, dueAt: humanDueAt(now).toISOString() },
        actorType: "ai",
        executedAt: null,
      }).onConflictDoNothing();
    } else {
      if (!pilotBatchId) await tx.update(savThreads).set({ status: "closed_no_action", updatedAt: now }).where(eq(savThreads.id, message.threadId));
    }
    await tx.update(savMessages).set({ processedAt: now }).where(eq(savMessages.id, message.id));
    return decision;
  });
}

export async function ingestInboundMessage(rawInput: unknown) {
  const input = inboundMessageSchema.parse(rawInput);
  const db = requireDb();
  const mailbox = await ensureSavMailbox(input.mailboxEmail);
  const normalizedFrom = normalizeEmailAddress(input.from);
  const bodyText = sanitizeInboundText(input.bodyText);

  const result = await db.transaction(async (tx) => {
    let [thread] = await tx.select().from(savThreads)
      .where(and(eq(savThreads.mailboxId, mailbox.id), eq(savThreads.gmailThreadId, input.gmailThreadId))).limit(1);
    if (!thread) {
      [thread] = await tx.insert(savThreads).values({
        mailboxId: mailbox.id,
        gmailThreadId: input.gmailThreadId,
        subject: input.subject || "Sans objet",
        customerEmail: normalizedFrom,
        lastMessageAt: input.receivedAt,
      }).returning();
    }

    const [created] = await tx.insert(savMessages).values({
      mailboxId: mailbox.id,
      threadId: thread.id,
      gmailMessageId: input.gmailMessageId,
      direction: "inbound",
      fromEmail: normalizedFrom,
      toEmails: input.to.map(normalizeEmailAddress),
      subject: input.subject || "Sans objet",
      preview: bodyText.replace(/\s+/g, " ").slice(0, 280),
      bodyCiphertext: encryptSavPayload({ text: bodyText, ...(input.bodyHtml ? { html: input.bodyHtml } : {}), ...(input.headers ? { headers: input.headers } : {}) }),
      receivedAt: input.receivedAt,
    }).onConflictDoNothing().returning();
    const [message] = created ? [created] : await tx.select().from(savMessages)
      .where(and(eq(savMessages.mailboxId, mailbox.id), eq(savMessages.gmailMessageId, input.gmailMessageId))).limit(1);
    if (!message) throw new Error("SAV_MESSAGE_NOT_FOUND");
    await tx.update(savThreads).set({
      subject: input.subject || thread.subject,
      customerEmail: normalizedFrom,
      lastMessageAt: input.receivedAt,
      updatedAt: new Date(),
    }).where(eq(savThreads.id, thread.id));
    if (created) await tx.update(savFollowups).set({ status: "cancelled", cancelledAt: new Date() })
      .where(and(eq(savFollowups.threadId, thread.id), inArray(savFollowups.status, ["scheduled", "queued"])));
    return { mailbox, thread, message, duplicate: !created };
  });

  if (result.duplicate) return result;
  if (isSavPilotMode()) return { ...result, queuedForPilot: true as const };
  const analysis = await analyzeSavMessage({
    from: input.from,
    subject: input.subject,
    body: bodyText,
    autoSubmitted: input.autoSubmitted,
  }, { messageId: result.message.id });
  const decision = await createDecision(result.message, analysis.proposal, analysis.evidence, analysis.model);
  if (analysis.replyDraft) {
    await db.insert(savActions).values({
      threadId: result.thread.id,
      messageId: result.message.id,
      decisionId: decision.id,
      kind: "draft_reply",
      status: "succeeded",
      idempotencyKey: `reply:draft:${result.message.id}`,
      payload: { bodyCiphertext: encryptSavPayload({ text: analysis.replyDraft }), model: analysis.model },
      actorType: "ai",
      executedAt: new Date(),
    }).onConflictDoNothing();
  }
  return { ...result, decision };
}

export async function processSavPilotItem(itemId: string) {
  const db = requireDb();
  const [claimed] = await db.update(savPilotItems).set({
    status: "processing",
    errorCode: null,
    updatedAt: new Date(),
  }).where(and(eq(savPilotItems.id, itemId), eq(savPilotItems.status, "pending"))).returning();
  if (!claimed) return null;
  try {
    const [message] = await db.select().from(savMessages).where(eq(savMessages.id, claimed.messageId)).limit(1);
    if (!message) throw new Error("SAV_PILOT_MESSAGE_NOT_FOUND");
    const body = decryptSavPayload<SavMessageBody>(message.bodyCiphertext);
    const analysis = await analyzeSavMessage(
      { from: message.fromEmail, subject: message.subject, body: body.text },
      { messageId: message.id, pilotBatchId: claimed.batchId },
    );
    const [activeBatch] = await db.select({ id: savPilotBatches.id }).from(savPilotBatches)
      .where(and(eq(savPilotBatches.id, claimed.batchId), eq(savPilotBatches.status, "processing"))).limit(1);
    if (!activeBatch) throw new Error("SAV_PILOT_BATCH_CANCELLED");
    const decision = await createDecision(message, analysis.proposal, analysis.evidence, analysis.model, claimed.batchId);
    if (analysis.replyDraft) await db.insert(savActions).values({
      threadId: message.threadId,
      messageId: message.id,
      decisionId: decision.id,
      pilotBatchId: claimed.batchId,
      kind: "draft_reply",
      status: "succeeded",
      idempotencyKey: `pilot:${claimed.batchId}:reply:draft:${message.id}`,
      payload: { bodyCiphertext: encryptSavPayload({ text: analysis.replyDraft }), model: analysis.model },
      actorType: "ai",
      executedAt: new Date(),
    }).onConflictDoNothing();
    if (analysis.internalNote && ["ticket_pending", "human_review_required"].includes(analysis.proposal.kind)) {
      await db.insert(savActions).values({
        threadId: message.threadId,
        messageId: message.id,
        decisionId: decision.id,
        pilotBatchId: claimed.batchId,
        kind: "create_note",
        idempotencyKey: `pilot:${claimed.batchId}:hubspot:note:${message.id}`,
        payload: { bodyCiphertext: encryptSavPayload({ text: analysis.internalNote }), model: analysis.model },
        actorType: "ai",
      }).onConflictDoNothing();
    }
    await db.update(savPilotItems).set({ status: "ready", decisionId: decision.id, updatedAt: new Date() })
      .where(eq(savPilotItems.id, claimed.id));
    return { itemId: claimed.id, status: "ready" as const };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    await db.update(savPilotItems).set({ status: "error", errorCode, updatedAt: new Date() })
      .where(eq(savPilotItems.id, claimed.id));
    return { itemId: claimed.id, status: "error" as const, errorCode };
  }
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
    ))
    .orderBy(asc(savMessages.receivedAt))
    .limit(Math.min(100, Math.max(10, limit)));
}

export async function startSavPilotBatch(actorEmail: string, selection: number | string[] = 10) {
  if (!isSavPilotMode()) throw new Error("SAV_PILOT_MODE_DISABLED");
  const selectedMessageIds = Array.isArray(selection) ? [...new Set(selection.map((value) => value.trim()).filter(Boolean))] : null;
  if (selectedMessageIds && selectedMessageIds.length !== 10) throw new Error("SAV_PILOT_REQUIRES_10_SELECTED_MAILS");
  const targetSize = selectedMessageIds ? 10 : Math.min(10, Math.max(1, typeof selection === "number" ? selection : 10));
  const db = requireDb();
  const batch = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-pilot-batch'))`);
    const [active] = await tx.select({ id: savPilotBatches.id }).from(savPilotBatches)
      .where(inArray(savPilotBatches.status, ["processing", "reviewing"])).limit(1);
    if (active) throw new Error("SAV_PILOT_BATCH_IN_PROGRESS");
    const candidates = await tx.select({ id: savMessages.id }).from(savMessages)
      .leftJoin(savPilotItems, eq(savPilotItems.messageId, savMessages.id))
      .where(and(
        eq(savMessages.direction, "inbound"),
        isNull(savMessages.processedAt),
        isNull(savPilotItems.id),
        selectedMessageIds ? inArray(savMessages.id, selectedMessageIds) : undefined,
      ))
      .orderBy(asc(savMessages.receivedAt)).limit(targetSize);
    if (candidates.length < targetSize) throw new Error(selectedMessageIds ? "SAV_PILOT_SELECTION_STALE" : `SAV_PILOT_NEEDS_${targetSize}_MAILS`);
    const [created] = await tx.insert(savPilotBatches).values({ targetSize, createdBy: actorEmail }).returning();
    await tx.insert(savPilotItems).values(candidates.map((message) => ({ batchId: created.id, messageId: message.id })))
      .onConflictDoNothing();
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "sav_pilot_batch_started",
      entityType: "sav_pilot_batch",
      entityId: created.id,
      technicalMetadata: { targetSize },
    });
    return created;
  });
  return batch;
}

export async function listSavPilotBatchItems(batchId: string) {
  const db = requireDb();
  const items = await db.select({
    id: savPilotItems.id,
    batchId: savPilotItems.batchId,
    status: savPilotItems.status,
    verdict: savPilotItems.verdict,
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
    .orderBy(asc(savMessages.receivedAt));
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

export async function cancelSavPilotBatch(batchId: string, actorEmail: string, reason: string) {
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

export async function processPendingSavPilotItems(limit = 10) {
  if (!isSavPilotMode()) return { skipped: "pilot_disabled", processed: [] as Array<Record<string, unknown>> };
  const db = requireDb();
  const items = await db.select({ id: savPilotItems.id, batchId: savPilotItems.batchId }).from(savPilotItems)
    .innerJoin(savPilotBatches, eq(savPilotBatches.id, savPilotItems.batchId))
    .where(and(eq(savPilotBatches.status, "processing"), eq(savPilotItems.status, "pending")))
    .orderBy(asc(savPilotItems.createdAt)).limit(Math.min(10, Math.max(1, limit)));
  const processed = [];
  for (const item of items) {
    const result = await processSavPilotItem(item.id);
    if (result) processed.push(result);
  }
  const batchIds = [...new Set(items.map((item) => item.batchId))];
  for (const batchId of batchIds) await finalizeSavPilotBatchIfReady(batchId);
  return { processed };
}

export async function listSavInbox(limit = 100) {
  const db = requireDb();
  return db.select({
    messageId: savMessages.id,
    threadId: savThreads.id,
    receivedAt: savMessages.receivedAt,
    fromEmail: savMessages.fromEmail,
    subject: savMessages.subject,
    preview: savMessages.preview,
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
    .leftJoin(savPilotItems, eq(savPilotItems.messageId, savMessages.id))
    .where(eq(savMessages.direction, "inbound"))
    .orderBy(desc(savMessages.receivedAt))
    .limit(Math.min(250, Math.max(1, limit)));
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
    verdict: savPilotItems.verdict,
    reviewedAt: savPilotItems.reviewedAt,
    createdAt: savAgentRuns.createdAt,
  }).from(savAgentRuns)
    .leftJoin(savPilotItems, eq(savPilotItems.messageId, savAgentRuns.messageId))
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
    latestAt: Date;
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
      latestAt: row.createdAt,
    };
    group.runs += 1;
    group.durationTotalMs += row.durationMs;
    if (["failed", "fallback"].includes(row.status)) group.degraded += 1;
    if (row.reviewedAt && row.verdict) {
      group.reviewed += 1;
      group[row.verdict] += 1;
    }
    groups.set(key, group);
  }

  return [...groups.values()].map(({ durationTotalMs, ...group }) => ({
    ...group,
    acceptanceRate: group.reviewed
      ? Math.round(((group.correct + group.partial * 0.5) / group.reviewed) * 100)
      : null,
    degradedRate: group.runs ? Math.round((group.degraded / group.runs) * 100) : 0,
    averageDurationMs: group.runs ? Math.round(durationTotalMs / group.runs) : 0,
  })).sort((left, right) => right.latestAt.getTime() - left.latestAt.getTime());
}

export async function getSavImprovementSignals(limit = 5_000) {
  const rows = await requireDb().select({
    verdict: savPilotItems.verdict,
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
  const messages = await db.select().from(savMessages).where(eq(savMessages.threadId, threadId)).orderBy(savMessages.receivedAt);
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
      const { bodyCiphertext: _privateBody, ...safePayload } = action.payload;
      void _privateBody;
      return { ...action, payload: safePayload, draftText, noteText };
    }),
  };
}

export async function reviewSavPilotItem(itemId: string, rawInput: unknown, actorEmail: string) {
  const input = pilotReviewSchema.parse(rawInput);
  const db = requireDb();
  const [item] = await db.select().from(savPilotItems).where(eq(savPilotItems.id, itemId)).limit(1);
  if (!item || !["ready", "reviewed"].includes(item.status)) throw new Error("SAV_PILOT_ITEM_NOT_REVIEWABLE");
  const correctedDraftCiphertext = input.correctedDraft ? encryptSavPayload({ text: input.correctedDraft }) : null;
  const now = new Date();
  const [updated] = await db.update(savPilotItems).set({
    status: "reviewed",
    verdict: input.verdict,
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
    technicalMetadata: { verdict: input.verdict, batchId: item.batchId, feedbackCount: input.feedbackCodes.length },
  });
  if (input.verdict !== "correct" && input.correctedDraft.length >= 20) {
    const [context] = await db.select({
      threadId: savThreads.id,
      hubspotTicketId: savThreads.hubspotTicketId,
      subject: savThreads.subject,
    }).from(savMessages)
      .innerJoin(savThreads, eq(savThreads.id, savMessages.threadId))
      .where(eq(savMessages.id, item.messageId))
      .limit(1);
    if (context?.hubspotTicketId) {
      const sourceContentHash = savContentHash({
        source: "pilot_human_review",
        pilotItemId: item.id,
        correctedDraft: input.correctedDraft,
      });
      await db.insert(savLearningCandidates).values({
        threadId: context.threadId,
        hubspotTicketId: context.hubspotTicketId,
        sourceContentHash,
        proposedPatch: {
          ciphertext: encryptSavPayload({
            subject: context.subject,
            finalHumanResolution: input.correctedDraft,
            sourceSnapshotId: `pilot:${item.id}`,
          }),
        },
        explanation: "Un humain a corrigé la réponse proposée pendant le pilote. Cette correction doit encore être relue et approuvée avant de devenir une fiche de résolution.",
        evidenceTicketIds: [context.hubspotTicketId],
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

export async function requestHumanIntervention(threadId: string, actorEmail: string, reason: string) {
  const cleanReason = reason.trim().slice(0, 1_000);
  if (cleanReason.length < 3) throw new Error("HUMAN_REQUEST_REASON_REQUIRED");
  const db = requireDb();
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId)).limit(1);
  if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
  if (thread.aiPaused && thread.humanRequestedAt) return thread;
  const now = new Date();
  const dueAt = humanDueAt(now);
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(savThreads).set({
      status: "human_requested",
      aiPaused: true,
      humanRequestedAt: now,
      humanDueAt: dueAt,
      updatedAt: now,
    }).where(eq(savThreads.id, threadId)).returning();
    await tx.insert(savActions).values({
      threadId,
      kind: "request_human",
      status: "pending",
      idempotencyKey: `human:admin-request:${threadId}`,
      payload: { reason: cleanReason, dueAt: dueAt.toISOString() },
      actorType: "human",
      actorEmail,
    }).onConflictDoNothing();
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "sav_human_requested",
      entityType: "sav_thread",
      entityId: threadId,
      technicalMetadata: { dueAt: dueAt.toISOString() },
    });
    return updated;
  });
}

export async function correctSavDecision(decisionId: string, rawInput: unknown, actorEmail: string) {
  const input = correctedDecisionSchema.parse(rawInput);
  const db = requireDb();
  const [current] = await db.select().from(savDecisions).where(eq(savDecisions.id, decisionId)).limit(1);
  if (!current || !current.isCurrent) throw new Error("SAV_DECISION_NOT_CURRENT");
  return db.transaction(async (tx) => {
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

export async function approveSavDraft(draftActionId: string, actorEmail: string) {
  const db = requireDb();
  const [draft] = await db.select().from(savActions)
    .where(and(eq(savActions.id, draftActionId), eq(savActions.kind, "draft_reply"), eq(savActions.status, "succeeded"))).limit(1);
  if (!draft || !draft.payload.bodyCiphertext) throw new Error("SAV_DRAFT_NOT_FOUND");
  assertSavPilotReplyApprovalAllowed(draft.pilotBatchId);
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
  const db = requireDb();
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId)).limit(1);
  if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
  if (thread.hubspotTicketId) return null;
  const [message] = await db.select().from(savMessages)
    .where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt)).limit(1);
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

export async function retrySavAction(actionId: string, actorEmail: string) {
  const db = requireDb();
  const [action] = await db.update(savActions).set({ status: "pending", errorCode: null, updatedAt: new Date() })
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
