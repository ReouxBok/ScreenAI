import "server-only";
import { and, desc, eq, inArray, lte, sql, isNull } from "drizzle-orm";
import { requireDb } from "@/db";
import { savActions, savAgentRuns, savMessages, savThreads, savReplyDrafts } from "@/db/schema";
import { decryptSavPayload, savContentHash } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import { savEvidenceContains } from "./evidence-text";
import { splitSavMessageText } from "./message-context";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";

export type SavConversation = {
  threadId: string;
  currentMessageId: string;
  hubspotTicketId: string | null;
  status: string;
  aiPaused: boolean;
  senderMatchesCustomer: boolean;
  messages: Array<{ id: string; direction: string; from: string; receivedAt: string; text: string; truncated: boolean }>;
  olderSummary: Array<{ messageId: string; direction: string; receivedAt: string; excerpt: string }>;
  historyTruncated: boolean;
  attachmentNotice: string;
  diagnosticChecks?: Array<{ cardId?: string; id: string; versionId: string; instruction: string; expectedResult: string; messageId: string }>;
};

/** Preserve the original in storage. This only removes obvious quoted history from model context. */
export function currentMessageText(text: string) {
  return splitSavMessageText(text).currentText;
}

export async function loadSavConversation(messageId: string): Promise<SavConversation> {
  const db = requireDb();
  const [current] = await db.select().from(savMessages).where(eq(savMessages.id, messageId)).limit(1);
  if (!current) throw new Error("SAV_CONTEXT_MESSAGE_MISSING");
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, current.threadId)).limit(1);
  if (!thread) throw new Error("SAV_CONTEXT_THREAD_MISSING");
  const rows = await db.select().from(savMessages).where(and(
    eq(savMessages.threadId, thread.id), eq(savMessages.mailboxId, current.mailboxId),
    // Compare timestamps inside PostgreSQL: JS Date truncates microseconds and
    // could exclude the current message (or a tied historical message).
    lte(savMessages.receivedAt, sql`(select anchor.received_at from sav.messages anchor where anchor.id = ${current.id}::uuid)`),
    lte(savMessages.createdAt, sql`(select anchor.created_at from sav.messages anchor where anchor.id = ${current.id}::uuid)`),
  )).orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(33);
  const outboundProofs = new Map<string, { hash: string; messageId: string | null }>();
  let remaining = 15_000;
  const messages = rows.slice(0, 12).map((row) => {
    const body = decryptSavPayload<{ text: string; headers?: Record<string, string> }>(row.bodyCiphertext);
    if (row.direction === "outbound") outboundProofs.set(row.id, { hash: savContentHash(body.text), messageId: body.headers?.["message-id"] ?? null });
    const clean = currentMessageText(body.text);
    const text = clean.slice(0, Math.min(4_000, remaining));
    remaining -= text.length;
    return { id: row.id, direction: row.direction, from: row.fromEmail, receivedAt: row.receivedAt.toISOString(), text, truncated: text.length < clean.length };
  }).reverse();
  let summaryRemaining = 3_000;
  const olderSummary = rows.slice(12, 32).map((row) => {
    const body = decryptSavPayload<{ text: string }>(row.bodyCiphertext);
    const excerpt = currentMessageText(body.text).replace(/\s+/g, " ").slice(0, Math.min(300, summaryRemaining));
    summaryRemaining -= excerpt.length;
    return { messageId: row.id, direction: row.direction, receivedAt: row.receivedAt.toISOString(), excerpt };
  }).filter((item) => item.excerpt).reverse();
  const previousInbound = rows.filter(row => row.id !== current.id && row.direction === "inbound").map(row => row.id);
  const runs = previousInbound.length ? await db.select().from(savAgentRuns).where(inArray(savAgentRuns.messageId, previousInbound)).orderBy(desc(savAgentRuns.createdAt)).limit(12) : [];
  // Only a completed Studio send tied to its actual draft can prove which version was sent.
  // A matching phrase in an unrelated/older outbound remains history, not a version reference.
  const sends = runs.length ? await db.select({ action: savActions, draft: savReplyDrafts }).from(savActions)
    .innerJoin(savReplyDrafts, sql`${savReplyDrafts.id}::text = ${savActions.payload}->>'studioDraftId'`)
    .where(and(eq(savActions.threadId, thread.id), eq(savReplyDrafts.threadId, thread.id),
      eq(savReplyDrafts.messageId, savActions.messageId), inArray(savReplyDrafts.agentRunId, runs.map(run => run.id)),
      eq(savActions.kind, "send_reply"), eq(savActions.status, "succeeded"), eq(savActions.actorType, "human"),
      isNull(savActions.pilotBatchId), sql`${savActions.payload}->>'manualReplyConfirmed' = 'true'`))
    .orderBy(desc(savActions.executedAt)).limit(33) : [];
  const diagnosticChecks: NonNullable<SavConversation["diagnosticChecks"]> = [];
  for (const run of runs) {
    if (!run.proposalCiphertext) continue;
    const parsed = savStructuredProposalSchema.safeParse(decryptSavPayload(run.proposalCiphertext));
    if (!parsed.success) continue;
    for (const plan of parsed.data.replyAssessment?.harness?.plans ?? []) {
      const check = plan.nextCheck;
      const sent = check ? messages.find(message => message.direction === "outbound"
        && Date.parse(message.receivedAt) >= run.createdAt.getTime()
        && savEvidenceContains(message.text, check.instruction)
        && sends.some(({ action, draft }) => draft.agentRunId === run.id
          && action.executedAt && action.executedAt <= current.receivedAt
          && action.payload.outboundBodyHash === outboundProofs.get(message.id)?.hash
          && outboundProofs.get(message.id)?.messageId === `<sav-${action.id}@studio.limova.ai>`)) : null;
      if (check && plan.card && sent && !diagnosticChecks.some(saved => saved.id === check.id && saved.versionId === plan.card!.versionId))
        diagnosticChecks.push({ cardId: plan.card.id, id: check.id, versionId: plan.card.versionId, instruction: check.instruction, expectedResult: check.expectedResult, messageId: sent.id });
    }
  }
  return {
    ...(diagnosticChecks.length ? { diagnosticChecks: diagnosticChecks.slice(0, 15) } : {}),
    threadId: thread.id, currentMessageId: current.id, hubspotTicketId: thread.hubspotTicketId,
    status: thread.status, aiPaused: thread.aiPaused,
    senderMatchesCustomer: current.fromEmail.toLowerCase() === thread.customerEmail.toLowerCase(),
    messages, olderSummary, historyTruncated: rows.length > 32 || olderSummary.length > 0 || messages.some((message) => message.truncated),
    attachmentNotice: "Les pièces jointes ne sont pas analysées. Ne prétends pas avoir consulté une capture ou un document joint ; demande les détails nécessaires si leur contenu est indispensable.",
  };
}
