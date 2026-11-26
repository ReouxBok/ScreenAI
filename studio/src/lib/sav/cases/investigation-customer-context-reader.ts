import "server-only";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savIntakeExecutions, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import type { CaseEvent, CaseSnapshot } from "./case-types";
import {
  buildCaseCustomerContext, caseCustomerContextUnavailable, SAV_CASE_CUSTOMER_CONTEXT_LIMITS,
  type CaseCustomerContext, type CaseCustomerContextMissing, type CaseCustomerRawCrm, type CaseCustomerRawMessage,
} from "./investigation-customer-context";
import { withCaseCustomerAttachments } from "./investigation-customer-attachments";
import {
  caseAttachmentMediaMode, caseStoredAttachmentMetadata, readCaseCustomerAttachments,
  type CaseAttachmentDownload, type CaseStoredMail, type CaseStoredMailBody,
} from "./investigation-customer-attachments-reader";
import { grantSmartCaseAttachments, smartCaseWantsAttachments } from "./smart/smart-attachments";

/*
 * SAV-92: the runner's `customerContext` port, READ ONLY, from what V1 already stored. No HubSpot, Gmail or model call:
 * - the case's mails (`sav.messages`, bodies decrypted), the latest customer mail of the input and a few before it;
 * - V1's CRM snapshot of the case's contact (`intake_executions.payload.baseline`: tickets and their histories, as V1 read
 *   them before acting on a mail of this case), only for the contact V1 identified and only when that execution names
 *   this case's ticket (or created it).
 * Bounded reads (a handful of rows), any failure degrades: the case goes on with what could be read and `missing` says the rest.
 */

const MESSAGE_ROWS = 1 + SAV_CASE_CUSTOMER_CONTEXT_LIMITS.threadMessages + 4;
/** How many of the case's latest customer mails are tried for V1's CRM snapshot (newest first). */
const CRM_SOURCES = 4;

const ticketSchema = z.object({ id: z.string().min(1).max(40), stage: z.enum(["new", "open", "closed", "unknown"]), createdAt: z.string().optional(),
  closedAt: z.string().optional(), subject: z.string() }).passthrough();
const historySchema = z.array(z.object({ id: z.string(), kind: z.enum(["note", "email", "stage"]), text: z.string(), at: z.string() }).passthrough());
const payloadSchema = z.object({
  plan: z.object({ decision: z.object({ disposition: z.object({ kind: z.string(), contactScope: z.object({ primaryContactId: z.string() }).passthrough().optional() }).passthrough() }).passthrough() }).passthrough(),
  baseline: z.object({ tickets: z.record(z.string(), z.array(z.unknown())), histories: z.record(z.string(), z.unknown()) }).passthrough().optional(),
}).passthrough();

function decryptBody(ciphertext: string): CaseStoredMailBody | null {
  try { const body = decryptSavPayload<CaseStoredMailBody>(ciphertext); return body && typeof body === "object" ? body : null; } catch { return null; }
}
const textOf = (body: CaseStoredMailBody | null) => typeof body?.text === "string" ? body.text : null;

/** The stored mailbox and Gmail thread of a mail: what V1's download path re-validates each reference against. */
async function attachmentOwner(mail: CaseStoredMail & { threadId: string }) {
  const [row] = await requireDb().select({ email: savMailboxes.email, gmailThreadId: savThreads.gmailThreadId }).from(savThreads)
    .innerJoin(savMailboxes, eq(savMailboxes.id, savThreads.mailboxId)).where(eq(savThreads.id, mail.threadId)).limit(1);
  return row && mail.gmailMessageId ? { mailboxEmail: row.email, gmailMessageId: mail.gmailMessageId, gmailThreadId: row.gmailThreadId } : null;
}

/** V1's stored CRM snapshot for this case's contact, or the reason why none is usable. */
async function readV1CrmSnapshot(snapshot: CaseSnapshot, gmailIds: readonly string[]): Promise<CaseCustomerRawCrm> {
  const db = requireDb();
  let reason: Extract<CaseCustomerRawCrm, { status: "missing" }>["reason"] = "crm_not_recorded";
  for (const gmailId of gmailIds.slice(0, CRM_SOURCES)) {
    const [message] = await db.select({ id: savMessages.id }).from(savMessages)
      .where(and(eq(savMessages.direction, "inbound"), eq(savMessages.gmailMessageId, gmailId), inArray(savMessages.threadId, snapshot.threadIds))).limit(1);
    if (!message) continue;
    const [execution] = await db.select({ ticketId: savIntakeExecutions.ticketId, payload: savIntakeExecutions.payloadCiphertext, createdAt: savIntakeExecutions.createdAt })
      .from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, message.id)).limit(1);
    if (!execution) continue;
    // V1 handled this mail for another ticket: its contact and history are not this case's.
    if (execution.ticketId && execution.ticketId !== snapshot.ticketId) { reason = "crm_ticket_mismatch"; continue; }
    let payload: z.infer<typeof payloadSchema>;
    try { payload = payloadSchema.parse(decryptSavPayload(execution.payload)); } catch { reason = "crm_unavailable"; continue; }
    const disposition = payload.plan.decision.disposition, contactId = disposition.kind === "ticket" ? disposition.contactScope?.primaryContactId : undefined;
    if (!payload.baseline || !contactId) continue;
    // Only the contact V1 identified from the sender: never the tickets of an associated contact (another person).
    const tickets = z.array(ticketSchema).safeParse(payload.baseline.tickets[contactId] ?? []);
    if (!tickets.success) { reason = "crm_unavailable"; continue; }
    const histories: Record<string, z.infer<typeof historySchema>> = {};
    for (const ticket of tickets.data) {
      const history = historySchema.safeParse(payload.baseline.histories[ticket.id] ?? []);
      if (history.success) histories[ticket.id] = history.data;
    }
    return { status: "read", observedAt: execution.createdAt.toISOString(), caseTicketId: snapshot.ticketId,
      tickets: tickets.data.map(ticket => ({ id: ticket.id, stage: ticket.stage, subject: ticket.subject,
        ...(ticket.createdAt ? { createdAt: ticket.createdAt } : {}), ...(ticket.closedAt ? { closedAt: ticket.closedAt } : {}) })), histories };
  }
  return { status: "missing", reason };
}

/** The `customerContext` port: never throws; a failed read is a context that says it could not be read. */
export function caseCustomerContextReader(options: Readonly<{ env?: () => Readonly<Record<string, string | undefined>>; download?: CaseAttachmentDownload }> = {}) {
  return async (snapshot: CaseSnapshot, events: readonly CaseEvent[]): Promise<CaseCustomerContext> => {
    try {
      const inbound = events.filter(event => event.direction === "customer_inbound" && event.sourceRef.type === "email")
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.caseVersion - a.caseVersion);
      if (!snapshot.threadIds.length) return buildCaseCustomerContext({ latestMessageId: null, messages: [], crm: { status: "missing", reason: "crm_unavailable" } });
      const db = requireDb(), missing: CaseCustomerContextMissing[] = [];
      const columns = { id: savMessages.id, direction: savMessages.direction, at: savMessages.receivedAt, subject: savMessages.subject, body: savMessages.bodyCiphertext,
        gmailMessageId: savMessages.gmailMessageId, threadId: savMessages.threadId };
      const latestGmail = inbound[0]?.sourceRef.id;
      const [latest] = latestGmail ? await db.select(columns).from(savMessages)
        .where(and(eq(savMessages.direction, "inbound"), eq(savMessages.gmailMessageId, latestGmail), inArray(savMessages.threadId, snapshot.threadIds))).limit(1) : [];
      // The latest customer mail of this input and the few before it; never a later mail (it belongs to a later input).
      const rows = await db.select(columns).from(savMessages)
        .where(and(inArray(savMessages.threadId, snapshot.threadIds), ...(latest ? [lte(savMessages.receivedAt, latest.at)] : [])))
        .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt)).limit(MESSAGE_ROWS);
      const bodies = new Map(rows.map(row => [row.id, decryptBody(row.body)]));
      const messages: CaseCustomerRawMessage[] = rows.map(row => ({ id: row.id, direction: row.direction, at: row.at.toISOString(), subject: row.subject, text: textOf(bodies.get(row.id) ?? null) }));
      let crm: CaseCustomerRawCrm;
      try { crm = await readV1CrmSnapshot(snapshot, inbound.map(event => event.sourceRef.id)); } catch { crm = { status: "missing", reason: "crm_unavailable" }; }
      const context = buildCaseCustomerContext({ latestMessageId: latest?.id ?? null, messages, crm, missing });
      // SAV-92 review P2-2 (Ugo 14/11): the whole attachments feature (file view, evidence, its instruction with the "screenshot or link" rule) rides on
      // SAV_V2_ATTACHMENT_MEDIA. Off (the default, any unknown value): the context and the prompt stay exactly the v4 ones.
      const env = options.env?.() ?? {}, mode = caseAttachmentMediaMode(env);
      // Smart images (`SAV_V2_SMART_ATTACHMENT_IMAGES=on`, smart cases only): the same read, images at least, and the context granted to the brain.
      const smart = smartCaseWantsAttachments(env, snapshot);
      if (mode === "off" && !smart) return context;
      const granted = (next: CaseCustomerContext, read: boolean) => smart ? grantSmartCaseAttachments(next, read) : next;
      // SAV-92 (15/11): the files of the latest customer mail and the previous one. A failure here keeps the context without them.
      try {
        const inboundRows = rows.filter(row => row.direction === "inbound" && (!latest || row.at.getTime() <= latest.at.getTime()));
        const ordered = latest ? [latest.id, ...inboundRows.filter(row => row.id !== latest.id).map(row => row.id)] : inboundRows.map(row => row.id);
        const byId = new Map([...(latest ? [latest] : []), ...rows].map(row => [row.id, row]));
        if (latest && !bodies.has(latest.id)) bodies.set(latest.id, decryptBody(latest.body));
        const mails = ordered.slice(0, 2).flatMap((id, index) => {
          const row = byId.get(id);
          return row ? [{ id, role: index === 0 ? "latest" as const : "previous" as const, gmailMessageId: row.gmailMessageId, threadId: row.threadId, body: bodies.get(id) ?? null }] : [];
        });
        const earlier = ordered.slice(2).some(id => caseStoredAttachmentMetadata(bodies.get(id)).some(item => /^image\//i.test(item.mimeType)))
          || snapshot.body.facts.some(fact => fact.source.type === "attachment");
        const built = await readCaseCustomerAttachments(mails, { mode: mode === "off" ? "images" : mode,
          owner: mail => attachmentOwner(mail as CaseStoredMail & { threadId: string }), ...(options.download ? { download: options.download } : {}) });
        return granted(withCaseCustomerAttachments(context, built, earlier), true);
      } catch {
        return granted(withCaseCustomerAttachments(context, null), false);
      }
    } catch {
      return caseCustomerContextUnavailable();
    }
  };
}
