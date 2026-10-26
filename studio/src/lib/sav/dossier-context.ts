import "server-only";
import { and, desc, eq, ne } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { loadSavConversation, type SavConversation } from "./conversation";
import { readSavHubspotContext } from "./hubspot";
import { extractSavIdentityHints } from "./identity";
import { resolveSavCustomerMessage, resolveSavCustomerIdentity } from "./forwarded-identity";
import { splitSavMessageText } from "./message-context";
import { getSavRelatedThreads } from "./thread-context";
import { applySavHumanTicketRouting, savEffectiveCustomerEmail, savHumanTicketAction } from "./human-process";
import { savEffectiveReceivedAt, savNotAfterAnchor } from "@/lib/sav/message-order";

export type SavDossierContext = {
  version: 1; messageId: string; collectedAt: string;
  customerIdentity: ReturnType<typeof resolveSavCustomerIdentity>;
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

async function otherConversations(message: typeof savMessages.$inferSelect, customerEmail = message.fromEmail) {
  const db = requireDb();
  const related = customerEmail.toLowerCase() === message.fromEmail.toLowerCase() ? await getSavRelatedThreads(message.threadId) : [];
  // Same sender is a search candidate, not evidence that this is the same issue.
  // Use actual incoming messages (including participants in multi-party threads).
  const rows = await db.select({ id: savThreads.id, subject: savThreads.subject, receivedAt: savMessages.receivedAt,
    from: savMessages.fromEmail, direction: savMessages.direction, bodyCiphertext: savMessages.bodyCiphertext })
    .from(savMessages).innerJoin(savThreads, eq(savThreads.id, savMessages.threadId)).where(and(
      eq(savMessages.mailboxId, message.mailboxId), ne(savMessages.threadId, message.threadId),
      eq(savMessages.direction, "inbound"), eq(savMessages.fromEmail, customerEmail),
      savNotAfterAnchor(message.id),
    )).orderBy(desc(savEffectiveReceivedAt)).limit(40);
  const candidates: SavDossierContext["otherConversations"] = [];
  for (const row of rows) {
    if (candidates.some((entry) => entry.id === row.id)) continue;
    candidates.push({ id: row.id, subject: row.subject,
      relation: related.find((entry) => entry.id === row.id)?.relationLabel ?? "Même expéditeur — sujet à vérifier",
      messages: [] });
    if (candidates.length === 5) break;
  }
  await Promise.all(candidates.map(async candidate => {
    const history = await db.select().from(savMessages).where(and(eq(savMessages.threadId, candidate.id),
      eq(savMessages.mailboxId, message.mailboxId), savNotAfterAnchor(message.id)))
      .orderBy(desc(savEffectiveReceivedAt)).limit(6);
    // Do not expose another participant's messages as this customer's history.
    candidate.messages = history.filter((row) => row.direction === "inbound" ? row.fromEmail.toLowerCase() === customerEmail.toLowerCase()
      : row.toEmails.some((email) => email.toLowerCase() === customerEmail.toLowerCase()))
      .map((row) => ({ from: row.fromEmail, direction: row.direction, receivedAt: row.receivedAt.toISOString(),
        text: splitSavMessageText(decryptSavPayload<{ text: string }>(row.bodyCiphertext).text).currentText.slice(0, 1_200) })).reverse();
  }));
  return candidates;
}

/** Refresh the message displayed by the dossier, including when an older inbox row was clicked. */
export async function collectLatestSavDossierContext(threadId: string): Promise<SavDossierContext> {
  const db = requireDb();
  const latestInbound = async () => {
    const [message] = await db.select({ id: savMessages.id }).from(savMessages)
      .where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
      .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    if (!message) throw new Error("SAV_MESSAGE_NOT_FOUND");
    return message;
  };
  let latest = await latestInbound();
  // A new inbound can arrive during provider reads. Refresh it before reporting success,
  // but stop after three attempts if the conversation keeps changing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const context = await collectSavDossierContext(latest.id);
    const current = await latestInbound();
    if (current.id === context.messageId) return context;
    latest = current;
  }
  throw new Error("SAV_CONTEXT_CHANGED_DURING_REFRESH");
}

/** Persist enrichment before a rule or model can produce its decision. No CRM/Gmail writes. */
export async function collectSavDossierContext(messageId: string, options: { persist?: boolean } = {}): Promise<SavDossierContext> {
  const db = requireDb();
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, messageId)).limit(1);
  if (!message) throw new Error("SAV_MESSAGE_NOT_FOUND");
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, message.threadId)).limit(1);
  const body = decryptSavPayload<{ text: string; headers?: Record<string, string>; supportContext?: SavDossierContext }>(message.bodyCiphertext);
  const customerMessage = resolveSavCustomerMessage({ fromEmail: message.fromEmail, subject: message.subject, body: body.text });
  const parts = splitSavMessageText(customerMessage.body);
  const customerIdentity = resolveSavCustomerIdentity({ fromEmail: message.fromEmail, body: body.text });
  let proposal: import("./proposal").SavStructuredProposal | null = null;
  try {
    const { loadSavDossierReviewContext } = await import("./draft-verdicts");
    const reviewed = await loadSavDossierReviewContext(messageId);
    if (reviewed.review?.status === "approved") proposal = reviewed.proposal;
  } catch { /* An initial analysis has no review yet. */ }
  const customerEmail = proposal ? savEffectiveCustomerEmail(proposal, customerIdentity) : customerIdentity.email;
  const [crm, conversation, others] = await Promise.allSettled([
    customerEmail ? readSavHubspotContext({ email: customerEmail, subject: customerMessage.subject, body: customerMessage.body, returnedAt: message.receivedAt,
      skipSemanticMatch: Boolean(proposal && savHumanTicketAction(proposal)), cachedMatching: body.supportContext?.crm.data?.matching,
      currentTicketId: customerIdentity.kind === "sender" && thread?.customerEmail.toLowerCase() === customerEmail.toLowerCase() ? thread.hubspotTicketId : undefined,
      identityHints: customerIdentity.kind === "sender" ? extractSavIdentityHints([parts.currentText, parts.signatureText].filter(Boolean).join("\n"), body.headers?.["from-display-name"]) : undefined, toleratePartial: true, includeHistory: true })
      : Promise.reject(new Error("SAV_FORWARDED_CUSTOMER_UNRESOLVED")),
    customerMessage.kind !== "sender"
      ? Promise.resolve<SavConversation>({ threadId: message.threadId, currentMessageId: message.id, hubspotTicketId: null,
        status: thread?.status ?? "new", aiPaused: thread?.aiPaused ?? false, senderMatchesCustomer: customerMessage.kind === "forwarded",
        messages: customerMessage.kind === "forwarded" && customerIdentity.email ? [{ id: message.id, direction: "inbound", from: customerIdentity.email, receivedAt: message.receivedAt.toISOString(),
          text: parts.currentText.slice(0, 4_000), truncated: parts.currentText.length > 4_000 }] : [], olderSummary: [], historyTruncated: parts.currentText.length > 4_000,
        attachmentNotice: "Les pièces jointes ne sont pas analysées. Ne prétends pas avoir consulté une capture ou un document joint ; demande les détails nécessaires si leur contenu est indispensable." })
      : loadSavConversation(messageId),
    customerMessage.kind === "unresolved_forward"
      ? Promise.resolve<SavDossierContext["otherConversations"]>([])
      : otherConversations(message, customerIdentity.email ?? message.fromEmail),
  ]);
  if (customerMessage.kind === "forwarded" && conversation.status === "fulfilled" && crm.status === "fulfilled" && crm.value.routing.kind === "matched") {
    conversation.value.hubspotTicketId = crm.value.routing.ticketId;
  }
  let context: SavDossierContext = {
    version: 1, messageId, collectedAt: new Date().toISOString(), customerIdentity,
    crm: crm.status === "fulfilled" ? { status: crm.value.errorCode ? "partial" : "ready", data: crm.value, errorCode: crm.value.errorCode ?? null }
      : { status: "error", data: null, errorCode: customerIdentity.kind === "unresolved_forward" ? "SAV_FORWARDED_CUSTOMER_UNRESOLVED" : "SAV_HUBSPOT_CONTACT_UNAVAILABLE" },
    conversation: conversation.status === "fulfilled" ? conversation.value : null,
    conversationError: conversation.status === "fulfilled" ? null : "SAV_CONVERSATION_UNAVAILABLE",
    otherConversations: others.status === "fulfilled" ? others.value : [],
    otherConversationsError: others.status === "fulfilled" ? null : "SAV_OTHER_CONVERSATIONS_UNAVAILABLE",
  };
  if (proposal && savHumanTicketAction(proposal) && context.crm.status === "ready") {
    try { context = applySavHumanTicketRouting(proposal, context, message.receivedAt); }
    catch { context.crm = { ...context.crm, status: "partial", errorCode: "SAV_TICKET_SELECTION_UNVERIFIED" }; }
  }
  if (options.persist !== false) await db.transaction(async (tx) => {
    const [current] = await tx.select().from(savMessages).where(eq(savMessages.id, messageId)).for("update");
    if (!current) throw new Error("SAV_MESSAGE_NOT_FOUND");
    const original = decryptSavPayload<Record<string, unknown>>(current.bodyCiphertext);
    await tx.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ ...original, supportContext: context }) }).where(eq(savMessages.id, messageId));
  });
  return context;
}
