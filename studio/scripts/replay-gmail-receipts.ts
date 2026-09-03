import "dotenv/config";
import { and, asc, eq } from "drizzle-orm";
import { closeDb, requireDb } from "../src/db/client";
import { savWebhookReceipts } from "../src/db/schema";
import { replayFailedGmailReceipts } from "../src/lib/sav/gmail";

const apply = process.argv.includes("--apply");
const requestedLimit = Number(process.argv.find((value) => value.startsWith("--limit="))?.split("=")[1] ?? 100);
const limit = Math.min(500, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));

try {
  if (!apply) {
    const receipts = await requireDb().select({
      id: savWebhookReceipts.id,
      attempts: savWebhookReceipts.attempts,
      errorCode: savWebhookReceipts.errorCode,
      receivedAt: savWebhookReceipts.receivedAt,
    }).from(savWebhookReceipts)
      .where(and(eq(savWebhookReceipts.provider, "gmail"), eq(savWebhookReceipts.status, "failed")))
      .orderBy(asc(savWebhookReceipts.receivedAt)).limit(limit);
    console.log(JSON.stringify({ mode: "dry-run", count: receipts.length, receipts }, null, 2));
  } else {
    const results = await replayFailedGmailReceipts(limit);
    console.log(JSON.stringify({
      mode: "apply",
      processed: results.filter(({ status }) => status === "processed").length,
      failed: results.filter(({ status }) => status === "failed").length,
      results,
    }, null, 2));
  }
} finally {
  await closeDb();
}
