import { savDerivedCostQuote } from "../derived-budget";
import { SAV_ATTACHMENT_LIMITS } from "../attachment-contract";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";

/** Reservation of ONE intake model call, computed from the exact body before dispatch.
 *
 * Output: maxOutputTokens, enforced in the request, includes thinking tokens and both are
 * billed at the output price (ai.google.dev/gemini-api/docs/thinking, docs/pricing).
 * Media: the transport's own admission allowance (4096 tokens per HIGH image against the
 * documented 1120, see savGeminiWireBody).
 * Text: the provider documents no per-byte bound (only "about 4 characters" per token).
 * We bound tokens by the UTF-8 bytes of the serialized request (system instruction, data,
 * JSON escaping and response schema included), plus a fixed framing allowance for turn and
 * schema rendering. This bound is an assumption, so it is checked on every settled call:
 * one call above its bound revokes it and every later reservation returns to the full
 * model input window (see intakeReservationBoundRevoked). Never below the old quote's
 * output part, never above the old full quote. */
export const SAV_INTAKE_RESERVATION_REVISION = "sav-intake-request-reservation-2026-10-28.v1";
export const SAV_INTAKE_FRAMING_TOKENS = 16_384;
const MEDIA_TOKENS_PER_IMAGE = 4096, REVISION_PRICED_AT = new Date("2026-10-28T00:00:00.000Z");
export type IntakeRequestSize = { textBytes: number; mediaTokens: number; maxOutputTokens: number };
export type IntakeReservation = IntakeRequestSize & { revision: typeof SAV_INTAKE_RESERVATION_REVISION; inputTokenBound: number; full: boolean; reservedNanoUsd: number };
const count = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

export function intakeRequestReservation(model: string, size: IntakeRequestSize | undefined, now = new Date(), full = false): IntakeReservation {
  const quote = savDerivedCostQuote(model, size?.maxOutputTokens ?? 8192, now);
  if (size && (!count(size.textBytes, SAV_INTAKE_MODEL_LIMITS.wireTextBytes) || size.textBytes < 1 || !count(size.mediaTokens, quote.maxInputTokens)))
    throw Error("SAV_INTAKE_RUNTIME_REQUEST_REJECTED");
  // Without a measured body (legacy callers) or once the bound is revoked: the full window.
  const whole = full || !size;
  const inputTokenBound = whole ? quote.maxInputTokens : Math.min(quote.maxInputTokens, size.textBytes + size.mediaTokens + SAV_INTAKE_FRAMING_TOKENS);
  return { revision: SAV_INTAKE_RESERVATION_REVISION, textBytes: size?.textBytes ?? 0, mediaTokens: size?.mediaTokens ?? 0, maxOutputTokens: quote.maxOutputTokens,
    inputTokenBound, full: whole, reservedNanoUsd: inputTokenBound * quote.inputNanoUsdPerToken + quote.maxOutputTokens * quote.outputNanoUsdPerToken };
}
/** Largest reservation one admissible intake call can need: the margin required before
 * an attempt starts, so a budget deferral still never consumes an attempt. */
export function intakeMaxCallReservation(model: string, now = new Date(), full = false) {
  return intakeRequestReservation(model, { textBytes: SAV_INTAKE_MODEL_LIMITS.wireTextBytes,
    mediaTokens: SAV_ATTACHMENT_LIMITS.images * MEDIA_TOKENS_PER_IMAGE, maxOutputTokens: 8192 }, now, full);
}
/** A stored descriptor is accepted only if it recomputes to the stored amount. The revision
 * pins the tariff it was computed with, so history stays readable after a price change. */
export function storedIntakeReservation(value: unknown, reservedNanoUsd: number): IntakeReservation | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<IntakeReservation>;
  if (r.revision !== SAV_INTAKE_RESERVATION_REVISION || typeof r.full !== "boolean") return null;
  try {
    const again = intakeRequestReservation("gemini-3.6-flash", r.full && !r.textBytes ? undefined : { textBytes: r.textBytes!, mediaTokens: r.mediaTokens!, maxOutputTokens: r.maxOutputTokens! }, REVISION_PRICED_AT, r.full);
    return again.reservedNanoUsd === reservedNanoUsd && again.inputTokenBound === r.inputTokenBound && again.maxOutputTokens === r.maxOutputTokens ? again : null;
  } catch { return null; }
}
