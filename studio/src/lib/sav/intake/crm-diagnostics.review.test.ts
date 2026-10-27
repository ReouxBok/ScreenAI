import { expect, it } from "vitest";
import { assertOriginalExecutionCrm, IntakeCrmDeltaError } from "./execution-context";
import { savIntakeEvidenceContentHash } from "./engine";
import type { IntakePlan } from "./engine-types";
import type { CrmSnapshot } from "./execution-types";
import { intakeCrmEvidenceFingerprint } from "./crm-evidence-fingerprint";

const ticket = { id: "201", contactIds: ["101"], ownerId: null, stage: "new", subject: "Synthetic support", content: "Request", createdAt: "2026-10-27T08:00:00.000Z" };
function snapshot(): CrmSnapshot {
  const contact = { id: "101", emails: ["synthetic@example.invalid"] };
  return { address: contact.emails[0], lookup: [contact], contacts: { "101": contact }, associations: [], tickets: { "101": [structuredClone(ticket)] } as CrmSnapshot["tickets"], histories: { "201": [] } };
}
function plan(data: unknown, source: string, evidenceId: string) {
  return { decision: { evidence: [{ id: evidenceId, source, sourceId: "201", contentHash: savIntakeEvidenceContentHash(data) }] } } as unknown as IntakePlan;
}

it("CRMREVIEW initial owner drift supplies typed diagnostics while remaining blocked", () => {
  const baseline = snapshot(), current = snapshot();
  current.tickets["101"][0].ownerId = "999";
  let error: unknown;
  // SAV-45: the analysis now records a digest-only fingerprint of what it saw.
  const analysed = plan(baseline.tickets["101"][0], "crm_ticket", "ticket-201");
  try { assertOriginalExecutionCrm(analysed, current, intakeCrmEvidenceFingerprint(analysed, [baseline])); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(IntakeCrmDeltaError);
  expect((error as IntakeCrmDeltaError).diagnostic.fields).toContain("ticket.ownerId");
});

it("CRMREVIEW initial history drift supplies typed diagnostics while remaining blocked", () => {
  const baseline = snapshot(), current = snapshot();
  current.histories["201"] = [{ id: "notes:301", kind: "note", at: "2026-10-27T09:00:00.000Z", text: "Synthetic new information" }];
  let error: unknown;
  const analysed = plan(baseline.histories["201"], "crm_event", "history-201");
  try { assertOriginalExecutionCrm(analysed, current, intakeCrmEvidenceFingerprint(analysed, [baseline])); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(IntakeCrmDeltaError);
  expect((error as IntakeCrmDeltaError).diagnostic.fields).toContain("histories");
});

it("CRMREVIEW control: initial identity/ticket drift is still refused", () => {
  const baseline = snapshot(), current = snapshot(); current.tickets["101"][0].stage = "closed";
  expect(() => assertOriginalExecutionCrm(plan(baseline.tickets["101"][0], "crm_ticket", "ticket-201"), current)).toThrow("SAV_INTAKE_EXECUTION_CRM_CHANGED");
});

it("SAV-45 without an analysis fingerprint the delta stays typed and blocked, its detail explicitly unknown", () => {
  const baseline = snapshot(), current = snapshot();
  current.tickets["101"][0].ownerId = "999";
  let error: unknown;
  try { assertOriginalExecutionCrm(plan(baseline.tickets["101"][0], "crm_ticket", "ticket-201"), current); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(IntakeCrmDeltaError);
  expect((error as IntakeCrmDeltaError).diagnostic).toMatchObject({ stage: "original", reason: "original_evidence_changed", fields: ["tickets"], fieldsKnown: false, classification: "unknown",
    evidence: [{ id: "ticket-201", category: "ticket", state: "changed" }] });
});
