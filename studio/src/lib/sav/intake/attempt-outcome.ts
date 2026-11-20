/** SAV-120 (N7 fix 3): why an analysis attempt ended without a decision, as closed codes only.
 * The run payload (and the journal copies of it) holds the whole input and can exceed the diagnostic
 * read bound (256 KB): its traces are then unreadable and an exhaustion cannot say why. This compact
 * summary is journalled next to it ("attempt_outcome"), in the shape the diagnostic projector already
 * reads ({ reason, traces }). Every value is a closed code, a known enum or a byte count: never a quote,
 * a model output, an exception message, an address or any customer text. */
export const SAV_INTAKE_ATTEMPT_OUTCOME_KIND = "attempt_outcome";

const technicalCode = /^(?:SAV_[A-Z0-9_]{1,90}|HUBSPOT_HTTP_\d{3})$/;
const methods = new Set(["analyseMessage", "assessIdentity", "assessIssues"]);
const phases = new Set(["understanding", "ticket_matching", "accepted_semantics", "forwarded_origin_gate", "automation_gate", "noise_filter"]);
const operations = new Set(["email_lookup", "contact", "direct_associations", "contact_tickets", "ticket_history"]);
const statuses = new Set(["partial", "failed"]);
const validationReasons = new Set(["unknown_anchor", "wrong_anchor_source", "ambiguous_quote_format", "unknown_source", "excerpt_not_in_source",
  "required_source_missing", "message_id_mismatch", "registration_source_invalid", "output_schema_invalid", "visual_structure_invalid"]);
const validationStages = new Set(["sanitize_wire", "visual_normalize", "decode", "final_schema", "evidence"]);
const readReasons = new Set(["request_limit", "operation_forbidden", "partial_response", "total_mismatch", "pagination_cycle", "page_limit", "archived_contact",
  "aliases_unavailable", "batch_limit", "partial_batch", "conflicting_contact", "contact_limit", "cancelled", "read_unavailable", "ticket_limit",
  "ticket_membership_conflict", "ticket_content_unavailable", "history_limit", "history_date_unknown", "history_body_unavailable", "wrong_contact"]);
const contextStages = new Set(["catalogue", "data", "wire"]);

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const pick = (v: unknown, allowed: ReadonlySet<string>) => typeof v === "string" && allowed.has(v) ? v : null;
const code = (v: unknown) => typeof v === "string" && (technicalCode.test(v) || readReasons.has(v)) ? v : null;
const bytes = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

export type IntakeAttemptOutcome = { reason: string | null; traces: Array<Record<string, unknown>> };

/** The last failing steps of an attempt (at most 3), allow-listed field by field. */
export function intakeAttemptOutcome(payload: { reason?: unknown; traces?: unknown }): IntakeAttemptOutcome {
  const failing = (Array.isArray(payload.traces) ? payload.traces : []).map(object)
    .filter(t => t.accepted === false || statuses.has(String(t.status)) || t.refused === true || t.phase === "forwarded_origin_gate");
  return {
    reason: code(payload.reason),
    traces: failing.slice(-3).map(t => {
      const validation = object(t.validationFailure), limit = object(t.contextLimit);
      return {
        method: pick(t.method, methods), phase: pick(t.phase, phases), operation: pick(t.operation, operations), status: pick(t.status, statuses),
        accepted: t.accepted === false ? false : null, errorCode: code(t.errorCode), reason: code(t.reason),
        ...(Object.keys(validation).length ? { validationFailure: { reason: pick(validation.reason, validationReasons), stage: pick(validation.stage, validationStages) } } : {}),
        ...(contextStages.has(String(limit.stage)) ? { contextLimit: { stage: String(limit.stage), bytes: bytes(limit.bytes), limitBytes: bytes(limit.limitBytes) } } : {}),
      };
    }),
  };
}
