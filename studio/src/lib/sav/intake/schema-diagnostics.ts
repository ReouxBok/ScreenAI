import { z } from "zod";

const fields = new Set(["messageId", "requests", "id", "kind", "currentMessageId", "originMessageId", "quoteId", "quote", "registration", "address", "sourceMessageId", "ticketSummary", "title", "description", "requestIds", "images", "index", "readability", "text", "uncertainties", "regions", "box", "tickets", "ticketId", "relation", "evidenceIds", "grounding", "sourceId", "rationale", "investigationComplete", "contactIds", "attachmentObservations", "sourceId", "fileHash", "nature", "imageRequirements", "role", "textQuoteId"]);
const codes = new Set(["invalid_type", "too_big", "too_small", "invalid_format", "invalid_value", "unrecognized_keys", "invalid_union", "custom"]);
export type IntakeSchemaIssue = { path: string; code: string; minimum?: number; maximum?: number };
/** No unknown object keys, rejected values or validator messages are public facts. */
export function intakeSchemaPath(path: readonly PropertyKey[]): string {
  return path.length > 0 && path.length <= 8 && path.every(p => typeof p === "string" ? fields.has(p) : typeof p === "number" && Number.isInteger(p) && p >= 0 && p <= 100)
    ? path.join(".") : "output";
}
export function intakeSchemaIssues(error: z.ZodError): IntakeSchemaIssue[] {
  return error.issues.slice(0, 8).map(issue => {
    const bounds = issue as typeof issue & { minimum?: unknown; maximum?: unknown };
    return { path: intakeSchemaPath(issue.path), code: codes.has(issue.code) ? issue.code : "invalid_type",
      ...(typeof bounds.minimum === "number" && Number.isSafeInteger(bounds.minimum) ? { minimum: bounds.minimum } : {}),
      ...(typeof bounds.maximum === "number" && Number.isSafeInteger(bounds.maximum) ? { maximum: bounds.maximum } : {}) };
  });
}
export function publicIntakeSchemaIssues(raw: unknown): IntakeSchemaIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).flatMap(value => {
    if (!value || typeof value !== "object" || typeof value.path !== "string" || !codes.has(value.code)) return [];
    const pieces = value.path.split(".").map((v: string) => /^\d{1,3}$/.test(v) ? Number(v) : v);
    const path = value.path === "output" ? "output" : intakeSchemaPath(pieces);
    return [{ path, code: value.code,
      ...(Number.isSafeInteger(value.minimum) ? { minimum: value.minimum } : {}),
      ...(Number.isSafeInteger(value.maximum) ? { maximum: value.maximum } : {}) }];
  });
}
