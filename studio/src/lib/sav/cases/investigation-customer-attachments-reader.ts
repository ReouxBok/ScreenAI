import "server-only";
import { prepareSavAttachmentSelection, attachmentSkeleton } from "../attachment-reader";
import { savAttachmentInventorySchema, savAttachmentReadSchema, type SavAttachmentReference } from "../attachment-contract";
import { isSavPdfMedia } from "../attachment-pdf";
import {
  buildCaseCustomerAttachments, caseAttachmentReason, caseStoredAttachmentMetadata,
  type CaseAttachmentsMissing, type CaseCustomerAttachmentMedia, type CaseCustomerAttachments, type CaseCustomerRawAttachment, type CaseStoredMailBody,
} from "./investigation-customer-attachments";

/*
 * SAV-92 (15/11): the server side of the V2 attachments, READ ONLY.
 * - Metadata and V1's reading come from what V1 already stored in the encrypted message body (`attachments`, `attachmentInventory`,
 *   `attachmentRead`): no call at all.
 * - The files themselves are not stored anywhere (by design: V1 keeps only references). When the operator turns it on
 *   (`SAV_V2_ATTACHMENT_MEDIA=images` or `images_pdf`), a few of them are downloaded through V1's own bounded path
 *   (`prepareSavAttachmentSelection`: Gmail GET only, the reference re-validated against the stored mailbox / message / thread, 4 MB per
 *   file, 8 MB in all, 12 s, at most 3 files, then decoded and admitted by `admitSavAttachmentImage` / `admitSavAttachmentPdf`). The bytes
 *   live in memory for this run only; nothing is written. Any failure is a reason on the file, never an error of the case.
 */

export const SAV_V2_ATTACHMENT_MEDIA_ENV = "SAV_V2_ATTACHMENT_MEDIA";
export type CaseAttachmentMediaMode = "off" | "images" | "images_pdf";
/** Off unless set exactly: an unknown value is off (no download, no cost). */
export function caseAttachmentMediaMode(env: Readonly<Record<string, string | undefined>>): CaseAttachmentMediaMode {
  const value = env[SAV_V2_ATTACHMENT_MEDIA_ENV]?.trim();
  return value === "images" || value === "images_pdf" ? value : "off";
}

export { caseStoredAttachmentMetadata, type CaseStoredMailBody } from "./investigation-customer-attachments";
export type CaseStoredMail = { id: string; role: "latest" | "previous"; gmailMessageId: string | null; body: CaseStoredMailBody | null };
export type CaseAttachmentOwner = { mailboxEmail: string; gmailMessageId: string; gmailThreadId: string };
export type CaseAttachmentDownload = (reference: SavAttachmentReference, size: number, signal: AbortSignal, mimeType?: string) => Promise<Buffer>;

/** V1's completed reading of each file of this very mail, by V1's own source id. */
function v1Readings(mail: CaseStoredMail) {
  const parsed = savAttachmentReadSchema.safeParse(mail.body?.attachmentRead);
  const readings = new Map<string, CaseCustomerRawAttachment["reading"]>();
  if (!parsed.success || parsed.data.state !== "complete" || parsed.data.messageId !== mail.id) return readings;
  for (const row of parsed.data.observations) if ((row.status === "analyzed" || row.status === "partial") && (row.text || row.regions.length))
    readings.set(row.sourceId, { status: row.status, text: [row.text, ...row.regions.map(region => region.text)].filter(Boolean).join("\n"), uncertainties: row.uncertainties });
  return readings;
}

const inlineCandidate = (mimeType: string, mode: CaseAttachmentMediaMode) => /^image\/(png|jpeg|webp)$/i.test(mimeType) || mode === "images_pdf" && /^application\/pdf$/i.test(mimeType);

/**
 * The files of the latest customer mail and the previous one, the view and the media. Never throws: a mail that cannot be read is listed in
 * `missing`, a file that cannot be downloaded carries its reason.
 */
export async function readCaseCustomerAttachments(mails: readonly CaseStoredMail[], options: Readonly<{
  mode: CaseAttachmentMediaMode;
  owner: (mail: CaseStoredMail) => Promise<CaseAttachmentOwner | null>;
  download?: CaseAttachmentDownload;
}>): Promise<{ attachments: CaseCustomerAttachments; media: CaseCustomerAttachmentMedia[] } | null> {
  const files: CaseCustomerRawAttachment[] = [], missing = new Set<CaseAttachmentsMissing>();
  let slots = 3;
  for (const mail of mails) {
    if (!mail.body) { missing.add("attachments_unavailable"); continue; }
    const metadata = caseStoredAttachmentMetadata(mail.body);
    const inventory = savAttachmentInventorySchema.safeParse(mail.body.attachmentInventory);
    if (inventory.success && !inventory.data.complete) missing.add("attachment_inventory_incomplete");
    if (!metadata.length) continue;
    const readings = v1Readings(mail);
    const media = new Map<number, CaseCustomerRawAttachment["media"]>();
    const wanted = metadata.some(item => inlineCandidate(item.mimeType, options.mode));
    if (options.mode !== "off" && wanted && slots > 0) {
      try {
        const owner = mail.gmailMessageId ? await options.owner(mail) : null;
        if (!owner) { missing.add("attachment_download_failed"); }
        else {
          const download = options.download ?? (await import("../gmail")).createSavGmailAttachmentDownloader();
          const prepared = await prepareSavAttachmentSelection({ metadata, expected: owner, pdf: options.mode === "images_pdf" }, { download });
          prepared.observations.forEach((observation, index) => {
            const chosen = prepared.selected.find(row => row.observation === observation);
            if (chosen) {
              const value = chosen.image;
              media.set(index, { ok: true, value: { mimeType: value.mimeType, bytes: value.bytes, hash: value.hash, pages: isSavPdfMedia(value) ? value.pages : null } });
            } else media.set(index, { ok: false, reason: observation.status === "unsupported" ? "unsupported_type" : caseAttachmentReason(observation.reason) });
          });
          slots -= prepared.selected.length;
        }
      } catch { missing.add("attachment_download_failed"); }
    }
    metadata.forEach((item, index) => {
      const fallback: CaseCustomerRawAttachment["media"] = { ok: false, reason: !inlineCandidate(item.mimeType, options.mode === "off" ? "images_pdf" : options.mode) ? "unsupported_type"
        : options.mode === "off" ? "media_off" : slots <= 0 ? "image_limit" : "download_failed" };
      files.push({ message: mail.role, filename: item.filename, mimeType: item.mimeType, size: item.size,
        reading: readings.get(attachmentSkeleton(item, index).sourceId) ?? null, media: media.get(index) ?? fallback });
    });
  }
  if (!files.length && !missing.size) return null;
  return buildCaseCustomerAttachments(files, { missing: [...missing] });
}
