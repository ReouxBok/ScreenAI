import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savMessages, savThreads } from "@/db/schema";
import { assertSavActor } from "./access";
import { savReleaseStage } from "./config";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import type { SavDossierContext } from "./dossier-context";
import { loadSavDraftContext } from "./draft-verdicts";
import { readSavHubspotContext } from "./hubspot";
import { isSavMessageEligible } from "./cutover";
import { resolveSavCustomerMessage, resolveSavCustomerIdentity } from "./forwarded-identity";
import { SAV_HUBSPOT_SUPPORT, savSupportTicketProperties } from "./hubspot-mapping";
import type { SavStructuredProposal } from "./proposal";
import { savTicketActionPresentation } from "./ticket-action-presentation";
import { savTicketReturnPlan } from "./ticket-lifecycle";
import { savTicketReturnNote } from "./ticket-return-note";

const selectionSchema = z.object({ threadId: z.uuid(), reviewId: z.uuid(), ticketId: z.string().regex(/^\d{1,30}$/).optional(), distinctIssueReason: z.string().trim().max(2000).default("") });
const commandSchema = selectionSchema.extend({ kind: z.enum(["create_ticket", "link_ticket"]), returnOperation: z.enum(["keep", "reactivate", "create"]).optional() });
const tokenSchema = z.object({ purpose: z.literal("sav_ticket_preview_v1"), actorEmail: z.string(), expiresAt: z.number(), hash: z.string(), command: commandSchema });
type PreviewContext = { threadId: string; linkedTicketId: string | null; messageId: string; receivedAt: Date; fromEmail: string; subject: string; text: string; reviewId: string; proposal: SavStructuredProposal; context?: SavDossierContext };

/** Stable material fields only: a refresh timestamp or model timing cannot stale an otherwise identical preview. */
export function buildSavTicketPreview(input: z.infer<typeof selectionSchema>, data: PreviewContext) {
  const crm = data.context?.crm;
  const identity = resolveSavCustomerIdentity({ fromEmail: data.fromEmail, body: data.text });
  if (data.threadId !== input.threadId || data.reviewId !== input.reviewId || data.context?.messageId !== data.messageId
    || crm?.status !== "ready" || !crm.data?.contactId || !identity.email || data.context.customerIdentity.email !== identity.email) throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
  if (!["ticket_pending", "human_review_required"].includes(data.proposal.decision.kind)) throw new Error("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");
  const target = input.ticketId ? crm.data.tickets.find(ticket => ticket.id === input.ticketId) : null;
  if (input.ticketId && (!target || target.pipelineId !== SAV_HUBSPOT_SUPPORT.pipelineId || crm.data.routing.kind !== "matched" || crm.data.routing.ticketId !== target.id)) throw new Error("SAV_TICKET_SELECTION_UNVERIFIED");
  if (!target && (crm.data.routing.kind !== "new" || data.linkedTicketId)) throw new Error("SAV_EXISTING_TICKET_REQUIRES_LINK");
  if (!target && crm.data.tickets.some(ticket => ticket.status === "open") && input.distinctIssueReason.length < 20) throw new Error("SAV_DISTINCT_ISSUE_CONFIRMATION_REQUIRED");
  const operation = target ? savTicketReturnPlan(target, data.receivedAt).operation : "create";
  if (operation === "review") throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
  if (target && operation !== "keep" && !target.ownerId) throw new Error("SAV_TICKET_OWNER_REQUIRED");
  const command = { ...input, kind: operation === "create" ? "create_ticket" as const : "link_ticket" as const, ...(target ? { returnOperation: operation } : {}) };
  const creation = operation === "create" ? savSupportTicketProperties(data.proposal.ticket) : null;
  const presentation = target ? savTicketActionPresentation(target, operation, creation?.subject) : { label: "Ouvrir un nouveau ticket", title: creation!.subject, explanation: "Créer un ticket dans le pipeline SAV pour cette demande validée." };
  const note = target && operation === "reactivate" ? savTicketReturnNote(target.status) : null;
  const details = { label: presentation.label, title: presentation.title, explanation: presentation.explanation, targetId: target?.id ?? null,
    targetTitle: target?.subject ?? null, targetStatus: target?.status ?? null, stageId: target?.stageId ?? null, ownerId: target?.ownerId ?? null,
    createdAt: target?.createdAt ?? null, contactId: crm.data.contactId, note, description: creation?.content ?? null };
  const hash = savContentHash({ command, details, messageId: data.messageId, text: data.text, subject: data.subject, receivedAt: data.receivedAt,
    linkedTicketId: data.linkedTicketId, reviewId: data.reviewId, proposal: data.proposal, target: target ? { id: target.id, subject: target.subject, status: target.status, stageId: target.stageId, closedAt: target.closedAt, ownerId: target.ownerId, pipelineId: target.pipelineId } : null });
  return { command, details, hash };
}

export type SavTicketPreview = { token: string; expiresAt: number; details: ReturnType<typeof buildSavTicketPreview>["details"] };
export function readSavTicketPreviewToken(token: string, actorEmail: string) {
  try {
    const value = tokenSchema.parse(decryptSavPayload(token));
    if (value.actorEmail !== actorEmail.toLowerCase() || value.expiresAt < Date.now()) throw new Error();
    return value;
  } catch { throw new Error("SAV_TICKET_PREVIEW_EXPIRED"); }
}
export function assertSavTicketPreview(token: string, actorEmail: string, input: z.infer<typeof commandSchema>, data: PreviewContext) {
  const signed = readSavTicketPreviewToken(token, actorEmail);
  const current = buildSavTicketPreview(selectionSchema.parse(input), data);
  if (signed.hash !== current.hash || JSON.stringify(signed.command) !== JSON.stringify(commandSchema.parse(input))) throw new Error("SAV_TICKET_PREVIEW_CHANGED");
  return current;
}
/** Fresh reads used by the preview never overwrite the source whose dossier
 * review was approved (provider timing metadata is not a new human decision). */
export async function readSavManualTicketPreviewContext(threadId: string): Promise<SavDossierContext> {
  const db = requireDb();
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId));
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  if (!thread || !message) throw new Error("SAV_THREAD_NOT_FOUND");
  if (!await isSavMessageEligible(message.id)) throw new Error("SAV_MESSAGE_BEFORE_CUTOVER");
  const body = decryptSavPayload<{ text: string }>(message.bodyCiphertext);
  const customer = resolveSavCustomerMessage({ fromEmail: message.fromEmail, subject: message.subject, body: body.text });
  const customerIdentity = resolveSavCustomerIdentity({ fromEmail: message.fromEmail, body: body.text });
  if (!customer.email) throw new Error("SAV_FORWARDED_CUSTOMER_UNRESOLVED");
  const crm = await readSavHubspotContext({ email: customer.email, subject: customer.subject, body: customer.body, returnedAt: message.receivedAt,
    currentTicketId: customer.kind === "sender" && thread.customerEmail.toLowerCase() === customer.email.toLowerCase() ? thread.hubspotTicketId : undefined });
  return { version: 1, messageId: message.id, collectedAt: new Date().toISOString(), customerIdentity,
    crm: { status: crm.errorCode ? "partial" : "ready", errorCode: crm.errorCode, data: crm }, conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
}
export async function prepareSavManualTicketPreview(raw: unknown, actorEmail: string): Promise<SavTicketPreview> {
  assertSavActor(actorEmail);
  if (savReleaseStage() !== "v0") throw new Error("SAV_MANUAL_TICKET_INVALID");
  const input = selectionSchema.parse(raw), db = requireDb();
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, input.threadId));
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, input.threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  if (!thread || !message) throw new Error("SAV_THREAD_NOT_FOUND");
  const c = await loadSavDraftContext(message.id);
  if (c.review?.id !== input.reviewId || c.review.status !== "approved" || c.review.reviewScope !== "dossier") throw new Error("SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED");
  const body = decryptSavPayload<{ text: string; supportContext?: SavDossierContext }>(message.bodyCiphertext);
  const preview = buildSavTicketPreview(input, { threadId: thread.id, linkedTicketId: thread.hubspotTicketId, messageId: message.id, receivedAt: message.receivedAt,
    fromEmail: message.fromEmail, subject: message.subject, text: body.text, reviewId: c.review.id, proposal: c.proposal, context: await readSavManualTicketPreviewContext(thread.id) });
  const expiresAt = Date.now() + 15 * 60 * 1000;
  return { details: preview.details, expiresAt, token: encryptSavPayload({ purpose: "sav_ticket_preview_v1", actorEmail: actorEmail.toLowerCase(), expiresAt, hash: preview.hash, command: preview.command }) };
}
