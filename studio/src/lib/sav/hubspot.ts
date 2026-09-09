import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import {
  savActions,
  savDecisions,
  savLearningCandidates,
  savMessages,
  savSyncState,
  savThreads,
  savTicketSnapshots,
  savWebhookReceipts,
} from "@/db/schema";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { assertSavWriteAllowed } from "./write-guard";
import { savModeAllowsWrite } from "./action-policy";
import { autoReplyMinConfidence, canSendRepliesAutomatically, savAutoReplyCategories, savAutoReplyDailyLimit, savAutomationMode, savThreadInAutoReplyRollout } from "./config";
import { AI_DISCLOSURE, assertSavTicketStageNotClosed, normalizeEmailAddress } from "./policy";
import { getSavAutonomyGate } from "./promotion";
import { selectSavTicketMatch } from "./ticket-routing";
import { extractSavLearningResolution, isHubspotOutboundDirection } from "./learning-extraction";
import { savActionFailurePlan } from "./retry-policy";
import { claimWebhookReceipt, markWebhookReceipt, recordWebhookReceipt, type SavMessageBody } from "./service";

const hubspotEventSchema = z.object({
  eventId: z.number().optional(),
  subscriptionId: z.number().optional(),
  portalId: z.number().optional(),
  appId: z.number().optional(),
  occurredAt: z.number().optional(),
  subscriptionType: z.string().min(1),
  objectId: z.number().or(z.string()).optional(),
  propertyName: z.string().optional(),
  propertyValue: z.string().optional(),
  attemptNumber: z.number().optional(),
  messageId: z.string().optional(),
  changeSource: z.string().optional(),
}).passthrough();

type HubspotRecord = {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  associations?: Record<string, { results?: Array<{ id: string }> }>;
};
type TicketEmailSnapshot = {
  id: string;
  hs_email_text: string;
  hs_email_html: string;
  hs_email_subject: string;
  hs_email_from_email: string;
  hs_email_to_email: string;
  hs_timestamp: string;
  hs_email_direction: string;
};

const globalForHubspot = globalThis as typeof globalThis & { __savClosedHubspotStages?: { values: Set<string>; expiresAt: number } };
export const HUBSPOT_EMAIL_READ_SCOPE = "crm.objects.emails.read";
const HUBSPOT_BACKFILL_RETRY_MS = 30 * 60 * 1_000;
const HUBSPOT_BACKFILL_LEASE_MS = 10 * 60 * 1_000;
export const HUBSPOT_TICKET_TRANSCRIPT_MAX_BYTES = 48 * 1024;
const HUBSPOT_TICKET_EMAIL_BODY_MAX_CHARS = 8_000;

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

function decodeHubspotUri(uri: string) {
  const decodable: Record<string, string> = {
    "%3A": ":", "%2F": "/", "%3F": "?", "%40": "@", "%21": "!", "%24": "$",
    "%27": "'", "%28": "(", "%29": ")", "%2A": "*", "%2C": ",", "%3B": ";",
  };
  return uri.replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (match) => decodable[match.toUpperCase()]);
}

export function verifyHubspotSignature(input: {
  method: string;
  uri: string;
  body: string;
  timestamp: string;
  signature: string;
  clientSecret: string;
  now?: number;
}) {
  const timestamp = Number(input.timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 5 * 60 * 1_000) return false;
  const source = `${input.method.toUpperCase()}${decodeHubspotUri(input.uri)}${input.body}${input.timestamp}`;
  const expected = createHmac("sha256", input.clientSecret).update(source, "utf8").digest("base64");
  return secureEqual(expected, input.signature);
}

export function verifyHubspotWebhookRequest(request: Request, rawBody: string) {
  const signature = request.headers.get("x-hubspot-signature-v3") ?? "";
  const timestamp = request.headers.get("x-hubspot-request-timestamp") ?? "";
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (clientSecret && signature && timestamp) {
    return verifyHubspotSignature({
      method: request.method,
      uri: process.env.HUBSPOT_WEBHOOK_PUBLIC_URL || request.url,
      body: rawBody,
      timestamp,
      signature,
      clientSecret,
    });
  }
  return process.env.NODE_ENV !== "production" && process.env.SAV_ALLOW_UNSIGNED_WEBHOOKS === "true";
}

export async function acceptHubspotWebhook(rawInput: unknown) {
  const events = z.array(hubspotEventSchema).max(100).parse(rawInput);
  const receipts = [];
  for (const event of events) {
    const externalId = savContentHash({
      eventId: event.eventId,
      subscriptionType: event.subscriptionType,
      objectId: event.objectId,
      occurredAt: event.occurredAt,
      propertyName: event.propertyName,
      propertyValue: event.propertyValue,
      messageId: event.messageId,
    });
    receipts.push(await recordWebhookReceipt("hubspot", externalId, event));
  }
  return receipts;
}

async function hubspotFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.hubapi.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requiredEnv("HUBSPOT_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(summarizeHubspotError(response.status, payload));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function summarizeHubspotError(status: number, payload: unknown) {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const errors = Array.isArray(value.errors) ? value.errors : [];
  const first = errors[0] && typeof errors[0] === "object" ? errors[0] as Record<string, unknown> : {};
  const context = first.context && typeof first.context === "object" ? first.context as Record<string, unknown> : {};
  const diagnosticValues = Object.entries(context).flatMap(([key, raw]) => {
    if (!/(scope|propert|field)/i.test(key)) return [];
    return (Array.isArray(raw) ? raw : [raw]).map(String);
  });
  const message = typeof value.message === "string" ? value.message : "";
  const embeddedField = message.match(/["'](?:name|propertyName)["']\s*:\s*["']([A-Za-z0-9_.-]+)["']/)?.[1];
  const embeddedError = message.match(/["']error["']\s*:\s*["']([A-Za-z0-9_.-]+)["']/)?.[1];
  const parts = [
    `HUBSPOT_HTTP_${status}`,
    value.category,
    value.subCategory,
    first.code,
    ...diagnosticValues,
    embeddedField,
    embeddedError,
  ].map((part) => String(part || "").replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 80)).filter(Boolean);
  return [...new Set(parts)].join(":").slice(0, 160);
}

export function isHubspotEmailReadScopeError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error || "");
  return code.startsWith("HUBSPOT_HTTP_403:MISSING_SCOPES")
    && /(?:crm\.objects\.emails\.read|crm\.schemas\.emails\.read|sales-email-read)/i.test(code);
}

export function shouldAttemptHubspotBackfill(
  state: { status: string; lastError: string | null; updatedAt: Date } | null,
  now = Date.now(),
) {
  if (!state) return true;
  const age = now - state.updatedAt.getTime();
  if (state.status === "running" && age < HUBSPOT_BACKFILL_LEASE_MS) return false;
  if (state.status !== "blocked" || !isHubspotEmailReadScopeError(state.lastError)) return true;
  return age >= HUBSPOT_BACKFILL_RETRY_MS;
}

function isHubspotValidationError(error: unknown) {
  return error instanceof Error && error.message.startsWith("HUBSPOT_HTTP_400");
}

async function withoutRejectedOwner<T>(properties: Record<string, string>, operation: (properties: Record<string, string>) => Promise<T>) {
  try {
    return await operation(properties);
  } catch (error) {
    if (!properties.hubspot_owner_id || !isHubspotValidationError(error)) throw error;
    const { hubspot_owner_id: _rejectedOwner, ...withoutOwner } = properties;
    void _rejectedOwner;
    console.warn("hubspot_owner_rejected_retrying_without_owner", { errorCode: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
    return operation(withoutOwner);
  }
}

async function closedTicketStages() {
  const cached = globalForHubspot.__savClosedHubspotStages;
  if (cached && cached.expiresAt > Date.now()) return cached.values;
  const response = await hubspotFetch<{ results?: Array<{ stages?: Array<{ id: string; metadata?: { ticketState?: string } }> }> }>("/crm/v3/pipelines/tickets");
  const values = new Set(response.results?.flatMap((pipeline) => pipeline.stages ?? [])
    .filter((stage) => stage.metadata?.ticketState === "CLOSED").map((stage) => stage.id) ?? []);
  globalForHubspot.__savClosedHubspotStages = { values, expiresAt: Date.now() + 15 * 60 * 1_000 };
  return values;
}

async function findContactByEmail(email: string) {
  const response = await hubspotFetch<{ results?: HubspotRecord[] }>("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: normalizeEmailAddress(email) }] }],
      properties: ["email"],
      limit: 1,
    }),
  });
  return response.results?.[0] ?? null;
}

async function guardedHubspotWrite<T>(actionId: string, path: string, init: RequestInit): Promise<T> {
  await assertSavWriteAllowed(actionId);
  return hubspotFetch<T>(path, init);
}

async function ensureContactByEmail(email: string, actionId: string) {
  const existing = await findContactByEmail(email);
  if (existing) return existing;
  return guardedHubspotWrite<HubspotRecord>(actionId, "/crm/v3/objects/contacts", {
    method: "POST",
    body: JSON.stringify({ properties: { email: normalizeEmailAddress(email) } }),
  });
}

async function findExistingTicket(contactId: string | null, subject: string, currentTicketId?: string | null) {
  if (currentTicketId) {
    try {
      const linked = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(currentTicketId)}?properties=subject,hs_pipeline,hs_pipeline_stage,hs_lastmodifieddate`);
      if (!(await closedTicketStages()).has(String(linked.properties.hs_pipeline_stage || ""))) return linked;
    } catch (error) {
      if (!/HUBSPOT_HTTP_404/.test(error instanceof Error ? error.message : "")) throw error;
    }
  }
  if (!contactId) return null;
  const filters = contactId
    ? [{ propertyName: "associations.contact", operator: "EQ", value: contactId }]
    : [{ propertyName: "subject", operator: "EQ", value: subject }];
  const response = await hubspotFetch<{ results?: HubspotRecord[] }>("/crm/v3/objects/tickets/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters }],
      query: subject.slice(0, 120),
      properties: ["subject", "hs_pipeline", "hs_pipeline_stage", "hs_lastmodifieddate"],
      sorts: ["-hs_lastmodifieddate"],
      limit: 20,
    }),
  });
  const closed = await closedTicketStages();
  const records = response.results ?? [];
  const selection = selectSavTicketMatch({ subject, currentTicketId, candidates: records.map((ticket) => ({
    id: ticket.id, subject: String(ticket.properties.subject || ""),
    status: closed.has(String(ticket.properties.hs_pipeline_stage || "")) ? "closed" : "open",
    updatedAt: ticket.properties.hs_lastmodifieddate || ticket.updatedAt || null,
  })) });
  if (selection.kind === "ambiguous") throw new Error(`SAV_TICKET_MATCH_AMBIGUOUS:${selection.candidates.map((ticket) => ticket.id).join(",")}`);
  return selection.kind === "matched" ? records.find((ticket) => ticket.id === selection.ticket.id) ?? null : null;
}

export async function readSavHubspotContext(input: { email: string; subject: string; currentTicketId?: string | null }) {
  let linkedTicket: HubspotRecord | null = null;
  if (input.currentTicketId) {
    try {
      linkedTicket = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(input.currentTicketId)}?properties=subject,hs_pipeline,hs_pipeline_stage,hs_lastmodifieddate`);
    } catch (error) {
      if (!/HUBSPOT_HTTP_404/.test(error instanceof Error ? error.message : "")) throw error;
    }
  }
  const contact = await findContactByEmail(input.email);
  const response = contact ? await hubspotFetch<{ results?: HubspotRecord[] }>("/crm/v3/objects/tickets/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "associations.contact", operator: "EQ", value: contact.id }] }],
        query: input.subject.slice(0, 120),
        properties: ["subject", "hs_pipeline", "hs_pipeline_stage", "hs_lastmodifieddate"],
        sorts: ["-hs_lastmodifieddate"],
        limit: 10,
      }),
    }) : { results: [] };
  const closed = await closedTicketStages();
  const records = [...(linkedTicket ? [linkedTicket] : []), ...(response.results ?? []).filter((ticket) => ticket.id !== linkedTicket?.id)];
  const tickets = records.slice(0, 10).map((ticket) => ({
    id: ticket.id,
    subject: String(ticket.properties.subject || "Sans objet").slice(0, 500),
    pipelineId: ticket.properties.hs_pipeline,
    stageId: ticket.properties.hs_pipeline_stage,
    status: closed.has(String(ticket.properties.hs_pipeline_stage || "")) ? "closed" as const : "open" as const,
    updatedAt: ticket.properties.hs_lastmodifieddate || ticket.updatedAt || null,
  }));
  const routing = selectSavTicketMatch({ subject: input.subject, candidates: tickets, currentTicketId: input.currentTicketId });
  return {
    contactFound: Boolean(contact),
    contactId: contact?.id,
    tickets,
    routing: routing.kind === "matched"
      ? { kind: routing.kind, ticketId: routing.ticket.id, reason: routing.reason }
      : { kind: routing.kind, reason: routing.reason, candidateIds: routing.kind === "ambiguous" ? routing.candidates.map((ticket) => ticket.id) : [] },
  };
}

async function createHubspotTicket(message: typeof savMessages.$inferSelect, body: SavMessageBody, contactId: string | null, actionId: string) {
  const properties: Record<string, string> = {
    subject: message.subject,
    content: body.text.slice(0, 20_000),
    hs_pipeline_stage: requiredEnv("HUBSPOT_NEW_TICKET_STAGE_ID"),
  };
  if (process.env.HUBSPOT_TICKET_PIPELINE_ID) properties.hs_pipeline = process.env.HUBSPOT_TICKET_PIPELINE_ID;
  const associations = contactId ? [{
    to: { id: contactId },
    types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 16 }],
  }] : [];
  await assertSavTicketStageNotClosed(properties.hs_pipeline_stage, await closedTicketStages());
  return guardedHubspotWrite<HubspotRecord>(actionId, "/crm/v3/objects/tickets", {
    method: "POST",
    body: JSON.stringify({ properties, associations }),
  });
}

async function finalizeTicketAction(action: typeof savActions.$inferSelect) {
  const db = requireDb();
  const [message] = action.messageId
    ? await db.select().from(savMessages).where(eq(savMessages.id, action.messageId)).limit(1)
    : [];
  if (!message) throw new Error("SAV_ACTION_MESSAGE_NOT_FOUND");
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, action.threadId)).limit(1);
  if (!thread) throw new Error("SAV_ACTION_THREAD_NOT_FOUND");
  const body = decryptSavPayload<SavMessageBody>(message.bodyCiphertext);
  const existingContact = await findContactByEmail(thread.customerEmail);
  const persistedTicketId = typeof action.payload.hubspotTicketId === "string" ? action.payload.hubspotTicketId : null;
  const existing = await findExistingTicket(existingContact?.id ?? null, thread.subject, persistedTicketId || thread.hubspotTicketId);
  const contact = existingContact ?? await ensureContactByEmail(thread.customerEmail, action.id);
  const ticket = existing ?? await createHubspotTicket(message, body, contact?.id ?? null, action.id);
  if (!existing) await db.update(savActions).set({ payload: { ...action.payload, hubspotTicketId: ticket.id }, updatedAt: new Date() }).where(eq(savActions.id, action.id));
  const [sourceDecision] = action.decisionId
    ? await db.select({ confidence: savDecisions.confidence }).from(savDecisions).where(eq(savDecisions.id, action.decisionId)).limit(1)
    : [];
  const decisionKind = existing ? "attached_to_existing_ticket" : "ticket_created";
  const explanation = existing
    ? `Le message a été rattaché au ticket HubSpot ${ticket.id}, déjà ouvert pour le même client et le même sujet.`
    : `Un ticket HubSpot ${ticket.id} a été créé car le message contient une demande SAV exploitable.`;
  const autonomy = canSendRepliesAutomatically() ? await getSavAutonomyGate() : null;
  const categoryEligible = savAutoReplyCategories().has(String(action.payload.category ?? "other"));
  const rolloutEligible = savThreadInAutoReplyRollout(thread.id);
  await db.transaction(async (tx) => {
    if (action.decisionId) await tx.update(savDecisions).set({ isCurrent: false }).where(eq(savDecisions.id, action.decisionId));
    await tx.insert(savDecisions).values({
      messageId: message.id,
      kind: decisionKind,
      reasonCode: existing ? "matched_open_customer_ticket" : "new_customer_support_request",
      explanation,
      confidence: existing ? 930 : 900,
      evidence: [{ sourceType: "hubspot_ticket", sourceId: ticket.id, title: String(ticket.properties.subject || thread.subject) }],
      model: "hubspot-router-v1",
      actorType: "system",
      supersedesDecisionId: action.decisionId,
    });
    await tx.update(savThreads).set({ hubspotTicketId: ticket.id, status: thread.aiPaused ? "human_requested" : "ai_processing", updatedAt: new Date() })
      .where(eq(savThreads.id, thread.id));
    await tx.update(savActions).set({ status: "succeeded", executedAt: new Date(), updatedAt: new Date(), payload: { ...action.payload, hubspotTicketId: ticket.id } })
      .where(eq(savActions.id, action.id));
    await tx.insert(savActions).values({
      threadId: thread.id,
      messageId: message.id,
      pilotBatchId: action.pilotBatchId,
      kind: "log_email",
      idempotencyKey: `hubspot:log-email:${message.id}`,
      payload: { hubspotTicketId: ticket.id, contactId: contact.id },
      actorType: "system",
    }).onConflictDoNothing();
    if (thread.aiPaused) await tx.insert(savActions).values({
      threadId: thread.id,
      messageId: message.id,
      pilotBatchId: action.pilotBatchId,
      kind: "update_ticket_status",
      status: action.pilotBatchId ? "cancelled" : "pending",
      idempotencyKey: `hubspot:status:human:${message.id}`,
      payload: { hubspotTicketId: ticket.id, target: "human" },
      actorType: "system",
      errorCode: action.pilotBatchId ? "SAV_PILOT_STATUS_UPDATE_BLOCKED" : null,
      executedAt: action.pilotBatchId ? new Date() : null,
    }).onConflictDoNothing();
    if (!action.pilotBatchId && autonomy?.eligible && categoryEligible && rolloutEligible
      && !thread.aiPaused && (sourceDecision?.confidence ?? 0) >= autoReplyMinConfidence()) {
      // Serialize the daily-cap check across concurrent cron instances.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(1471638451)`);
      const [dailyAutonomous] = await tx.select({ count: sql<number>`count(*)::int` }).from(savActions).where(and(
        eq(savActions.kind, "send_reply"), eq(savActions.status, "succeeded"), eq(savActions.actorType, "ai"),
        sql`${savActions.executedAt} >= ${new Date(Date.now() - 86_400_000)}`,
      ));
      if ((dailyAutonomous?.count ?? 0) >= savAutoReplyDailyLimit()) return;
      const [draft] = await tx.select().from(savActions)
        .where(and(eq(savActions.messageId, message.id), eq(savActions.kind, "draft_reply"), eq(savActions.status, "succeeded"))).limit(1);
      if (draft?.payload.bodyCiphertext) await tx.insert(savActions).values({
        threadId: thread.id,
        messageId: message.id,
        decisionId: action.decisionId,
        kind: "send_reply",
        idempotencyKey: `reply:send:${message.id}`,
        payload: { bodyCiphertext: draft.payload.bodyCiphertext, model: draft.payload.model ?? "unknown" },
        actorType: "ai",
      }).onConflictDoNothing();
    }
  });
  return ticket;
}

async function createHubspotNote(action: typeof savActions.$inferSelect) {
  const db = requireDb();
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, action.threadId)).limit(1);
  const ticketId = String(action.payload.hubspotTicketId || thread?.hubspotTicketId || "");
  if (!ticketId) throw new Error("HUBSPOT_TICKET_NOT_LINKED");
  const bodyCiphertext = String(action.payload.bodyCiphertext || "");
  if (!bodyCiphertext) throw new Error("SAV_NOTE_BODY_MISSING");
  const noteText = decryptSavPayload<{ text: string }>(bodyCiphertext).text.trim();
  if (!noteText) throw new Error("SAV_NOTE_BODY_EMPTY");
  const persistedNoteId = typeof action.payload.hubspotNoteId === "string" ? action.payload.hubspotNoteId : null;
  const note = persistedNoteId ? { id: persistedNoteId, properties: {} } : await guardedHubspotWrite<HubspotRecord>(action.id, "/crm/v3/objects/notes", {
      method: "POST",
      body: JSON.stringify({ properties: { hs_timestamp: new Date().toISOString(), hs_note_body: noteText.slice(0, 50_000) } }),
    });
  if (!persistedNoteId) await db.update(savActions).set({ payload: { ...action.payload, hubspotTicketId: ticketId, hubspotNoteId: note.id }, updatedAt: new Date() }).where(eq(savActions.id, action.id));
  await guardedHubspotWrite(action.id, `/crm/v4/objects/notes/${encodeURIComponent(note.id)}/associations/default/tickets/${encodeURIComponent(ticketId)}`, { method: "PUT" });
  await db.update(savActions).set({
    status: "succeeded",
    executedAt: new Date(),
    updatedAt: new Date(),
    errorCode: null,
    payload: { ...action.payload, hubspotTicketId: ticketId, hubspotNoteId: note.id },
  }).where(eq(savActions.id, action.id));
  return { noteId: note.id, ticketId };
}

async function logHubspotEmail(action: typeof savActions.$inferSelect) {
  const db = requireDb();
  if (!action.messageId) throw new Error("SAV_LOG_EMAIL_MESSAGE_MISSING");
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, action.messageId)).limit(1);
  if (!message) throw new Error("SAV_LOG_EMAIL_MESSAGE_NOT_FOUND");
  if (message.hubspotEmailId) {
    await db.update(savActions).set({ status: "succeeded", executedAt: new Date(), updatedAt: new Date() }).where(eq(savActions.id, action.id));
    return { emailId: message.hubspotEmailId };
  }
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, message.threadId)).limit(1);
  const ticketId = String(action.payload.hubspotTicketId || thread?.hubspotTicketId || "");
  if (!ticketId) throw new Error("HUBSPOT_TICKET_NOT_LINKED");
  const body = decryptSavPayload<SavMessageBody>(message.bodyCiphertext);
  const headers = {
    from: { email: message.fromEmail },
    to: message.toEmails.map((email) => ({ email })),
    cc: [],
    bcc: [],
  };
  const properties: Record<string, string> = {
      hs_timestamp: message.receivedAt.toISOString(),
      hs_email_direction: message.direction === "inbound" ? "INCOMING_EMAIL" : "EMAIL",
      ...(message.direction === "outbound" ? { hs_email_status: "SENT" } : {}),
      hs_email_subject: message.subject,
      hs_email_text: body.text.slice(0, 50_000),
      hs_email_headers: JSON.stringify(headers),
      ...(process.env.HUBSPOT_SAV_OWNER_ID ? { hubspot_owner_id: process.env.HUBSPOT_SAV_OWNER_ID } : {}),
  };
  const fallbackAsNote = async (error: unknown) => {
    const errorCode = error instanceof Error ? error.message : "HUBSPOT_EMAIL_VALIDATION_ERROR";
    const fallbackText = [
      "Email entrant archivé par le Studio SAV (repli en note HubSpot).",
      `Date : ${message.receivedAt.toISOString()}`,
      `De : ${message.fromEmail}`,
      `À : ${message.toEmails.join(", ")}`,
      `Objet : ${message.subject}`,
      "",
      body.text,
    ].join("\n").slice(0, 50_000);
    const note = await createHubspotNote({
      ...action,
      payload: {
        ...action.payload,
        hubspotTicketId: ticketId,
        bodyCiphertext: encryptSavPayload({ text: fallbackText }),
        hubspotEmailFallbackReason: errorCode,
      },
    });
    console.warn("hubspot_email_validation_fallback_note", { actionId: action.id, errorCode });
    return { emailId: null, fallbackNoteId: note.noteId };
  };
  let email: HubspotRecord;
  try {
    const persistedEmailId = typeof action.payload.hubspotEmailId === "string" ? action.payload.hubspotEmailId : null;
    email = persistedEmailId
      ? { id: persistedEmailId, properties: {} }
      : await withoutRejectedOwner(properties, (safeProperties) => guardedHubspotWrite<HubspotRecord>(action.id, "/crm/v3/objects/emails", {
        method: "POST",
        body: JSON.stringify({ properties: safeProperties }),
      }));
    if (!persistedEmailId) await db.update(savActions).set({ payload: { ...action.payload, hubspotEmailId: email.id }, updatedAt: new Date() }).where(eq(savActions.id, action.id));
    await guardedHubspotWrite(action.id, `/crm/v4/objects/emails/${encodeURIComponent(email.id)}/associations/default/tickets/${encodeURIComponent(ticketId)}`, { method: "PUT" });
  } catch (error) {
    if (!isHubspotValidationError(error)) throw error;
    return fallbackAsNote(error);
  }
  const contactId = String(action.payload.contactId || "");
  if (contactId) {
    try {
      await guardedHubspotWrite(action.id, `/crm/v4/objects/emails/${encodeURIComponent(email.id)}/associations/default/contacts/${encodeURIComponent(contactId)}`, { method: "PUT" });
    } catch (error) {
      // The ticket association is the source of truth. A missing optional
      // contact association must not duplicate the email on every retry.
      console.warn("hubspot_email_contact_association_skipped", {
        actionId: action.id,
        errorCode: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      });
    }
  }
  await db.transaction(async (tx) => {
    await tx.update(savMessages).set({ hubspotEmailId: email.id }).where(eq(savMessages.id, message.id));
    await tx.update(savActions).set({ status: "succeeded", executedAt: new Date(), updatedAt: new Date(), errorCode: null })
      .where(eq(savActions.id, action.id));
  });
  return { emailId: email.id };
}

async function updateHubspotTicketStatus(action: typeof savActions.$inferSelect) {
  const db = requireDb();
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, action.threadId)).limit(1);
  const ticketId = String(action.payload.hubspotTicketId || thread?.hubspotTicketId || "");
  if (!ticketId) throw new Error("HUBSPOT_TICKET_NOT_LINKED");
  const target = String(action.payload.target || "");
  const stageId = target === "human"
    ? requiredEnv("HUBSPOT_HUMAN_STAGE_ID")
    : target === "awaiting_customer"
      ? requiredEnv("HUBSPOT_AWAITING_CUSTOMER_STAGE_ID")
      : requiredEnv("HUBSPOT_NEW_TICKET_STAGE_ID");
  const properties: Record<string, string> = { hs_pipeline_stage: stageId };
  assertSavTicketStageNotClosed(stageId, await closedTicketStages());
  if (target === "human" && process.env.HUBSPOT_SAV_OWNER_ID) properties.hubspot_owner_id = process.env.HUBSPOT_SAV_OWNER_ID;
  await withoutRejectedOwner(properties, (safeProperties) => guardedHubspotWrite(action.id, `/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: safeProperties }),
  }));
  await db.update(savActions).set({ status: "succeeded", executedAt: new Date(), updatedAt: new Date(), errorCode: null })
    .where(eq(savActions.id, action.id));
  return { ticketId, stageId };
}

export async function processPendingHubspotActions(limit = 20) {
  const mode = savAutomationMode();
  if (mode === "shadow" || process.env.SAV_WRITES_DISABLED === "true") return { skipped: "shadow_mode", processed: [] as Array<Record<string, unknown>> };
  const db = requireDb();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000);
  const candidates = await db.select().from(savActions)
    .where(and(
      inArray(savActions.kind, ["create_ticket", "link_ticket", "log_email", "update_ticket_status"]),
      isNull(savActions.pilotBatchId),
      or(eq(savActions.status, "pending"), and(eq(savActions.status, "running"), lt(savActions.updatedAt, staleBefore))),
      or(isNull(savActions.scheduledAt), lte(savActions.scheduledAt, new Date())),
    ))
    .orderBy(desc(savActions.priority), asc(savActions.createdAt)).limit(Math.min(100, Math.max(1, limit)));
  const actions = candidates.filter((action) => savModeAllowsWrite(mode, action.kind, action.actorType));
  const processed = [];
  for (const action of actions) {
    const [claimed] = await db.update(savActions).set({ status: "running", scheduledAt: null, attemptCount: sql`${savActions.attemptCount} + 1`, updatedAt: new Date() }).where(and(
      eq(savActions.id, action.id),
      isNull(savActions.pilotBatchId),
      or(eq(savActions.status, "pending"), and(eq(savActions.status, "running"), lt(savActions.updatedAt, staleBefore))),
    )).returning();
    if (!claimed) continue;
    try {
      if (claimed.kind === "log_email") {
        const result = await logHubspotEmail(claimed);
        processed.push({ actionId: claimed.id, status: "succeeded", hubspotEmailId: result.emailId });
      } else {
        const result = claimed.kind === "update_ticket_status"
          ? await updateHubspotTicketStatus(claimed)
          : await finalizeTicketAction(claimed);
        processed.push({ actionId: claimed.id, status: "succeeded", ticketId: "id" in result ? result.id : result.ticketId });
      }
    } catch (error) {
      const errorCode = (error instanceof Error ? error.message : "UNKNOWN_ERROR").slice(0, 160);
      const failure = savActionFailurePlan(errorCode, claimed.attemptCount);
      await db.update(savActions).set({ status: failure.status, scheduledAt: failure.scheduledAt, errorCode, updatedAt: new Date() }).where(eq(savActions.id, claimed.id));
      processed.push({ actionId: claimed.id, status: failure.status, retryScheduledAt: failure.scheduledAt, errorCode });
    }
  }
  return { processed };
}

export async function processPendingPilotHubspotActions(batchId: string, limit = 50) {
  // Deliberately return before touching the database or HubSpot. Pilot actions
  // are proposals displayed in the Studio, never commands to execute.
  void batchId;
  void limit;
  return { skipped: "pilot_simulation_only", processed: [] as Array<Record<string, unknown>> };
}

export async function processPendingPilotHubspotActionsAcrossBatches(limit = 100) {
  void limit;
  return { skipped: "pilot_simulation_only", processed: [] as Array<Record<string, unknown>> };
}

async function loadTicketEmails(ticket: HubspotRecord) {
  const ids = ticket.associations?.emails?.results?.map((association) => association.id) ?? [];
  const emails: HubspotRecord[] = [];
  for (const id of ids.slice(-200)) {
    emails.push(await hubspotFetch<HubspotRecord>(`/crm/v3/objects/emails/${encodeURIComponent(id)}?properties=hs_email_text,hs_email_html,hs_email_subject,hs_email_from_email,hs_email_to_email,hs_timestamp,hs_email_direction`));
  }
  return emails;
}

function hubspotEmailPlainText(value: string) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactHubspotEmail(email: TicketEmailSnapshot): TicketEmailSnapshot {
  return {
    id: String(email.id || "").slice(0, 200),
    // HubSpot commonly returns the same message as both text and HTML. Keeping
    // one normalized representation avoids duplicating entire quoted threads.
    hs_email_text: hubspotEmailPlainText(email.hs_email_text || email.hs_email_html)
      .slice(0, HUBSPOT_TICKET_EMAIL_BODY_MAX_CHARS),
    hs_email_html: "",
    hs_email_subject: hubspotEmailPlainText(email.hs_email_subject).slice(0, 500),
    hs_email_from_email: String(email.hs_email_from_email || "").slice(0, 320),
    hs_email_to_email: String(email.hs_email_to_email || "").slice(0, 1_000),
    hs_timestamp: String(email.hs_timestamp || "").slice(0, 80),
    hs_email_direction: String(email.hs_email_direction || "").slice(0, 80),
  };
}

export function compactHubspotTicketTranscript(rawTranscript: TicketEmailSnapshot[]) {
  const normalized = rawTranscript.map(compactHubspotEmail)
    .sort((left, right) => `${left.hs_timestamp}:${left.id}`.localeCompare(`${right.hs_timestamp}:${right.id}`));
  const selected: TicketEmailSnapshot[] = [];
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const candidate = [normalized[index], ...selected];
    if (Buffer.byteLength(JSON.stringify({ transcript: candidate }), "utf8") > HUBSPOT_TICKET_TRANSCRIPT_MAX_BYTES) {
      if (selected.length) break;
      const fallback = { ...normalized[index], hs_email_text: normalized[index].hs_email_text.slice(0, 4_000) };
      selected.push(fallback);
      break;
    }
    selected.unshift(normalized[index]);
  }
  return selected;
}

async function snapshotTicket(ticket: HubspotRecord) {
  const emails = await loadTicketEmails(ticket);
  const transcript = compactHubspotTicketTranscript(emails.map((email) => ({
    id: email.id,
    hs_email_text: String(email.properties.hs_email_text || ""),
    hs_email_html: String(email.properties.hs_email_html || ""),
    hs_email_subject: String(email.properties.hs_email_subject || ""),
    hs_email_from_email: String(email.properties.hs_email_from_email || ""),
    hs_email_to_email: String(email.properties.hs_email_to_email || ""),
    hs_timestamp: String(email.properties.hs_timestamp || ""),
    hs_email_direction: String(email.properties.hs_email_direction || ""),
  })));
  const outbound = transcript.filter((email) => isHubspotOutboundDirection(String(email.hs_email_direction || "")));
  const humanIntervened = outbound.some((email) => !String(email.hs_email_text || email.hs_email_html || "").includes(AI_DISCLOSURE));
  const closed = (await closedTicketStages()).has(String(ticket.properties.hs_pipeline_stage || ""));
  const updatedAt = new Date(ticket.updatedAt || ticket.properties.hs_lastmodifieddate || Date.now());
  const ticketContent = hubspotEmailPlainText(ticket.properties.content || "").slice(0, 10_000);
  const contentHash = savContentHash({ transcript, ticketContent });
  const db = requireDb();
  const [snapshot] = await db.insert(savTicketSnapshots).values({
    hubspotTicketId: ticket.id,
    pipelineId: ticket.properties.hs_pipeline,
    stageId: ticket.properties.hs_pipeline_stage,
    status: closed ? "closed" : "open",
    subject: String(ticket.properties.subject || "Sans objet"),
    transcriptCiphertext: encryptSavPayload({ transcript }),
    contentHash,
    humanIntervened,
    resolvedAt: closed ? updatedAt : null,
    hubspotUpdatedAt: updatedAt,
    processedAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: savTicketSnapshots.hubspotTicketId,
    set: {
      pipelineId: ticket.properties.hs_pipeline,
      stageId: ticket.properties.hs_pipeline_stage,
      status: closed ? "closed" : "open",
      subject: String(ticket.properties.subject || "Sans objet"),
      transcriptCiphertext: encryptSavPayload({ transcript }),
      contentHash,
      humanIntervened,
      resolvedAt: closed ? updatedAt : null,
      hubspotUpdatedAt: updatedAt,
      processedAt: new Date(),
      updatedAt: new Date(),
    },
  }).returning();
  if (closed) {
    const extracted = extractSavLearningResolution(ticketContent, transcript.map((email) => ({
      id: email.id, direction: String(email.hs_email_direction || ""),
      text: hubspotEmailPlainText(email.hs_email_text || email.hs_email_html || ""),
      timestamp: email.hs_timestamp, aiAuthored: String(email.hs_email_text || email.hs_email_html || "").includes(AI_DISCLOSURE),
    })));
    const finalResolution = extracted.resolution;
    if (finalResolution.length >= 20) await db.insert(savLearningCandidates).values({
      hubspotTicketId: ticket.id,
      sourceRef: `hubspot:${ticket.id}`,
      sourceContentHash: contentHash,
      proposedPatch: {
        ciphertext: encryptSavPayload({
          subject: snapshot.subject,
          finalHumanResolution: finalResolution,
          sourceSnapshotId: snapshot.id,
          provenance: extracted.provenance,
          customerConfirmed: extracted.customerConfirmed,
          sourceMessageId: extracted.sourceMessageId,
        }),
      },
      explanation: `${extracted.provenance === "human_resolution" ? "Résolution humaine" : extracted.provenance === "ai_resolution" ? "Réponse IA" : "Contenu du ticket"}${extracted.customerConfirmed ? " confirmée par un message client ultérieur" : " sans confirmation client explicite"}. Cette proposition doit être relue avant de devenir une fiche de connaissance.`,
      evidenceTicketIds: [ticket.id],
      createdBy: "system",
    }).onConflictDoNothing();
  }
  return snapshot;
}

export async function backfillHubspotTickets(options: { after?: string; maxPages?: number; pageSize?: number } = {}) {
  let after = options.after;
  const maxPages = Math.min(100, Math.max(1, options.maxPages ?? 5));
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 25));
  let pages = 0;
  let processed = 0;
  do {
    const params = new URLSearchParams({
      limit: String(pageSize),
      archived: "false",
      properties: "subject,content,hs_pipeline,hs_pipeline_stage,hs_lastmodifieddate",
      associations: "emails,contacts",
    });
    if (after) params.set("after", after);
    const page = await hubspotFetch<{ results?: HubspotRecord[]; paging?: { next?: { after?: string } } }>(`/crm/v3/objects/tickets?${params}`);
    for (const ticket of page.results ?? []) {
      await snapshotTicket(ticket);
      processed += 1;
    }
    after = page.paging?.next?.after;
    pages += 1;
  } while (after && pages < maxPages);
  return { processed, pages, nextAfter: after ?? null, complete: !after };
}

export async function getHubspotBackfillState() {
  const [state] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, "hubspot:tickets:backfill")).limit(1);
  return state ?? null;
}

export async function continueHubspotBackfill(maxPages = 1, pageSize = 25) {
  const db = requireDb();
  const existing = await getHubspotBackfillState();
  if (existing?.status === "complete") return { processed: 0, pages: 0, nextAfter: null, complete: true };
  const now = new Date();
  const claimed = existing
    ? await db.update(savSyncState).set({
      status: "running",
      lastError: null,
      updatedAt: now,
      startedAt: existing.startedAt ?? now,
    }).where(and(
      eq(savSyncState.key, "hubspot:tickets:backfill"),
      eq(savSyncState.updatedAt, existing.updatedAt),
    )).returning({ key: savSyncState.key })
    : await db.insert(savSyncState).values({
      key: "hubspot:tickets:backfill",
      status: "running",
      processedCount: 0,
      startedAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning({ key: savSyncState.key });
  // Optimistic compare-and-set gives the backfill a single database-backed
  // lease across concurrent Vercel instances. A second cron exits immediately.
  if (!claimed.length) return {
    processed: 0,
    pages: 0,
    nextAfter: existing?.cursor ?? null,
    complete: false,
    skipped: "already_running" as const,
  };
  try {
    const result = await backfillHubspotTickets({ after: existing?.cursor ?? undefined, maxPages, pageSize });
    await db.update(savSyncState).set({
      cursor: result.nextAfter,
      status: result.complete ? "complete" : "idle",
      processedCount: (existing?.processedCount ?? 0) + result.processed,
      completedAt: result.complete ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(savSyncState.key, "hubspot:tickets:backfill"));
    return result;
  } catch (error) {
    const errorCode = (error instanceof Error ? error.message : "UNKNOWN_ERROR").slice(0, 160);
    const blocked = isHubspotEmailReadScopeError(errorCode);
    await db.update(savSyncState).set({
      status: blocked ? "blocked" : "failed",
      lastError: errorCode,
      updatedAt: new Date(),
    }).where(eq(savSyncState.key, "hubspot:tickets:backfill"));
    if (blocked) return {
      processed: 0,
      pages: 0,
      nextAfter: existing?.cursor ?? null,
      complete: false,
      blocked: true as const,
      reason: "missing_email_read_scope" as const,
      requiredScope: HUBSPOT_EMAIL_READ_SCOPE,
    };
    throw error;
  }
}

async function processHubspotReceipt(receiptId: string) {
  const receipt = await claimWebhookReceipt(receiptId, "hubspot");
  if (!receipt) return;
  try {
    const event = hubspotEventSchema.parse(receipt.payload);
    if (event.objectId && event.subscriptionType.startsWith("ticket.")) {
      const ticket = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${event.objectId}?properties=subject,content,hs_pipeline,hs_pipeline_stage,hs_lastmodifieddate&associations=emails,contacts`);
      await snapshotTicket(ticket);
    }
    await markWebhookReceipt(receipt.id, "processed");
  } catch (error) {
    await markWebhookReceipt(receipt.id, "failed", error);
    throw error;
  }
}

export async function processPendingHubspotReceipts(limit = 20) {
  const db = requireDb();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000);
  const receipts = await db.select({ id: savWebhookReceipts.id }).from(savWebhookReceipts)
    .where(and(
      eq(savWebhookReceipts.provider, "hubspot"),
      or(
        inArray(savWebhookReceipts.status, ["pending", "failed"]),
        and(eq(savWebhookReceipts.status, "processing"), or(isNull(savWebhookReceipts.lastAttemptAt), lt(savWebhookReceipts.lastAttemptAt, staleBefore))),
      ),
      lt(savWebhookReceipts.attempts, 10),
    ))
    .orderBy(asc(savWebhookReceipts.receivedAt)).limit(Math.min(100, Math.max(1, limit)));
  const results = [];
  for (const receipt of receipts) {
    try {
      await processHubspotReceipt(receipt.id);
      results.push({ id: receipt.id, status: "processed" });
    } catch (error) {
      results.push({ id: receipt.id, status: "failed", error: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
    }
  }
  return results;
}
