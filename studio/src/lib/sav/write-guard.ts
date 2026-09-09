import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savActions, savMessages, savThreads } from "@/db/schema";
import { savAutomationMode } from "./config";
import { savWriteDenial } from "./action-policy";
import { assertSavOutboundRecipientAllowed } from "./policy";

/** Load current state as close as possible to the external mutation. */
export async function assertSavWriteAllowed(actionId: string) {
  const db = requireDb();
  const [action] = await db.select().from(savActions).where(eq(savActions.id, actionId)).limit(1);
  if (!action) throw new Error("SAV_ACTION_NOT_FOUND");
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, action.threadId)).limit(1);
  if (!thread) throw new Error("SAV_THREAD_NOT_FOUND");
  const [latest] = await db.select().from(savMessages).where(and(
    eq(savMessages.threadId, thread.id), eq(savMessages.direction, "inbound"),
  )).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const denial = savWriteDenial({
    mode: savAutomationMode(), writesDisabled: process.env.SAV_WRITES_DISABLED === "true",
    kind: action.kind, actorType: action.actorType, pilotBatchId: action.pilotBatchId,
    status: action.status, aiPaused: thread.aiPaused, messageId: action.messageId,
    latestInboundId: latest?.id ?? null, latestInboundCreatedAt: latest?.createdAt ?? null,
    followup: Boolean(action.payload.followupSequence), threadStatus: thread.status,
    actionCreatedAt: action.createdAt,
    statusTarget: String(action.payload.target ?? ""),
  });
  if (denial) throw new Error(denial);
  if (["send_reply", "request_human"].includes(action.kind)) assertSavOutboundRecipientAllowed(thread.customerEmail);
  return { action, thread, latest };
}
