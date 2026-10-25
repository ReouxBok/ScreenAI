import { z } from "zod";

export const SAV_ATTACHMENT_READER_REVISION = "sav-attachments-2026-10-19.v1";
export const SAV_ATTACHMENT_LIMITS = Object.freeze({ images: 3, imageBytes: 4 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, pixels: 16_000_000, references: 100, downloadMs: 12_000, readMs: 15_000 });
const gmailId = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/);
export const savAttachmentReferenceSchema = z.object({
  version: z.literal(1), mailboxEmail: z.email(), gmailMessageId: gmailId, gmailThreadId: gmailId,
  partId: z.string().regex(/^(?:\d+(?:\.\d+)*)?$/).max(100), attachmentId: gmailId.nullable(),
  contentId: z.string().max(200).nullable(), disposition: z.enum(["inline", "attachment", "unknown"]),
}).strict();
export const savAttachmentMetadataSchema = z.object({ filename: z.string().max(500), mimeType: z.string().max(200), size: z.number().int().nonnegative(), reference: savAttachmentReferenceSchema.optional() });
export type SavAttachmentMetadata = z.infer<typeof savAttachmentMetadataSchema>;
export type SavAttachmentReference = z.infer<typeof savAttachmentReferenceSchema>;
export const savAttachmentInventorySchema = z.object({
  complete: z.boolean(),
  limits: z.array(z.enum(["reference_limit", "node_limit", "depth_limit"])).max(3),
}).strict().refine(value => value.complete === (value.limits.length === 0) && new Set(value.limits).size === value.limits.length, "Inconsistent inventory completeness");
export type SavAttachmentInventory = z.infer<typeof savAttachmentInventorySchema>;
export const savAttachmentStatusSchema = z.enum(["analyzed", "partial", "unreadable", "unsupported", "not_read"]);
export const savAttachmentReasonSchema = z.enum(["observed", "partial_content", "unreadable_content", "unsupported_type", "legacy_reference_missing", "image_limit", "byte_limit", "pixel_limit", "invalid_image", "type_mismatch", "association_mismatch", "permission_denied", "not_found", "rate_limited", "timeout", "download_failed", "provider_failed", "validation_failed", "budget_exhausted", "model_unsupported", "in_progress", "outcome_uncertain", "context_changed", "context_incomplete", "reader_disabled"]);
export const savAttachmentObservationSchema = z.object({
  sourceId: z.string().max(100), filename: z.string().max(500), mimeType: z.string().max(200), referenceHash: z.string(),
  fileHash: z.string().nullable(), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(),
  status: savAttachmentStatusSchema, reason: savAttachmentReasonSchema,
  text: z.string().max(4000), uncertainties: z.array(z.string().max(300)).max(8),
  regions: z.array(z.object({ text: z.string().max(1000), box: z.tuple([z.number().min(0).max(1000), z.number().min(0).max(1000), z.number().min(0).max(1000), z.number().min(0).max(1000)]).nullable() }).strict()).max(8),
}).strict();
export type SavAttachmentObservation = z.infer<typeof savAttachmentObservationSchema>;
export const savAttachmentReadSchema = z.object({
  version: z.literal(1), readerRevision: z.string(), model: z.string(), messageId: z.uuid(), mailboxId: z.uuid(), gmailMessageId: z.string(),
  selectionHash: z.string(), claimId: z.uuid(), state: z.enum(["reading", "complete"]), startedAt: z.string(), completedAt: z.string().nullable(),
  observations: z.array(savAttachmentObservationSchema).max(100),
}).strict();
export type SavAttachmentRead = z.infer<typeof savAttachmentReadSchema>;
export function savAttachmentClaimReason(startedAt: string, now = Date.now()): "in_progress" | "outcome_uncertain" {
  const age = now - Date.parse(startedAt);
  return Number.isFinite(age) && age >= 0 && age < 120_000 ? "in_progress" : "outcome_uncertain";
}
/** Read-only projection: no Gmail references/claim identifiers and no false live/read status. */
export function savAttachmentDisplayRead(read: SavAttachmentRead | null | undefined, now = Date.now()) {
  const parsed = savAttachmentReadSchema.safeParse(read);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return { readerRevision: value.readerRevision, observations: value.state === "reading"
    ? value.observations.map(o => ({ ...o, status: "not_read" as const, reason: savAttachmentClaimReason(value.startedAt, now), text: "", regions: [], uncertainties: [] }))
    : value.observations };
}

export function savAttachmentNotice(read?: SavAttachmentRead | null, inventory?: SavAttachmentInventory | null) {
  const reading = !read ? "Pièces jointes non lues : aucune observation visuelle acquise. Ne pas affirmer avoir consulté une capture."
    : "Observations visuelles dérivées, potentiellement inexactes ; aucune identité, cause racine ou action réussie n’est prouvée par une capture. Seules les observations analyzed/partial sont disponibles. Les autres pièces restent non lues avec leur raison explicite.";
  const coverage = inventory?.complete === false ? " Inventaire incomplet : des parties MIME n’ont pas été parcourues ou des pièces ont été omises par une limite. Leur nombre et leur contenu restent inconnus ; ne pas affirmer que toutes les pièces ont été vues."
    : !inventory ? " La complétude de l’inventaire de ce message ancien ou sans métadonnée de collecte n’est pas certifiée." : "";
  return reading + coverage;
}
