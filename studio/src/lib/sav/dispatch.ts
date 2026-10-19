import "server-only";
import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savMessages, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { savV0EligibleMessageFilter } from "./cutover";
import { executeSavTicketCommandWorkflow, refreshSavContextWorkflow, executeSavEmailOpeningWorkflow } from "@/workflows/sav-commands";

export async function dispatchSavTicketCommand(actionId: string) {
  try { await start(executeSavTicketCommandWorkflow, [actionId]); }
  catch {
    // The command is already committed; cron recovery remains authoritative.
    console.error("sav_ticket_workflow_deferred", { actionId });
  }
}
export async function dispatchSavEmailOpening(commandId: string) {
  try {
    const [claimed] = await requireDb().update(auditLogs).set({ technicalMetadata: sql`${auditLogs.technicalMetadata} || jsonb_build_object('lastDispatchedAt', now())` })
      .where(and(eq(auditLogs.id, commandId), eq(auditLogs.entityType, "sav_email_opening"), eq(auditLogs.action, "sav_email_opening_requested"),
        sql`${auditLogs.technicalMetadata}->>'state' in ('pending', 'running', 'dispatching')`,
        sql`coalesce((${auditLogs.technicalMetadata}->>'lastDispatchedAt')::timestamptz, 'epoch'::timestamptz) < now() - interval '2 minutes'`)).returning({ id: auditLogs.id });
    if (!claimed) return false;
    await start(executeSavEmailOpeningWorkflow, [commandId]);
    return true;
  }
  catch { console.error("sav_email_opening_workflow_deferred"); return false; }
}
/** Cron only re-dispatches durable intents. Provider work runs in separate
 * Workflow steps and cannot consume the reconciliation function's whole budget. */
export async function dispatchPendingSavEmailOpenings(limit = 10) {
  const pending = await requireDb().select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityType, "sav_email_opening"), eq(auditLogs.action, "sav_email_opening_requested"),
    sql`${auditLogs.technicalMetadata}->>'state' in ('pending', 'running', 'dispatching')`,
    sql`(${auditLogs.technicalMetadata}->>'state' = 'pending' or (${auditLogs.technicalMetadata}->>'leaseUntil')::timestamptz <= now())`,
    sql`coalesce((${auditLogs.technicalMetadata}->>'lastDispatchedAt')::timestamptz, 'epoch'::timestamptz) < now() - interval '2 minutes'`))
    .orderBy(asc(auditLogs.createdAt)).limit(Math.max(1, Math.min(20, Math.trunc(limit) || 10)));
  let dispatched = 0;
  for (const command of pending) if (await dispatchSavEmailOpening(command.id)) dispatched++;
  return { dispatched };
}
export async function enqueueSavContextRefresh(threadId: string, actorEmail: string, schedule?: (work: () => Promise<void>) => void) {
  assertSavActor(actorEmail);
  z.uuid().parse(threadId);
  const [message] = await requireDb().select({ id: savMessages.id }).from(savMessages)
    .where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter()))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  if (!message) throw new Error("SAV_MESSAGE_BEFORE_CUTOVER");
  const requested = await requireDb().transaction(async tx => {
    await tx.select({ id: savThreads.id }).from(savThreads).where(eq(savThreads.id, threadId)).for("update");
    const [pending] = await tx.select({ id: auditLogs.entityId }).from(auditLogs).where(and(eq(auditLogs.action, "sav_context_refresh_requested"), eq(auditLogs.entityType, "sav_context_refresh"),
      sql`${auditLogs.technicalMetadata}->>'threadId' = ${threadId}`, sql`${auditLogs.technicalMetadata}->>'messageId' = ${message.id}`,
      sql`${auditLogs.createdAt} > now() - interval '5 minutes'`,
      sql`not exists (select 1 from audit_logs terminal where terminal.entity_type = 'sav_context_refresh' and terminal.entity_id = ${auditLogs.entityId} and terminal.action in ('sav_context_refresh_completed', 'sav_context_refresh_failed'))`))
      .orderBy(desc(auditLogs.createdAt)).limit(1);
    if (pending) return { id: pending.id, created: false };
    const requestId = randomUUID();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_context_refresh_requested", entityType: "sav_context_refresh", entityId: requestId, technicalMetadata: { version: 1, threadId, messageId: message.id } });
    return { id: requestId, created: true };
  });
  const requestId = requested.id;
  if (!requested.created) return requestId;
  const dispatch = async () => {
    try { await start(refreshSavContextWorkflow, [threadId, requestId, actorEmail]); }
    catch { console.error("sav_context_workflow_deferred"); }
  };
  if (schedule) schedule(dispatch); else await dispatch();
  return requestId;
}

/** Only versioned new requests are recovered; historical requests stay untouched.
 * Refresh is read-only at providers, so a lost dispatch can safely be retried. */
export async function processPendingSavContextRefreshes(limit = 5) {
  const db = requireDb();
  const pending = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "sav_context_refresh_requested"), eq(auditLogs.entityType, "sav_context_refresh"),
    sql`${auditLogs.technicalMetadata}->>'version' = '1'`, sql`${auditLogs.createdAt} < now() - interval '5 minutes'`,
    sql`not exists (select 1 from audit_logs terminal where terminal.entity_type = 'sav_context_refresh' and terminal.entity_id = ${auditLogs.entityId} and (terminal.action in ('sav_context_refresh_completed', 'sav_context_refresh_failed') or terminal.action = 'sav_context_refresh_redispatched' and terminal.created_at > now() - interval '5 minutes'))`))
    .orderBy(asc(auditLogs.createdAt)).limit(Math.max(1, Math.min(10, Math.trunc(limit) || 5)));
  let dispatched = 0;
  for (const request of pending) {
    const claim = await db.transaction(async tx => {
      const [locked] = await tx.select().from(auditLogs).where(eq(auditLogs.id, request.id)).for("update");
      if (!locked) return null;
      const [blocked] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityType, "sav_context_refresh"), eq(auditLogs.entityId, request.entityId),
        sql`(${auditLogs.action} in ('sav_context_refresh_completed', 'sav_context_refresh_failed') or ${auditLogs.action} = 'sav_context_refresh_redispatched' and ${auditLogs.createdAt} > now() - interval '5 minutes')`)).limit(1);
      if (blocked) return null;
      assertSavActor(locked.actorEmail);
      const threadId = z.uuid().parse(locked.technicalMetadata.threadId);
      await tx.insert(auditLogs).values({ actorEmail: locked.actorEmail, action: "sav_context_refresh_redispatched", entityType: "sav_context_refresh", entityId: locked.entityId, technicalMetadata: { threadId } });
      return { threadId, actorEmail: locked.actorEmail, requestId: locked.entityId };
    });
    if (!claim) continue;
    dispatched++;
    try { await start(refreshSavContextWorkflow, [claim.threadId, claim.requestId, claim.actorEmail]); }
    catch { console.error("sav_context_workflow_deferred"); }
  }
  return { dispatched };
}
