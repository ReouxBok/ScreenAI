import { SAV_CASE_SENSITIVE_FAMILIES, type CaseRequestFamily, type CaseSnapshot } from "./case-types";
import type { CaseAdmissionStatus } from "./admission-policy";
import { caseAdmissionRefusalCode } from "./decision-contract";

/*
 * SAV-7 gate, evaluated before any lease, budget reservation or model call. Pure: it reads only
 * the snapshot and the admission it is given. Exclusions are decided here, never by a V2 call:
 * a finance or mixed case is not investigated in order to propose a handoff, it is not investigated.
 */

export type CaseInvestigationGate =
  | { open: true }
  | { open: false; reason: CaseInvestigationGateReason; detail?: string };

export type CaseInvestigationGateReason =
  /** Finance, cancellation, subscription, rights or identity anywhere in the case, including mixed cases. */
  | "excluded_sensitive"
  /** A human or an administrative hold owns the case; a new inbound never gives it back to the agent. */
  | "not_agent_owned"
  /** No admission, a negative one, or one staled by a newer input or policy (pole A `caseAdmissionStatus`). */
  | "admission_missing" | "admission_not_positive" | "admission_stale"
  /** Nothing left for the agent to work on. */
  | "no_open_request";

export const caseInvestigationGateLabels: Record<CaseInvestigationGateReason, string> = {
  excluded_sensitive: "Demande sensible (finance, résiliation, abonnement, droits ou identité) : dossier réservé à l'équipe, aucune investigation V2.",
  not_agent_owned: "Dossier détenu par un humain ou en pause administrative : aucune investigation V2.",
  admission_missing: "Aucune admission du dossier pour l'agent : qualification par l'équipe avant toute investigation.",
  admission_not_positive: "Dossier non admis pour l'agent : il reste à l'équipe, aucune investigation V2.",
  admission_stale: "Admission périmée par une entrée plus récente ou une nouvelle politique : à réévaluer avant toute investigation.",
  no_open_request: "Aucune demande ouverte : rien à investiguer.",
};

const sensitive = (family: CaseRequestFamily) => (SAV_CASE_SENSITIVE_FAMILIES as readonly string[]).includes(family);

export function caseInvestigationGate(snapshot: CaseSnapshot, admission: CaseAdmissionStatus | null): CaseInvestigationGate {
  // Sensitivity first: its reason must stay visible even when another condition would also close the gate.
  const families = snapshot.body.openRequests.map(row => row.family).filter(sensitive);
  if (snapshot.sensitivity !== "none" || families.length)
    return { open: false, reason: "excluded_sensitive", detail: [...new Set([snapshot.sensitivity, ...families].filter(value => value !== "none"))].sort().join(",") };
  if (snapshot.owner !== "agent") return { open: false, reason: "not_agent_owned", detail: snapshot.owner };
  const refused = caseAdmissionRefusalCode(admission);
  if (refused) return { open: false, reason: refused, ...(admission?.admitted === false ? { detail: admission.reason } : {}) };
  if (!snapshot.body.openRequests.some(row => row.status === "open")) return { open: false, reason: "no_open_request" };
  return { open: true };
}
