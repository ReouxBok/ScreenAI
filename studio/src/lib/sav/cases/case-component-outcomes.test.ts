import { expect, it } from "vitest";
import { caseComponentOutcomes, type ComponentExecution, type ComponentEffect } from "./case-component-outcomes";
const execution: ComponentExecution = { id: "reply", key: "reply:case:input", state: "waiting", reason: null, noteExpected: true };
const mail: ComponentEffect = { executionId: "reply", kind: "reply_send", state: "confirmed", confirmedAt: new Date() };
it.each([
  ["SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED", "owner_changed"],
  ["SAV_CASE_EFFECT_CANCELLED_OWNER_HUMAN", "human_intervention"],
  ["SAV_CASE_EFFECT_CANCELLED_NEW_INPUT", "new_mail"],
  ["SAV_CASE_EFFECT_MUTATION_NOT_GRANTED", "authority_changed"],
  ["SAV_CASE_EFFECT_CANCELLED_QUALIFICATION_SCOPE", "authority_changed"],
  ["SAV_INTAKE_AGENT_ACTIONS_PAUSED", "paused"],
  ["private@example.invalid", "effect_refused"],
])("keeps mail proof and sanitizes a subsequent refusal %s", (reason, code) => {
  const result = caseComponentOutcomes({ ...execution, reason }, [], [mail]);
  expect(result.mail).toEqual({ state: "confirmed", reason: null, message: null });
  expect(result.note).toMatchObject({ state: "blocked", reason: code });
  expect(JSON.stringify(result)).not.toContain("private@");
});
it("requires both note creation and association, independently of parent confirmation", () => {
  const note: ComponentEffect = { ...mail, kind: "note_create" };
  expect(caseComponentOutcomes({ ...execution, state: "confirmed" }, [], [mail, note]).note.state).toBe("queued");
  expect(caseComponentOutcomes(execution, [], [mail, note, { ...mail, kind: "note_associate" }]).note.state).toBe("confirmed");
});
it("preserves uncertainty over a later cancellation and distinguishes disabled notes", () => {
  expect(caseComponentOutcomes({ ...execution, state: "refused", reason: "owner_changed" }, [], [mail, { ...mail, kind: "note_create", state: "uncertain", confirmedAt: null }]).note.state).toBe("uncertain");
  expect(caseComponentOutcomes({ ...execution, state: "confirmed", noteOutcome: { state: "skipped", reason: "reply_note_off" } }, [], [mail]).note).toMatchObject({ state: "skipped", reason: "disabled" });
});
it("does not infer confirmation from a confirmed parent or follow a corrupt status reference", () => {
  expect(caseComponentOutcomes({ ...execution, state: "confirmed" }, [], []).mail.state).toBe("queued");
  const self = { ...execution, statusOutcome: { executionId: "reply" } };
  expect(caseComponentOutcomes(self, [self], [mail]).status.state).toBe("blocked");
});

it.each([
  ["stages_stage_missing", "mapping_invalid"],
  ["stages_stages_equal", "mapping_invalid"],
  ["customer_replied_since", "new_mail"],
  ["team_part_pending", "human_intervention"],
  ["owner_not_agent", "owner_changed"],
])("exposes a queue refusal independently of the mail and note: %s", (reason, code) => {
  const result = caseComponentOutcomes({ ...execution, statusOutcome: { state: "blocked", reason } }, [],
    [mail, { ...mail, kind: "note_create" }, { ...mail, kind: "note_associate" }]);
  expect(result.mail.state).toBe("confirmed");
  expect(result.note.state).toBe("confirmed");
  expect(result.status).toMatchObject({ state: "blocked", reason: code });
});
it("keeps a confirmed status when only the subsequent note is refused", () => {
  const stage = { ...execution, id: "stage", key: "case-stage:case:closed:cycle-1", reason: "SAV_TICKET_STAGE_CANCELLED_OWNER_CHANGED" };
  const result = caseComponentOutcomes(stage, [], [{ ...mail, executionId: "stage", kind: "ticket_stage" }]);
  expect(result.status.state).toBe("confirmed");
  expect(result.note).toMatchObject({ state: "blocked", reason: "owner_changed" });
  expect(result.mail.state).toBe("absent");
});

it("does not replace a status queue refusal with a later note refusal", () => {
  const result = caseComponentOutcomes({ ...execution, reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_CHANGED",
    statusOutcome: { state: "blocked", reason: "stages_stage_invalid" } }, [], [mail]);
  expect(result.mail.state).toBe("confirmed");
  expect(result.note).toMatchObject({ state: "blocked", reason: "owner_changed" });
  expect(result.status).toMatchObject({ state: "blocked", reason: "mapping_invalid" });
});
