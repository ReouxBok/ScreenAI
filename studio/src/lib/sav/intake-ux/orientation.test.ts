import { expect, it } from "vitest";
import { orientationCommand, orientationPreview, orientationSchema, type Orientation } from "./orientation";
const input: Orientation = { commandKey: "10000000-0000-4000-8000-000000000001", threadId: "10000000-0000-4000-8000-000000000002", messageId: "10000000-0000-4000-8000-000000000003", runId: "10000000-0000-4000-8000-000000000004", version: 2, sourceHash: "a".repeat(64), candidatesHash: "b".repeat(64), intent: "orient", classification: "finance", contactId: "101", ticketId: "201", reason: "Preuves synthétiques vérifiées pour cette correction." };
it("carries category, contact and ticket in ONE canonical classify command", () => {
  const { intent, ...fields } = input; void intent;
  expect(orientationCommand(input)).toEqual({ ...fields, kind: "classify" });
  expect(orientationPreview(input)).toContain("Facturation"); expect(orientationPreview(input)).toContain("après vérification");
});
it("refusal submits only the visible refusal decision and preserves past effects", () => {
  const command = orientationCommand({ ...input, intent: "refuse" });
  expect(command.kind).toBe("refuse"); expect(command).not.toHaveProperty("classification"); expect(command).not.toHaveProperty("ticketId"); expect(command).not.toHaveProperty("contactId");
  expect(orientationPreview({ ...input, intent: "refuse" })).toContain("actions déjà accomplies restent conservées");
});
it.each([{ version: 0 }, { contactId: "bad" }, { reason: "court" }, { reason: "a".repeat(2001) }, { classification: "unknown" }, { bypass: true }])("rejects malformed or excessive UX input %j", change => {
  expect(orientationSchema.safeParse({ ...input, ...change }).success).toBe(false);
});
it.each(["other", "partnership", "commercial", "investor"] as const)("%s cannot promise or submit ignored ticket targets", classification => {
  expect(orientationSchema.safeParse({ ...input, classification }).success).toBe(false);
  const { contactId, ticketId, ...fields } = input; void contactId; void ticketId;
  expect(orientationCommand({ ...fields, classification })).not.toHaveProperty("ticketId");
  expect(orientationPreview({ ...fields, classification })).not.toContain("proposé au rattachement");
});
