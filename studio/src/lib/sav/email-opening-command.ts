import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { recordSavEmailOpened } from "./opened-email";

const action = "sav_email_opening_requested", entityType = "sav_email_opening";
const leaseMs = 5 * 60_000;
const inputSchema = z.object({ threadId: z.uuid(), messageId: z.uuid() });
type Metadata = (typeof auditLogs.$inferSelect)["technicalMetadata"];
const finalNotice = (metadata: Metadata) => metadata.gmailFilingStatus === "succeeded" ? metadata.alreadyFiled ? "already_filed" : "filed"
  : String(metadata.errorCode || "SAV_GMAIL_FILING_UNCERTAIN");

/** Authorized click -> durable intent + consultation, with no provider call.
 * The worker retains the existing exact-message Gmail filing guards. */
export async function requestSavEmailOpening(rawInput: unknown, actorEmail: string) {
  assertSavActor(actorEmail);
  const input = inputSchema.parse(rawInput), db = requireDb();
  const [source] = await db.select({ direction: savMessages.direction, gmailMessageId: savMessages.gmailMessageId }).from(savMessages)
    .innerJoin(savThreads, and(eq(savThreads.id, savMessages.threadId), eq(savThreads.mailboxId, savMessages.mailboxId)))
    .innerJoin(savMailboxes, eq(savMailboxes.id, savMessages.mailboxId))
    .where(and(eq(savMessages.id, input.messageId), eq(savMessages.threadId, input.threadId))).limit(1);
  if (!source || source.direction !== "inbound" || !source.gmailMessageId) throw new Error("SAV_GMAIL_FILING_SOURCE_INVALID");
  return db.transaction(async tx => {
    await tx.select({ id: savThreads.id }).from(savThreads).where(eq(savThreads.id, input.threadId)).for("update");
    const [pending] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, action), eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, input.messageId),
      sql`${auditLogs.technicalMetadata}->>'state' in ('pending', 'running', 'dispatching')`)).limit(1);
    if (pending) return { commandId: pending.id, notice: "pending" };
    const [command] = await tx.insert(auditLogs).values({ actorEmail, action, entityType, entityId: input.messageId,
      technicalMetadata: { version: 1, threadId: input.threadId, state: "pending" } }).returning({ id: auditLogs.id });
    await tx.update(savMessages).set({ studioOpenedAt: new Date() }).where(and(eq(savMessages.id, input.messageId), isNull(savMessages.studioOpenedAt)));
    return { commandId: command.id, notice: "pending" };
  });
}

export async function executeSavEmailOpening(commandId: string) {
  z.uuid().parse(commandId);
  const db = requireDb(), leaseToken = randomUUID(), now = Date.now();
  const claim = await db.transaction(async tx => {
    const [command] = await tx.select().from(auditLogs).where(and(eq(auditLogs.id, commandId), eq(auditLogs.action, action), eq(auditLogs.entityType, entityType))).for("update");
    if (!command || command.technicalMetadata.version !== 1) throw new Error("SAV_GMAIL_FILING_COMMAND_INVALID");
    assertSavActor(command.actorEmail);
    const metadata = command.technicalMetadata;
    if (["completed", "uncertain"].includes(String(metadata.state))) return { notice: typeof metadata.notice === "string" ? metadata.notice : "SAV_GMAIL_FILING_UNCERTAIN", command: null };
    if (["running", "dispatching"].includes(String(metadata.state)) && Date.parse(String(metadata.leaseUntil)) > now) return { notice: "pending", command: null };
    if (metadata.state !== "pending") {
      // Recover a committed provider receipt if only the outer acknowledgment was lost.
      const [receipt] = await tx.select({ metadata: auditLogs.technicalMetadata }).from(auditLogs).where(and(eq(auditLogs.action, "sav_email_opened"), eq(auditLogs.entityType, "sav_message"), eq(auditLogs.entityId, command.entityId),
        sql`${auditLogs.technicalMetadata}->>'openingCommandId' = ${commandId}`,
        sql`${auditLogs.technicalMetadata}->>'gmailFilingStatus' in ('succeeded', 'failed', 'disabled', 'uncertain')`)).orderBy(sql`${auditLogs.createdAt} desc`, sql`${auditLogs.id} desc`).limit(1);
      if (receipt || metadata.dispatchedAt) {
        const notice = receipt ? finalNotice(receipt.metadata) : "SAV_GMAIL_FILING_UNCERTAIN";
        await tx.update(auditLogs).set({ technicalMetadata: { ...metadata, state: notice === "SAV_GMAIL_FILING_UNCERTAIN" ? "uncertain" : "completed", notice } }).where(eq(auditLogs.id, command.id));
        return { notice, command: null };
      }
    }
    const next: Metadata = { ...metadata, state: "running", leaseToken, leaseUntil: new Date(now + leaseMs).toISOString() };
    await tx.update(auditLogs).set({ technicalMetadata: next }).where(eq(auditLogs.id, command.id));
    return { notice: "pending", command: { ...command, technicalMetadata: next } };
  });
  if (!claim.command) return { notice: claim.notice };
  const command = claim.command;
  let notice: string;
  try {
    notice = (await recordSavEmailOpened({ threadId: command.technicalMetadata.threadId, messageId: command.entityId }, command.actorEmail, {
      id: commandId,
      beforeModify: async () => {
        // Fencing: a worker whose lease was replaced cannot issue a Gmail mutation.
        const [owned] = await db.update(auditLogs).set({ technicalMetadata: { ...command.technicalMetadata, state: "dispatching", dispatchedAt: new Date().toISOString() } })
          .where(and(eq(auditLogs.id, commandId), sql`${auditLogs.technicalMetadata}->>'leaseToken' = ${leaseToken}`,
            sql`${auditLogs.technicalMetadata}->>'state' = 'running'`, sql`(${auditLogs.technicalMetadata}->>'leaseUntil')::timestamptz > now()`)).returning({ id: auditLogs.id });
        if (!owned) throw new Error("SAV_GMAIL_FILING_COMMAND_STALE");
      },
    })).notice;
  } catch { notice = "SAV_GMAIL_FILING_FAILED"; }
  // Merge the result into the current metadata; preserve durable dispatch proof.
  const [completed] = await db.update(auditLogs).set({ technicalMetadata: sql`${auditLogs.technicalMetadata} || ${JSON.stringify({ state: notice === "SAV_GMAIL_FILING_UNCERTAIN" ? "uncertain" : "completed", notice, completedAt: new Date().toISOString() })}::jsonb` })
    .where(and(eq(auditLogs.id, commandId), sql`${auditLogs.technicalMetadata}->>'leaseToken' = ${leaseToken}`)).returning({ id: auditLogs.id });
  return { notice: completed ? notice : "pending" };
}

