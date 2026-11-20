import {
  SAV_CASE_ACCESS_BLOCK_ID, SAV_CASE_ADMISSION_REASONS, SAV_CASE_ADMISSION_REVISION, SAV_CASE_ADMISSION_TEAM_REASONS, SAV_CASE_SENSITIVE_FAMILIES,
  SAV_SMART_ENTRY_ADMISSION, SAV_SMART_ENTRY_POLICY_REVISION, caseAdmissionPolicySchema, caseAdmissionQualificationSchema, caseSensitivityForFamily, isSmartSupportProvenance,
  type CaseAdmissionDecision, type CaseAdmissionPolicy, type CaseAdmissionQualification, type CaseAdmissionReason,
  type CaseRequestFamily, type CaseSensitivity, type CaseSnapshot,
} from "./case-types";

export type CaseAdmissionInput = { policy: unknown; qualification: CaseAdmissionQualification };

const SENSITIVITY_RANK: Record<CaseSensitivity, number> = { none: 0, finance: 1, cancellation: 2 };
export const maxCaseSensitivity = (a: CaseSensitivity, b: CaseSensitivity) => SENSITIVITY_RANK[b] > SENSITIVITY_RANK[a] ? b : a;
const isSensitive = (family: string) => (SAV_CASE_SENSITIVE_FAMILIES as readonly string[]).includes(family);

function provenAdmissible(request: CaseAdmissionQualification["requests"][number], policy: CaseAdmissionPolicy) {
  const { provenance, family } = request;
  if (provenance.kind === "human") return true;
  if (provenance.kind === "intake_hint" || provenance.kind === "team_part") return false;
  return policy.qualifiedRules.some(rule => rule.ruleId === provenance.ruleId && rule.revision === provenance.revision && (rule.families as readonly string[]).includes(family)
    && approvedBlock(rule.blockId) === approvedBlock(provenance.blockId));
}
/** Treatment blocks (11/11): the block a rule was approved for, and the block its provenance names, must be the same. No `blockId` on either
 * side is Access's (every policy and provenance written before blocks), so Access keeps today's exact semantics; another block's rule admits
 * only under a policy entry that carries that very block, never by an edit of the configured rules alone. */
const approvedBlock = (blockId: string | undefined) => blockId ?? SAV_CASE_ACCESS_BLOCK_ID;

/** Whether a human or a rule the policy lists proves this request's family (v8: the family a
 * relayed request is recorded with). A model hint proves nothing, and neither does `unknown`. */
export function caseRequestFamilyProven(request: CaseAdmissionQualification["requests"][number], policy: unknown) {
  if (request.family === "unknown") return false;
  if (request.provenance.kind === "human") return true;
  const parsed = caseAdmissionPolicySchema.safeParse(policy);
  return parsed.success && provenAdmissible(request, parsed.data);
}

/** Pure server admission (SAV-44). Exclusions are checked before the positive list, and
 * every applicable reason is kept in contract order. A malformed qualification throws:
 * there is no silent default. */
export function decideCaseAdmission(input: CaseAdmissionInput & { caseSensitivity: CaseSensitivity }): CaseAdmissionDecision {
  const parsed = caseAdmissionQualificationSchema.safeParse(input.qualification);
  if (!parsed.success) throw Error("SAV_CASE_ADMISSION_INPUT_INVALID");
  const qualification = parsed.data;
  if (qualification.requests.some(request => isSmartSupportProvenance(request.provenance))) return decideSmartCaseAdmission(qualification, input.caseSensitivity);
  const policy = input.policy === null || input.policy === undefined ? null : caseAdmissionPolicySchema.safeParse(input.policy);
  const families = qualification.requests.map(request => request.family);
  const sensitivity = families.reduce<CaseSensitivity>((current, family) =>
    family === "unknown" ? current : maxCaseSensitivity(current, caseSensitivityForFamily(family) ?? "none"), input.caseSensitivity);

  const reasons = new Set<CaseAdmissionReason>();
  if (input.caseSensitivity !== "none") reasons.add("case_sensitive");
  if (families.some(isSensitive)) {
    reasons.add("sensitive_family");
    if (families.some(family => !isSensitive(family))) reasons.add("mixed_sensitive");
  }
  for (const signal of qualification.teamSignals) reasons.add(signal.kind);
  if (!policy) reasons.add("policy_missing");
  else if (!policy.success) reasons.add("policy_invalid");
  // SAV-92 (Ugo 14/11): a request no active block covers (`team_part`, read by the entry) is the team's part of an admitted mail. It is never what admits:
  // the other requests must all be proven, and a mail with team parts only has no request for the agent. Exclusions above still read every request.
  const handled = qualification.requests.filter(request => request.provenance.kind !== "team_part");
  if (!handled.length) reasons.add("no_request");
  if (handled.some(request => request.family === "unknown")) reasons.add("family_unknown");
  if (qualification.identity.status !== "confirmed") reasons.add("identity_unconfirmed");
  if (qualification.crmContext !== "complete") reasons.add("context_incomplete");
  if (policy?.success) {
    const admitted = policy.data.admittedFamilies as readonly string[];
    const known = handled.filter(request => request.family !== "unknown" && !isSensitive(request.family));
    if (known.some(request => !admitted.includes(request.family))) reasons.add("family_not_admitted");
    if (known.some(request => admitted.includes(request.family) && !provenAdmissible(request, policy.data))) reasons.add("qualification_unproven");
  }
  if (!reasons.size) reasons.add("admitted");

  const ordered = SAV_CASE_ADMISSION_REASONS.filter(reason => reasons.has(reason));
  const target = SAV_CASE_ADMISSION_TEAM_REASONS.includes(ordered[0]!) ? "team" : ordered[0] === "admitted" ? "agent" : "qualification";
  return {
    revision: SAV_CASE_ADMISSION_REVISION, target, reasons: ordered,
    nextStep: target === "agent" ? "none" : target === "team" ? "team_takeover" : "qualify",
    families: [...new Set(families)] as (CaseRequestFamily | "unknown")[], sensitivity,
    policyRevision: policy?.success ? policy.data.revision : null,
  };
}

/**
 * SAV-117 (N4): the admission of a mail the smart entry read (`SAV_V2_ENTRY_SMART=on`), recognised by its provenance only, so every re-evaluation of the stored
 * qualification decides the same. Kept from V1→V2: sensitivity of the case and of every family (finance, cancellation... and mixed mails: the team), team
 * signals, at least one request, identity confirmed, CRM complete. Not read: the block, the word list, the approved policy (recorded as `smart-entry.v1`).
 * A request that is neither the smart entry's nor a team part makes the whole decision `qualification_unproven`: the two entries are never mixed.
 */
function decideSmartCaseAdmission(qualification: CaseAdmissionQualification, caseSensitivity: CaseSensitivity): CaseAdmissionDecision {
  const families = qualification.requests.map(request => request.family);
  const sensitivity = families.reduce<CaseSensitivity>((current, family) =>
    family === "unknown" ? current : maxCaseSensitivity(current, caseSensitivityForFamily(family) ?? "none"), caseSensitivity);
  const reasons = new Set<CaseAdmissionReason>();
  if (caseSensitivity !== "none") reasons.add("case_sensitive");
  if (families.some(isSensitive)) {
    reasons.add("sensitive_family");
    if (families.some(family => !isSensitive(family))) reasons.add("mixed_sensitive");
  }
  for (const signal of qualification.teamSignals) reasons.add(signal.kind);
  const handled = qualification.requests.filter(request => request.provenance.kind !== "team_part");
  if (!handled.length) reasons.add("no_request");
  if (handled.some(request => !isSmartSupportProvenance(request.provenance))) reasons.add("qualification_unproven");
  if (qualification.identity.status !== "confirmed") reasons.add("identity_unconfirmed");
  if (qualification.crmContext !== "complete") reasons.add("context_incomplete");
  if (!reasons.size) reasons.add("admitted");
  const ordered = SAV_CASE_ADMISSION_REASONS.filter(reason => reasons.has(reason));
  const target = SAV_CASE_ADMISSION_TEAM_REASONS.includes(ordered[0]!) ? "team" : ordered[0] === "admitted" ? "agent" : "qualification";
  return {
    revision: SAV_CASE_ADMISSION_REVISION, target, reasons: ordered,
    nextStep: target === "agent" ? "none" : target === "team" ? "team_takeover" : "qualify",
    families: [...new Set(families)] as (CaseRequestFamily | "unknown")[], sensitivity,
    policyRevision: SAV_SMART_ENTRY_POLICY_REVISION, admission: SAV_SMART_ENTRY_ADMISSION,
  };
}

export type CaseAdmissionStatus =
  | { admitted: true }
  | { admitted: false; reason: "owner_not_agent" | "no_admission" | "not_admitted" | "input_newer" | "policy_missing" | "policy_changed" };
/** What every V2 actor (decision validator, runner, timers, executor) checks before acting:
 * `owner = agent` alone is not enough. */
export function caseAdmissionStatus(snapshot: Pick<CaseSnapshot, "owner" | "admission" | "admissionInputVersion">, currentPolicyRevision: string | null,
  /** `SAV_V2_ENTRY_SMART=on` (`smart-entry-switch.ts`), read from the process by default: every actor runs in the process whose switch it obeys. */
  smartEntryOn: boolean = process.env.SAV_V2_ENTRY_SMART === "on"): CaseAdmissionStatus {
  if (snapshot.owner !== "agent") return { admitted: false, reason: "owner_not_agent" };
  if (!snapshot.admission) return { admitted: false, reason: "no_admission" };
  if (snapshot.admission.target !== "agent") return { admitted: false, reason: "not_admitted" };
  if (snapshot.admissionInputVersion > snapshot.admission.inputVersion) return { admitted: false, reason: "input_newer" };
  // SAV-123 (N8): a smart admission is decided under the entry's own fixed revision (`smart-entry.v1`), never under `SAV_V2_ADMISSION_POLICY_JSON` (contract
  // V1 → V2, line 4): it is admitted while `SAV_V2_ENTRY_SMART=on` and that revision is the code's. Switched off, it no longer matches the policy in force
  // (`policy_changed`), so every actor stops and the policy sweep gives the case back to the team, exactly as for any other policy change.
  if (smartEntryOn && snapshot.admission.admission === SAV_SMART_ENTRY_ADMISSION && snapshot.admission.policyRevision === SAV_SMART_ENTRY_POLICY_REVISION) return { admitted: true };
  if (currentPolicyRevision === null) return { admitted: false, reason: "policy_missing" };
  if (snapshot.admission.policyRevision !== currentPolicyRevision) return { admitted: false, reason: "policy_changed" };
  return { admitted: true };
}
