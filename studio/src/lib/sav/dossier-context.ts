import "server-only";
import { and, desc, eq, lte, ne } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { loadSavConversation, type SavConversation } from "./conversation";
import { readSavHubspotContext } from "./hubspot";
import { extractSavIdentityHints } from "./identity";
import { splitSavMessageText } from "./message-context";
import { getSavRelatedThreads } from "./thread-context";

export type SavDossierContext = {
  version: 1; messageId: string; collectedAt: string;
  crm: { status: "ready" | "partial" | "error"; errorCode: string | null; data: Awaited<ReturnType<typeof readSavHubspotContext>> | null };
  conversation: SavConversation | null;
  conversationError: string | null;
  otherConversations: Array<{ id: string; subject: string; relation: string; messages: Array<{ from: string; direction: string; text: string; receivedAt: string }> }>;
  otherConversationsError: string | null;
};

export function savedSavDossierContext(body: { supportContext?: unknown }, messageId: string): SavDossierContext | null {
  const value = body.supportContext as SavDossierContext | undefined;
  return value?.version === 1 && value.messageId === messageId && value.crm ? value : null;
}

async function otherConversations(message: typeof savMessages.$inferSelect) {
  const db = requireDb();
  const related = await getSavRelatedThreads(message.threadId);
  // Same sender is a search candidate, not evidence that this is the same issue.
  // Use actual incoming messages (including participants in multi-party threads).
  const rows = await db.select({ id: savThreads.id, subject: savThreads.subject, receivedAt: savMessages.receivedAt,
    from: savMessages.fromEmail, direction: savMessages.direction, bodyCiphertext: savMessages.bodyCiphertext })
    .from(savMessages).innerJoin(savThreads, eq(savThreads.id, savMessages.threadId)).where(and(
      eq(savMessages.mailboxId, message.mailboxId), ne(savMessages.threadId, message.threadId),
      eq(savMessages.direction, "inbound"), eq(savMessages.fromEmail, message.fromEmail),
      lte(savMessages.receivedAt, message.receivedAt),
    )).orderBy(desc(savMessages.receivedAt)).limit(40);
  const candidates: SavDossierContext["otherConversations"] = [];
  for (const row of rows) {
    if (candidates.some((entry) => entry.id === row.id)) continue;
    candidates.push({ id: row.id, subject: row.subject,
      relation: related.find((entry) => entry.id === row.id)?.relationLabel ?? "Même expéditeur — sujet à vérifier",
      messages: [] });
    if (candidates.length === 5) break;
  }
  for (const candidate of candidates) {
    const history = await db.select().from(savMessages).where(and(eq(savMessages.threadId, candidate.id),
      eq(savMessages.mailboxId, message.mailboxId), lte(savMessages.receivedAt, message.receivedAt)))
      .orderBy(desc(savMessages.receivedAt)).limit(6);
    // Do not expose another participant's messages as this customer's history.
    candidate.messages = history.filter((row) => row.direction === "inbound" ? row.fromEmail === message.fromEmail
      : row.toEmails.some((email) => email.toLowerCase() === message.fromEmail.toLowerCase()))
      .map((row) => ({ from: row.fromEmail, direction: row.direction, receivedAt: row.receivedAt.toISOString(),
        text: splitSavMessageText(decryptSavPayload<{ text: string }>(row.bodyCiphertext).text).currentText.slice(0, 1_200) })).reverse();
  }
  return candidates;
}

/** Persist enrichment before a rule or model can produce its decision. No CRM/Gmail writes. */
export async function collectSavDossierContext(messageId: string): Promise<SavDossierContext> {
  const db = requireDb();
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, messageId)).limit(1);
  if (!message) throw new Error("SAV_MESSAGE_NOT_FOUND");
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, message.threadId)).limit(1);
  const body = decryptSavPayload<{ text: string; headers?: Record<string, string> }>(message.bodyCiphertext);
  const parts = splitSavMessageText(body.text);
  const [crm, conversation, others] = await Promise.allSettled([
    readSavHubspotContext({ email: message.fromEmail, subject: message.subject,
      currentTicketId: thread?.customerEmail.toLowerCase() === message.fromEmail.toLowerCase() ? thread.hubspotTicketId : undefined,
      identityHints: extractSavIdentityHints([parts.currentText, parts.signatureText].filter(Boolean).join("\n"), body.headers?.["from-display-name"]), toleratePartial: true }),
    loadSavConversation(messageId), otherConversations(message),
  ]);
  const context: SavDossierContext = {
    version: 1, messageId, collectedAt: new Date().toISOString(),
    crm: crm.status === "fulfilled" ? { status: crm.value.errorCode ? "partial" : "ready", data: crm.value, errorCode: crm.value.errorCode ?? null }
      : { status: "error", data: null, errorCode: "SAV_HUBSPOT_CONTACT_UNAVAILABLE" },
    conversation: conversation.status === "fulfilled" ? conversation.value : null,
    conversationError: conversation.status === "fulfilled" ? null : "SAV_CONVERSATION_UNAVAILABLE",
    otherConversations: others.status === "fulfilled" ? others.value : [],
    otherConversationsError: others.status === "fulfilled" ? null : "SAV_OTHER_CONVERSATIONS_UNAVAILABLE",
  };
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(savMessages).where(eq(savMessages.id, messageId)).for("update");
    if (!current) throw new Error("SAV_MESSAGE_NOT_FOUND");
    const original = decryptSavPayload<Record<string, unknown>>(current.bodyCiphertext);
    await tx.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ ...original, supportContext: context }) }).where(eq(savMessages.id, messageId));
  });
  return context;
}
