import "server-only";
import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savMessages } from "@/db/schema";
import { assertSavActor } from "./access";
import { savV0EligibleMessageFilter } from "./cutover";
import { executeSavTicketCommandWorkflow, refreshSavContextWorkflow } from "@/workflows/sav-commands";

export async function dispatchSavTicketCommand(actionId: string) {
  try { await start(executeSavTicketCommandWorkflow, [actionId]); }
  catch {
    // The command is already committed; cron recovery remains authoritative.
    console.error("sav_ticket_workflow_deferred", { actionId });
  }
}
export async function enqueueSavContextRefresh(threadId: string, actorEmail: string) {
  assertSavActor(actorEmail);
  z.uuid().parse(threadId);
  const [message] = await requireDb().select({ id: savMessages.id }).from(savMessages)
    .where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound"), savV0EligibleMessageFilter()))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  if (!message) throw new Error("SAV_MESSAGE_BEFORE_CUTOVER");
  const requestId = randomUUID();
  await requireDb().insert(auditLogs).values({ actorEmail, action: "sav_context_refresh_requested", entityType: "sav_context_refresh", entityId: requestId, technicalMetadata: { threadId } });
  try { await start(refreshSavContextWorkflow, [threadId, requestId, actorEmail]); }
  catch {
    await requireDb().insert(auditLogs).values({ actorEmail, action: "sav_context_refresh_failed", entityType: "sav_context_refresh", entityId: requestId, technicalMetadata: { threadId } });
  }
  return requestId;
}
