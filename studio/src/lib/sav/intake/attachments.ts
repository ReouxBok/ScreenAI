import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savMessages, savMailboxes, savThreads } from "@/db/schema";
import { savContentHash } from "../crypto";
import { prepareSavAttachmentSelection, type SavPreparedAttachments } from "../attachment-reader";
import { savAttachmentInventorySchema, savAttachmentMetadataSchema, savAttachmentReadSchema, SAV_ATTACHMENT_READER_REVISION, type SavAttachmentInventory, type SavAttachmentRead } from "../attachment-contract";
import type { IntakeLease } from "./runtime-store";
import type { EngineInput } from "./engine-types";

export type IntakeAttachmentState = { textComplete: boolean; sourceHash: string; read: SavAttachmentRead; inventory: SavAttachmentInventory | null };
export async function prepareIntakeAttachments(lease: IntakeLease, model: string, live: () => Promise<void>, download?: Parameters<typeof prepareSavAttachmentSelection>[1]["download"]) {
  if (!lease.body.attachments?.length) return null;
  await live();
  const db = requireDb();
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, lease.run.messageId));
  const actualMailbox = message ? (await db.select().from(savMailboxes).where(eq(savMailboxes.id, message.mailboxId)))[0] : null;
  const [thread] = message ? await db.select().from(savThreads).where(eq(savThreads.id, message.threadId)) : [];
  if (!message?.gmailMessageId || !actualMailbox || thread?.mailboxId !== actualMailbox.id || message.threadId !== lease.run.threadId) throw Error("SAV_INTAKE_ATTACHMENT_SOURCE_REQUIRED");
  const raw = lease.body.attachments.slice(0, 100), parsed = raw.map(a => savAttachmentMetadataSchema.safeParse(a));
  const metadata = parsed.flatMap(a => a.success ? [a.data] : []);
  const inventoryResult = savAttachmentInventorySchema.safeParse(lease.body.attachmentInventory);
  const inventory = inventoryResult.success && parsed.every(a => a.success) && raw.length === lease.body.attachments.length ? inventoryResult.data : null;
  const downloader = download ?? (await import("../gmail")).createSavGmailAttachmentDownloader();
  const prepared = await prepareSavAttachmentSelection({ metadata, expected: { mailboxEmail: actualMailbox.email, gmailMessageId: message.gmailMessageId, gmailThreadId: thread.gmailThreadId } },
    { download: async (...args) => { await live(); const value = await downloader(...args); await live(); return value; } });
  await live();
  const read: SavAttachmentRead = { version: 1, readerRevision: SAV_ATTACHMENT_READER_REVISION, model, messageId: message.id, mailboxId: message.mailboxId,
    gmailMessageId: message.gmailMessageId, selectionHash: savContentHash({ metadata, inventory }), claimId: randomUUID(), state: "reading", startedAt: new Date().toISOString(), completedAt: null, observations: prepared.observations };
  const state: IntakeAttachmentState = { textComplete: lease.provenance.get(message.id)?.textComplete === true, sourceHash: lease.sourceHash, read, inventory };
  const complete=inventory?.complete === true && metadata.length > 0 && prepared.selected.length === metadata.length;
  if(!complete) finishIntakeAttachmentRead(state,"context_incomplete");
  return { state, prepared, complete };
}
/** Never import pixels or mutate the encrypted source body. Derived inputs are
 * accepted only with the unchanged lease source and the current message. */
export function intakeInputWithAttachments(input: EngineInput, sourceHash: string, state: IntakeAttachmentState | undefined, prepared?: SavPreparedAttachments): EngineInput {
  if (!state || state.sourceHash !== sourceHash || state.read.messageId !== input.message.id) return input;
  const read = savAttachmentReadSchema.parse(state.read);
  const observations = read.observations;
  const ready = state.textComplete && state.inventory?.complete === true && observations.length > 0 && observations.length <= 3
    && observations.every(o => o.fileHash && (prepared ? prepared.selected.some(s => s.observation.sourceId === o.sourceId) : o.status === "analyzed"));
  if (!ready) return intakeInputWithUnreadAttachments(input, state, observations);
  const message = { ...input.message, contentComplete: true, attachmentInputs: observations.map(o => ({ sourceId: o.sourceId, fileHash: o.fileHash! })) };
  return { ...input, message, conversation: { ...input.conversation, data: input.conversation.data.map(m => m.id === message.id ? message : m) } };
}
/** Durable per-file outcomes that a retry cannot change: the file stays unread, the
 * complete written text may still be analysed. Transport, permission, budget and
 * association failures are excluded and keep the dossier incomplete. */
const SAV_INTAKE_UNREAD_TEXT_ONLY_REASONS = new Set(["unsupported_type", "byte_limit", "pixel_limit", "invalid_image", "type_mismatch"]);
function intakeInputWithUnreadAttachments(input: EngineInput, state: IntakeAttachmentState, observations: SavAttachmentRead["observations"]): EngineInput {
  const textOnly = state.textComplete && state.inventory?.complete === true && observations.length > 0 && observations.length <= 20
    && observations.every(o => o.status !== "analyzed" && SAV_INTAKE_UNREAD_TEXT_ONLY_REASONS.has(o.reason));
  if (!textOnly) return input;
  const message = { ...input.message, contentComplete: true, unreadAttachments: observations.map(o => ({ sourceId: o.sourceId, reason: o.reason })) };
  return { ...input, message, conversation: { ...input.conversation, data: input.conversation.data.map(m => m.id === message.id ? message : m) } };
}

/** Complete the attempt, never assert that an unobserved image was analyzed.
 * Preparation failures retain their specific per-file reasons. */
export function finishIntakeAttachmentRead(state:IntakeAttachmentState|undefined,reason:import("../attachment-contract").SavAttachmentObservation["reason"]) {
  if(!state||state.read.state!=="reading")return;
  state.read={...state.read,state:"complete",completedAt:new Date().toISOString(),observations:state.read.observations.map(o=>
    o.reason==="in_progress"?{...o,status:"not_read",reason,text:"",regions:[],uncertainties:[]}:o)};
}
