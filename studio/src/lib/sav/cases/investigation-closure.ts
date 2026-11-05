import { z } from "zod";
import type { CaseDecisionProposal, CaseDecisionValidationContext, CaseResolutionEvidence } from "./decision-contract";

/*
 * Second, independent reading of a closure (Ugo, 27/10/2026). The validator proves that the quoted words exist
 * in a later customer message with no human reply in between; it cannot tell "it works, thanks" from "thanks for
 * passing it on". A short separate question answers that, per request, before any closure is planned.
 * Every closure is soft: the ticket is closed with a message that leaves the door open, and a customer who says
 * it still fails is reopened by V1 under its existing rules. Pure helpers; the call goes through the same model port.
 */

export const CASE_RESOLUTION_VERDICTS = ["resolved", "thanks_for_transfer", "not_resolved", "unclear"] as const;
export type CaseResolutionVerdict = typeof CASE_RESOLUTION_VERDICTS[number];

export const caseResolutionCheckSchema = z.object({
  verdicts: z.array(z.object({ requestId: z.string().min(1).max(200), verdict: z.enum(CASE_RESOLUTION_VERDICTS) }).strict()).min(1).max(6),
}).strict();

export type CaseClosureItem = { requestId: string; evidence: CaseResolutionEvidence };
export type CaseClosurePlan = "soft_close" | "no_close_transfer_thanks" | "no_close_not_resolved" | "ask_confirmation";
export type CaseClosureCheck = {
  plan: CaseClosurePlan;
  verdicts: Array<{ requestId: string; verdict: CaseResolutionVerdict }>;
  /** Why the plan is not a closure without a verdict (second reading impossible or unreadable). */
  reason: "checked" | "no_call_left" | "check_unreadable";
};

export const caseClosurePlanLabels: Record<CaseClosurePlan, string> = {
  soft_close: "Problème résolu selon les deux lectures : clôture douce (ticket fermé, message qui laisse la porte ouverte).",
  no_close_transfer_thanks: "Le client remercie pour le transfert ou la prise en charge, pas pour une résolution : aucune clôture.",
  no_close_not_resolved: "Le message indique que le problème n'est pas résolu : aucune clôture.",
  ask_confirmation: "Résolution pas certaine : demander au client de confirmer que tout fonctionne, sans clôturer.",
};

/** Every request the decision closes: the explicit confirmation and any request marked resolved along the way. */
export function caseClosureItems(decision: CaseDecisionProposal, context: Pick<CaseDecisionValidationContext, "requests">): CaseClosureItem[] {
  const items: CaseClosureItem[] = [];
  if (decision.nextAction.kind === "confirm_resolution")
    for (const { requestId, ...evidence } of decision.nextAction.evidence) items.push({ requestId, evidence });
  for (const request of decision.understanding.requests) {
    const before = context.requests.find(row => row.id === request.id);
    if (request.status === "resolved" && request.resolvedBy && before?.status === "open" && !items.some(row => row.requestId === request.id))
      items.push({ requestId: request.id, evidence: request.resolvedBy });
  }
  return items;
}

/** No closure unless every closed request is read as resolved; the most cautious verdict wins. */
export function caseClosurePlan(items: readonly CaseClosureItem[], output: unknown): CaseClosureCheck {
  const parsed = caseResolutionCheckSchema.safeParse(output);
  if (!parsed.success) return { plan: "ask_confirmation", verdicts: [], reason: "check_unreadable" };
  const verdicts = items.map(item => ({ requestId: item.requestId, verdict: parsed.data.verdicts.find(row => row.requestId === item.requestId)?.verdict ?? "unclear" as const }));
  const has = (verdict: CaseResolutionVerdict) => verdicts.some(row => row.verdict === verdict);
  const plan: CaseClosurePlan = has("not_resolved") ? "no_close_not_resolved" : has("thanks_for_transfer") ? "no_close_transfer_thanks"
    : has("unclear") ? "ask_confirmation" : "soft_close";
  return { plan, verdicts, reason: "checked" };
}
