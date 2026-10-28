import type { IntakeModelTrace } from "./model-readers";
import { intakeSchemaPath, publicIntakeSchemaIssues } from "./schema-diagnostics";
const reasons = new Set(["unknown_anchor", "wrong_anchor_source", "ambiguous_quote_format", "unknown_source", "excerpt_not_in_source",
  "required_source_missing", "message_id_mismatch", "registration_source_invalid", "output_schema_invalid", "visual_structure_invalid"]);
const stages = new Set(["sanitize_wire", "visual_normalize", "decode", "final_schema", "evidence"]);
/** Private admin report, still allowlisted: no arbitrary model/validator text or dynamic keys. */
export function comparisonValidationDiagnostics(traces: readonly IntakeModelTrace[]) {
  return traces.filter(t => !t.accepted).slice(0, 8).map(t => {
    const failure = t.validationFailure;
    return { phase: t.phase === "ticket_matching" ? "ticket_matching" : "understanding",
      code: t.errorCode && /^SAV_[A-Z0-9_]+$/.test(t.errorCode) ? t.errorCode : "SAV_INTAKE_MODEL_OUTPUT_REJECTED",
      ...(failure && reasons.has(failure.reason) ? { validationFailure: {
        reason: failure.reason, path: intakeSchemaPath(failure.path.split(".").map(p => /^\d{1,3}$/.test(p) ? Number(p) : p)),
        ...(failure.stage && stages.has(failure.stage) ? { stage: failure.stage } : {}),
        ...(failure.issues ? { issues: publicIntakeSchemaIssues(failure.issues) } : {}),
      } } : {}),
    };
  });
}
