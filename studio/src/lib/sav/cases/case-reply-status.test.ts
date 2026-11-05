import { describe, expect, it } from "vitest";
import { deriveCaseReplyStatus, type CaseReplyStatusFacts } from "./case-reply-status";

const base: CaseReplyStatusFacts = { mode: "supervised", validation: "approved", execution: null, reply: "none", timer: null };
const status = (patch: Partial<CaseReplyStatusFacts>) => deriveCaseReplyStatus({ ...base, ...patch });
const exec = (state: NonNullable<CaseReplyStatusFacts["execution"]>["state"], reason: string | null = null) => ({ state, reason });

describe("the status never claims a send that the ledger does not hold", () => {
  it("before a decision nothing left, and a declined or superseded reply is final", () => {
    expect(status({ validation: "proposed" })).toMatchObject({ code: "awaiting_validation", sent: "no", terminal: false });
    expect(status({ validation: "declined" })).toMatchObject({ code: "declined", sent: "no", terminal: true });
    expect(status({ validation: "superseded" })).toMatchObject({ code: "superseded", sent: "no", terminal: true });
    expect(status({ validation: "revoked", execution: exec("pending") })).toMatchObject({ code: "revoked", sent: "no", terminal: true });
    // a revocation never hides a send that was started: the ledger wins
    expect(status({ validation: "revoked", execution: exec("running"), reply: "dispatched" })).toMatchObject({ code: "sending", sent: "maybe" });
  });

  it("approved but not queued, then queued, then held for a named reason", () => {
    expect(status({})).toMatchObject({ code: "approved_not_queued", sent: "no", terminal: false });
    expect(status({ execution: exec("pending") })).toMatchObject({ code: "queued", sent: "no" });
    expect(status({ execution: exec("waiting", "SAV_CASE_EFFECT_HOLD_PAUSED") })).toMatchObject({ code: "held", hold: "paused", sent: "no", terminal: false });
    expect(status({ execution: exec("waiting", "SAV_CASE_EFFECT_HOLD_POLICY_CHANGED") })).toMatchObject({ code: "held", hold: "policy_changed" });
    expect(status({ mode: "off", execution: exec("pending") })).toMatchObject({ code: "held", hold: "effects_off", sent: "no" });
  });

  it("a possibly sent mail is `maybe`, never `no` and never `yes`", () => {
    expect(status({ execution: exec("running"), reply: "dispatched" })).toMatchObject({ code: "sending", sent: "maybe", terminal: false });
    expect(status({ execution: exec("running"), reply: "acked" })).toMatchObject({ code: "sending", sent: "maybe" });
    expect(status({ execution: exec("uncertain", "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED"), reply: "uncertain" })).toMatchObject({ code: "send_unconfirmed", sent: "maybe", terminal: false });
    // even when mode is off now or the parent row says refused/waiting: what was started stays possibly sent
    expect(status({ mode: "off", execution: exec("waiting"), reply: "dispatched" })).toMatchObject({ code: "sending", sent: "maybe" });
    expect(status({ execution: exec("refused", "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT"), reply: "uncertain" })).toMatchObject({ sent: "maybe" });
  });

  it("only a confirmed receipt is `yes`; the parent row confirming afterwards makes it final", () => {
    expect(status({ execution: exec("running"), reply: "confirmed" })).toMatchObject({ code: "sent_recording", sent: "yes", terminal: false });
    expect(status({ execution: exec("confirmed"), reply: "confirmed" })).toMatchObject({ code: "sent_confirmed", sent: "yes", terminal: true });
    expect(status({ execution: exec("confirmed"), reply: "none" })).not.toMatchObject({ sent: "yes" });
  });

  it("a cancelled reply carries its code, an unknown ending keeps its machine code, nothing was sent", () => {
    expect(status({ execution: exec("refused", "SAV_CASE_EFFECT_CANCELLED_NEW_INPUT") })).toMatchObject({ code: "cancelled", cancel: "new_input", sent: "no", terminal: true });
    expect(status({ execution: exec("refused", "SAV_CASE_EFFECT_CANCELLED_RECIPIENT_CHANGED") })).toMatchObject({ cancel: "recipient_changed" });
    expect(status({ execution: exec("refused", "SAV_INTAKE_EXECUTION_AUTHORITY_REFUSED") })).toMatchObject({ code: "cancelled", cancel: null, endedBy: "SAV_INTAKE_EXECUTION_AUTHORITY_REFUSED" });
    expect(status({ execution: exec("refused", "free text with spaces") })).toMatchObject({ endedBy: null });
  });

  it("the J2 is reported as the timer says, and `none` when there is no question timer", () => {
    expect(status({ execution: exec("confirmed"), reply: "confirmed", timer: { state: "scheduled", dueAt: "2026-10-29T08:00:00.000Z" } }).j2).toEqual({ state: "scheduled", dueAt: "2026-10-29T08:00:00.000Z" });
    expect(status({ execution: exec("confirmed"), reply: "confirmed", timer: { state: "cancelled", dueAt: "2026-10-29T08:00:00.000Z" } }).j2.state).toBe("cancelled");
    expect(status({ execution: exec("confirmed"), reply: "confirmed" }).j2).toEqual({ state: "none", dueAt: null });
  });
});
