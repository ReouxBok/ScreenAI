import type { SavAttachmentMetadata, SavAttachmentRead } from "../src/lib/sav/attachment-contract";
export const SAV83_E2E_KEY = "synthetic-only-sav83-browser-encryption-key";
export const SAV83_THREAD = "00000083-0000-4000-8000-000000000001";
export const SAV83_MESSAGE = "00000083-0000-4000-8000-000000000002";
export const SAV83_UNREAD_THREAD = "00000083-0000-4000-8000-000000000004";
export const SAV83_UNREAD_MESSAGE = "00000083-0000-4000-8000-000000000005";
export const SAV83_ATTACHMENTS: SavAttachmentMetadata[] = [
  { filename: "capture-fictive.png", mimeType: "image/png", size: 100 },
  { filename: "capture-partielle.jpeg", mimeType: "image/jpeg", size: 100 },
  { filename: "document-fictif.pdf", mimeType: "application/pdf", size: 100 },
  { filename: "grande-image.webp", mimeType: "image/webp", size: 5 * 1024 * 1024 },
  { filename: "capture-illisible.png", mimeType: "image/png", size: 100 },
];
export function sav83Read(mailboxId: string): SavAttachmentRead {
  return { version: 1, readerRevision: "sav-attachments-2026-10-19.v1", model: "synthetic-only", messageId: SAV83_MESSAGE, mailboxId, gmailMessageId: "sav83-synthetic-message",
    selectionHash: "synthetic", claimId: "00000083-0000-4000-8000-000000000003", state: "complete", startedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(),
    observations: SAV83_ATTACHMENTS.map((item, index) => ({ sourceId: `attachment:synthetic-${index}`, filename: item.filename, mimeType: item.mimeType, referenceHash: "synthetic", fileHash: index < 2 || index === 4 ? (index + 1).toString(16).repeat(64) : null,
      width: index < 2 || index === 4 ? 100 : null, height: index < 2 || index === 4 ? 100 : null,
      status: (["analyzed", "partial", "unsupported", "not_read", "unreadable"] as const)[index],
      reason: (["observed", "partial_content", "unsupported_type", "byte_limit", "unreadable_content"] as const)[index],
      text: index === 0 ? "Erreur E42. Version 7.2." : index === 1 ? "Panneau partiellement lisible." : "", uncertainties: index === 1 ? ["La zone inférieure est floue."] : index === 4 ? ["Le code d’erreur est illisible."] : [], regions: [] })) };
}
