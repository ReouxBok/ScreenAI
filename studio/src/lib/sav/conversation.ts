import "server-only";
import { and, desc, eq, lte } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload } from "./crypto";

export type SavConversation = {
  threadId: string;
  currentMessageId: string;
  hubspotTicketId: string | null;
  status: string;
  aiPaused: boolean;
  senderMatchesCustomer: boolean;
  messages: Array<{ id: string; direction: string; from: string; receivedAt: string; text: string; truncated: boolean }>;
  historyTruncated: boolean;
  attachmentNotice: string;
};

/** Preserve the original in storage. This only removes obvious quoted history from model context. */
export function currentMessageText(text: string) {
  return text.split(/\n(?:On .+ wrote:|Le .+ a écrit\s*:|[- ]*Original Message[- ]*|[- ]*Message d'origine[- ]*)\s*\n/i)[0]
    .split("\n").filter((line) => !/^\s*>/.test(line)).join("\n").trim();
}

export async function loadSavConversation(messageId: string): Promise<SavConversation> {
  const db = requireDb();
  const [current] = await db.select().from(savMessages).where(eq(savMessages.id, messageId)).limit(1);
  if (!current) throw new Error("SAV_CONTEXT_MESSAGE_MISSING");
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, current.threadId)).limit(1);
  if (!thread) throw new Error("SAV_CONTEXT_THREAD_MISSING");
  const rows = await db.select().from(savMessages).where(and(
    eq(savMessages.threadId, thread.id), eq(savMessages.mailboxId, current.mailboxId),
    lte(savMessages.receivedAt, current.receivedAt), lte(savMessages.createdAt, current.createdAt),
  )).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(13);
  let remaining = 18_000;
  const messages = rows.slice(0, 12).map((row) => {
    const body = decryptSavPayload<{ text: string }>(row.bodyCiphertext);
    const clean = currentMessageText(body.text);
    const text = clean.slice(0, Math.min(4_000, remaining));
    remaining -= text.length;
    return { id: row.id, direction: row.direction, from: row.fromEmail, receivedAt: row.receivedAt.toISOString(), text, truncated: text.length < clean.length };
  }).reverse();
  return {
    threadId: thread.id, currentMessageId: current.id, hubspotTicketId: thread.hubspotTicketId,
    status: thread.status, aiPaused: thread.aiPaused,
    senderMatchesCustomer: current.fromEmail.toLowerCase() === thread.customerEmail.toLowerCase(),
    messages, historyTruncated: rows.length > 12 || messages.some((message) => message.truncated),
    attachmentNotice: "Les pièces jointes ne sont pas analysées. Ne prétends pas avoir consulté une capture ou un document joint ; demande les détails nécessaires si leur contenu est indispensable.",
  };
}
