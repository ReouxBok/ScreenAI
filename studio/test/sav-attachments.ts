import sharp from "sharp";
import { attachmentSkeleton } from "../src/lib/sav/attachment-reader";
import { SAV_ATTACHMENT_READER_REVISION, type SavAttachmentMetadata, type SavAttachmentRead } from "../src/lib/sav/attachment-contract";
export const attachmentMessageId = "00000000-0000-4000-8000-000000000083";
export function attachmentMetadata(size = 100, partId = "1"): SavAttachmentMetadata {
  return { filename: "capture-fictive.png", mimeType: "image/png", size, reference: { version: 1, mailboxEmail: "contact@limova.ai", gmailMessageId: "gmail-fixture", gmailThreadId: "thread-fixture", partId, attachmentId: "attachment-fixture", contentId: null, disposition: "attachment" } };
}
export function attachmentRead(items: SavAttachmentMetadata[] = [attachmentMetadata()]): SavAttachmentRead {
  return { version: 1, readerRevision: SAV_ATTACHMENT_READER_REVISION, model: "gemini-3.6-flash", messageId: attachmentMessageId,
    mailboxId: "00000000-0000-4000-8000-000000000001", gmailMessageId: "gmail-fixture", selectionHash: "fixture", claimId: "00000000-0000-4000-8000-000000000002",
    state: "complete", startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(), observations: items.map(attachmentSkeleton) };
}
export function observedAttachment() {
  const read = attachmentRead();
  read.observations[0] = { ...read.observations[0], status: "analyzed", reason: "observed", text: "Erreur E42. Version 7.2.", fileHash: "a".repeat(64), width: 100, height: 100 };
  return read;
}
export function syntheticImage(format: "png" | "jpeg" | "webp" = "png") {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: "white" } }).toFormat(format).toBuffer();
}
