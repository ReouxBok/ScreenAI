import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMailboxes, savMessages, savProposalReviews, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "./crypto";
import { isSavMessageEligible } from "./cutover";
import { savGeminiApiKey } from "./config";
import { attachmentSkeleton, readSavAttachmentSelection } from "./attachment-reader";
import { savAttachmentMetadataSchema, savAttachmentReadSchema, savAttachmentClaimReason, SAV_ATTACHMENT_READER_REVISION, type SavAttachmentRead } from "./attachment-contract";

type Body = { text?: string; html?: string; attachments?: unknown[]; attachmentRead?: unknown; [key: string]: unknown };
const selectionHash = (body: Body) => savContentHash({ text: body.text, html: body.html, attachments: body.attachments, attachmentInventory: body.attachmentInventory });
const metadata = (body: Body) => (body.attachments ?? []).slice(0, 100).flatMap(a => { const parsed = savAttachmentMetadataSchema.safeParse(a); return parsed.success ? [parsed.data] : []; });
const saved = (body: Body) => { const result = savAttachmentReadSchema.safeParse(body.attachmentRead); return result.success ? result.data : null; };
function unavailable(read: SavAttachmentRead, reason: "in_progress" | "outcome_uncertain" | "context_changed"): SavAttachmentRead {
  return { ...read, observations: read.observations.map(o => ({ ...o, status: "not_read", reason, text: "", regions: [] })) };
}
type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
async function lockSource(tx: Tx, messageId: string) {
  const [anchor] = await tx.select({ threadId: savMessages.threadId }).from(savMessages).where(eq(savMessages.id, messageId));
  if (!anchor) return null;
  // Same thread → message lock order as human reviews; an inbound ingestion must
  // commit its thread update before it can become a concurrent current source.
  await tx.select({ id: savThreads.id }).from(savThreads).where(eq(savThreads.id, anchor.threadId)).for("update");
  const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, messageId)).for("update");
  return message?.threadId === anchor.threadId ? message : null;
}
async function isLatest(tx: Tx, message: typeof savMessages.$inferSelect) {
  const [latest] = await tx.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, message.threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  return latest?.id === message.id;
}

/** Called only from an explicit analysis. Reads of a dossier never start work.
 * A persisted claim is never blindly retried after uncertain provider dispatch. */
export async function acquireSavAttachmentRead(messageId: string, options: { fetch?: typeof fetch; apiKey?: string } = {}): Promise<SavAttachmentRead | null> {
  const db = requireDb(), model = process.env.SAV_AI_MODEL ?? "gemini-3.6-flash";
  const claim = await db.transaction(async tx => {
    const message = await lockSource(tx, messageId);
    if (!message || message.direction !== "inbound") return null;
    const body = decryptSavPayload<Body>(message.bodyCiphertext), items = metadata(body), prior = saved(body);
    if (!items.length) return null;
    const hash = selectionHash(body);
    if (prior?.messageId === message.id && prior.mailboxId === message.mailboxId && prior.gmailMessageId === message.gmailMessageId) {
      if (prior.state === "reading") return { cached: unavailable(prior, savAttachmentClaimReason(prior.startedAt)) };
      if (prior.selectionHash === hash && prior.readerRevision === SAV_ATTACHMENT_READER_REVISION && prior.model === model) return { cached: prior };
    }
    const [mailbox] = await tx.select().from(savMailboxes).where(eq(savMailboxes.id, message.mailboxId));
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, message.threadId));
    if (!mailbox || !thread || thread.mailboxId !== mailbox.id || !message.gmailMessageId) return null;
    const read: SavAttachmentRead = { version: 1, readerRevision: SAV_ATTACHMENT_READER_REVISION, model, messageId, mailboxId: mailbox.id, gmailMessageId: message.gmailMessageId,
      selectionHash: hash, claimId: randomUUID(), state: "reading", startedAt: new Date().toISOString(), completedAt: null, observations: items.map(attachmentSkeleton) };
    // Historical repairs can reuse a cache, never introduce image reading retrospectively.
    if (message.processedAt || message.analysisStatus !== "processing" || !await isLatest(tx, message)) return { cached: unavailable(read, "context_changed") };
    const [review] = await tx.select({ id: savProposalReviews.id }).from(savProposalReviews).where(eq(savProposalReviews.messageId, message.id)).limit(1);
    if (review) return { cached: unavailable(read, "context_changed") };
    await tx.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ ...body, attachmentRead: read }) }).where(eq(savMessages.id, messageId));
    return { read, items, mailbox, message, gmailThreadId: thread.gmailThreadId };
  });
  if (!claim) return null;
  if ("cached" in claim) return claim.cached ?? null;
  const { read, items, mailbox, message, gmailThreadId } = claim;
  let observations = read.observations;
  if (!await isSavMessageEligible(messageId) || process.env.SAV_AI_ANALYSIS === "false" || !(options.apiKey ?? savGeminiApiKey())) {
    observations = observations.map(o => ({ ...o, reason: "reader_disabled" }));
  } else {
    const gmail = await import("./gmail");
    observations = await readSavAttachmentSelection({ read, metadata: items, expected: { mailboxEmail: mailbox.email, gmailMessageId: message.gmailMessageId!, gmailThreadId } },
      { download: gmail.createSavGmailAttachmentDownloader(), ...options, beforeVisual: async () => {
        if (process.env.SAV_AI_ANALYSIS === "false" || !(options.apiKey ?? savGeminiApiKey()) || !await isSavMessageEligible(messageId)) throw new Error("reader_disabled");
        return db.transaction(async tx => {
          const current = await lockSource(tx, messageId);
          if (!current || !await isLatest(tx, current)) return false;
          const body = decryptSavPayload<Body>(current.bodyCiphertext);
          const [review] = await tx.select({ id: savProposalReviews.id }).from(savProposalReviews).where(eq(savProposalReviews.messageId, messageId)).limit(1);
          return !review && saved(body)?.claimId === read.claimId && selectionHash(body) === read.selectionHash;
        });
      } });
  }
  const complete = savAttachmentReadSchema.parse({ ...read, state: "complete", completedAt: new Date().toISOString(), observations });
  return db.transaction(async tx => {
    const current = await lockSource(tx, messageId);
    if (!current) return null;
    const body = decryptSavPayload<Body>(current.bodyCiphertext), owner = saved(body);
    if (owner?.claimId !== read.claimId || selectionHash(body) !== read.selectionHash || current.mailboxId !== read.mailboxId || current.gmailMessageId !== read.gmailMessageId) return unavailable(complete, "context_changed");
    const [review] = await tx.select({ id: savProposalReviews.id }).from(savProposalReviews).where(eq(savProposalReviews.messageId, messageId)).limit(1);
    // A human snapshot may already include this ciphertext: do not invalidate it
    // merely to record a late machine result, even an unavailable one.
    if (review) return unavailable(complete, "context_changed");
    const result = !await isLatest(tx, current) ? unavailable(complete, "context_changed") : complete;
    // Merge the fresh encrypted body under lock, preserving concurrent context and reviews.
    await tx.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ ...body, attachmentRead: result }) }).where(eq(savMessages.id, messageId));
    return result;
  });
}
