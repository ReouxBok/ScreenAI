import "server-only";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savIntakeExecutions, savMessages } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import type { CaseEvent, CaseSnapshot } from "./case-types";
import {
  buildCaseCustomerContext, caseCustomerContextUnavailable, SAV_CASE_CUSTOMER_CONTEXT_LIMITS,
  type CaseCustomerContext, type CaseCustomerContextMissing, type CaseCustomerRawCrm, type CaseCustomerRawMessage,
} from "./investigation-customer-context";

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

function decryptText(ciphertext: string): string | null {
  try { const body = decryptSavPayload<{ text?: unknown }>(ciphertext); return typeof body.text === "string" ? body.text : null; } catch { return null; }
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
export function caseCustomerContextReader() {
  return async (snapshot: CaseSnapshot, events: readonly CaseEvent[]): Promise<CaseCustomerContext> => {
    try {
      const inbound = events.filter(event => event.direction === "customer_inbound" && event.sourceRef.type === "email")
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.caseVersion - a.caseVersion);
      if (!snapshot.threadIds.length) return buildCaseCustomerContext({ latestMessageId: null, messages: [], crm: { status: "missing", reason: "crm_unavailable" } });
      const db = requireDb(), missing: CaseCustomerContextMissing[] = [];
      const columns = { id: savMessages.id, direction: savMessages.direction, at: savMessages.receivedAt, subject: savMessages.subject, body: savMessages.bodyCiphertext };
      const latestGmail = inbound[0]?.sourceRef.id;
      const [latest] = latestGmail ? await db.select(columns).from(savMessages)
        .where(and(eq(savMessages.direction, "inbound"), eq(savMessages.gmailMessageId, latestGmail), inArray(savMessages.threadId, snapshot.threadIds))).limit(1) : [];
      // The latest customer mail of this input and the few before it; never a later mail (it belongs to a later input).
      const rows = await db.select(columns).from(savMessages)
        .where(and(inArray(savMessages.threadId, snapshot.threadIds), ...(latest ? [lte(savMessages.receivedAt, latest.at)] : [])))
        .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt)).limit(MESSAGE_ROWS);
      const messages: CaseCustomerRawMessage[] = rows.map(row => ({ id: row.id, direction: row.direction, at: row.at.toISOString(), subject: row.subject, text: decryptText(row.body) }));
      let crm: CaseCustomerRawCrm;
      try { crm = await readV1CrmSnapshot(snapshot, inbound.map(event => event.sourceRef.id)); } catch { crm = { status: "missing", reason: "crm_unavailable" }; }
      return buildCaseCustomerContext({ latestMessageId: latest?.id ?? null, messages, crm, missing });
    } catch {
      return caseCustomerContextUnavailable();
    }
  };
}
