import "server-only";

import { timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savActions, savFollowups, savGmailQuarantine, savMailboxes, savMessages, savThreads, savWebhookReceipts } from "@/db/schema";
import { savAutomationMode } from "./config";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import {
  claimWebhookReceipt,
  ensureSavMailbox,
  ingestInboundMessage,
  markWebhookReceipt,
  recordWebhookReceipt,
  updateMailboxCursor,
  updateMailboxWatch,
} from "./service";
import { assertSavOutboundRecipientAllowed, ensureAiTransparency, followupDates, normalizeEmailAddress, sanitizeInboundText } from "./policy";

const pubSubEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().min(1).optional(),
    message_id: z.string().min(1).optional(),
    publishTime: z.string().optional(),
    publish_time: z.string().optional(),
  }).refine((message) => Boolean(message.messageId || message.message_id), {
    message: "Pub/Sub message ID is missing",
  }),
  subscription: z.string().optional(),
});
const gmailNotificationSchema = z.object({
  emailAddress: z.email(),
  historyId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1)),
});

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};
type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

const globalForGmail = globalThis as typeof globalThis & { __savGmailToken?: { value: string; expiresAt: number } };

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyGmailWebhookRequest(request: Request) {
  const expectedToken = process.env.GMAIL_WEBHOOK_TOKEN;
  const suppliedToken = new URL(request.url).searchParams.get("token") ?? "";
  if (expectedToken && secureEqual(suppliedToken, expectedToken)) return true;

  const expectedAudience = process.env.GMAIL_PUBSUB_AUDIENCE;
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (expectedAudience && bearer) {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(bearer)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    const identity = await response.json() as { aud?: string; email?: string; email_verified?: string | boolean };
    const expectedEmail = process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT_EMAIL;
    return identity.aud === expectedAudience
      && (!expectedEmail || identity.email === expectedEmail)
      && (identity.email_verified === true || identity.email_verified === "true");
  }

  return process.env.NODE_ENV !== "production" && process.env.SAV_ALLOW_UNSIGNED_WEBHOOKS === "true";
}

export function decodeGmailPubSubEnvelope(rawInput: unknown) {
  // Pub/Sub normally wraps Gmail's notification in message.data. Payload
  // unwrapping is optional, though, and can be toggled from the Google Cloud
  // console. Supporting both formats makes the receiver resilient to that
  // infrastructure setting.
  const directNotification = gmailNotificationSchema.safeParse(rawInput);
  if (directNotification.success) {
    const notification = directNotification.data;
    return {
      envelope: {
        message: {
          messageId: `gmail-history:${notification.emailAddress}:${notification.historyId}`,
          publishTime: undefined,
        },
      },
      notification,
    };
  }

  const parsedEnvelope = pubSubEnvelopeSchema.parse(rawInput);
  const decoded = Buffer.from(parsedEnvelope.message.data, "base64url").toString("utf8");
  const notification = gmailNotificationSchema.parse(JSON.parse(decoded));
  return {
    envelope: {
      ...parsedEnvelope,
      message: {
        ...parsedEnvelope.message,
        messageId: parsedEnvelope.message.messageId ?? parsedEnvelope.message.message_id!,
        publishTime: parsedEnvelope.message.publishTime ?? parsedEnvelope.message.publish_time,
      },
    },
    notification,
  };
}

export async function acceptGmailWebhook(rawInput: unknown) {
  const { envelope, notification } = decodeGmailPubSubEnvelope(rawInput);
  const payload = {
    emailAddress: notification.emailAddress,
    historyId: notification.historyId,
    publishTime: envelope.message.publishTime ?? null,
  };
  const result = await recordWebhookReceipt("gmail", envelope.message.messageId, payload);
  return { ...result, notification };
}

async function gmailAccessToken() {
  const cached = globalForGmail.__savGmailToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requiredEnv("GMAIL_CLIENT_ID"),
      client_secret: requiredEnv("GMAIL_CLIENT_SECRET"),
      refresh_token: requiredEnv("GMAIL_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GMAIL_TOKEN_HTTP_${response.status}`);
  const payload = await response.json() as { access_token?: string; expires_in?: number };
  if (!payload.access_token) throw new Error("GMAIL_ACCESS_TOKEN_MISSING");
  globalForGmail.__savGmailToken = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(300, payload.expires_in ?? 3_600) * 1_000,
  };
  return payload.access_token;
}

async function gmailFetch<T>(mailboxEmail: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(mailboxEmail)}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await gmailAccessToken()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const error = new Error(`GMAIL_HTTP_${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

export async function renewGmailWatch(mailboxEmail = requiredEnv("GMAIL_SUPPORT_ADDRESS")) {
  const response = await gmailFetch<{ historyId: string; expiration: string }>(mailboxEmail, "watch", {
    method: "POST",
    body: JSON.stringify({
      topicName: requiredEnv("GMAIL_PUBSUB_TOPIC"),
      labelIds: ["INBOX"],
      labelFilterBehavior: "include",
    }),
  });
  if (!response.historyId || !response.expiration) throw new Error("GMAIL_WATCH_RESPONSE_INVALID");
  return updateMailboxWatch(mailboxEmail, response.historyId, new Date(Number(response.expiration)));
}

export async function renewActiveGmailWatches() {
  const db = requireDb();
  const mailboxes = await db.select().from(savMailboxes).where(eq(savMailboxes.active, true));
  if (!mailboxes.length && process.env.GMAIL_SUPPORT_ADDRESS) return [await renewGmailWatch(process.env.GMAIL_SUPPORT_ADDRESS)];
  return Promise.all(mailboxes.map((mailbox) => renewGmailWatch(mailbox.email)));
}

function decodeBase64Url(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function headerValue(headers: GmailHeader[] | undefined, name: string) {
  return headers?.find((header) => header.name?.toLocaleLowerCase("en") === name.toLocaleLowerCase("en"))?.value ?? "";
}

function collectMimeBodies(part: GmailPart | undefined, result = { text: [] as string[], html: [] as string[] }) {
  if (!part) return result;
  const data = part.body?.data ? decodeBase64Url(part.body.data) : "";
  if (data && part.mimeType === "text/plain") result.text.push(data);
  if (data && part.mimeType === "text/html") result.html.push(data);
  for (const child of part.parts ?? []) collectMimeBodies(child, result);
  return result;
}

function htmlToText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function boundedHeader(value: string, maxLength: number, keepEnd = false) {
  const normalized = String(value || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return keepEnd ? normalized.slice(-maxLength) : normalized.slice(0, maxLength);
}

export function normalizeRecipientHeader(value: string, prioritized: string[] = []) {
  const extracted = String(value || "").match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
    ?? String(value || "").split(",");
  const recipients = extracted.map(normalizeEmailAddress).filter(Boolean);
  const priorities = prioritized.map(normalizeEmailAddress).filter(Boolean);
  return [...new Set([
    ...priorities.filter((recipient) => recipients.includes(recipient)),
    ...recipients,
  ])].slice(0, 50);
}

export function normalizeReferencesHeader(value: string, maxLength = 2_000) {
  const normalized = boundedHeader(value, Math.max(maxLength * 4, maxLength), true);
  const ids = normalized.match(/<[^<>\s]{1,998}>/g) ?? [];
  if (!ids.length) return boundedHeader(normalized, maxLength, true);
  const kept: string[] = [];
  let length = 0;
  for (const id of ids.toReversed()) {
    const nextLength = length + id.length + (kept.length ? 1 : 0);
    if (nextLength > maxLength) break;
    kept.unshift(id);
    length = nextLength;
  }
  return kept.join(" ");
}

export function parseGmailMessage(mailboxEmail: string, message: GmailMessage) {
  if (!message.id || !message.threadId) throw new Error("GMAIL_MESSAGE_INVALID");
  const headers = message.payload?.headers;
  const from = boundedHeader(headerValue(headers, "From"), 500);
  const intakeRecipients = String(process.env.GMAIL_INTAKE_RECIPIENTS || mailboxEmail).split(",");
  const to = normalizeRecipientHeader(headerValue(headers, "To"), intakeRecipients);
  const subject = boundedHeader(headerValue(headers, "Subject") || "Sans objet", 1_000);
  const bodies = collectMimeBodies(message.payload);
  const bodyText = sanitizeInboundText(bodies.text.join("\n\n") || htmlToText(bodies.html.join("\n\n")) || message.snippet || "");
  return {
    mailboxEmail,
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    from,
    to,
    subject,
    bodyText: bodyText.slice(0, 100_000),
    ...(bodies.html.length ? { bodyHtml: bodies.html.join("\n\n").slice(0, 300_000) } : {}),
    autoSubmitted: boundedHeader(headerValue(headers, "Auto-Submitted"), 200) || undefined,
    headers: {
      "message-id": boundedHeader(headerValue(headers, "Message-ID"), 2_000),
      references: normalizeReferencesHeader(headerValue(headers, "References")),
      "in-reply-to": boundedHeader(headerValue(headers, "In-Reply-To"), 2_000, true),
      "delivered-to": boundedHeader(headerValue(headers, "Delivered-To"), 2_000),
      "x-original-to": boundedHeader(headerValue(headers, "X-Original-To"), 2_000),
    },
    receivedAt: new Date(Number(message.internalDate || Date.now())),
  };
}

export function matchesGmailIntakeRecipient(message: ReturnType<typeof parseGmailMessage>, configured = process.env.GMAIL_INTAKE_RECIPIENTS) {
  const recipients = String(configured || message.mailboxEmail)
    .split(",")
    .map(normalizeEmailAddress)
    .filter(Boolean);
  if (!recipients.length) return false;
  const actualRecipients = [
    ...message.to.map(normalizeEmailAddress),
    normalizeEmailAddress(message.headers["delivered-to"] || ""),
    normalizeEmailAddress(message.headers["x-original-to"] || ""),
  ].filter(Boolean);
  return actualRecipients.some((recipient) => recipients.includes(recipient));
}

async function fetchAndIngestMessage(mailboxEmail: string, messageId: string) {
  let message: GmailMessage;
  try {
    message = await gmailFetch<GmailMessage>(mailboxEmail, `messages/${encodeURIComponent(messageId)}?format=full`);
  } catch (error) {
    // Gmail list/history results can race with a deletion or mailbox rule. A
    // vanished message must not poison the whole receipt or force ten retries.
    if ((error as Error & { status?: number }).status === 404) return { skipped: "message_missing" as const };
    throw error;
  }
  const parsed = parseGmailMessage(mailboxEmail, message);
  if (normalizeEmailAddress(parsed.from) === normalizeEmailAddress(mailboxEmail)) return { skipped: "outbound" as const };
  if (!matchesGmailIntakeRecipient(parsed)) return { skipped: "outside_support_intake" as const };
  return ingestInboundMessage(parsed);
}

function isPermanentGmailMessageError(error: unknown) {
  return error instanceof z.ZodError
    || error instanceof SyntaxError
    || (error instanceof Error && error.message.startsWith("GMAIL_MESSAGE_INVALID"));
}

async function resolveGmailQuarantine(mailboxId: string, messageId: string) {
  await requireDb().update(savGmailQuarantine).set({ status: "resolved", resolvedAt: new Date() })
    .where(and(eq(savGmailQuarantine.mailboxId, mailboxId), eq(savGmailQuarantine.gmailMessageId, messageId)));
}

async function quarantineGmailMessage(mailboxEmail: string, messageId: string, receiptId: string | undefined, error: unknown) {
  const mailbox = await ensureSavMailbox(mailboxEmail);
  const cause = (error instanceof Error ? error.message : "GMAIL_MESSAGE_UNPARSABLE")
    .replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 240);
  await requireDb().insert(savGmailQuarantine).values({
    mailboxId: mailbox.id,
    receiptId,
    gmailMessageId: messageId,
    cause,
  }).onConflictDoUpdate({
    target: [savGmailQuarantine.mailboxId, savGmailQuarantine.gmailMessageId],
    set: {
      receiptId,
      cause,
      attempts: sql`${savGmailQuarantine.attempts} + 1`,
      status: "quarantined",
      lastFailedAt: new Date(),
      resolvedAt: null,
    },
  });
  console.warn("gmail_message_quarantined", { gmailMessageId: messageId, cause });
  return { skipped: "quarantined" as const, gmailMessageId: messageId, cause };
}

async function processGmailMessageSafely(mailboxEmail: string, mailboxId: string, messageId: string, receiptId?: string) {
  try {
    const result = await fetchAndIngestMessage(mailboxEmail, messageId);
    await resolveGmailQuarantine(mailboxId, messageId);
    return result;
  } catch (error) {
    if (!isPermanentGmailMessageError(error)) throw error;
    return quarantineGmailMessage(mailboxEmail, messageId, receiptId, error);
  }
}

async function fullInboxSync(mailboxEmail: string, mailboxId: string, receiptId?: string, maxMessages = 500) {
  let pageToken: string | undefined;
  const messageIds: string[] = [];
  do {
    const params = new URLSearchParams({ labelIds: "INBOX", maxResults: String(Math.min(100, maxMessages - messageIds.length)) });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gmailFetch<{ messages?: Array<{ id: string }>; nextPageToken?: string; resultSizeEstimate?: number }>(mailboxEmail, `messages?${params}`);
    messageIds.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken;
  } while (pageToken && messageIds.length < maxMessages);
  for (const id of messageIds) await processGmailMessageSafely(mailboxEmail, mailboxId, id, receiptId);
}

export async function processGmailReceipt(receiptId: string) {
  const receipt = await claimWebhookReceipt(receiptId, "gmail");
  if (!receipt) return;
  try {
    const notification = gmailNotificationSchema.parse(receipt.payload);
    const mailbox = await ensureSavMailbox(notification.emailAddress);
    if (!mailbox.historyId) {
      await fullInboxSync(mailbox.email, mailbox.id, receipt.id);
      await updateMailboxCursor(mailbox.id, notification.historyId);
      await markWebhookReceipt(receipt.id, "processed");
      return;
    }

    const addedIds = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId = notification.historyId;
    try {
      do {
        const params = new URLSearchParams({ startHistoryId: mailbox.historyId, historyTypes: "messageAdded", maxResults: "100" });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await gmailFetch<{
          history?: Array<{ id?: string; messagesAdded?: Array<{ message?: { id?: string } }> }>;
          nextPageToken?: string;
          historyId?: string;
        }>(mailbox.email, `history?${params}`);
        for (const history of page.history ?? []) {
          latestHistoryId = history.id || latestHistoryId;
          for (const added of history.messagesAdded ?? []) if (added.message?.id) addedIds.add(added.message.id);
        }
        latestHistoryId = page.historyId || latestHistoryId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (error) {
      if ((error as Error & { status?: number }).status !== 404) throw error;
      await fullInboxSync(mailbox.email, mailbox.id, receipt.id);
    }
    for (const messageId of addedIds) await processGmailMessageSafely(mailbox.email, mailbox.id, messageId, receipt.id);
    await updateMailboxCursor(mailbox.id, latestHistoryId);
    await markWebhookReceipt(receipt.id, "processed");
  } catch (error) {
    await markWebhookReceipt(receipt.id, "failed", error);
    throw error;
  }
}

export async function processPendingGmailReceipts(limit = 20) {
  const db = requireDb();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000);
  const receipts = await db.select({ id: savWebhookReceipts.id }).from(savWebhookReceipts)
    .where(and(
      eq(savWebhookReceipts.provider, "gmail"),
      or(
        inArray(savWebhookReceipts.status, ["pending", "failed"]),
        and(eq(savWebhookReceipts.status, "processing"), or(isNull(savWebhookReceipts.lastAttemptAt), lt(savWebhookReceipts.lastAttemptAt, staleBefore))),
      ),
      // Legacy validation failures reached the former ceiling of ten attempts.
      // The parser is now bounded per header and quarantines only the poisoned
      // message, so give those receipts a finite replay window after rollout.
      lt(savWebhookReceipts.attempts, 25),
    ))
    .orderBy(asc(savWebhookReceipts.receivedAt))
    .limit(Math.min(100, Math.max(1, limit)));
  const results = [];
  for (const receipt of receipts) {
    try {
      await processGmailReceipt(receipt.id);
      results.push({ id: receipt.id, status: "processed" });
    } catch (error) {
      results.push({ id: receipt.id, status: "failed", error: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
    }
  }
  return results;
}

export async function replayFailedGmailReceipts(limit = 100) {
  const receipts = await requireDb().select({ id: savWebhookReceipts.id }).from(savWebhookReceipts)
    .where(and(eq(savWebhookReceipts.provider, "gmail"), eq(savWebhookReceipts.status, "failed")))
    .orderBy(asc(savWebhookReceipts.receivedAt))
    .limit(Math.min(500, Math.max(1, limit)));
  const results = [];
  for (const receipt of receipts) {
    try {
      await processGmailReceipt(receipt.id);
      results.push({ id: receipt.id, status: "processed" as const });
    } catch (error) {
      results.push({ id: receipt.id, status: "failed" as const, error: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
    }
  }
  return results;
}

function safeMailHeader(value: string) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function encodedSubject(value: string) {
  return `=?UTF-8?B?${Buffer.from(safeMailHeader(value), "utf8").toString("base64")}?=`;
}

async function findSentMessage(mailboxEmail: string, rfcMessageId: string) {
  const params = new URLSearchParams({ q: `rfc822msgid:${rfcMessageId}`, maxResults: "1" });
  const response = await gmailFetch<{ messages?: Array<{ id: string; threadId: string }> }>(mailboxEmail, `messages?${params}`);
  return response.messages?.[0] ?? null;
}

async function sendReplyAction(action: typeof savActions.$inferSelect, text: string) {
  const db = requireDb();
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, action.threadId)).limit(1);
  if (!thread) throw new Error("SAV_ACTION_THREAD_NOT_FOUND");
  const [mailbox] = await db.select().from(savMailboxes).where(eq(savMailboxes.id, thread.mailboxId)).limit(1);
  if (!mailbox) throw new Error("SAV_ACTION_MAILBOX_NOT_FOUND");
  const [inbound] = await db.select().from(savMessages)
    .where(and(eq(savMessages.threadId, thread.id), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt)).limit(1);
  if (!inbound) throw new Error("SAV_ACTION_INBOUND_NOT_FOUND");
  assertSavOutboundRecipientAllowed(thread.customerEmail);
  const inboundBody = decryptSavPayload<{ text: string; headers?: Record<string, string> }>(inbound.bodyCiphertext);
  const transparentText = ensureAiTransparency(text);
  const replyFrom = normalizeEmailAddress(process.env.GMAIL_REPLY_FROM_ADDRESS || mailbox.email);
  const rfcMessageId = `<sav-${action.id}@studio.limova.ai>`;
  const priorId = inboundBody.headers?.["message-id"] || inboundBody.headers?.["in-reply-to"] || "";
  const references = [inboundBody.headers?.references, priorId].filter(Boolean).join(" ");
  const raw = [
    `From: ${safeMailHeader(replyFrom)}`,
    `To: ${safeMailHeader(thread.customerEmail)}`,
    `Subject: ${encodedSubject(/^re\s*:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`)}`,
    `Message-ID: ${rfcMessageId}`,
    ...(priorId ? [`In-Reply-To: ${safeMailHeader(priorId)}`] : []),
    ...(references ? [`References: ${safeMailHeader(references)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    transparentText,
  ].join("\r\n");

  const existing = await findSentMessage(mailbox.email, rfcMessageId);
  const sent = existing ?? await gmailFetch<{ id: string; threadId: string }>(mailbox.email, "messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url"), threadId: thread.gmailThreadId }),
  });
  const now = new Date();
  await db.transaction(async (tx) => {
    const [createdOutbound] = await tx.insert(savMessages).values({
      mailboxId: mailbox.id,
      threadId: thread.id,
      gmailMessageId: sent.id,
      direction: "outbound",
      fromEmail: replyFrom,
      toEmails: [thread.customerEmail],
      subject: /^re\s*:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`,
      preview: transparentText.replace(/\s+/g, " ").slice(0, 280),
      bodyCiphertext: encryptSavPayload({ text: transparentText, headers: { "message-id": rfcMessageId } }),
      receivedAt: now,
      processedAt: now,
    }).onConflictDoNothing().returning();
    const [outbound] = createdOutbound ? [createdOutbound] : await tx.select().from(savMessages)
      .where(and(eq(savMessages.mailboxId, mailbox.id), eq(savMessages.gmailMessageId, sent.id))).limit(1);
    await tx.update(savActions).set({ status: "succeeded", executedAt: now, updatedAt: now, errorCode: null })
      .where(eq(savActions.id, action.id));
    if (thread.hubspotTicketId && outbound) await tx.insert(savActions).values({
      threadId: thread.id,
      messageId: outbound.id,
      kind: "log_email",
      idempotencyKey: `hubspot:log-email:gmail:${sent.id}`,
      payload: { hubspotTicketId: thread.hubspotTicketId },
      actorType: "system",
    }).onConflictDoNothing();
    if (action.kind === "send_reply") {
      await tx.update(savThreads).set({ status: "awaiting_customer", lastMessageAt: now, updatedAt: now })
        .where(eq(savThreads.id, thread.id));
      for (const [index, dueAt] of followupDates(now).entries()) {
        await tx.insert(savFollowups).values({ threadId: thread.id, sequence: index + 1, dueAt })
          .onConflictDoNothing();
      }
    }
    if (thread.hubspotTicketId) {
      await tx.insert(savActions).values({
        threadId: thread.id,
        kind: "update_ticket_status",
        idempotencyKey: `hubspot:status:${action.kind}:${action.id}`,
        payload: {
          hubspotTicketId: thread.hubspotTicketId,
          target: action.kind === "request_human" ? "human" : "awaiting_customer",
        },
        actorType: "ai",
      }).onConflictDoNothing();
    }
  });
  return sent;
}

export async function processPendingGmailSendActions(limit = 20) {
  const mode = savAutomationMode();
  if (mode === "shadow") return { skipped: "shadow_mode", processed: [] as Array<Record<string, unknown>> };
  const db = requireDb();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000);
  const allowedKinds = ["send_reply", "request_human"] as const;
  const candidates = await db.select().from(savActions)
    .where(and(
      inArray(savActions.kind, [...allowedKinds]),
      isNull(savActions.pilotBatchId),
      or(eq(savActions.status, "pending"), and(eq(savActions.status, "running"), lt(savActions.updatedAt, staleBefore))),
    ))
    .orderBy(asc(savActions.createdAt)).limit(Math.min(100, Math.max(1, limit)));
  const actions = mode === "assist" ? candidates.filter((action) => action.actorType === "human") : candidates;
  const processed = [];
  for (const action of actions) {
    const [claimed] = await db.update(savActions).set({ status: "running", updatedAt: new Date() }).where(and(
      eq(savActions.id, action.id),
      or(eq(savActions.status, "pending"), and(eq(savActions.status, "running"), lt(savActions.updatedAt, staleBefore))),
    )).returning();
    if (!claimed) continue;
    try {
      const text = claimed.kind === "request_human"
        ? "Votre demande a bien été transmise à notre équipe. Un membre de l’équipe Limova vous répondra sous trois jours. Je reste disponible immédiatement si vous souhaitez poursuivre avec l’assistant IA en attendant."
        : decryptSavPayload<{ text: string }>(String(claimed.payload.bodyCiphertext || "")).text;
      const sent = await sendReplyAction(claimed, text);
      processed.push({ actionId: claimed.id, status: "succeeded", gmailMessageId: sent.id });
    } catch (error) {
      const errorCode = (error instanceof Error ? error.message : "UNKNOWN_ERROR").slice(0, 160);
      await db.update(savActions).set({ status: "failed", errorCode, updatedAt: new Date() }).where(eq(savActions.id, claimed.id));
      processed.push({ actionId: claimed.id, status: "failed", errorCode });
    }
  }
  return { processed };
}
