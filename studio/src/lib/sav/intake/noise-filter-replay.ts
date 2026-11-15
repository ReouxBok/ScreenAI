import "server-only";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { requireDb } from "@/db";
import { savIntakeConsole, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { intakeQuotesMailbox } from "./message";
import { readIntakeNoiseSenderHistory } from "./noise-filter-runtime";
import { savIntakeNoiseVerdict, summarizeSavIntakeNoiseReplay, type SavIntakeNoiseReplayRecord } from "./noise-filter";

type Db = Pick<ReturnType<typeof requireDb>, "select">;
export const SAV_NOISE_REPLAY_VIEWS = ["other", "to_validate"] as const;

/** SAV-92 offline replay, read only (SELECT only; the CLI wraps it in a READ ONLY transaction). Replays the
 * latest console decision of each thread in the chosen views through the noise filter, as of the mail's
 * receipt. Returns counts and internal message ids only: no address, subject, header value or text.
 * Approximations, all on the conservative side: the human context is the thread's pause/human request,
 * the mailbox-quote check runs on the whole stored text, and mails stored before the header capture only
 * expose Auto-Submitted, Content-Type and the sender (see headersCaptured). */
export async function replaySavIntakeNoiseFilter(db: Db, options: { mailboxId?: string; limit?: number; views?: readonly string[] } = {}) {
  const views = (options.views ?? SAV_NOISE_REPLAY_VIEWS).filter(v => (SAV_NOISE_REPLAY_VIEWS as readonly string[]).includes(v));
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 5000);
  if (!views.length) throw Error("SAV_NOISE_REPLAY_VIEWS_REQUIRED");
  const rows = await db.select({ messageId: savIntakeConsole.messageId, view: savIntakeConsole.view, mailboxId: savIntakeConsole.mailboxId }).from(savIntakeConsole)
    .where(and(inArray(savIntakeConsole.view, [...views]), sql`${savIntakeConsole.messageId} is not null`, options.mailboxId ? eq(savIntakeConsole.mailboxId, options.mailboxId) : undefined))
    .orderBy(desc(savIntakeConsole.updatedAt)).limit(limit);
  const records: SavIntakeNoiseReplayRecord[] = [];
  let headersCaptured = 0, unreadable = 0;
  for (const row of rows) {
    const [message] = await db.select().from(savMessages).where(eq(savMessages.id, row.messageId!));
    const [thread] = message ? await db.select().from(savThreads).where(eq(savThreads.id, message.threadId)) : [];
    const [mailbox] = message ? await db.select({ email: savMailboxes.email }).from(savMailboxes).where(eq(savMailboxes.id, message.mailboxId)) : [];
    let body: { text?: string; headers?: Record<string, string>; attachments?: unknown[] };
    try {
      if (!message || !thread || !mailbox) throw Error();
      body = decryptSavPayload(message.bodyCiphertext);
    } catch { unreadable++; continue; }
    if (body.headers?.["x-studio-noise-headers"] === "v1") headersCaptured++;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(savMessages)
      .where(and(eq(savMessages.threadId, message!.threadId), lte(savMessages.receivedAt, message!.receivedAt)));
    let senderHistory;
    try { senderHistory = await readIntakeNoiseSenderHistory(db, { mailboxId: message!.mailboxId, messageId: message!.id, address: message!.fromEmail, before: message!.receivedAt }); }
    catch { senderHistory = null; }
    const text = body.text ?? "";
    const verdict = savIntakeNoiseVerdict({ messageId: message!.id, direction: message!.direction, fromEmail: message!.fromEmail, subject: message!.subject,
      bodyText: text, headers: body.headers, attachmentCount: body.attachments?.length ?? 0, senderHistory,
      context: { conversationLength: Number(n), threadTicketId: thread!.hubspotTicketId, humanContext: Boolean(thread!.aiPaused || thread!.humanRequestedAt),
        quotedMailboxReply: intakeQuotesMailbox({ currentText: text, quotedText: "" }, mailbox!.email) } });
    records.push({ messageId: message!.id, view: row.view, verdict });
  }
  return { ...summarizeSavIntakeNoiseReplay(records), scanned: rows.length, unreadable, headersCaptured };
}
