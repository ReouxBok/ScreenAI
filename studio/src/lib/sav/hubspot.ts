import "server-only";
import { readSavTicketHistory, type SavTicketHistory } from "./ticket-history";
import { getSavLearningCutover, recordSavLearningSignal } from "./learning-admission";
import { processSavLearningResolution } from "./learning-pipeline";
import { SAV_TICKET_RETURN_NOTE_VERSION, savTicketReturnNote } from "./ticket-return-note";

import { shortlistSavTickets, savSubsetMatchIsComplete } from "./ticket-shortlist";
import { requestSavHubspot } from "./hubspot-transport";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import {
  auditLogs,
  savActions,
  savActorType,
  savAgentRuns,
  savDecisions,
  savMessages,
  savMailboxes,
  savProposalReviews,
  savSyncState,
  savThreads,
  savTicketSnapshots,
  savWebhookReceipts,
} from "@/db/schema";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { assertSavWriteAllowed } from "./write-guard";
import { savModeAllowsWrite } from "./action-policy";
import { SAV_HUBSPOT_SUPPORT, assertSavSupportConfiguration, assertSavSupportPipeline, savSupportTicketProperties, savReviewedTicketProperties } from "./hubspot-mapping";
import { autoReplyMinConfidence, canSendRepliesAutomatically, savAutoReplyCategories, savAutoReplyDailyLimit, savAutomationMode, savThreadInAutoReplyRollout, savReleaseStage } from "./config";
import { assertSavTicketStageNotClosed, normalizeEmailAddress } from "./policy";
import { isSavAiAuthoredReply } from "./reply-format";
import { getSavAutonomyGate } from "./promotion";
import { savTicketReturnPlan, sortSavTicketsNewestFirst, type SavLifecycleTicket } from "./ticket-lifecycle";
import { selectSavTicketMatch } from "./ticket-routing";
import { matchSavTicketsByContent, type SavTicketMatchCache } from "./ticket-routing-model";
import { applySavHumanTicketRouting, savEffectiveCustomerEmail, savHumanTicketAction } from "./human-process";
import type { SavDossierContext } from "./dossier-context";
import { extractSavLearningResolution, isHubspotOutboundDirection } from "./learning-extraction";
import { savActionFailurePlan } from "./retry-policy";
import { claimWebhookReceipt, markWebhookReceipt, recordWebhookReceipt, type SavMessageBody } from "./service";
import { savReviewMatchesProposal } from "./review-contract";
import { assertSavCurrentTicketReview } from "./manual-tickets";
import { assertSavGmailThreadCurrent } from "./gmail";
import { savStructuredProposalSchema } from "./proposal";
import { phoneMatchesHint, type SavIdentityCandidate, type SavIdentityHints } from "./identity";
import { assertSavActor } from "./access";
import { resolveSavCustomerIdentity, resolveSavCustomerMessage } from "./forwarded-identity";
import { hasSavTicketObservation, refreshSavTicketObservations } from "./observations";

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
type HubspotOwner = { id: string; firstName?: string | null; lastName?: string | null; email?: string | null };
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

const globalForHubspot = globalThis as typeof globalThis & {
  __savClosedHubspotStages?: { values: Set<string>; expiresAt: number };
  __savHubspotOwnerNames?: { accountKey: string; values: Map<string, string>; expiresAt: number };
};
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
  return requestSavHubspot<T>(path, {
    ...init, headers: { Authorization: `Bearer ${requiredEnv("HUBSPOT_ACCESS_TOKEN")}`, "Content-Type": "application/json", Accept: "application/json", ...(init?.headers ?? {}) },
  }, summarizeHubspotError);
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
  const response = await hubspotFetch<{ results?: Array<{ stages?: Array<{ id: string; metadata?: { ticketState?: string; isClosed?: boolean | string } }> }> }>("/crm/v3/pipelines/tickets");
  const values = new Set(response.results?.flatMap((pipeline) => pipeline.stages ?? [])
    .filter((stage) => stage.metadata?.ticketState === "CLOSED" || stage.metadata?.isClosed === true || stage.metadata?.isClosed === "true").map((stage) => stage.id) ?? []);
  globalForHubspot.__savClosedHubspotStages = { values, expiresAt: Date.now() + 15 * 60 * 1_000 };
  return values;
}

async function hubspotOwnerNames(): Promise<Map<string, string>> {
  const accountKey = savContentHash(requiredEnv("HUBSPOT_ACCESS_TOKEN"));
  const cached = globalForHubspot.__savHubspotOwnerNames;
  if (cached?.accountKey === accountKey && cached.expiresAt > Date.now()) return cached.values;
  const values = new Map<string, string>();
  try {
    let after: string | undefined;
    const signal = AbortSignal.timeout(3_000);
    // Read the owner directory in cached pages, not once per ticket. Names are
    // optional presentation data: the whole enrichment has a short time budget.
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ limit: "500" });
      if (after) query.set("after", after);
      const response = await hubspotFetch<{ results?: HubspotOwner[]; paging?: { next?: { after?: string } } }>(`/crm/v3/owners?${query}`, { signal });
      for (const owner of response.results ?? []) {
        const name = [owner.firstName, owner.lastName].filter((part): part is string => Boolean(part?.trim())).join(" ").trim();
        if (owner.id && name) values.set(owner.id, name);
      }
      after = response.paging?.next?.after;
      if (!after) break;
    }
    // A short empty cache prevents repeated requests when HubSpot has no owners
    // or the service account cannot read them; it never affects CRM actions.
    globalForHubspot.__savHubspotOwnerNames = { accountKey, values, expiresAt: Date.now() + 5 * 60 * 1_000 };
  } catch {
    globalForHubspot.__savHubspotOwnerNames = { accountKey, values, expiresAt: Date.now() + 60 * 1_000 };
  }
  return values;
}

async function findContactByEmail(email: string) {
  const address = normalizeEmailAddress(email);
  const primary = await hubspotFetch<{ results?: HubspotRecord[]; paging?: { next?: unknown } }>("/crm/v3/objects/contacts/search", {
    method: "POST", body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: address }] }],
      properties: ["email", "hs_additional_emails", "firstname", "lastname"], limit: 2 }),
  });
  if (primary.paging?.next || (primary.results?.length ?? 0) > 1) throw new Error("SAV_HUBSPOT_IDENTITY_AMBIGUOUS");
  if (primary.results?.length) return primary.results[0];
  // Search's documented default text properties include hs_additional_emails.
  // This broad query is only retrieval: exact address membership confirms identity.
  const secondary = await hubspotFetch<{ results?: HubspotRecord[]; paging?: { next?: unknown } }>("/crm/v3/objects/contacts/search", {
    method: "POST", body: JSON.stringify({ query: address, properties: ["email", "hs_additional_emails", "firstname", "lastname"], limit: 100 }),
  });
  if (secondary.paging?.next) throw new Error("SAV_HUBSPOT_IDENTITY_INCOMPLETE");
  const matches = (secondary.results ?? []).filter(c => [c.properties.email, ...(c.properties.hs_additional_emails ?? "").split(";")].some(value => value && normalizeEmailAddress(value) === address));
  if (matches.length > 1) throw new Error("SAV_HUBSPOT_IDENTITY_AMBIGUOUS");
  return matches[0] ?? null;
}

async function guardedHubspotWrite<T>(actionId: string, path: string, init: RequestInit): Promise<T> {
  await assertSavWriteAllowed(actionId);
  return hubspotFetch<T>(path, init);
}

function escapeSavNoteHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Two writes form a supervised operation. Unknown/partial results require human reconciliation;
 * they are never replayed as another note. Every write retains the live V0 authorization guard. */
async function reactivateSavTicketForReturn(action: typeof savActions.$inferSelect, ticketId: string, contactId: string, expectedStage: string | null | undefined, expectedClosedAt: string | null | undefined, expectedOwnerId: string, message: typeof savMessages.$inferSelect, mailboxEmail: string, gmailThreadId: string, replacesClosedTicketId?: string) {
  const body = decryptSavPayload<SavMessageBody>(message.bodyCiphertext);
  const noteVersion = action.payload.ticketReturnNoteVersion ?? 1;
  if (noteVersion !== 1 && noteVersion !== SAV_TICKET_RETURN_NOTE_VERSION) throw new Error("SAV_TICKET_RETURN_NOTE_VERSION_INVALID");
  const note = noteVersion === SAV_TICKET_RETURN_NOTE_VERSION
    ? savTicketReturnNote(expectedStage === SAV_HUBSPOT_SUPPORT.stages.closed ? "closed" : "open")
    : `Le client est revenu sur le même sujet. Retour reçu le ${message.receivedAt.toISOString()}.\nDe : ${message.fromEmail}\nObjet : ${message.subject}\nEmail source : ${message.gmailMessageId}\n\n${body.text}`;
  const html = `<p>${escapeSavNoteHtml(note).replace(/\n/g, "<br>")}</p>`;
  if (html.length > 60_000) throw new Error("SAV_TICKET_RETURN_EMAIL_TOO_LARGE");
  const checkTarget = async () => {
    if (replacesClosedTicketId) {
      const { thread } = await assertSavWriteAllowed(action.id);
      const predecessor = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(replacesClosedTicketId)}?properties=hs_pipeline,hs_pipeline_stage&associations=contacts`);
      if (thread.hubspotTicketId !== replacesClosedTicketId || predecessor.properties.hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId
        || predecessor.properties.hs_pipeline_stage !== SAV_HUBSPOT_SUPPORT.stages.closed
        || !predecessor.associations?.contacts?.results?.some(contact => contact.id === contactId)) throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
    }
    const target = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}?properties=hs_pipeline,hs_pipeline_stage,hs_last_closed_date,closed_date,hubspot_owner_id&associations=contacts`);
    if (target.properties.hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId || target.properties.hs_pipeline_stage !== expectedStage
      || (target.properties.hs_last_closed_date || target.properties.closed_date || null) !== (expectedClosedAt ?? null)
      || target.properties.hubspot_owner_id !== expectedOwnerId
      || !target.associations?.contacts?.results?.some(contact => contact.id === contactId)) throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
  };
  await checkTarget();
  const associations = await hubspotFetch<{ results: Array<{ category: string; typeId: number; label: string | null }> }>("/crm/v4/associations/notes/tickets/labels");
  const association = associations.results.find(type => type.category === "HUBSPOT_DEFINED" && type.label === null);
  if (!association) throw new Error("SAV_TICKET_RETURN_ASSOCIATION_INVALID");
  await assertSavGmailThreadCurrent(mailboxEmail, gmailThreadId, message.gmailMessageId!);
  await assertSavWriteAllowed(action.id);
  const db = requireDb();
  const [claimed] = await db.update(savActions).set({ payload: sql`${savActions.payload} || ${JSON.stringify({ ticketReturnDispatchedAt: new Date().toISOString(), ticketReturnRequestCiphertext: encryptSavPayload({ ticketId, contactId, html, noteTimestamp: message.receivedAt.toISOString(), expectedOwnerId, replacesClosedTicketId, noteVersion: action.payload.ticketReturnNoteVersion ?? 1, sourceMessageId: message.id }) })}::jsonb`, updatedAt: new Date() })
    .where(and(eq(savActions.id, action.id), eq(savActions.status, "running"), sql`${savActions.payload}->>'ticketReturnDispatchedAt' is null`)).returning();
  if (!claimed) throw new Error("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED");
  let noteAcknowledged = false;
  try {
    const noteResult = await guardedHubspotWrite<HubspotRecord>(action.id, "/crm/v3/objects/notes", { method: "POST", body: JSON.stringify({
      properties: { hs_timestamp: message.receivedAt.toISOString(), hs_note_body: html },
      associations: [{ to: { id: ticketId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: association.typeId }] }],
    }) });
    if (!noteResult?.id) throw new Error("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED");
    noteAcknowledged = true;
    await db.update(savActions).set({ payload: sql`${savActions.payload} || ${JSON.stringify({ ticketReturnNoteId: noteResult.id })}::jsonb` }).where(eq(savActions.id, action.id));
    await assertSavGmailThreadCurrent(mailboxEmail, gmailThreadId, message.gmailMessageId!);
    await checkTarget();
    await guardedHubspotWrite(action.id, `/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}`, { method: "PATCH", body: JSON.stringify({ properties: { hs_pipeline_stage: SAV_HUBSPOT_SUPPORT.stages.new, hubspot_owner_id: expectedOwnerId } }) });
    await db.update(savActions).set({ payload: sql`${savActions.payload} || ${JSON.stringify({ ticketReturnCompletedAt: new Date().toISOString(), hubspotTicketId: ticketId })}::jsonb`, updatedAt: new Date() }).where(eq(savActions.id, action.id));
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    if (!noteAcknowledged && /^HUBSPOT_HTTP_(?:400|401|403|404|405|409|422|429)(?::|$)/.test(code)) {
      await db.update(savActions).set({ payload: sql`${savActions.payload} - 'ticketReturnDispatchedAt'` }).where(eq(savActions.id, action.id));
      throw error;
    }
    throw new Error("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED");
  }
}

async function finalizeSavV0TicketAction(action: typeof savActions.$inferSelect) {
  const { thread, latest } = await assertSavWriteAllowed(action.id);
  const review = await assertSavCurrentTicketReview(action);
  const proposal = savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext));
  if (!latest?.gmailMessageId) throw new Error("SAV_GMAIL_MESSAGE_ID_REQUIRED");
  const [mailbox] = await requireDb().select().from(savMailboxes).where(eq(savMailboxes.id, latest.mailboxId)).limit(1);
  if (!mailbox) throw new Error("SAV_MAILBOX_NOT_FOUND");
  const returnRequest = action.payload.ticketReturn ? z.object({ ticketId: z.string(), operation: z.enum(["keep", "reactivate", "create"]), stageId: z.string().nullish(), closedAt: z.string().nullish(), ownerId: z.string().optional(), replacesClosedTicketId: z.string().optional() }).parse(action.payload.ticketReturn) : null;
  if (action.payload.ticketReturnDispatchedAt && !action.payload.ticketReturnCompletedAt) throw new Error("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED");
  if (returnRequest?.replacesClosedTicketId && thread.hubspotTicketId !== returnRequest.replacesClosedTicketId && thread.hubspotTicketId !== action.payload.hubspotTicketId) throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
  const knownTicketId = typeof action.payload.hubspotTicketId === "string" ? action.payload.hubspotTicketId : null;
  if (!knownTicketId && action.payload.ticketCreateDispatchedAt) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
  assertSavSupportConfiguration(process.env);
  const pipeline = await hubspotFetch<{ id: string; stages: Array<{ id: string; metadata?: { isClosed?: string | boolean } }> }>(`/crm/v3/pipelines/tickets/${SAV_HUBSPOT_SUPPORT.pipelineId}`);
  assertSavSupportPipeline(pipeline);
  let ticket: HubspotRecord;
  if (knownTicketId) {
    // An acknowledged result is resumed, never replaced by another POST.
    ticket = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(knownTicketId)}?properties=subject,hs_pipeline,hs_pipeline_stage`);
  } else {
    await assertSavGmailThreadCurrent(mailbox.email, thread.gmailThreadId, latest.gmailMessageId);
    const customerMessage = resolveSavCustomerMessage({ fromEmail: latest.fromEmail, subject: latest.subject, body: decryptSavPayload<SavMessageBody>(latest.bodyCiphertext).text });
    const customerIdentity = { kind: customerMessage.kind, email: customerMessage.email };
    if (!customerIdentity.email) throw new Error("SAV_FORWARDED_CUSTOMER_UNRESOLVED");
    const customerEmail = savEffectiveCustomerEmail(proposal, customerIdentity)!;
    const savedContext = decryptSavPayload<{ supportContext?: SavDossierContext }>(latest.bodyCiphertext).supportContext;
    const freshContext = await readSavHubspotContext({ email: customerEmail, subject: customerMessage.subject, body: customerMessage.body, returnedAt: latest.receivedAt,
      includeHistory: true, historyTicketId: savHumanTicketAction(proposal)?.ticketId, skipSemanticMatch: Boolean(savHumanTicketAction(proposal)), cachedMatching: savedContext?.crm.data?.matching,
      currentTicketId: customerIdentity.kind === "sender" && thread.customerEmail.toLowerCase() === customerEmail.toLowerCase() ? thread.hubspotTicketId : undefined });
    const context = applySavHumanTicketRouting(proposal, { version: 1, messageId: latest.id, collectedAt: new Date().toISOString(), customerIdentity,
      crm: { status: freshContext.errorCode ? "partial" : "ready", errorCode: freshContext.errorCode, data: freshContext }, conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null }, latest.receivedAt).crm.data!;
    if (!context.contactId) throw new Error("SAV_HUBSPOT_CONTACT_REQUIRED");
    const previewDetails = typeof action.payload.ticketPreviewSnapshotCiphertext === "string"
      ? decryptSavPayload<{ contactId: string; targetId: string | null; targetTitle: string | null }>(action.payload.ticketPreviewSnapshotCiphertext) : null;
    if (previewDetails && (context.contactId !== previewDetails.contactId
      || previewDetails.targetId && context.tickets.find(ticket => ticket.id === previewDetails.targetId)?.subject !== previewDetails.targetTitle)) throw new Error("SAV_TICKET_PREVIEW_CHANGED");
    const returnTarget = returnRequest ? context.tickets.find(value => value.id === returnRequest.ticketId) : null;
    if (returnRequest && (!returnTarget || context.routing.kind !== "matched" || context.routing.ticketId !== returnTarget.id
      || returnTarget.stageId !== returnRequest.stageId || returnTarget.closedAt !== returnRequest.closedAt
      || (returnRequest.operation === "reactivate" || returnRequest.operation === "create") && (!returnRequest.ownerId || returnTarget.ownerId !== returnRequest.ownerId)
      || savTicketReturnPlan(returnTarget, latest.receivedAt).operation !== returnRequest.operation)) throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
    if (returnRequest?.replacesClosedTicketId && (thread.hubspotTicketId !== returnRequest.replacesClosedTicketId
      || action.payload.previousTicketId !== returnRequest.replacesClosedTicketId
      || context.tickets.find(value => value.id === returnRequest.replacesClosedTicketId)?.status !== "closed"
      || returnTarget?.status !== "open")) throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
    if (action.kind === "link_ticket") {
      if (returnRequest?.operation === "create") throw new Error("SAV_LINK_TARGET_INVALID");
      const selected = context.tickets.find((value) => value.id === action.payload.ticketId && (value.status === "open" || returnRequest?.operation === "reactivate"));
      if (!selected) throw new Error("SAV_LINK_TARGET_INVALID");
      ticket = { id: selected.id, properties: { subject: selected.subject, hs_pipeline: selected.pipelineId || SAV_HUBSPOT_SUPPORT.pipelineId } };
      if (returnRequest?.operation === "reactivate") {
        if (!returnRequest.ownerId) throw new Error("SAV_TICKET_OWNER_REQUIRED");
        await reactivateSavTicketForReturn(action, selected.id, context.contactId, returnRequest.stageId, returnRequest.closedAt, returnRequest.ownerId, latest, mailbox.email, thread.gmailThreadId, returnRequest.replacesClosedTicketId);
      }
      // A plain link (including a ticket already New) never changes the CRM.
    } else {
      if (context.routing.kind === "ambiguous" || context.routing.kind === "matched" && returnRequest?.operation !== "create") throw new Error("SAV_EXISTING_TICKET_REQUIRES_LINK");
      const distinctIssueReason = typeof action.payload.distinctIssueReasonCiphertext === "string" ? decryptSavPayload<{ text: string }>(action.payload.distinctIssueReasonCiphertext).text : "";
      if (!returnRequest && context.tickets.some((value) => value.status === "open") && distinctIssueReason.trim().length < 20) throw new Error("SAV_DISTINCT_ISSUE_CONFIRMATION_REQUIRED");
      await assertSavWriteAllowed(action.id);
      await assertSavGmailThreadCurrent(mailbox.email, thread.gmailThreadId, latest.gmailMessageId);
      const properties = savReviewedTicketProperties(proposal);
      if (returnRequest?.operation === "create") {
        if (!returnTarget?.ownerId || !returnRequest.ownerId || returnTarget.ownerId !== returnRequest.ownerId) throw new Error("SAV_TICKET_OWNER_REQUIRED");
        properties.hubspot_owner_id = returnTarget.ownerId;
      }
      const db = requireDb();
      // Durable marker before dispatch. Recovery must fail closed after a crash.
      const [claimed] = await db.update(savActions).set({ payload: sql`${savActions.payload} || ${JSON.stringify({ ticketCreateDispatchedAt: new Date().toISOString(), ticketCreateRequestCiphertext: encryptSavPayload({
          actionId: action.id, reviewId: review.id, decisionId: action.decisionId, messageId: action.messageId, threadId: thread.id,
          contactId: context.contactId, customerEmail, customerIdentityKind: customerIdentity.kind, properties,
        }) })}::jsonb`, updatedAt: new Date() })
        .where(and(eq(savActions.id, action.id), eq(savActions.status, "running"), sql`${savActions.payload}->>'ticketCreateDispatchedAt' is null`)).returning();
      if (!claimed) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
      try {
        ticket = await guardedHubspotWrite<HubspotRecord>(action.id, "/crm/v3/objects/tickets", { method: "POST", body: JSON.stringify({ properties, associations: [{ to: { id: context.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 16 }] }] }) });
        if (!ticket?.id) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
        await db.update(savActions).set({ payload: sql`${savActions.payload} || ${JSON.stringify({ hubspotTicketId: ticket.id })}::jsonb`, updatedAt: new Date() }).where(eq(savActions.id, action.id));
      } catch (error) {
        const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
        // Only a definite rejection is safe to repeat. 408/5xx/transport errors
        // can mean that the ticket exists despite an absent acknowledgement.
        if (/^HUBSPOT_HTTP_(?:400|401|403|404|405|409|422|429)(?::|$)/.test(code)) {
          await db.update(savActions).set({ payload: sql`${savActions.payload} - 'ticketCreateDispatchedAt'` }).where(eq(savActions.id, action.id));
          throw error;
        }
        throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
      }
    }
  }
  await requireDb().transaction(async (tx) => {
    await tx.select().from(savThreads).where(eq(savThreads.id, thread.id)).for("update");
    const [current] = await tx.select().from(savThreads).where(eq(savThreads.id, thread.id));
    if (current?.hubspotTicketId && current.hubspotTicketId !== ticket.id
      && !(returnRequest?.operation === "create" && current.hubspotTicketId === action.payload.previousTicketId && current.hubspotTicketId === returnRequest.ticketId)
      && !(returnRequest?.replacesClosedTicketId === current.hubspotTicketId && current.hubspotTicketId === action.payload.previousTicketId && returnRequest.ticketId === ticket.id)) throw new Error("SAV_MANUAL_RECONCILIATION_REQUIRED");
    await tx.update(savThreads).set({ hubspotTicketId: ticket.id, updatedAt: new Date() }).where(eq(savThreads.id, thread.id));
    await tx.update(savActions).set({ status: "succeeded", errorCode: null, executedAt: new Date(), updatedAt: new Date(), payload: sql`${savActions.payload} || ${JSON.stringify({ hubspotTicketId: ticket.id })}::jsonb` }).where(eq(savActions.id, action.id));
    await tx.insert(auditLogs).values({ actorEmail: action.actorEmail || "system", action: "sav_manual_ticket_completed", entityType: "sav_action", entityId: action.id, technicalMetadata: { ticketId: ticket.id, kind: action.kind, reviewId: review.id, messageId: latest.id } });
    // No reply is queued. Only an explicitly confirmed return may add a note and reopen.
  });
  return ticket;
}

/** Read-only reconciliation: never repeat a note or patch with an unknown outcome. */
export async function reconcileSavTicketReturn(actionId: string, noteId: string, actorEmail: string) {
  assertSavActor(actorEmail);
  if (!/^\d{1,30}$/.test(noteId)) throw new Error("SAV_RECONCILIATION_CONFIRMATION_REQUIRED");
  const db = requireDb();
  const [action] = await db.select().from(savActions).where(eq(savActions.id, actionId));
  if (!action || action.kind !== "link_ticket" || action.status !== "failed" || typeof action.payload.ticketReturnRequestCiphertext !== "string" || !action.payload.ticketReturnDispatchedAt) throw new Error("SAV_ACTION_NOT_RECONCILABLE");
  const request = decryptSavPayload<{ ticketId: string; contactId: string; html: string; noteTimestamp?: string; expectedOwnerId: string; replacesClosedTicketId?: string }>(action.payload.ticketReturnRequestCiphertext);
  if (!request.expectedOwnerId) throw new Error("SAV_TICKET_RETURN_LEGACY_OWNER_UNVERIFIABLE");
  const [ticket, note] = await Promise.all([
    hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(request.ticketId)}?properties=hs_pipeline,hs_pipeline_stage,hubspot_owner_id&associations=contacts`),
    hubspotFetch<HubspotRecord>(`/crm/v3/objects/notes/${encodeURIComponent(noteId)}?properties=hs_note_body,hs_timestamp&associations=tickets`),
  ]);
  const normalizeHtml = (html: string) => html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?p>/gi, "").replace(/\r\n/g, "\n").trim();
  // Generic return notes are identical across messages. Text and association
  // alone cannot prove this attempt. Prefer the acknowledged ID; after a lost
  // acknowledgement require both the source timestamp and dispatch-time creation.
  const acknowledgedId = action.payload.ticketReturnNoteId;
  const dispatchTime = Date.parse(String(action.payload.ticketReturnDispatchedAt));
  const createdTime = Date.parse(note.createdAt ?? "");
  const sourceTime = Date.parse(request.noteTimestamp ?? "");
  const timestamp = note.properties.hs_timestamp;
  const noteTime = typeof timestamp === "string" && /^\d+$/.test(timestamp) ? Number(timestamp) : Date.parse(timestamp ?? "");
  const belongsToAttempt = typeof acknowledgedId === "string"
    ? acknowledgedId === noteId
    : Number.isFinite(sourceTime) && noteTime === sourceTime && Number.isFinite(dispatchTime)
      && createdTime >= Math.floor(dispatchTime / 1000) * 1000 && createdTime <= dispatchTime + 20_000;
  if (!belongsToAttempt || note.id !== noteId || ticket.id !== request.ticketId) throw new Error("SAV_RECONCILIATION_TARGET_INVALID");
  if (ticket.properties.hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId || ticket.properties.hs_pipeline_stage !== SAV_HUBSPOT_SUPPORT.stages.new
    || !request.expectedOwnerId || ticket.properties.hubspot_owner_id !== request.expectedOwnerId
    || !ticket.associations?.contacts?.results?.some(value => value.id === request.contactId)
    || !note.associations?.tickets?.results?.some(value => value.id === request.ticketId)
    || normalizeHtml(String(note.properties.hs_note_body ?? "")) !== normalizeHtml(request.html)) throw new Error("SAV_RECONCILIATION_TARGET_INVALID");
  return db.transaction(async tx => {
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, action.threadId)).for("update");
    const [current] = await tx.select().from(savActions).where(eq(savActions.id, action.id)).for("update");
    if (!thread || current?.status !== "failed" || (thread.hubspotTicketId && thread.hubspotTicketId !== request.ticketId && !(thread.hubspotTicketId === request.replacesClosedTicketId && thread.hubspotTicketId === action.payload.previousTicketId))) throw new Error("SAV_RECONCILIATION_TARGET_INVALID");
    await tx.update(savThreads).set({ hubspotTicketId: request.ticketId, updatedAt: new Date() }).where(eq(savThreads.id, thread.id));
    await tx.update(savActions).set({ status: "succeeded", errorCode: null, executedAt: new Date(), updatedAt: new Date(),
      payload: sql`${savActions.payload} || ${JSON.stringify({ ticketReturnCompletedAt: new Date().toISOString(), ticketReturnNoteId: noteId, hubspotTicketId: request.ticketId, ticketReturnReconciledBy: actorEmail })}::jsonb` }).where(eq(savActions.id, action.id));
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_ticket_return_reconciled", entityType: "sav_action", entityId: action.id, technicalMetadata: { ticketId: request.ticketId, noteId } });
  });
}

/** Reconcile an uncertain create via reads and an explicit human confirmation.
 * This never dispatches another HubSpot mutation, even for a stale proposal. */
export async function reconcileSavManualTicket(actionId: string, ticketId: string, actorEmail: string, reason: string) {
  assertSavActor(actorEmail);
  if (!/^\d{1,30}$/.test(ticketId) || reason.trim().length < 10) throw new Error("SAV_RECONCILIATION_CONFIRMATION_REQUIRED");
  const db = requireDb();
  const [action] = await db.select().from(savActions).where(eq(savActions.id, actionId)).limit(1);
  if (!action || action.kind !== "create_ticket" || !action.payload.ticketCreateDispatchedAt || typeof action.payload.savReviewId !== "string") throw new Error("SAV_ACTION_NOT_RECONCILABLE");
  const [review] = await db.select().from(savProposalReviews).where(eq(savProposalReviews.id, action.payload.savReviewId)).limit(1);
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, action.threadId)).limit(1);
  if (!review || !thread || review.messageId !== action.messageId) throw new Error("SAV_ACTION_NOT_RECONCILABLE");
  const [sourceMessage] = await db.select().from(savMessages).where(eq(savMessages.id, review.messageId)).limit(1);
  if (!sourceMessage) throw new Error("SAV_ACTION_NOT_RECONCILABLE");
  const sourceIdentity = resolveSavCustomerIdentity({ fromEmail: sourceMessage.fromEmail, body: decryptSavPayload<SavMessageBody>(sourceMessage.bodyCiphertext).text });
  if (!sourceIdentity.email) throw new Error("SAV_FORWARDED_CUSTOMER_UNRESOLVED");
  const proposal = savStructuredProposalSchema.parse(decryptSavPayload(review.afterCiphertext));
  let email = sourceIdentity.kind === "forwarded" ? sourceIdentity.email
    : proposal.customerIdentity.verifiedByHuman && proposal.customerIdentity.registrationEmail ? proposal.customerIdentity.registrationEmail : sourceIdentity.email;
  let expected = savReviewedTicketProperties(proposal);
  let dispatchedContactId: string | null = null;
  if (typeof action.payload.ticketCreateRequestCiphertext === "string") {
    const request = decryptSavPayload<{ actionId: string; reviewId: string; decisionId: string; messageId: string; threadId: string; contactId: string; customerEmail: string; customerIdentityKind?: "sender" | "forwarded" | "unresolved_forward"; properties: typeof expected }>(action.payload.ticketCreateRequestCiphertext);
    if (request.actionId !== action.id || request.reviewId !== review.id || request.decisionId !== action.decisionId || request.messageId !== action.messageId || request.threadId !== thread.id || !request.contactId || !request.customerEmail
      || sourceIdentity.kind === "forwarded" && request.customerEmail !== sourceIdentity.email)
      throw new Error("SAV_ACTION_NOT_RECONCILABLE");
    expected = request.properties; email = request.customerEmail; dispatchedContactId = request.contactId;
  } else if (typeof action.payload.ticketReviewSnapshotCiphertext === "string") {
    const request = decryptSavPayload<{ reviewId: string; decisionId: string; messageId: string; threadId: string; customerEmail: string; customerIdentityKind?: "sender" | "forwarded" | "unresolved_forward"; proposal: unknown }>(action.payload.ticketReviewSnapshotCiphertext);
    if (request.reviewId !== review.id || request.decisionId !== action.decisionId || request.messageId !== action.messageId || request.threadId !== thread.id || savContentHash(request.proposal) !== savContentHash(proposal)
      || sourceIdentity.kind === "forwarded" && request.customerEmail !== sourceIdentity.email)
      throw new Error("SAV_ACTION_NOT_RECONCILABLE");
    email = request.customerIdentityKind === "forwarded" ? request.customerEmail
      : proposal.customerIdentity.verifiedByHuman && proposal.customerIdentity.registrationEmail ? proposal.customerIdentity.registrationEmail : request.customerEmail;
  } else {
    // Compatibility for commands queued before immutable request snapshots.
    // Compare the historical generation actually attached to this action, never the latest one.
    const [decision] = await db.select().from(savDecisions).where(eq(savDecisions.id, action.decisionId!));
    const [run] = decision?.agentRunId ? await db.select().from(savAgentRuns).where(eq(savAgentRuns.id, decision.agentRunId)) : [];
    const [message] = await db.select().from(savMessages).where(eq(savMessages.id, action.messageId!));
    if (!decision || !message || run?.messageId !== message.id || !run.proposalCiphertext || !savReviewMatchesProposal(review, { decisionId: decision.id, agentRunId: run.id,
      proposal: savStructuredProposalSchema.parse(decryptSavPayload(run.proposalCiphertext)), message })) throw new Error("SAV_ACTION_NOT_RECONCILABLE");
  }
  const contact = await findContactByEmail(email);
  const ticket = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}?properties=subject,content,hs_pipeline,hubspot_owner_id&associations=contacts`);
  if (!contact || (dispatchedContactId && contact.id !== dispatchedContactId) || ticket.properties.hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId || ticket.properties.subject !== expected.subject || ticket.properties.content !== expected.content
    || (expected.hubspot_owner_id && ticket.properties.hubspot_owner_id !== expected.hubspot_owner_id)
    || !ticket.associations?.contacts?.results?.some((value) => value.id === contact.id)) throw new Error("SAV_RECONCILIATION_TARGET_INVALID");
  return db.transaction(async (tx) => {
    await tx.select().from(savThreads).where(eq(savThreads.id, thread.id)).for("update");
    const [current] = await tx.select().from(savActions).where(eq(savActions.id, action.id)).for("update");
    const [currentThread] = await tx.select().from(savThreads).where(eq(savThreads.id, thread.id));
    if (!current || (current.payload.hubspotTicketId && current.payload.hubspotTicketId !== ticketId) || (currentThread?.hubspotTicketId && currentThread.hubspotTicketId !== ticketId && !(action.payload.ticketReturn && currentThread.hubspotTicketId === action.payload.previousTicketId))) throw new Error("SAV_RECONCILIATION_TARGET_INVALID");
    if (current.status === "succeeded") return current;
    const [updated] = await tx.update(savActions).set({ status: "succeeded", executedAt: new Date(), updatedAt: new Date(), errorCode: null,
      payload: { ...current.payload, hubspotTicketId: ticketId, reconciledBy: actorEmail, reconciledAt: new Date().toISOString() } }).where(eq(savActions.id, current.id)).returning();
    await tx.update(savThreads).set({ hubspotTicketId: ticketId, updatedAt: new Date() }).where(eq(savThreads.id, thread.id));
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_ticket_manually_reconciled", entityType: "sav_action", entityId: current.id, technicalMetadata: { ticketId, reviewId: review.id, reason: reason.trim().slice(0, 2000) } });
    return updated;
  });
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
      const linked = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(currentTicketId)}?properties=subject,hs_pipeline,hs_pipeline_stage,hs_lastmodifieddate,hubspot_owner_id`);
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
      properties: ["subject", "hs_pipeline", "hs_pipeline_stage", "hs_lastmodifieddate", "hubspot_owner_id"],
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

export async function findSavContactCandidates(hints: SavIdentityHints): Promise<SavIdentityCandidate[]> {
  const candidates = new Map<string, SavIdentityCandidate>();
  const properties = ["firstname", "lastname", "email", "phone", "mobilephone"];
  for (const name of hints.names.slice(0, 2)) {
    const response = await hubspotFetch<{ results?: HubspotRecord[] }>("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({ query: name.slice(0, 100), properties, limit: 10 }) });
    for (const contact of response.results ?? []) {
      const fullName = [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(" ");
      // Search can also match a company/email. Only actual name matches qualify.
      const normalize = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();
      if (normalize(fullName) !== normalize(name)) continue;
      candidates.set(contact.id, { contactId: contact.id, name: fullName.slice(0, 200), email: String(contact.properties.email || "").slice(0, 254), phoneHint: "", matchedBy: "name", confirmed: false });
    }
  }
  for (const phone of hints.phones.slice(0, 2)) {
    const response = await hubspotFetch<{ results?: HubspotRecord[] }>("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify({ properties, limit: 10,
      filterGroups: ["phone", "mobilephone"].map((propertyName) => ({ filters: [{ propertyName, operator: "CONTAINS_TOKEN", value: `*${phone.slice(-9)}` }] })) }) });
    for (const contact of response.results ?? []) {
      if (![contact.properties.phone, contact.properties.mobilephone].some((value) => value && phoneMatchesHint(value, phone))) continue;
      candidates.set(contact.id, { contactId: contact.id, name: [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(" ").slice(0, 200), email: String(contact.properties.email || "").slice(0, 254), phoneHint: `…${phone.slice(-4)}`, matchedBy: "phone", confirmed: false });
    }
  }
  return [...candidates.values()].slice(0, 10);
}

export type SavHubspotContext = {
  history?: SavTicketHistory;
  errorCode: string | null; contactFound: boolean; contactId?: string; contactName?: string | null; identityCandidates: SavIdentityCandidate[];
  tickets: Array<SavLifecycleTicket & { subject: string; description: string; descriptionTruncated?: boolean; subjectTruncated?: boolean; pipelineId: string | null; stageId: string | null; updatedAt: string | null }>;
  matching?: Awaited<ReturnType<typeof matchSavTicketsByContent>>["matching"];
  limitations?: { paginationComplete: boolean; total: number; shown: number; omittedOpen: number; omittedClosed: number };
  routing: { kind: "matched"; ticketId: string; reason: string; returnOperation: ReturnType<typeof savTicketReturnPlan>["operation"] }
    | { kind: "new" | "ambiguous"; reason: string; candidateIds: string[] };
};

export async function readSavHubspotContext(input: { email: string; subject: string; body?: string; currentTicketId?: string | null; returnedAt?: Date | string; identityHints?: SavIdentityHints; toleratePartial?: boolean; skipSemanticMatch?: boolean; cachedMatching?: SavTicketMatchCache; includeHistory?: boolean; historyTicketId?: string | null }): Promise<SavHubspotContext> {
  const contact = await findContactByEmail(input.email);
  const contactName = contact ? [contact.properties.firstname, contact.properties.lastname].filter((part): part is string => Boolean(part?.trim())).join(" ").trim() || null : null;
  let identityCandidates: SavIdentityCandidate[] = [];
  try {
    identityCandidates = !contact && input.identityHints ? await findSavContactCandidates(input.identityHints) : [];
    const readLinked = async () => {
      let linkedTicket: HubspotRecord | null = null;
    const linkedId = input.historyTicketId ?? input.currentTicketId;
    if (linkedId) {
      try {
        linkedTicket = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(linkedId)}?properties=subject,content,createdate,hs_pipeline,hs_pipeline_stage,hs_lastmodifieddate,hs_last_closed_date,closed_date,hubspot_owner_id&associations=contacts`);
      } catch (error) {
        if (!/HUBSPOT_HTTP_404/.test(error instanceof Error ? error.message : "")) throw error;
      }
    }
      return linkedTicket;
    };
    const readAssociated = async () => {
    const recordsById = new Map<string, HubspotRecord>();
    let after: string | undefined;
    let paginationComplete = true;
    const seenCursors = new Set<string>();
    if (contact) for (let page = 0; page < 5; page++) {
      const response = await hubspotFetch<{ results?: HubspotRecord[]; paging?: { next?: { after?: string | number } } }>("/crm/v3/objects/tickets/search", {
        method: "POST", body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "associations.contact", operator: "EQ", value: contact.id }] }],
          properties: ["subject", "content", "hs_pipeline", "hs_pipeline_stage", "hs_lastmodifieddate", "createdate", "hs_last_closed_date", "closed_date", "hubspot_owner_id"],
          sorts: ["-createdate"], limit: 100, ...(after ? { after } : {}) }),
      });
      for (const ticket of response.results ?? []) recordsById.set(ticket.id, ticket);
      if (!response.paging?.next) break;
      const next = response.paging.next.after;
      if (next === undefined || !/^\d+$/.test(String(next)) || seenCursors.has(String(next)) || page === 4) { paginationComplete = false; break; }
      after = String(next); seenCursors.add(after);
    }
      return { recordsById, paginationComplete };
    };
    const [linked, { recordsById, paginationComplete }, closed] = await Promise.all([readLinked(), readAssociated(), closedTicketStages()]);
    let linkedTicket = linked;
    if (linkedTicket && !linkedTicket.associations?.contacts?.results?.some(row => row.id === contact?.id)) linkedTicket = null;
    const records = [...(linkedTicket ? [linkedTicket] : []), ...[...recordsById.values()].filter((ticket) => ticket.id !== linkedTicket?.id)]
      .filter((ticket) => String(ticket.properties.hs_pipeline) === SAV_HUBSPOT_SUPPORT.pipelineId);
    const ownerNames = records.some(ticket => ticket.properties.hubspot_owner_id) ? await hubspotOwnerNames() : new Map<string, string>();
    const tickets = sortSavTicketsNewestFirst(records.map((ticket): SavLifecycleTicket & { subject: string; description: string; descriptionTruncated?: boolean; subjectTruncated?: boolean; pipelineId: string | null; stageId: string | null; updatedAt: string | null } => ({
      id: ticket.id,
      subject: String(ticket.properties.subject || "Sans objet").slice(0, 500),
      subjectTruncated: String(ticket.properties.subject || "Sans objet").length > 500,
      description: String(ticket.properties.content || "").slice(0, 8_000),
      descriptionTruncated: String(ticket.properties.content || "").length > 8_000,
      pipelineId: ticket.properties.hs_pipeline,
      stageId: ticket.properties.hs_pipeline_stage,
      ownerId: ticket.properties.hubspot_owner_id || null,
      ownerName: ticket.properties.hubspot_owner_id ? ownerNames.get(ticket.properties.hubspot_owner_id) ?? null : null,
      status: closed.has(String(ticket.properties.hs_pipeline_stage || "")) ? "closed" as const : "open" as const,
      createdAt: ticket.createdAt ?? ticket.properties.createdate ?? null,
      closedAt: ticket.properties.hs_last_closed_date || ticket.properties.closed_date || null,
      updatedAt: ticket.properties.hs_lastmodifieddate || ticket.updatedAt || null,
    })));
    const shortlist = shortlistSavTickets(tickets, `${input.subject}\n${input.body ?? ""}`, input.currentTicketId);
    const historyDeadline = AbortSignal.timeout(8000);
    let history = input.includeHistory && contact ? await readSavTicketHistory(shortlist.selected.map(t => t.id), new Date(input.returnedAt ?? new Date()), hubspotFetch, historyDeadline) : undefined;
    const matchingTickets = shortlist.selected.map(ticket => {
      const description = [ticket.description, ...(history?.events.filter(e => e.ticketId === ticket.id).map(e => `[Historical declaration / ticket ${ticket.id} / ${e.kind} / ${e.occurredAt} / source ${e.sourceId}] ${e.text}`) ?? [])].join("\n");
      if (history && description.length > 11_000) history.limitations.push("history_matching_content_limited");
      return { ...ticket, description: description.slice(0, 11_000) };
    });
    const assessed = input.body !== undefined && !input.skipSemanticMatch && paginationComplete ? await matchSavTicketsByContent({ subject: input.subject, body: input.body, tickets: matchingTickets }, { cached: input.cachedMatching }) : null;
    let routing = assessed?.selection ?? selectSavTicketMatch({ subject: input.subject, candidates: tickets, currentTicketId: input.currentTicketId, includeClosed: true });
    if (!paginationComplete || assessed && !savSubsetMatchIsComplete(routing, shortlist.omitted)) routing = { kind: "ambiguous", candidates: tickets, reason: "ticket_context_incomplete" };
    if (history?.limitations.length && routing.kind === "new" && tickets.length) routing = { kind: "ambiguous", candidates: tickets, reason: "ticket_history_incomplete" };
    const explicitHistoryTarget = input.historyTicketId && tickets.some(t => t.id === input.historyTicketId) ? input.historyTicketId : null;
    const selectedId = explicitHistoryTarget ?? (routing.kind === "matched" ? routing.ticket.id : input.skipSemanticMatch && linkedTicket ? linkedTicket.id : null);
    // Reserve one selected-ticket read when matching chose outside the two candidates.
    // A separate eight-second bound keeps the selected issue readable after matching.
    if (history && selectedId && !history.ticketIds.includes(selectedId)) {
      const selectedHistory = await readSavTicketHistory([selectedId], new Date(input.returnedAt ?? new Date()), hubspotFetch);
      history = { ...selectedHistory, limitations: [...new Set([...history.limitations, ...selectedHistory.limitations])].sort() };
    }
    if (history) history.relevantTicketId = selectedId && history.ticketIds.includes(selectedId) ? selectedId : null;
    return {
      ...(history ? { history } : {}),
      errorCode: paginationComplete ? null : "SAV_HUBSPOT_TICKETS_TRUNCATED",
      limitations: { paginationComplete, ...shortlist.limits },
      contactFound: Boolean(contact),
      contactId: contact?.id,
      ...(contactName ? { contactName } : {}),
      identityCandidates,
      tickets,
      ...(assessed ? { matching: assessed.matching } : {}),
      routing: routing.kind === "matched"
        ? { kind: routing.kind, ticketId: routing.ticket.id, reason: routing.reason, returnOperation: savTicketReturnPlan(tickets.find(ticket => ticket.id === routing.ticket.id)!, input.returnedAt ?? new Date()).operation }
        : { kind: routing.kind, reason: routing.reason, candidateIds: routing.kind === "ambiguous" ? routing.candidates.map((ticket) => ticket.id) : [] },
    };
  } catch (error) {
    // Reading the ticket pipeline must not erase a contact already found. Write
    // callers remain strict; only the read-only enrichment allows partial data.
    if (!input.toleratePartial) throw error;
    return { contactFound: Boolean(contact), contactId: contact?.id, ...(contactName ? { contactName } : {}), identityCandidates, tickets: [],
      errorCode: "SAV_HUBSPOT_TICKETS_UNAVAILABLE",
      routing: { kind: "ambiguous" as const, reason: "hubspot_context_unavailable", candidateIds: [] as string[] } };
  }
}

async function createHubspotTicket(message: typeof savMessages.$inferSelect, body: SavMessageBody, contactId: string | null, actionId: string) {
  const properties: Record<string, string> = savReleaseStage() === "v0" ? savSupportTicketProperties({ title: message.subject, description: body.text }) : {
    subject: message.subject,
    content: body.text.slice(0, 20_000),
    hs_pipeline_stage: requiredEnv("HUBSPOT_NEW_TICKET_STAGE_ID"),
  };
  if (savReleaseStage() !== "v0" && process.env.HUBSPOT_TICKET_PIPELINE_ID) properties.hs_pipeline = process.env.HUBSPOT_TICKET_PIPELINE_ID;
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
  if (savReleaseStage() === "v0") return finalizeSavV0TicketAction(action);
  if (savReleaseStage() === "v0") {
    assertSavSupportConfiguration(process.env);
    const pipeline = await hubspotFetch<{ id: string; stages: Array<{ id: string; metadata?: { isClosed?: string | boolean } }> }>(`/crm/v3/pipelines/tickets/${SAV_HUBSPOT_SUPPORT.pipelineId}`);
    assertSavSupportPipeline(pipeline);
  }
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

export async function processPendingHubspotActions(limit = 20, actionId?: string) {
  const mode = savAutomationMode();
  if (mode === "shadow" || process.env.SAV_WRITES_DISABLED === "true") return { skipped: "shadow_mode", processed: [] as Array<Record<string, unknown>> };
  const db = requireDb();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000);
  const releaseStage = savReleaseStage();
  // Filter before LIMIT: forbidden proposals must not consume the worker's
  // batch and starve explicit human commands. Use the same policy as the guard.
  const eligibleKinds = (["create_ticket", "link_ticket", "log_email", "update_ticket_status"] as const).flatMap((kind) => {
    const actors = savActorType.enumValues.filter((actor) => savModeAllowsWrite(mode, kind, actor, false, releaseStage));
    return actors.length ? [and(eq(savActions.kind, kind), inArray(savActions.actorType, actors))!] : [];
  });
  const candidates = await db.select().from(savActions)
    .where(and(
      or(...eligibleKinds) ?? sql`false`,
      isNull(savActions.pilotBatchId),
      actionId ? eq(savActions.id, actionId) : undefined,
      or(eq(savActions.status, "pending"), and(eq(savActions.status, "running"), lt(savActions.updatedAt, staleBefore))),
      or(isNull(savActions.scheduledAt), lte(savActions.scheduledAt, new Date())),
    ))
    .orderBy(desc(savActions.priority), asc(savActions.createdAt)).limit(Math.min(100, Math.max(1, limit)));
  const actions = candidates.filter((action) => savModeAllowsWrite(savAutomationMode(), action.kind, action.actorType, false, savReleaseStage()));
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
    const result = processed.at(-1)!;
    console.info("sav_hubspot_action_result", {
      actionId: claimed.id, threadId: claimed.threadId, messageId: claimed.messageId,
      decisionId: claimed.decisionId,
      reviewId: typeof claimed.payload.savReviewId === "string" && /^[a-f0-9-]{36}$/i.test(claimed.payload.savReviewId) ? claimed.payload.savReviewId : null,
      kind: claimed.kind, status: result.status,
      errorCode: "errorCode" in result && typeof result.errorCode === "string" && /^[A-Z0-9_:.-]{1,160}$/.test(result.errorCode) ? result.errorCode : null,
    });
  }
  return { processed };
}

/** Execute one human-confirmed ticket action and its email association, without
 * draining unrelated HubSpot work from the shared cron queue. */
export async function processManualSavTicketActionImmediately(actionId: string) {
  await processPendingHubspotActions(1, actionId);
  const db = requireDb();
  const [action] = await db.select().from(savActions).where(eq(savActions.id, actionId)).limit(1);
  if (!action) return { status: "failed" as const, errorCode: "SAV_ACTION_NOT_FOUND" };
  if (action.status === "failed") return { status: "failed" as const, errorCode: action.errorCode || "SAV_HUBSPOT_ACTION_FAILED" };
  return action.status === "succeeded" ? { status: "completed" as const } : { status: "pending" as const };
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

export async function loadSavHubspotTicketEmails(ticket: HubspotRecord) {
  const ids = [...new Set(ticket.associations?.emails?.results?.map(a => a.id) ?? [])];
  if (ids.length > 200) throw new Error("HUBSPOT_EMAILS_TRUNCATED");
  if (!ids.length) return [];
  const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, (i + 1) * 100));
  const batches = await Promise.all(chunks.map(async chunk => {
    const result = await hubspotFetch<{ results?: HubspotRecord[]; errors?: unknown[] }>("/crm/v3/objects/emails/batch/read", { method: "POST", body: JSON.stringify({
      properties: ["hs_email_text", "hs_email_html", "hs_email_subject", "hs_email_from_email", "hs_email_to_email", "hs_timestamp", "hs_email_direction"], inputs: chunk.map(id => ({ id })),
    }) });
    if (result.errors?.length || result.results?.length !== chunk.length || new Set(result.results.map(e => e.id)).size !== chunk.length || result.results.some(e => !chunk.includes(e.id))) throw new Error("SAV_HUBSPOT_EMAIL_BATCH_INCOMPLETE");
    return result.results;
  }));
  const byId = new Map(batches.flat().map(e => [e.id, e]));
  return ids.map(id => byId.get(id)!);
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
  if (await hasSavTicketObservation(ticket.id)) {
    await refreshSavTicketObservations(ticket.id);
    const [snapshot] = await requireDb().select().from(savTicketSnapshots).where(eq(savTicketSnapshots.hubspotTicketId,ticket.id));
    return snapshot;
  }
  const emails = await loadSavHubspotTicketEmails(ticket);
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
  const sourceTruncated = transcript.length !== emails.length || emails.some(email => hubspotEmailPlainText(String(email.properties.hs_email_text || email.properties.hs_email_html || "")).length > HUBSPOT_TICKET_EMAIL_BODY_MAX_CHARS);
  const outbound = transcript.filter((email) => isHubspotOutboundDirection(String(email.hs_email_direction || "")));
  const humanIntervened = outbound.some((email) => !isSavAiAuthoredReply(String(email.hs_email_text || email.hs_email_html || "")));
  const closed = (await closedTicketStages()).has(String(ticket.properties.hs_pipeline_stage || ""));
  const updatedAt = new Date(ticket.updatedAt || ticket.properties.hs_lastmodifieddate || Date.now());
  const db = requireDb();
  // Keep PostgreSQL microseconds for the CAS; a JavaScript Date loses that precision.
  const [previousSnapshot] = await db.select({ ...getTableColumns(savTicketSnapshots),
    revisionTimestamp: sql<string>`${savTicketSnapshots.updatedAt}::text`,
  }).from(savTicketSnapshots).where(eq(savTicketSnapshots.hubspotTicketId, ticket.id)).limit(1);
  if (previousSnapshot && updatedAt < previousSnapshot.hubspotUpdatedAt) return previousSnapshot;
  const cutover = await getSavLearningCutover();
  const createdAt = ticket.createdAt ? new Date(ticket.createdAt) : null;
  const validCreation = createdAt && Number.isFinite(createdAt.getTime()) && cutover && createdAt > new Date(cutover.activatedAt) ? createdAt : null;
  // A closing timestamp never proves when the resolution cycle began.
  const learningCycleStartedAt = !closed && previousSnapshot?.status === "closed" && updatedAt > previousSnapshot.hubspotUpdatedAt
    ? updatedAt : previousSnapshot?.learningCycleStartedAt ?? validCreation;
  const ticketContent = hubspotEmailPlainText(ticket.properties.content || "").slice(0, 10_000);
  const contentHash = savContentHash({ transcript, ticketContent });
  const [snapshot] = await db.insert(savTicketSnapshots).values({
    hubspotTicketId: ticket.id,
    pipelineId: ticket.properties.hs_pipeline,
    stageId: ticket.properties.hs_pipeline_stage,
    status: closed ? "closed" : "open",
    subject: String(ticket.properties.subject || "Sans objet"),
    transcriptCiphertext: encryptSavPayload({ transcript }),
    contentHash,
    humanIntervened,
    learningCycleStartedAt,
    resolvedAt: closed ? updatedAt : null,
    hubspotUpdatedAt: updatedAt,
    processedAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: savTicketSnapshots.hubspotTicketId,
    // Compare-and-swap prevents a read made before a concurrent refresh from overwriting it.
    setWhere: previousSnapshot ? and(eq(savTicketSnapshots.id, previousSnapshot.id), eq(savTicketSnapshots.contentHash, previousSnapshot.contentHash),
      sql`${savTicketSnapshots.updatedAt} = ${previousSnapshot.revisionTimestamp}::timestamptz`) : sql`false`,
    set: {
      pipelineId: ticket.properties.hs_pipeline,
      stageId: ticket.properties.hs_pipeline_stage,
      status: closed ? "closed" : "open",
      subject: String(ticket.properties.subject || "Sans objet"),
      transcriptCiphertext: encryptSavPayload({ transcript }),
      contentHash,
      humanIntervened,
      learningCycleStartedAt,
      resolvedAt: closed ? updatedAt : null,
      hubspotUpdatedAt: updatedAt,
      processedAt: new Date(),
      updatedAt: new Date(),
    },
  }).returning();
  if (!snapshot) {
    const [current] = await db.select().from(savTicketSnapshots).where(eq(savTicketSnapshots.hubspotTicketId, ticket.id));
    return current ?? null;
  }
  if (closed) {
    if (sourceTruncated) {
      await recordSavLearningSignal({ sourceRef: `hubspot:${ticket.id}`, sourceHash: contentHash, origin: "hubspot", reasonCode: "source_truncated" });
    } else if (!learningCycleStartedAt) {
      await recordSavLearningSignal({ sourceRef: `hubspot:${ticket.id}`, sourceHash: contentHash, origin: "hubspot",
        reasonCode: "no_new_resolution_cycle", details: { snapshotId: snapshot.id, policyRevision: "sav-learning-admission-2026-10-15.v1" } });
    } else {
      const extracted = extractSavLearningResolution(ticketContent, transcript.map((email) => ({
        id: email.id, direction: String(email.hs_email_direction || ""),
        text: hubspotEmailPlainText(email.hs_email_text || email.hs_email_html || ""),
        timestamp: email.hs_timestamp, aiAuthored: isSavAiAuthoredReply(String(email.hs_email_text || email.hs_email_html || "")),
      })));
      await processSavLearningResolution({
        ticketId: ticket.id, cycleStartedAt: learningCycleStartedAt, snapshotId: snapshot.id, snapshotHash: contentHash,
        subject: snapshot.subject, resolution: extracted.resolution, provenance: extracted.provenance,
        sourceMessageId: extracted.sourceMessageId, customerConfirmed: extracted.customerConfirmed,
        evidenceOccurredAt: transcript.find(email => email.id === extracted.sourceMessageId)?.hs_timestamp || "invalid",
      });
    }
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

async function processHubspotReceiptGroup(receiptIds: string[]) {
  const claimed = [];
  for (const id of receiptIds) { const receipt = await claimWebhookReceipt(id, "hubspot"); if (receipt) claimed.push(receipt); }
  if (!claimed.length) return [] as string[];
  try {
    const events = claimed.map(receipt => hubspotEventSchema.parse(receipt.payload));
    const event = events.sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0))[0];
    // Every raw receipt remains durable; one fresh snapshot covers this bounded
    // group for the same object. Mark each claimed event only after it succeeds.
    if (event.objectId && event.subscriptionType.startsWith("ticket.") && await hasSavTicketObservation(String(event.objectId))) {
      await refreshSavTicketObservations(String(event.objectId));
    } else if (event.objectId && event.subscriptionType.startsWith("ticket.")) {
      const ticket = await hubspotFetch<HubspotRecord>(`/crm/v3/objects/tickets/${encodeURIComponent(String(event.objectId))}?properties=subject,content,hs_pipeline,hs_pipeline_stage,hs_lastmodifieddate&associations=emails,contacts`);
      await snapshotTicket(ticket);
    }
    for (const receipt of claimed) await markWebhookReceipt(receipt.id, "processed");
    return claimed.map(r => r.id);
  } catch (error) {
    for (const receipt of claimed) await markWebhookReceipt(receipt.id, "failed", error);
    throw error;
  }
}

export async function processPendingHubspotReceipts(limit = 20) {
  const db = requireDb();
  const staleBefore = new Date(Date.now() - 15 * 60 * 1_000);
  const receipts = await db.select({ id: savWebhookReceipts.id, payload: savWebhookReceipts.payload }).from(savWebhookReceipts)
    .where(and(
      eq(savWebhookReceipts.provider, "hubspot"),
      or(
        inArray(savWebhookReceipts.status, ["pending", "failed"]),
        and(eq(savWebhookReceipts.status, "processing"), or(isNull(savWebhookReceipts.lastAttemptAt), lt(savWebhookReceipts.lastAttemptAt, staleBefore))),
      ),
      lt(savWebhookReceipts.attempts, 10),
    ))
    .orderBy(asc(savWebhookReceipts.receivedAt)).limit(Math.min(100, Math.max(1, limit)));
  const groups = new Map<string, string[]>();
  for (const receipt of receipts) {
    const event = hubspotEventSchema.safeParse(receipt.payload);
    const key = event.success && event.data.objectId && event.data.subscriptionType.startsWith("ticket.") ? `ticket:${event.data.objectId}` : receipt.id;
    groups.set(key, [...(groups.get(key) ?? []), receipt.id]);
  }
  const results = [];
  for (const ids of groups.values()) {
    try {
      for (const id of await processHubspotReceiptGroup(ids)) results.push({ id, status: "processed" });
    } catch (error) {
      for (const id of ids) results.push({ id, status: "failed", error: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
    }
  }
  return results;
}
