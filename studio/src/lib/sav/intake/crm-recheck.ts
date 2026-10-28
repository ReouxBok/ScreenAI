import type { CrmDeltaDiagnostic } from "./execution-context";

/** Bounds reused from the executor, not new limits: 5 is the effect reconciliation
 * bound (reconcileAttempts < 5) and 60 s the existing waiting cadence, doubled per
 * recheck (1, 2, 4, 8 min). About a quarter of an hour, then a person decides. */
export const CRM_RECHECK_POLICY = Object.freeze({ maxRechecks: 5, baseDelayMs: 60_000 });
/** Journal kinds that carry the schedule; the selector reads them in SQL. */
export const CRM_RECHECK_JOURNAL = "crm_recheck", CRM_REVIEW_JOURNAL = "crm_review_required";
/** Kinds that open a new episode: progress or a new interpretation resets the counter. */
export const CRM_EPISODE_JOURNALS = ["admitted", "compatible_version_adopted"] as const;

export type CrmRecheckDecision = { decision: "recheck" | "human"; cause: "business_change" | "unattributed_email" | "unknown" | "read_incomplete" | "deterministic" };
/** Which waiting passes follow the CRM schedule. A change of a fact the decision relied
 * on goes to a person at once; a read failure, an unattributed email or an unknown
 * detail is re-read a bounded number of times. Anything else keeps its current path. */
export function crmRecheckDecision(reason: string, delta?: CrmDeltaDiagnostic): CrmRecheckDecision | null {
  if (delta) {
    const cause = delta.classification ?? "unknown";
    return { decision: cause === "business_change" ? "human" : "recheck", cause };
  }
  if (/^SAV_INTAKE_EXECUTION_CRM_READ_/.test(reason)) return { decision: "recheck", cause: "read_incomplete" };
  if (/^SAV_INTAKE_EXECUTION_(?:ADDRESS_PROOF_UNRESOLVED|ASSOCIATION_INCOMPLETE)$/.test(reason)) return { decision: "human", cause: "deterministic" };
  return null;
}
export const crmRecheckDelayMs = (attempt: number) => CRM_RECHECK_POLICY.baseDelayMs * 2 ** Math.max(0, attempt - 1);
export type CrmRecheckState = { attempts: number; max: number; humanRequired: boolean; nextAt: string | null; cause: CrmRecheckDecision["cause"] };
