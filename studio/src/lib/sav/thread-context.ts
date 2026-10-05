import "server-only";

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload } from "./crypto";
import { normalizeEmailAddress } from "./policy";

const MAX_SOURCE_MESSAGES = 50;
const MAX_CANDIDATE_THREADS = 40;
const MAX_CANDIDATE_MESSAGES = 400;
const MAX_RELATED_THREADS = 10;
const MAX_HEADER_LENGTH = 2_000;
const MAX_REFERENCE_IDS = 50;

export type SavRelatedThread = {
  id: string;
  subject: string;
  lastMessageAt: Date;
  relationLabel: string;
};

type MessageReferences = { ownIds: Set<string>; replyIds: Set<string> };
type ContextMessage = Pick<typeof savMessages.$inferSelect, "threadId" | "direction" | "fromEmail" | "toEmails" | "bodyCiphertext">;

function headerValue(headers: Record<string, unknown>, name: string) {
  const matches = Object.entries(headers).filter(([key]) => key.toLocaleLowerCase("en") === name);
  // Ambiguous repeated headers are not reliable evidence for a cross-thread link.
  return matches.length === 1 && typeof matches[0][1] === "string" ? matches[0][1] : undefined;
}

function referenceIds(value: string | undefined) {
  if (!value || value.length > MAX_HEADER_LENGTH || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return [];
  const ids: string[] = [];
  for (const match of value.matchAll(/<([^<>\s@]+@[^<>\s@]+)>/g)) {
    const id = match[1];
    if (id.length > 320) continue;
    const at = id.lastIndexOf("@");
    // The domain is case-insensitive; keep id-left case-sensitive to avoid guesses.
    ids.push(`${id.slice(0, at)}@${id.slice(at + 1).toLocaleLowerCase("en")}`);
    if (ids.length >= MAX_REFERENCE_IDS) break;
  }
  return ids;
}

function messageReferences(message: ContextMessage, customerEmail: string, mailboxEmail: string): MessageReferences | null {
  const from = normalizeEmailAddress(message.fromEmail);
  const belongsToCustomer = message.direction === "inbound"
    ? from === customerEmail
    : message.direction === "outbound" && from === mailboxEmail
      && message.toEmails.some((email) => normalizeEmailAddress(email) === customerEmail);
  if (!belongsToCustomer) return null;
  try {
    const body = decryptSavPayload<{ headers?: unknown }>(message.bodyCiphertext);
    if (!body.headers || typeof body.headers !== "object" || Array.isArray(body.headers)) return null;
    const headers = body.headers as Record<string, unknown>;
    const own = referenceIds(headerValue(headers, "message-id"));
    const reply = [
      ...referenceIds(headerValue(headers, "in-reply-to")),
      ...referenceIds(headerValue(headers, "references")),
    ];
    return { ownIds: new Set(own.length === 1 ? own : []), replyIds: new Set(reply) };
  } catch {
    // Corrupt/unreadable payloads cannot justify revealing another conversation.
    return null;
  }
}

function intersects(left: Set<string>, right: Set<string>) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function combineReferences(messages: ContextMessage[], customerEmail: string, mailboxEmail: string) {
  const combined: MessageReferences = { ownIds: new Set(), replyIds: new Set() };
  for (const message of messages) {
    const references = messageReferences(message, customerEmail, mailboxEmail);
    for (const id of references?.ownIds ?? []) combined.ownIds.add(id);
    for (const id of references?.replyIds ?? []) combined.replyIds.add(id);
  }
  return combined;
}

/**
 * Read-only UI context. The caller must first authorize access to the SAV Studio.
 * RFC headers establish a suggested link, never a merge or an identity decision.
 * Historical messages can provide context without being analyzed or reprocessed.
 * Missing headers and messages outside the bounded recent window produce no guess.
 */
export async function getSavRelatedThreads(threadId: string): Promise<SavRelatedThread[]> {
  if (!z.uuid().safeParse(threadId).success) return [];
  const db = requireDb();
  const [source] = await db.select({
    id: savThreads.id,
    mailboxId: savThreads.mailboxId,
    customerEmail: savThreads.customerEmail,
    mailboxEmail: savMailboxes.email,
  }).from(savThreads).innerJoin(savMailboxes, eq(savMailboxes.id, savThreads.mailboxId))
    .where(eq(savThreads.id, threadId)).limit(1);
  if (!source) return [];
  const customerEmail = normalizeEmailAddress(source.customerEmail);
  const mailboxEmail = normalizeEmailAddress(source.mailboxEmail);
  if (!z.email().safeParse(customerEmail).success) return [];

  const [sourceMessages, candidateThreads] = await Promise.all([
    db.select({
      threadId: savMessages.threadId, direction: savMessages.direction, fromEmail: savMessages.fromEmail,
      toEmails: savMessages.toEmails, bodyCiphertext: savMessages.bodyCiphertext,
    }).from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.mailboxId, source.mailboxId)))
      .orderBy(desc(savMessages.receivedAt), desc(savMessages.id)).limit(MAX_SOURCE_MESSAGES),
    db.select({ id: savThreads.id, subject: savThreads.subject, lastMessageAt: savThreads.lastMessageAt })
      .from(savThreads).where(and(
        eq(savThreads.mailboxId, source.mailboxId), ne(savThreads.id, threadId),
        sql`lower(trim(${savThreads.customerEmail})) = ${customerEmail}`,
      )).orderBy(desc(savThreads.lastMessageAt), desc(savThreads.id)).limit(MAX_CANDIDATE_THREADS),
  ]);
  const sourceReferences = combineReferences(sourceMessages, customerEmail, mailboxEmail);
  if ((!sourceReferences.ownIds.size && !sourceReferences.replyIds.size) || !candidateThreads.length) return [];

  const candidateMessages = await db.select({
    threadId: savMessages.threadId, direction: savMessages.direction, fromEmail: savMessages.fromEmail,
    toEmails: savMessages.toEmails, bodyCiphertext: savMessages.bodyCiphertext,
  }).from(savMessages).where(and(
    eq(savMessages.mailboxId, source.mailboxId), inArray(savMessages.threadId, candidateThreads.map((thread) => thread.id)),
  )).orderBy(desc(savMessages.receivedAt), desc(savMessages.id)).limit(MAX_CANDIDATE_MESSAGES);
  const messagesByThread = new Map<string, ContextMessage[]>();
  for (const message of candidateMessages) {
    const messages = messagesByThread.get(message.threadId) ?? [];
    messages.push(message);
    messagesByThread.set(message.threadId, messages);
  }

  const related: SavRelatedThread[] = [];
  for (const thread of candidateThreads) {
    const candidate = combineReferences(messagesByThread.get(thread.id) ?? [], customerEmail, mailboxEmail);
    const refersToCandidate = intersects(sourceReferences.replyIds, candidate.ownIds);
    const repliesToSource = intersects(candidate.replyIds, sourceReferences.ownIds);
    const sharedAncestor = intersects(sourceReferences.replyIds, candidate.replyIds);
    if (!refersToCandidate && !repliesToSource && !sharedAncestor) continue;
    related.push({
      ...thread,
      relationLabel: refersToCandidate ? "Conversation d’origine"
        : repliesToSource ? "Réponse dans un autre fil" : "Référence de réponse commune",
    });
    if (related.length >= MAX_RELATED_THREADS) break;
  }
  return related;
}
