import type { CaseDecisionRejection, CaseDecisionRejectionCode } from "./decision-contract";

/*
 * What a validator rejection means for the next step. Pure table over rejection codes: no text is read,
 * so it adds no wording rule. The validator still decides what is refused; this only says whether a bounded
 * correction can help and what to do when it cannot. A security refusal is never relaxed here: a corrected
 * proposal is validated again from scratch.
 */

export type CaseDecisionRefusalKind =
  /** Our own read of the case is inconsistent: a technical wait, never a customer or team need. */
  | "technical"
  /** The case or its admission changed under the decision: re-read the current version. */
  | "stale"
  /** The case itself forbids agent action (not owned, not admitted, sensitive): stop, the team keeps it. */
  | "forbidden_case"
  /** A rule forbids this action or content (secret requested, unsupported impossibility, closing without proof...). */
  | "forbidden_action"
  /** The decision lacks a valid source or an answer from the customer: ask, wait or hand off with what is missing. */
  | "missing_information"
  /** Shape or reference error the model can fix with the exact codes and paths. */
  | "repairable_format";

export const caseDecisionRefusalKinds: Record<CaseDecisionRejectionCode, CaseDecisionRefusalKind> = {
  context_invalid: "technical",
  admission_stale: "stale",
  case_not_agent_owned: "forbidden_case",
  admission_missing: "forbidden_case",
  admission_not_positive: "forbidden_case",
  sensitive_requires_human: "forbidden_case",
  sensitive_request_downgraded: "forbidden_case",
  credential_requested: "forbidden_action",
  credential_request_pattern: "forbidden_action",
  account_advice_forbidden: "forbidden_action",
  access_link_invalid: "forbidden_action",
  // Pilot ACCÈS: the scope forbids answering from this source; asking or handing off stays possible.
  access_scope_missing: "forbidden_action",
  access_source_out_of_scope: "forbidden_action",
  access_source_version_out_of_scope: "forbidden_action",
  access_source_orient_only: "forbidden_action",
  pilot_family_out_of_scope: "forbidden_action",
  impossibility_without_valid_source: "forbidden_action",
  request_resolved_without_evidence: "forbidden_action",
  resolution_evidence_invalid: "forbidden_action",
  other_requests_open: "forbidden_action",
  resolution_quote_not_found: "forbidden_action",
  // Our read of the message failed: a technical wait, not a reason to ask the customer or the team.
  resolution_quote_unverifiable: "technical",
  request_not_open: "forbidden_action",
  knowledge_not_valid: "missing_information",
  knowledge_conflict: "missing_information",
  // The request has no card of its own: cite one retrieved for it, ask, or hand off with what is missing.
  knowledge_not_linked_to_request: "missing_information",
  repeated_failed_procedure: "missing_information",
  question_already_pending: "missing_information",
  login_procedure_redundant: "missing_information",
  procedure_step_repeated: "missing_information",
  proposal_schema_invalid: "repairable_format",
  // The model receives the version it must echo: a mismatch is its error; a real change is caught by the re-read.
  case_version_stale: "repairable_format",
  observe_only_with_reply: "repairable_format",
  request_reference_unknown: "repairable_format",
  request_duplicate: "repairable_format",
  open_request_omitted: "repairable_format",
  source_reference_unknown: "repairable_format",
  customer_statement_as_observed: "repairable_format",
  knowledge_reference_unknown: "repairable_format",
  knowledge_revision_mismatch: "repairable_format",
  knowledge_superseded: "repairable_format",
  question_already_answered: "repairable_format",
  new_fact_reference_invalid: "repairable_format",
  access_link_missing: "repairable_format",
  handoff_report_reference_invalid: "repairable_format",
  handoff_conflict_sources_missing: "repairable_format",
};

/** Most decisive first: a case-level stop outranks anything a correction could fix. */
const PRIORITY: readonly CaseDecisionRefusalKind[] = ["technical", "stale", "forbidden_case", "forbidden_action", "missing_information", "repairable_format"];
/** Kinds where another proposal on the same read can help. The others stop the correction loop at once. */
const CORRECTABLE = new Set<CaseDecisionRefusalKind>(["forbidden_action", "missing_information", "repairable_format"]);

export type CaseDecisionNextStep = "technical_wait" | "reread_current_version" | "team" | "observe_and_review" | "ask_wait_or_handoff" | "review_model_output";

export const caseDecisionNextStepLabels: Record<CaseDecisionNextStep, string> = {
  technical_wait: "Attente technique : la lecture du dossier est incohérente et doit être corrigée avant reprise. Ce n'est pas un besoin de l'équipe ni du client.",
  reread_current_version: "Le dossier ou son admission a changé : relire la version courante et réévaluer avant toute décision.",
  team: "Dossier réservé à l'équipe ou non admis pour l'agent : aucune action de l'agent.",
  observe_and_review: "Action refusée par une règle, refus conservé : la décision doit changer d'action. À relire en observation.",
  ask_wait_or_handoff: "Information manquante : poser une question ciblée, attendre la réponse déjà demandée, ou transférer en listant ce qui manque.",
  review_model_output: "Format toujours invalide après les corrections permises : relire la sortie du modèle. Les lectures et faits vérifiés restent conservés.",
};
const NEXT_STEP: Record<CaseDecisionRefusalKind, CaseDecisionNextStep> = {
  technical: "technical_wait", stale: "reread_current_version", forbidden_case: "team",
  forbidden_action: "observe_and_review", missing_information: "ask_wait_or_handoff", repairable_format: "review_model_output",
};

export type CaseDecisionRefusal = {
  kind: CaseDecisionRefusalKind;
  correctable: boolean;
  nextStep: CaseDecisionNextStep;
  /** Every kind present, in priority order, so that a refusal recovered later stays measurable. */
  kinds: CaseDecisionRefusalKind[];
  codes: CaseDecisionRejectionCode[];
};

export function classifyCaseDecisionRefusal(rejections: readonly Pick<CaseDecisionRejection, "code">[]): CaseDecisionRefusal | null {
  if (!rejections.length) return null;
  const present = new Set(rejections.map(row => caseDecisionRefusalKinds[row.code]));
  const kinds = PRIORITY.filter(kind => present.has(kind));
  const kind = kinds[0];
  return { kind, correctable: CORRECTABLE.has(kind), nextStep: NEXT_STEP[kind], kinds, codes: [...new Set(rejections.map(row => row.code))] };
}
