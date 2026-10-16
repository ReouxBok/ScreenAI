import "server-only";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { requireDb } from "@/db";
import { savAgentRuns, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import { savEvidenceContains } from "./evidence-text";
import { splitSavMessageText } from "./message-context";

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
  diagnosticChecks?: Array<{ id: string; versionId: string; instruction: string; expectedResult: string; messageId: string }>;
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
    lte(savMessages.receivedAt, current.receivedAt), lte(savMessages.createdAt, current.createdAt),
  )).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(33);
  let remaining = 15_000;
  const messages = rows.slice(0, 12).map((row) => {
    const body = decryptSavPayload<{ text: string }>(row.bodyCiphertext);
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
  const diagnosticChecks: NonNullable<SavConversation["diagnosticChecks"]> = [];
  for (const run of runs) {
    if (!run.proposalCiphertext) continue;
    const parsed = savStructuredProposalSchema.safeParse(decryptSavPayload(run.proposalCiphertext));
    if (!parsed.success) continue;
    for (const plan of parsed.data.replyAssessment?.harness?.plans ?? []) {
      const check = plan.nextCheck;
      const sent = check ? messages.find(message => message.direction === "outbound" && savEvidenceContains(message.text, check.instruction)) : null;
      if (check && plan.card && sent && !diagnosticChecks.some(saved => saved.id === check.id && saved.versionId === plan.card!.versionId))
        diagnosticChecks.push({ id: check.id, versionId: plan.card.versionId, instruction: check.instruction, expectedResult: check.expectedResult, messageId: sent.id });
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
