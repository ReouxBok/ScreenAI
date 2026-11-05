import { SAV_CASE_ADMISSION_REASONS, SAV_CASE_HUMAN_PHASES, type CaseAdmissionReason, type CaseEvent, type CasePhase } from "./case-types";

/** Q11 (decision Ugo 28/10): the launch thresholds count, per family and with failures in the
 * denominator, technical blocks (under 2 %) and unjustified transfers (at most 5 %, judged by a
 * human among business transfers). Every way a case leaves the agent falls in exactly one
 * category here, so both rates come from the journal without counting anything twice. A
 * human's own initiative is not a transfer by the agent. Pure: no database, no model. */
export const SAV_CASE_EXIT_CATEGORIES = ["technical_block", "business_transfer", "human_initiative", "unclassified"] as const;
export type CaseExitCategory = typeof SAV_CASE_EXIT_CATEGORIES[number];

/** Codes a handoff or a system takeover uses (SAV-7). Any other code counts as `unclassified`:
 * visible in the measure, never folded silently into a rate. */
export const SAV_CASE_EXIT_REASONS = {
  // Q5: a full case goes to the team with this visible reason, never retried.
  body_limit_reached: "technical_block",
  effect_uncertain: "technical_block",
  crm_read_failed: "technical_block",
  model_unavailable: "technical_block",
  out_of_scope: "business_transfer",
  sensitive_detected: "business_transfer",
  rights_not_proven: "business_transfer",
  customer_asked_human: "business_transfer",
  // A human became the HubSpot owner (owner-attribution.ts).
  hubspot_owner_human: "human_initiative",
} as const satisfies Record<string, Exclude<CaseExitCategory, "unclassified">>;
export type CaseExitReason = keyof typeof SAV_CASE_EXIT_REASONS;

/** An admission withdrawn by the server: a missing or invalid policy and an incomplete CRM read
 * are technical; every other reason is a business transfer. */
export const SAV_CASE_ADMISSION_EXIT_CATEGORIES: Record<Exclude<CaseAdmissionReason, "admitted">, "technical_block" | "business_transfer"> = {
  case_sensitive: "business_transfer", sensitive_family: "business_transfer", mixed_sensitive: "business_transfer",
  confirmed_bug: "business_transfer", out_of_capability: "business_transfer",
  policy_missing: "technical_block", policy_invalid: "technical_block",
  no_request: "business_transfer", family_unknown: "business_transfer", identity_unconfirmed: "business_transfer",
  context_incomplete: "technical_block",
  family_not_admitted: "business_transfer", qualification_unproven: "business_transfer",
};

/** Agent phases that stop the case without a transfer: counted as technical blocks too. */
export const SAV_CASE_BLOCKED_PHASES = ["blocked_technical", "blocked_reconcile"] as const satisfies readonly CasePhase[];

const exitReason = (code: unknown): CaseExitCategory =>
  typeof code === "string" && Object.hasOwn(SAV_CASE_EXIT_REASONS, code) ? SAV_CASE_EXIT_REASONS[code as CaseExitReason] : "unclassified";

/** Category of one journal event, or null when it is not a case leaving the agent (any other
 * event, a hold, a release or hand-back to the agent, a held human case released to the team). */
export function classifyCaseExit(event: Pick<CaseEvent, "kind" | "detail">): CaseExitCategory | null {
  if (event.kind !== "owner_changed") return null;
  const detail = event.detail ?? {};
  // A hold freezes the phase: released to the team from an agent phase, the case left the agent.
  if (detail.transition === "hold_release" && detail.to === "human") {
    return typeof detail.fromPhase === "string" && !(SAV_CASE_HUMAN_PHASES as readonly string[]).includes(detail.fromPhase) ? "human_initiative" : null;
  }
  if (detail.from !== "agent" || detail.to !== "human") return null;
  if (detail.transition === "admission_withdrawn") {
    const reason = Array.isArray(detail.reasons) ? detail.reasons[0] : undefined;
    return typeof reason === "string" && reason !== "admitted" && (SAV_CASE_ADMISSION_REASONS as readonly string[]).includes(reason)
      ? SAV_CASE_ADMISSION_EXIT_CATEGORIES[reason as Exclude<CaseAdmissionReason, "admitted">] : "unclassified";
  }
  const actor = (detail.actor as { type?: unknown } | undefined)?.type;
  if (detail.transition === "handoff") return actor === "agent" ? exitReason(detail.reason) : actor === "human" ? "human_initiative" : "unclassified";
  if (detail.transition === "human_takeover") return actor === "human" ? "human_initiative" : actor === "system" ? exitReason(detail.reason) : "unclassified";
  return "unclassified";
}
