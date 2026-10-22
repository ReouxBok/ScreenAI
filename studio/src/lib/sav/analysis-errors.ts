import { ZodError } from "zod";
import { SAV_AGENT_TOOL_NAMES } from "./agent/contracts";
import type { SavValidationDiagnostic } from "./validation-diagnostics";

/** Only application-owned codes may leave a provider boundary; never its body/message. */
const validationCodes = new Set([
  "SAV_UNKNOWN_EVIDENCE", "SAV_CITATION_NOT_DECLARED", "SAV_RESPONSE_KIND_MISMATCH",
  "SAV_UNGROUNDED_REPLY", "SAV_CITATION_MUST_USE_KNOWLEDGE", "SAV_CITATION_REQUIRES_RESOLUTION_CARD",
  "SAV_CITATION_QUOTE_MISMATCH", "SAV_CITATION_RELEVANCE_TOO_LOW", "SAV_CITATION_EXPIRED",
  "SAV_CITATION_STALE", "SAV_CONTRADICTORY_RESOLUTION_CARDS", "SAV_TOOL_BUDGET_EXCEEDED",
  "SAV_KNOWLEDGE_REVISION_CHANGED", "SAV_ADK_EMPTY_OUTPUT", "SAV_ADK_TIMEOUT",
  "SAV_TOOL_RATE_LIMITED", "SAV_TOOL_TIMEOUT", "SAV_AI_KEY_MISSING",
  "SAV_AI_INVALID_MODEL", "SAV_AI_BUDGET_EXCEEDED", "SAV_AI_INVALID_JSON", "SAV_AI_INVALID_SCHEMA", "SAV_AI_TIMEOUT", "SAV_AI_MEDIA_UNSUPPORTED_MODEL", "SAV_AI_MEDIA_ADMISSION_REQUIRED",
  "SAV_AI_INVALID_RESPONSE", "SAV_AI_OUTPUT_BLOCKED", "SAV_AI_OUTPUT_TRUNCATED",
  "SAV_AI_OUTPUT_INCOMPLETE", "SAV_AI_EMPTY_OUTPUT", "SAV_CONTEXT_UNAVAILABLE",
  "SAV_AI_ANALYSIS_DISABLED", "SAV_UNDERSTANDING_INVALID_EVIDENCE", "SAV_UNDERSTANDING_REPAIR_REJECTED", "SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING",
  "SAV_REPLY_COHERENCE_REJECTED",
  "SAV_CITATION_VERSION_REQUIRED", "SAV_REPLY_OUTSIDE_REQUEST_PLAN", "SAV_REQUEST_PLAN_COVERAGE_REQUIRED", "SAV_PLAYBOOK_UNAVAILABLE", "SAV_COMPACT_CONTEXT_BLOCKED",
]);

export function savAnalysisErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (validationCodes.has(message) || /^SAV_AI_HTTP_[1-5]\d{2}$/.test(message)) return message;
  if (SAV_AGENT_TOOL_NAMES.some(name => message === `SAV_REQUIRED_TOOL_UNAVAILABLE:${name}`)) return message;
  if (error instanceof ZodError) return "SAV_AI_INVALID_SCHEMA";
  if (error instanceof SyntaxError) return "SAV_AI_INVALID_JSON";
  if (error instanceof Error && error.name === "AbortError") return "SAV_AI_TIMEOUT";
  return "SAV_AI_GENERATION_FAILED";
}

export type SavAnalysisDiagnostic = {
  phase: "knowledge" | "generation";
  errorCode: string;
  validation?: SavValidationDiagnostic;
  resolved?: boolean;
};

export function savPrimaryAnalysisDiagnostic(diagnostics: SavAnalysisDiagnostic[] = []) {
  const active = diagnostics.filter(item => !item.resolved);
  return active.find((item) => item.phase === "generation") ?? active[0];
}
