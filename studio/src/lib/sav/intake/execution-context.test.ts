import { beforeEach, expect, it, vi } from "vitest";
import { encryptSavPayload } from "../crypto";
import { assertExecutionCrmUnchanged } from "./execution-context";
import type { CrmSnapshot, Effect, EffectIntent } from "./execution-types";

const ticket = { id: "201", contactIds: ["101"], stage: "new" as const, createdAt: "2026-10-24T10:00:00.000Z", ownerId: null, subject: "Synthetic issue", content: "Synthetic request." };
const email = { id: "emails:301", kind: "email" as const, at: "2026-10-24T10:00:00.000Z", text: "Synthetic inbound email." };
const copy = <T>(v: T): T => structuredClone(v);
function snapshot(withTicket = true): CrmSnapshot {
  const c = { id: "101", emails: ["customer@example.invalid"] };
  return { address: c.emails[0], lookup: [c], contacts: { "101": c }, associations: [], tickets: { "101": withTicket ? [copy(ticket)] : [] }, histories: withTicket ? { "201": [] } : {} };
}
function effect(kind: EffectIntent["kind"], proof: unknown, extra: Partial<EffectIntent> = {}): Effect {
  return { state: "confirmed", kind, intentCiphertext: encryptSavPayload({ kind, ticketId: ticket.id, objectId: "301", ...extra }),
    ackCiphertext: encryptSavPayload({ id: kind === "ticket_create" ? ticket.id : "301" }), verificationCiphertext: encryptSavPayload(proof) } as Effect;
}
beforeEach(() => vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-execution-encryption-key-32-characters"));
it("does not subtract a no-op email association already present in the baseline", () => {
  const baseline = snapshot(); baseline.histories["201"] = [email];
  expect(() => assertExecutionCrmUnchanged(baseline, copy(baseline), [effect("email_associate", { observedHistory: email })])).not.toThrow();
});
it("still refuses an edit to an already present, associated email", () => {
  const baseline = snapshot(); baseline.histories["201"] = [email];
  const current = copy(baseline); current.histories["201"][0].text = "Edited customer demand";
  expect(() => assertExecutionCrmUnchanged(baseline, current, [effect("email_associate", { observedHistory: email })], { finalizing: true })).toThrow("CRM_CHANGED");
});
it("continues the same verified creation when the CRM independently logs emails", () => {
  const baseline = snapshot(false), current = snapshot(); current.histories["201"] = [email];
  const effects = [effect("ticket_create", { observedTicket: ticket })];
  expect(assertExecutionCrmUnchanged(baseline, current, effects, { nextKind: "email_associate" })).toEqual([{ ticketId: "201", eventId: email.id, contentHash: expect.any(String) }]);
});
it("finalizes confirmed effects despite append-only CRM emails on the target", () => {
  const baseline = snapshot(), current = snapshot(); current.histories["201"] = [email, { ...email, id: "emails:302" }];
  expect(assertExecutionCrmUnchanged(baseline, current, [effect("email_associate", { observedHistory: email })], { finalizing: true })).toHaveLength(1);
});
it("does not ignore a new email before further mutations on an existing ticket", () => {
  const current = snapshot(); current.histories["201"] = [email];
  expect(() => assertExecutionCrmUnchanged(snapshot(), current, [], { nextKind: "stage_new" })).toThrow("CRM_CHANGED");
});
it.each(["note", "stage"] as const)("does not ignore a concurrent %s even when finalizing", kind => {
  const baseline = snapshot(), current = snapshot(); current.histories["201"] = [email, { ...email, id: "external", kind }];
  expect(() => assertExecutionCrmUnchanged(baseline, current, [effect("email_associate", { observedHistory: email })], { finalizing: true })).toThrow("CRM_CHANGED");
});
it.each(["owner", "stage", "contact", "content", "deleted_history"])("keeps the %s guard after effects are confirmed", change => {
  const baseline = snapshot(); baseline.histories["201"] = [{ ...email, id: "prior" }];
  const current = copy(baseline); current.histories["201"].push(email);
  if (change === "owner") current.tickets["101"][0].ownerId = "999" as never;
  if (change === "stage") current.tickets["101"][0].stage = "closed" as never;
  if (change === "contact") current.contacts["101"].emails = ["other@example.invalid"];
  if (change === "content") current.tickets["101"][0].content = "Changed by a human";
  if (change === "deleted_history") current.histories["201"].shift();
  expect(() => assertExecutionCrmUnchanged(baseline, current, [effect("email_associate", { observedHistory: email })], { finalizing: true })).toThrow("CRM_CHANGED");
});
