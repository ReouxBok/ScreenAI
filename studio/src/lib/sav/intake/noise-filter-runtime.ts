import "server-only";
import { and, eq, isNotNull, lt, ne, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages, savThreads } from "@/db/schema";
import { normalizeEmailAddress } from "../policy";
import { intakeQuotedMailboxReply } from "./other-routing-runtime";
import type { IntakeLease } from "./runtime-store";
import { SAV_INTAKE_NOISE_FILTER_REVISION, savIntakeNoiseVerdict, type SavIntakeNoiseSenderHistory, type SavIntakeNoiseVerdict } from "./noise-filter";

type Db = Pick<ReturnType<typeof requireDb>, "select">;

/** SAV-92: local, read-only history of a sender in the mailbox. No HubSpot call: a thread linked to a
 * ticket is the local proxy for a known contact. Addresses are compared case-insensitively. `before` (offline
 * replay only) limits messages to those received earlier; the runtime counts every other message, which is stricter. */
export async function readIntakeNoiseSenderHistory(db: Db, input: { mailboxId: string; messageId: string; address: string; before?: Date }): Promise<SavIntakeNoiseSenderHistory> {
  const address = normalizeEmailAddress(input.address);
  if (!address) throw Error("SAV_NOISE_SENDER_INVALID");
  const earlier = input.before ? lt(savMessages.receivedAt, input.before) : undefined;
  const [inbound] = await db.select({ n: sql<number>`count(*)::int` }).from(savMessages).where(and(eq(savMessages.mailboxId, input.mailboxId),
    eq(savMessages.direction, "inbound"), ne(savMessages.id, input.messageId), earlier, sql`lower(${savMessages.fromEmail}) = ${address}`));
  const [outbound] = await db.select({ n: sql<number>`count(*)::int` }).from(savMessages).where(and(eq(savMessages.mailboxId, input.mailboxId),
    eq(savMessages.direction, "outbound"), earlier, sql`exists (select 1 from unnest(${savMessages.toEmails}) as recipient where lower(recipient) = ${address})`));
  const [tickets] = await db.select({ n: sql<number>`count(*)::int` }).from(savThreads).where(and(eq(savThreads.mailboxId, input.mailboxId),
    isNotNull(savThreads.hubspotTicketId), sql`lower(${savThreads.customerEmail}) = ${address}`));
  return { priorInbound: Number(inbound?.n ?? NaN), outboundTo: Number(outbound?.n ?? NaN), ticketThreads: Number(tickets?.n ?? NaN) };
}

/** The verdict for one claimed lease. Any read failure keeps the mail (closed guard code), never throws. */
export async function evaluateIntakeNoise(lease: IntakeLease, mailboxId: string, deps: { db?: Db; quotedMailboxReply?: typeof intakeQuotedMailboxReply } = {}): Promise<SavIntakeNoiseVerdict> {
  const message = lease.input.message;
  const base = {
    messageId: message.id, direction: message.direction, fromEmail: message.fromEmail,
    subject: lease.provenance.get(lease.run.messageId)?.subject ?? "", bodyText: lease.body.text ?? "", headers: lease.body.headers,
    attachmentCount: (lease.body.attachments?.length ?? 0) + (message.attachmentInputs?.length ?? 0) + (message.unreadAttachments?.length ?? 0),
  };
  try {
    const db = deps.db ?? requireDb();
    const [thread] = await db.select({ aiPaused: savThreads.aiPaused, humanRequestedAt: savThreads.humanRequestedAt, ticketId: savThreads.hubspotTicketId })
      .from(savThreads).where(eq(savThreads.id, lease.run.threadId));
    if (!thread) throw Error("SAV_NOISE_THREAD_MISSING");
    const quotedMailboxReply = await (deps.quotedMailboxReply ?? intakeQuotedMailboxReply)(lease, mailboxId);
    const context = {
      // A partial history counts as history: it may hide a support exchange.
      conversationLength: lease.input.conversation.status === "complete" ? lease.input.conversation.data.length : Number.POSITIVE_INFINITY,
      threadTicketId: lease.threadTicketId ?? thread.ticketId ?? null,
      humanContext: Boolean(message.operatorInformation || lease.input.humanResolution || lease.input.priorRequestReview
        || lease.run.humanChoiceCiphertext || thread.aiPaused || thread.humanRequestedAt),
      quotedMailboxReply,
    };
    const first = savIntakeNoiseVerdict({ ...base, context });
    if (!first.needsSenderHistory) return first;
    let senderHistory: SavIntakeNoiseSenderHistory | null;
    try { senderHistory = await readIntakeNoiseSenderHistory(db, { mailboxId, messageId: message.id, address: message.fromEmail }); }
    catch { senderHistory = null; }
    return savIntakeNoiseVerdict({ ...base, context, senderHistory });
  } catch {
    return { revision: SAV_INTAKE_NOISE_FILTER_REVISION, verdict: "keep", reason: null, signals: [], guard: "SAV_NOISE_GUARD_EVIDENCE_UNAVAILABLE" };
  }
}
