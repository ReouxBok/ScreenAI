import { describe, expect, it } from "vitest";
import { intakeHandoff, intakeExpectedActions, intakeContextReasonLabels, intakeRuntimeHandoffReasons } from "./console-presentation";

describe("team handoff", () => {
  it("gives the cause, the exact action, the tickets examined with their reason and what was missing", () => {
    const handoff = intakeHandoff({ reasons: ["same_issue_unresolved"], judgement: { rationale: "Deux tickets proches.",
      missing: [{ kind: "image", why: "La capture citée par le client est illisible." }],
      tickets: [{ ticketId: "201", relation: "unclear", why: "Même module, symptôme différent." }, { ticketId: "202", relation: "different", why: "Facturation." }] } });
    expect(handoff.causes).toEqual([intakeContextReasonLabels.same_issue_unresolved]);
    expect(handoff.actions).toEqual([intakeExpectedActions.same_issue_unresolved]);
    expect(handoff.tickets).toEqual([{ ticketId: "201", relation: "incertain", why: "Même module, symptôme différent." }, { ticketId: "202", relation: "autre problème", why: "Facturation." }]);
    expect(handoff.missing).toHaveLength(1); expect(handoff.rationale).toBe("Deux tickets proches.");
  });
  it("every engine context reason has an expected action, never a bare 'to validate'", () => {
    for (const reason of Object.keys(intakeContextReasonLabels)) expect(intakeExpectedActions[reason], reason).toBeTruthy();
  });
  it("an exhausted dossier and the per-message call budget both name the manual action", () => {
    const handoff = intakeHandoff({ reasons: ["SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED"], blockedCause: "attempts_exhausted", assessments: [{ ticketId: "301", relation: "same" }] });
    expect(handoff.actions).toEqual([intakeExpectedActions.attempts_exhausted, intakeExpectedActions.SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED]);
    expect(handoff.tickets).toEqual([{ ticketId: "301", relation: "même problème", why: undefined }]);
  });
});

it("the shared daily cap tells the team nothing is needed: automatic resume next day", () => {
  const handoff = intakeHandoff({ reasons: ["SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED"] });
  expect(handoff.actions).toEqual([intakeExpectedActions.SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED]);
  expect(handoff.actions[0]).toContain("reprise automatique");
});

it("SAV-74 the analysis-call limit is named as such, with its own action, never as the money budget", () => {
  expect(intakeRuntimeHandoffReasons({ reason: "SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED", budgetLimit: "analysis_calls" })).toEqual(["analysis_calls_limit"]);
  for (const budgetLimit of ["per_message", "daily_nano_usd", undefined])
    expect(intakeRuntimeHandoffReasons({ reason: "SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED", budgetLimit })).toEqual(["SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED"]);
  expect(intakeRuntimeHandoffReasons({ reason: "SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED" })).toEqual(["SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED"]);
  expect(intakeRuntimeHandoffReasons(undefined)).toEqual([]);
  const handoff = intakeHandoff({ reasons: ["analysis_calls_limit"] });
  expect(handoff.causes[0]).toContain("aucun plafond financier");
  expect(handoff.actions).toEqual([intakeExpectedActions.analysis_calls_limit]);
  expect(handoff.actions[0]).toContain("choisir le ticket");
});
