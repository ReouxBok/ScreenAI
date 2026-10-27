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
// Choice rule (Ugo, 27/10): after a confirmed effect the remaining actions finish on the same
// target; before any effect only a change of the choice refuses. Everything else is traced.
it("after a confirmed effect, an edit of an associated email is traced, not refused", () => {
  const baseline = snapshot(); baseline.histories["201"] = [email];
  const current = copy(baseline); current.histories["201"][0].text = "Edited customer demand";
  expect(assertExecutionCrmUnchanged(baseline, current, [effect("email_associate", { observedHistory: email })], { finalizing: true, targetTicketId: "201" }))
    .toEqual([{ fields: ["histories", "history.text"], ticketIds: ["201"], eventIds: ["emails:301"] }]);
});
it("continues the same verified creation when the CRM independently logs emails", () => {
  const baseline = snapshot(false), current = snapshot(); current.histories["201"] = [email];
  const effects = [effect("ticket_create", { observedTicket: ticket })];
  expect(assertExecutionCrmUnchanged(baseline, current, effects, { nextKind: "email_associate", targetTicketId: "201" })).toEqual([expect.objectContaining({ ticketIds: ["201"] })]);
});
it("finalizes confirmed effects despite append-only CRM emails on the target", () => {
  const baseline = snapshot(), current = snapshot(); current.histories["201"] = [email, { ...email, id: "emails:302" }];
  expect(assertExecutionCrmUnchanged(baseline, current, [effect("email_associate", { observedHistory: email })], { finalizing: true, targetTicketId: "201" })).toHaveLength(1);
});
it("before any effect, a new email or note is traced, not refused", () => {
  const current = snapshot(); current.histories["201"] = [email, { ...email, id: "notes:302", kind: "note" }];
  expect(assertExecutionCrmUnchanged(snapshot(), current, [], { nextKind: "stage_new" })).toEqual([{ fields: ["histories", "history.added_email", "history.added_note"], ticketIds: ["201"], eventIds: ["emails:301", "notes:302"] }]);
});
it("before any effect, an owner change does not alter the choice", () => {
  const current = snapshot(); current.tickets["101"][0].ownerId = "999" as never;
  expect(assertExecutionCrmUnchanged(snapshot(), current, [], { nextKind: "stage_new" })).toEqual([{ fields: ["ticket.ownerId", "tickets"], ticketIds: ["201"], eventIds: [] }]);
});
it.each(["stage", "contact", "content", "subject", "new_ticket", "membership", "association"])("before any effect, a %s change alters the choice and is refused", change => {
  const baseline = snapshot(), current = copy(baseline);
  if (change === "stage") current.tickets["101"][0].stage = "closed" as never;
  if (change === "contact") current.contacts["101"].emails = ["other@example.invalid"];
  if (change === "content") current.tickets["101"][0].content = "Changed by a human";
  if (change === "subject") current.tickets["101"][0].subject = "Another issue";
  if (change === "new_ticket") current.tickets["101"].push({ ...copy(ticket), id: "202" });
  if (change === "membership") current.tickets["101"][0].contactIds = ["101", "102"];
  if (change === "association") current.associations = [{ fromContactId: "101", toContactId: "102", typeId: 449, category: "HUBSPOT_DEFINED" }] as never;
  expect(() => assertExecutionCrmUnchanged(baseline, current, [], { nextKind: "stage_new" })).toThrow("CRM_CHANGED");
});
it.each(["owner", "stage", "contact", "content", "deleted_history", "concurrent_note"])("after a confirmed effect, a %s change no longer stops the remaining actions", change => {
  const baseline = snapshot(); baseline.histories["201"] = [{ ...email, id: "prior" }];
  const current = copy(baseline); current.histories["201"].push(email);
  if (change === "owner") current.tickets["101"][0].ownerId = "999" as never;
  if (change === "stage") current.tickets["101"][0].stage = "closed" as never;
  if (change === "contact") current.contacts["101"].emails = ["other@example.invalid"];
  if (change === "content") current.tickets["101"][0].content = "Changed by a human";
  if (change === "deleted_history") current.histories["201"].shift();
  if (change === "concurrent_note") current.histories["201"].push({ ...email, id: "notes:9", kind: "note" });
  expect(assertExecutionCrmUnchanged(baseline, current, [effect("email_associate", { observedHistory: email })], { finalizing: true, targetTicketId: "201" })).toHaveLength(1);
});
it("after a confirmed effect, a target that disappeared stops the remaining actions", () => {
  const baseline = snapshot(), current = copy(baseline); current.tickets["101"] = [];
  expect(() => assertExecutionCrmUnchanged(baseline, current, [effect("email_associate", { observedHistory: email })], { finalizing: true, targetTicketId: "201" })).toThrow("CRM_CHANGED");
});
