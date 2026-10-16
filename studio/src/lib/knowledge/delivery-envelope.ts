import "server-only";
import { z } from "zod";
import type { CanonicalKnowledge } from "./contracts";
import { savContentHash } from "@/lib/sav/crypto";
import { assertSavSupportDelivery, projectSavSupportDelivery, savSupportDeliverySchema } from "./support-delivery";

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, ordered(v)]));
  return value;
}
export function savDeliveryHash(value: unknown) { return savContentHash(ordered(value === undefined ? null : value)); }
const envelopeSchema = z.object({ version: z.literal(1), documentHash: z.string(), qualification: savSupportDeliverySchema }).strict();
export function createSavDeliveryEnvelope(document: CanonicalKnowledge, raw: unknown) {
  return { version: 1 as const, documentHash: savDeliveryHash(document), qualification: assertSavSupportDelivery(document, raw) };
}
export function readSavDeliveryEnvelope(document: CanonicalKnowledge, raw: unknown) {
  const envelope = envelopeSchema.parse(raw);
  if (envelope.documentHash !== savDeliveryHash(document)) throw new Error("SAV_DELIVERY_DOCUMENT_CHANGED");
  assertSavSupportDelivery(document, envelope.qualification);
  return envelope;
}
export function savDeliveryMetadata(document: CanonicalKnowledge, raw: unknown) {
  const envelope = readSavDeliveryEnvelope(document, raw);
  return { envelope, projection: projectSavSupportDelivery(document, envelope.qualification) };
}
