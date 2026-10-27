import { z } from "zod";
import { SAV_VISUAL_OBSERVATION_LIMITS as V } from "../attachment-contract";
import { redactSavAttachmentText } from "../attachment-reader";

/** Where an analysis output was rejected, from the provider body to evidence rules. */
export type IntakeOutputStage = "sanitize_wire" | "visual_normalize" | "decode" | "final_schema" | "evidence";
/** Counts only: what was bounded or treated as absent, never the values themselves. */
export type IntakeOutputNormalization = {
  nullOptionalKeys: number; partialImages: number; truncatedImageTexts: number; truncatedUncertainties: number;
  droppedUncertainties: number; droppedRegions: number; truncatedRegionTexts: number; invalidBoxes: number; omittedChars: number;
  /** Unproven optional registration declarations discarded (identity falls back to the sender). */
  discardedRegistrations: number;
};
export const INTAKE_NULLABLE_OPTIONAL_KEYS = ["nature", "registration", "ticketSummary", "imageRequirements"] as const;
export const SAV_VISUAL_TRUNCATED_NOTE = "Observation abrégée : contenu visuel tronqué à la limite autorisée.";
export const SAV_VISUAL_INVALID_BOX_NOTE = "Coordonnées de zone invalides ignorées.";

export const emptyIntakeOutputNormalization = (): IntakeOutputNormalization => ({ nullOptionalKeys: 0, partialImages: 0, truncatedImageTexts: 0,
  truncatedUncertainties: 0, droppedUncertainties: 0, droppedRegions: 0, truncatedRegionTexts: 0, invalidBoxes: 0, omittedChars: 0, discardedRegistrations: 0 });
export const intakeOutputNormalized = (n: IntakeOutputNormalization) => Object.values(n).some(v => v > 0);
export function addIntakeOutputNormalization(into: IntakeOutputNormalization, from: IntakeOutputNormalization) {
  for (const key of Object.keys(into) as (keyof IntakeOutputNormalization)[]) into[key] += from[key];
}

// Inspect every entry before taking a bounded prefix. Only size constraints and
// finite numeric box shape/scale may be normalized; type/key errors must survive
// unchanged so the strict wire validator can report them, including in the tail.
const visualDetailsStructure = z.object({
  regions: z.array(z.object({ text: z.string(), box: z.array(z.number()).nullable() }).strict()),
  uncertainties: z.array(z.string()),
}).strict();
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Mask before cutting: a prefix never ends inside a secret the masker would miss. */
function bounded(value: string, limit: number, n: IntakeOutputNormalization) {
  const masked = redactSavAttachmentText(value);
  if (masked.length <= limit) return { text: masked, cut: false };
  n.omittedChars += masked.length - limit;
  return { text: masked.slice(0, limit), cut: true };
}
const validBox = (box: unknown[]) => box.length === 4 && box.every(v => typeof v === "number" && v >= 0 && v <= V.coordinate);
const numericBox = (box: unknown) => Array.isArray(box) && box.every(v => typeof v === "number" && Number.isFinite(v));

/** Derived pixels are not customer words: an over-long or over-numerous visual
 * observation becomes an explicit `partial` prefix instead of rejecting the whole
 * analysis. Structure stays the validator's job: indexes, counts, readability,
 * types, unknown keys and source links are left untouched so they still fail. */
function normalizeImage(raw: unknown, n: IntakeOutputNormalization) {
  if (!record(raw)) return raw;
  if (!visualDetailsStructure.safeParse({ regions: raw.regions, uncertainties: raw.uncertainties }).success) return raw;
  const image = { ...raw };
  let cut = false, invalidBox = false;
  if (typeof image.text === "string") {
    const { text, cut: c } = bounded(image.text, V.text, n);
    image.text = text; if (c) { cut = true; n.truncatedImageTexts++; }
  }
  if (Array.isArray(image.regions)) {
    const regions = image.regions.slice(0, V.regions);
    if (image.regions.length > V.regions) { cut = true; n.droppedRegions += image.regions.length - V.regions; }
    image.regions = regions.map(rawRegion => {
      if (!record(rawRegion)) return rawRegion;
      const region = { ...rawRegion };
      if (typeof region.text === "string") {
        const { text, cut: c } = bounded(region.text, V.regionText, n);
        region.text = text; if (c) { cut = true; n.truncatedRegionTexts++; }
      }
      // A numeric box of the wrong shape or scale is not a reliable location; box is nullable.
      if (numericBox(region.box) && !validBox(region.box as unknown[])) { region.box = null; invalidBox = true; n.invalidBoxes++; }
      return region;
    });
  }
  if (Array.isArray(image.uncertainties)) {
    const items = image.uncertainties.map(value => {
      if (typeof value !== "string") return value;
      const { text, cut: c } = bounded(value, V.uncertainty, n);
      if (c) { cut = true; n.truncatedUncertainties++; }
      return text;
    });
    if (items.length > V.uncertainties) cut = true;
    const notes = [...(cut ? [SAV_VISUAL_TRUNCATED_NOTE] : []), ...(invalidBox ? [SAV_VISUAL_INVALID_BOX_NOTE] : [])].filter(note => !items.includes(note));
    const merged = [...notes, ...items];
    if (merged.length > V.uncertainties) n.droppedUncertainties += merged.length - V.uncertainties;
    image.uncertainties = merged.slice(0, V.uncertainties);
  }
  if (cut) {
    n.partialImages++;
    if (image.readability === "readable") image.readability = "partial";
  }
  return image;
}

/** Bounded, explicit and idempotent. Null becomes absent only for the listed
 * top-level optional keys; no default value, no recursive leniency. */
export function normalizeIntakeAnalysisOutput(raw: unknown, options: { visual: boolean }) {
  const counts = emptyIntakeOutputNormalization();
  if (!record(raw)) return { value: raw, counts };
  const value: Record<string, unknown> = { ...raw };
  for (const key of INTAKE_NULLABLE_OPTIONAL_KEYS) if (Object.hasOwn(value, key) && value[key] === null) { delete value[key]; counts.nullOptionalKeys++; }
  if (options.visual && Array.isArray(value.images)) value.images = value.images.map(image => normalizeImage(image, counts));
  return { value, counts };
}

/** Prompt text derived from the same constants as the validators. */
export const INTAKE_OUTPUT_LIMITS_INSTRUCTION = `Output limits checked by the server: ticketSummary.title at most 120 characters. Omit an optional key (${INTAKE_NULLABLE_OPTIONAL_KEYS.join(", ")}) instead of returning null.`;
export const INTAKE_VISUAL_LIMITS_INSTRUCTION = `Visual limits checked by the server: per image, text at most ${V.text} characters, at most ${V.uncertainties} uncertainties of at most ${V.uncertainty} characters, at most ${V.regions} regions with text of at most ${V.regionText} characters. A region box is exactly four numbers [ymin, xmin, ymax, xmax] normalized from 0 to ${V.coordinate}, or null when the location is uncertain; never pixel coordinates. When an image holds more text, keep the most diagnostic part (error messages, versions, settings), set readability to partial and say so in uncertainties.`;
