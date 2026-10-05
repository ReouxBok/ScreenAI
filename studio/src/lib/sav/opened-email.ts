import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savMailboxes, savMessages, savPilotItems, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { savAutomationMode, savReleaseStage } from "./config";
import { isSavMessageEligible } from "./cutover";
import { fileOpenedGmailMessage, SAV_STUDIO_GMAIL_LABEL_NAME } from "./gmail";

const openedEmailSchema = z.object({ threadId: z.uuid(), messageId: z.uuid() });

function assertFilingEnabled() {
  if (savAutomationMode() === "shadow" || process.env.SAV_WRITES_DISABLED === "true" || process.env.SAV_TEST_MODE === "true") {
    throw new Error("SAV_GMAIL_FILING_DISABLED");
  }
  if (savReleaseStage() !== "v0" || process.env.SAV_PILOT_MODE === "true") throw new Error("SAV_GMAIL_FILING_PILOT_BLOCKED");
}

/** Called only by an authenticated POST from the inbox, never by rendering/prefetch. */
export async function recordSavEmailOpened(rawInput: unknown, actorEmail: string) {
  assertSavActor(actorEmail);
  const input = openedEmailSchema.parse(rawInput);
  const db = requireDb();
  const [source] = await db.select({
    gmailMessageId: savMessages.gmailMessageId, gmailThreadId: savThreads.gmailThreadId,
    direction: savMessages.direction, mailboxEmail: savMailboxes.email,
  }).from(savMessages)
    .innerJoin(savThreads, and(eq(savThreads.id, savMessages.threadId), eq(savThreads.mailboxId, savMessages.mailboxId)))
    .innerJoin(savMailboxes, eq(savMailboxes.id, savMessages.mailboxId))
    .where(and(eq(savMessages.id, input.messageId), eq(savMessages.threadId, input.threadId))).limit(1);
  if (!source || source.direction !== "inbound" || !source.gmailMessageId) throw new Error("SAV_GMAIL_FILING_SOURCE_INVALID");

  const [audit] = await db.insert(auditLogs).values({
    actorEmail, action: "sav_email_opened", entityType: "sav_message", entityId: input.messageId,
    technicalMetadata: { threadId: input.threadId, gmailFilingStatus: "pending", labelName: SAV_STUDIO_GMAIL_LABEL_NAME },
  }).returning({ id: auditLogs.id });
  let dispatched = false;
  const metadata: Record<string, string | number | boolean | null> = {
    threadId: input.threadId, labelName: SAV_STUDIO_GMAIL_LABEL_NAME,
  };
  async function assertCurrentSource() {
    assertFilingEnabled();
    const [mailbox] = await db.select({ active: savMailboxes.active }).from(savMailboxes)
      .where(eq(savMailboxes.email, source.mailboxEmail)).limit(1);
    if (!mailbox?.active) throw new Error("SAV_GMAIL_FILING_MAILBOX_INACTIVE");
    if (!await isSavMessageEligible(input.messageId)) throw new Error("SAV_GMAIL_FILING_BEFORE_CUTOVER");
    const [pilot] = await db.select({ id: savPilotItems.id }).from(savPilotItems).where(eq(savPilotItems.messageId, input.messageId)).limit(1);
    if (pilot) throw new Error("SAV_GMAIL_FILING_PILOT_BLOCKED");
  }
  let notice: string;
  try {
    await assertCurrentSource();
    const result = await fileOpenedGmailMessage({ mailboxEmail: source.mailboxEmail, gmailMessageId: source.gmailMessageId, gmailThreadId: source.gmailThreadId }, async () => {
      await assertCurrentSource();
      metadata.dispatchedAt = new Date().toISOString();
      await db.update(auditLogs).set({ technicalMetadata: { ...metadata, gmailFilingStatus: "dispatching" } }).where(eq(auditLogs.id, audit.id));
      // Configuration may have changed while the trace was being persisted.
      assertFilingEnabled();
      dispatched = true;
    });
    notice = result.alreadyFiled ? "already_filed" : "filed";
    Object.assign(metadata, { gmailFilingStatus: "succeeded", labelId: result.labelId, alreadyFiled: result.alreadyFiled });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    notice = code === "GMAIL_HTTP_403" ? "SAV_GMAIL_FILING_PERMISSION_DENIED"
      : /^SAV_GMAIL_[A-Z_]+$/.test(code) ? code : dispatched ? "SAV_GMAIL_FILING_UNCERTAIN" : "SAV_GMAIL_FILING_FAILED";
    Object.assign(metadata, { gmailFilingStatus: notice === "SAV_GMAIL_FILING_DISABLED" ? "disabled" : notice === "SAV_GMAIL_FILING_UNCERTAIN" ? "uncertain" : "failed", errorCode: notice });
  }
  metadata.completedAt = new Date().toISOString();
  try {
    await db.update(auditLogs).set({ technicalMetadata: metadata }).where(eq(auditLogs.id, audit.id));
  } catch {
    // The initial click/dispatch trace remains. Do not pretend the final audit committed.
    console.error("sav_gmail_filing_audit_failed", { auditId: audit.id });
    notice = "SAV_GMAIL_FILING_UNCERTAIN";
  }
  return { notice, auditId: audit.id };
}
