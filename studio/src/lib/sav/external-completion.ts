import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savActions, savDecisions, savLearningCandidates, savMessages, savPilotItems, savResolutionObservations, savThreads } from "@/db/schema";
import { savV0EligibleMessageFilter } from "./cutover";

export const SAV_EXTERNAL_COMPLETION = "sav_dossier_completed_externally";
export const SAV_EXTERNAL_COMPLETION_REVERTED = "sav_dossier_external_completion_reverted";
export const savExternalCompletionEvents = [SAV_EXTERNAL_COMPLETION, SAV_EXTERNAL_COMPLETION_REVERTED];
type Audit = Pick<typeof auditLogs.$inferSelect, "id" | "actorEmail" | "action" | "entityType" | "entityId" | "technicalMetadata" | "createdAt">;
type Action = Pick<typeof savActions.$inferSelect, "kind" | "actorType" | "status" | "payload">;
const markerSchema = z.object({ version: z.literal(1), threadId: z.uuid(), batchId: z.uuid(), receivedBefore: z.iso.datetime({ offset: true }), reason: z.literal("processed_outside_studio") });

/** A Studio disposition, never a model verdict, provider result or learning proof. */
export function findSavExternalCompletion(message: { id: string; threadId: string; receivedAt: Date }, events: Audit[]) {
  const revoked = new Set(events.filter(event => event.action === SAV_EXTERNAL_COMPLETION_REVERTED && event.actorEmail.toLowerCase() === "ugo@limova.ai" && event.entityType === "sav_message" && event.entityId === message.id)
    .map(event => event.technicalMetadata.completionId));
  return events.filter(event => {
    if (event.action !== SAV_EXTERNAL_COMPLETION || event.actorEmail.toLowerCase() !== "ugo@limova.ai" || event.entityType !== "sav_message" || event.entityId !== message.id || revoked.has(event.id)) return false;
    const marker = markerSchema.safeParse(event.technicalMetadata);
    return marker.success && marker.data.threadId === message.threadId && message.receivedAt.getTime() < Date.parse(marker.data.receivedBefore);
  }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))[0] ?? null;
}

/** Do not hide a real queued request or an uncertain provider result. */
export function hasUnsettledSavHumanAction(actions: Action[]) {
  const external = new Set(["create_ticket", "link_ticket", "send_reply", "log_email", "create_note", "update_ticket_status"]);
  return actions.some(action => action.actorType === "human" && external.has(action.kind) && (
    ["pending", "running"].includes(action.status)
    || Boolean(action.payload.ticketCreateDispatchedAt && !action.payload.hubspotTicketId)
    || Boolean(action.payload.ticketReturnDispatchedAt && !action.payload.ticketReturnCompletedAt)
    || Boolean(action.payload.replySendDispatchedAt && action.status !== "succeeded")
    || Boolean(action.payload.forwardDispatchedAt && action.status !== "succeeded")
  ));
}

export async function getSavExternalCompletion(message: { id: string; threadId: string; receivedAt: Date }) {
  const events = await requireDb().select().from(auditLogs).where(and(eq(auditLogs.entityType, "sav_message"), eq(auditLogs.entityId, message.id), inArray(auditLogs.action, savExternalCompletionEvents)));
  return findSavExternalCompletion(message, events);
}

const batchSchema = z.object({ batchId: z.uuid(), receivedBefore: z.iso.datetime({ offset: true }), messages: z.array(z.object({ threadId: z.uuid(), messageId: z.uuid() })).min(1).max(1_000) });
function assertOperator(actorEmail: string) {
  if (actorEmail.toLowerCase() !== "ugo@limova.ai") throw new Error("SAV_EXTERNAL_COMPLETION_FORBIDDEN");
  if (process.env.SAV_RELEASE_STAGE !== "v0" || process.env.SAV_PILOT_MODE === "true") throw new Error("SAV_EXTERNAL_COMPLETION_V0_ONLY");
}

/** Explicit operations entry point only. No cron, server action or model calls it.
 * The caller supplies a frozen preview; we recheck under thread row locks.
 * Only append-only audit rows are written. Snapshots/verdicts/actions are untouched. */
export async function markSavDossiersHandledExternally(raw: unknown, actorEmail: string) {
  assertOperator(actorEmail);
  const input = batchSchema.parse(raw);
  if (Date.parse(input.receivedBefore) > Date.now()) throw new Error("SAV_EXTERNAL_COMPLETION_FUTURE_BOUNDARY");
  const ids = input.messages.map(message => message.messageId);
  const threadIds = input.messages.map(message => message.threadId);
  if (new Set(ids).size !== ids.length || new Set(threadIds).size !== threadIds.length) throw new Error("SAV_EXTERNAL_COMPLETION_DUPLICATE_INPUT");
  return requireDb().transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '30s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.batchId}))`);
    const threads = await tx.select({ id: savThreads.id }).from(savThreads).where(inArray(savThreads.id, threadIds)).orderBy(asc(savThreads.id)).for("update");
    if (threads.length !== threadIds.length) throw new Error("SAV_EXTERNAL_COMPLETION_THREAD_MISSING");
    const latest = await tx.selectDistinctOn([savMessages.threadId]).from(savMessages).where(and(inArray(savMessages.threadId, threadIds), eq(savMessages.direction, "inbound")))
      .orderBy(asc(savMessages.threadId), desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id));
    const eligible = new Set((await tx.select({ id: savMessages.id }).from(savMessages).where(and(inArray(savMessages.id, ids), savV0EligibleMessageFilter()))).map(message => message.id));
    const pilots = new Set((await tx.select({ messageId: savPilotItems.messageId }).from(savPilotItems).where(inArray(savPilotItems.messageId, ids))).map(item => item.messageId));
    const actions = await tx.select().from(savActions).where(inArray(savActions.threadId, threadIds));
    const technicalKinds = new Set(["spam", "automatic_reply", "bounce", "internal_notification", "duplicate"]);
    const decisions = await tx.select({ messageId: savDecisions.messageId, kind: savDecisions.kind }).from(savDecisions).where(and(inArray(savDecisions.messageId, ids), eq(savDecisions.isCurrent, true)));
    const technicalMessages = new Set(decisions.filter(row => technicalKinds.has(row.kind)).map(row => row.messageId));
    const observations = await tx.select({ threadId: savResolutionObservations.threadId }).from(savResolutionObservations).where(inArray(savResolutionObservations.threadId, threadIds));
    const candidates = await tx.select({ threadId: savLearningCandidates.threadId }).from(savLearningCandidates).where(and(inArray(savLearningCandidates.threadId, threadIds), eq(savLearningCandidates.status, "pending")));
    const events = await tx.select().from(auditLogs).where(and(eq(auditLogs.entityType, "sav_message"), inArray(auditLogs.entityId, ids), inArray(auditLogs.action, savExternalCompletionEvents)));
    const blockedLearning = new Set([...observations, ...candidates].map(row => row.threadId));
    const rows: Array<typeof auditLogs.$inferInsert> = [];
    const skipped: Record<string, number> = {};
    let alreadyCompleted = 0;
    for (const requested of input.messages) {
      const message = latest.find(row => row.threadId === requested.threadId);
      let reason: string | null = null;
      if (!message || message.id !== requested.messageId) reason = "new_inbound";
      else if (message.receivedAt.getTime() >= Date.parse(input.receivedBefore)) reason = "after_boundary";
      else if (!eligible.has(message.id) || pilots.has(message.id)) reason = "not_live_eligible";
      else if (technicalMessages.has(message.id)) reason = "technical_exclusion";
      else if (blockedLearning.has(message.threadId)) reason = "learning_history";
      else if (hasUnsettledSavHumanAction(actions.filter(action => action.threadId === message.threadId))) reason = "unsettled_action";
      if (reason) { skipped[reason] = (skipped[reason] ?? 0) + 1; continue; }
      if (findSavExternalCompletion(message!, events)) { alreadyCompleted++; continue; }
      // A reverted batch is never silently re-applied on retry.
      if (events.some(event => event.entityId === requested.messageId && event.technicalMetadata.batchId === input.batchId)) { skipped.previously_applied_batch = (skipped.previously_applied_batch ?? 0) + 1; continue; }
      rows.push({ actorEmail: actorEmail.toLowerCase(), action: SAV_EXTERNAL_COMPLETION, entityType: "sav_message", entityId: message!.id,
        technicalMetadata: { version: 1, threadId: message!.threadId, batchId: input.batchId, receivedBefore: input.receivedBefore, reason: "processed_outside_studio" } });
    }
    if (rows.length) await tx.insert(auditLogs).values(rows);
    return { batchId: input.batchId, requested: input.messages.length, marked: rows.length, alreadyCompleted, skipped };
  });
}

/** Administrative rollback, not deletion or restoration of customer records. */
export async function revertSavExternalCompletionBatch(batchId: string, actorEmail: string) {
  assertOperator(actorEmail); z.uuid().parse(batchId);
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${batchId}))`);
    const originals = await tx.select().from(auditLogs).where(and(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION), eq(auditLogs.actorEmail, "ugo@limova.ai"), sql`${auditLogs.technicalMetadata}->>'batchId' = ${batchId}`));
    if (!originals.length) return { reverted: 0 };
    const reversals = await tx.select().from(auditLogs).where(and(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION_REVERTED), sql`${auditLogs.technicalMetadata}->>'batchId' = ${batchId}`));
    const revoked = new Set(reversals.map(event => event.technicalMetadata.completionId));
    const rows = originals.filter(event => !revoked.has(event.id)).map(event => ({ actorEmail: actorEmail.toLowerCase(), action: SAV_EXTERNAL_COMPLETION_REVERTED, entityType: "sav_message", entityId: event.entityId, technicalMetadata: { version: 1, batchId, completionId: event.id } }));
    if (rows.length) await tx.insert(auditLogs).values(rows);
    return { reverted: rows.length };
  });
}
