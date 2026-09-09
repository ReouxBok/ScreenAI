import "server-only";
import { and, eq, inArray, lt } from "drizzle-orm";
import { requireDb } from "@/db";
import { savGmailQuarantine, savThreads, savWebhookReceipts } from "@/db/schema";

export function savRetentionSettings(now = new Date()) {
  const requested = Number(process.env.SAV_CONTENT_RETENTION_DAYS ?? 365);
  const days = Number.isFinite(requested) ? Math.min(2_555, Math.max(30, Math.round(requested))) : 365;
  return { enabled: process.env.SAV_RETENTION_ENABLED === "true", days, cutoff: new Date(now.getTime() - days * 86_400_000), receiptCutoff: new Date(now.getTime() - 90 * 86_400_000) };
}

/** Deletes only terminal dossiers. Pending and human-owned work is never selected. */
export async function enforceSavRetention(now = new Date()) {
  const settings = savRetentionSettings(now);
  if (!settings.enabled) return { skipped: "disabled", deletedThreads: 0, deletedReceipts: 0, deletedQuarantine: 0 };
  const db = requireDb();
  return db.transaction(async (tx) => {
    const deletedThreads = await tx.delete(savThreads).where(and(
      inArray(savThreads.status, ["resolved", "closed_no_action"]), lt(savThreads.lastMessageAt, settings.cutoff),
    )).returning({ id: savThreads.id });
    const deletedReceipts = await tx.delete(savWebhookReceipts).where(and(
      eq(savWebhookReceipts.status, "processed"), lt(savWebhookReceipts.receivedAt, settings.receiptCutoff),
    )).returning({ id: savWebhookReceipts.id });
    const deletedQuarantine = await tx.delete(savGmailQuarantine).where(and(
      eq(savGmailQuarantine.status, "resolved"), lt(savGmailQuarantine.lastFailedAt, settings.receiptCutoff),
    )).returning({ id: savGmailQuarantine.id });
    return { deletedThreads: deletedThreads.length, deletedReceipts: deletedReceipts.length, deletedQuarantine: deletedQuarantine.length };
  });
}
