import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { savIntakeEvidenceContentHash } from "./engine";
import { collectExecutionCrm, publicIntakeCrmDelta } from "./execution-context";
import { crmProjectionFields, intakeCrmEvidenceFingerprint, projectCrmEvidence } from "./crm-evidence-fingerprint";
import type { IntakePlan } from "./engine-types";
import type { CrmSnapshot } from "./execution-types";
import type { IntakeRuntimeConfig } from "./runtime-contract";

const ticket = { id: "201", contactIds: ["101"], ownerId: null, stage: "open" as const, subject: "Synthetic private subject", content: "Synthetic private request", createdAt: "2026-10-27T08:00:00.000Z" };
const snapshot = (): CrmSnapshot => ({ address: "synthetic@example.invalid", lookup: [{ id: "101", emails: ["synthetic@example.invalid"] }], contacts: { "101": { id: "101", emails: ["synthetic@example.invalid"] } },
  associations: [], tickets: { "101": [structuredClone(ticket)] }, histories: { "201": [{ id: "notes:301", kind: "note", at: "2026-10-27T09:00:00.000Z", text: "Synthetic private note" }] } });
const plan = (evidence: { id: string; source: string; sourceId: string; data: unknown }[]) =>
  ({ decision: { evidence: evidence.map(e => ({ id: e.id, source: e.source, sourceId: e.sourceId, contentHash: savIntakeEvidenceContentHash(e.data) })) } }) as unknown as IntakePlan;

it("keeps only evidence whose re-read value has exactly the analysed hash, as digests", () => {
  const s = snapshot(), p = plan([{ id: "ticket-201", source: "crm_ticket", sourceId: "201", data: s.tickets["101"][0] },
    { id: "history-201", source: "crm_event", sourceId: "201", data: [{ id: "notes:999", kind: "note", at: "2026-10-27T09:00:00.000Z", text: "Other" }] }]);
  const fingerprint = intakeCrmEvidenceFingerprint(p, [s]);
  // The history evidence does not match the recorded read: unknown, never reconstructed.
  expect(Object.keys(fingerprint.entries)).toEqual(["ticket-201"]);
  expect(JSON.stringify(fingerprint)).not.toMatch(/Synthetic private|@/);
});
it("names ticket, contact and history fields without values", () => {
  const before = projectCrmEvidence("ticket", ticket), after = projectCrmEvidence("ticket", { ...ticket, stage: "closed", content: "Edited" });
  expect(crmProjectionFields("ticket", before, after)).toEqual(["ticket.content", "ticket.stage"]);
  const history = (rows: unknown[]) => projectCrmEvidence("history", rows);
  expect(crmProjectionFields("history", history([{ id: "notes:1", kind: "note", at: "a", text: "x" }]), history([{ id: "notes:1", kind: "note", at: "a", text: "y" }, { id: "emails:2", kind: "email", at: "b", text: "z" }])))
    .toEqual(["history.added_email", "history.text"]);
  expect(crmProjectionFields("contact", projectCrmEvidence("contact", { id: "101", emails: ["a@example.invalid"] }), null)).toEqual(["contact.missing"]);
});
it("reads a diagnostic stored before SAV-45 and drops anything outside the allow-list", () => {
  const legacy = { stage: "stage_new", reason: "unrecognized_added_email", ticketIds: ["201"], eventIds: ["emails:8801", "customer@example.invalid"], baselineHash: "x".repeat(43), currentHash: "bad",
    fields: ["histories", "ticket.ownerId", "Private text"], evidence: [{ id: "contact-customer@example.invalid", category: "contact", state: "changed" }] };
  expect(publicIntakeCrmDelta(legacy)).toMatchObject({ stage: "stage_new", reason: "unrecognized_added_email", classification: "unattributed_email", eventIds: ["emails:8801"],
    fields: ["histories", "ticket.ownerId"], evidence: [], baselineHash: "x".repeat(43), currentHash: null, fieldsKnown: null });
  expect(publicIntakeCrmDelta({ ...legacy, reason: "invented" })).toBeNull();
});
it("reports an incomplete CRM read as a read failure, not as a CRM change", async () => {
  const address = "synthetic@example.invalid", source = `lookup-${createHash("sha256").update(address).digest("base64url")}`;
  const p = { decision: { evidence: [{ id: "email-lookup", source: "crm_contact", sourceId: source, contentHash: "x" }], disposition: { kind: "collect_context" } } } as unknown as IntakePlan;
  const partial = async () => ({ status: "partial" as const, data: [], observedAt: new Date().toISOString(), reconstructedAsOf: undefined });
  await expect(collectExecutionCrm(p, { message: { fromEmail: address, currentText: "" } }, { policy: { admittedRelations: [] } } as unknown as IntakeRuntimeConfig,
    { findContactsByEmail: partial, directAssociations: partial, getContact: partial, ticketsForContact: partial, ticketHistory: partial } as never, new AbortController().signal))
    .rejects.toThrow("SAV_INTAKE_EXECUTION_CRM_READ_INCOMPLETE");
  await expect(collectExecutionCrm(p, { message: { fromEmail: "other@example.invalid", currentText: "" } }, { policy: { admittedRelations: [] } } as unknown as IntakeRuntimeConfig,
    { findContactsByEmail: partial } as never, new AbortController().signal)).rejects.toThrow("SAV_INTAKE_EXECUTION_ADDRESS_PROOF_UNRESOLVED");
});
