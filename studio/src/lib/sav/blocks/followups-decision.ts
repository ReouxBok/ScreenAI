import { caseSensitiveFamiliesInText, normalizeSensitiveText } from "../cases/sensitive-words";
import type { SavBlockMode } from "./block-attribution";

export type FollowupsContext = Readonly<{
  mode?: SavBlockMode;
  historyComplete?: boolean;
  /** Full message review includes signatures, quoted text and attachments. Missing assessments fail closed. */
  review?: Readonly<{ fullMessageReviewed: boolean; newRequest: boolean; sensitive: boolean; persistentProblem: boolean }>;
  needs?: readonly Readonly<{ id: string; status: "open" | "resolved"; evidence?: Readonly<{ ref: string; verified: boolean }> }>[];
}>;
export type FollowupsDecision = Readonly<{
  action: "close_proposal" | "no_action" | "handoff";
  reason: "block_off" | "sensitive" | "new_request" | "persistent_problem" | "history_incomplete" |
    "review_incomplete" | "unresolved_or_unproven" | "awaiting_customer" | "ambiguous_message" | "resolution_proven";
}>;

// Entire-message allowlist, deliberately narrow. Never strip signatures or suffixes to find a thank-you.
const acknowledgement = /^(?:merci(?: beaucoup| pour votre aide| pour votre retour)?|c'est bon merci|tout fonctionne merci|bien recu(?: merci)?|accuse de reception|probleme resolu merci)$/;
const waiting = /^(?:je reviens vers vous(?: plus tard)?|je vous tiens au courant|pas de nouvelles|je n'ai pas de nouvelles)$/;

/** Pure offline grid. Assessments and evidence are supplied facts, not verified by this function.
 * Even automatic mode returns only a proposal: no CRM, message, timer or ticket mutation.
 */
export function decideSavFollowup(text: string, context: FollowupsContext = {}): FollowupsDecision {
  if (context.mode !== "shadow" && context.mode !== "automatic") return { action: "no_action", reason: "block_off" };
  const review = context.review;
  if (caseSensitiveFamiliesInText(text).length || review?.sensitive === true) return { action: "handoff", reason: "sensitive" };
  if (review?.newRequest === true) return { action: "handoff", reason: "new_request" };
  if (review?.persistentProblem === true) return { action: "handoff", reason: "persistent_problem" };
  if (context.historyComplete !== true) return { action: "handoff", reason: "history_incomplete" };
  if (review?.fullMessageReviewed !== true || review.newRequest !== false || review.sensitive !== false || review.persistentProblem !== false) {
    return { action: "handoff", reason: "review_incomplete" };
  }
  const value = normalizeSensitiveText(text).trim().replace(/[.!…]+$/u, "").trim().replace(/\s+/g, " ");
  if (waiting.test(value)) return { action: "no_action", reason: "awaiting_customer" };
  if (!acknowledgement.test(value)) return { action: "handoff", reason: "ambiguous_message" };
  const needs = context.needs;
  if (!needs?.length || new Set(needs.map(need => need.id.trim())).size !== needs.length || needs.some(need =>
    !need.id.trim() || need.status !== "resolved" || need.evidence?.verified !== true || !need.evidence.ref.trim())) {
    return { action: "no_action", reason: "unresolved_or_unproven" };
  }
  return { action: "close_proposal", reason: "resolution_proven" };
}
