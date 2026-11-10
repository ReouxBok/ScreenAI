import { describe, expect, it } from "vitest";
import { caseDecisionRejectionLabels, type CaseDecisionRejectionCode } from "./decision-contract";
import { caseDecisionNextStepLabels, caseDecisionRefusalKinds, classifyCaseDecisionRefusal } from "./decision-recovery";

const codes = Object.keys(caseDecisionRejectionLabels) as CaseDecisionRejectionCode[];
const kindsOf = (...list: CaseDecisionRejectionCode[]) => classifyCaseDecisionRefusal(list.map(code => ({ code })));

describe("SAV-6 refusal typology", () => {
  it("classifies every rejection code, and only those", () => {
    expect(Object.keys(caseDecisionRefusalKinds).sort()).toEqual([...codes].sort());
  });
  it("keeps the four product families apart", () => {
    expect(kindsOf("proposal_schema_invalid")).toMatchObject({ kind: "repairable_format", correctable: true, nextStep: "review_model_output" });
    expect(kindsOf("credential_requested")).toMatchObject({ kind: "forbidden_action", correctable: true, nextStep: "observe_and_review" });
    expect(kindsOf("repeated_failed_procedure")).toMatchObject({ kind: "missing_information", correctable: true, nextStep: "ask_wait_or_handoff" });
    expect(kindsOf("context_invalid")).toMatchObject({ kind: "technical", correctable: false, nextStep: "technical_wait" });
  });
  it("stops at once on a case-level refusal, whatever else is wrong", () => {
    for (const code of ["sensitive_requires_human", "case_not_agent_owned", "admission_missing", "admission_not_positive", "sensitive_request_downgraded"] as const)
      expect(kindsOf("proposal_schema_invalid", code)).toMatchObject({ kind: "forbidden_case", correctable: false, nextStep: "team" });
    expect(kindsOf("credential_requested", "admission_stale")).toMatchObject({ kind: "stale", correctable: false, nextStep: "reread_current_version" });
  });
  it("never lets a fixable format error hide a forbidden action, and keeps every kind for measurement", () => {
    expect(kindsOf("open_request_omitted", "credential_request_pattern", "question_already_pending")).toEqual({
      kind: "forbidden_action", correctable: true, nextStep: "observe_and_review",
      kinds: ["forbidden_action", "missing_information", "repairable_format"],
      codes: ["open_request_omitted", "credential_request_pattern", "question_already_pending"],
    });
  });
  it("treats a technical inconsistency as a wait, never as a team or customer need", () => {
    expect(kindsOf("context_invalid", "sensitive_requires_human")).toMatchObject({ kind: "technical", nextStep: "technical_wait" });
  });
  it("returns nothing for an accepted decision and has a French label for every next step", () => {
    expect(classifyCaseDecisionRefusal([])).toBeNull();
    expect(Object.values(caseDecisionNextStepLabels).every(label => label.length > 40)).toBe(true);
  });
});
