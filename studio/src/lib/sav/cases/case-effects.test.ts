import { describe, expect, it } from "vitest";
import {
  caseEffectHash, caseNoteAssociationKey, caseNoteKey, caseRecipientCheck, caseReplyKey, caseReplyPayloadHash, checkCaseReplyApproval, decideCaseEffect,
  inboundInteractionId, j2TriggerEventId, readCaseEffectsMode, replyInteractionId, SAV_CASE_EFFECT_PERMISSIONS,
  type CaseEffectLedgerState, type CaseEffectLive, type CaseReplyApproval, type CaseReplyProposal,
} from "./case-effects";

const CASE = "10000000-0000-4000-8000-000000000001";
const proposal: CaseReplyProposal = {
  caseId: CASE, caseVersion: 7, triggerEventId: "inbound:gmail-1", inboundMessageId: "20000000-0000-4000-8000-000000000002", purpose: "answer",
  recipient: "Customer@Example.invalid", subject: "Re: synthetic", text: "SYNTHETIC reply text.\n\nSignature kept exactly.",
};
const approvalFor = (p: CaseReplyProposal, override: Partial<CaseReplyApproval> = {}): CaseReplyApproval => ({
  payloadHash: caseReplyPayloadHash(p), caseVersion: p.caseVersion, recipient: p.recipient, approvedBy: "staff@example.invalid", approvedAt: "2026-10-30T10:00:00.000Z", ...override,
});
const good: CaseEffectLive = {
  mode: "supervised", pause: { intake: "running", v2: "running" }, leaseValid: true, admission: { admitted: true }, recipient: "match", approval: "ok",
};

describe("SAV_CASE_EFFECTS mode: off by default, fails closed", () => {
  it.each([[undefined, "off", null], ["", "off", null], ["off", "off", null], ["supervised", "supervised", null]] as const)("%j -> %s", (value, mode, ignored) => {
    expect(readCaseEffectsMode({ SAV_CASE_EFFECTS: value })).toMatchObject({ mode, ignored });
  });
  it("auto is refused, never read as supervised; unknown spellings and case variants are off", () => {
    expect(readCaseEffectsMode({ SAV_CASE_EFFECTS: "auto" })).toEqual({ mode: "off", requested: "auto", ignored: "auto_not_available" });
    for (const value of ["Supervised", "SUPERVISED", " supervised", "on", "true", "1", "supervised,auto"]) expect(readCaseEffectsMode({ SAV_CASE_EFFECTS: value })).toMatchObject({ mode: "off", ignored: "unknown_value" });
    expect(readCaseEffectsMode({})).toMatchObject({ mode: "off" });
  });
});

describe("business keys", () => {
  it("reply: one key per (case, trigger); note: one key per (case, interaction); both stable across a technical retry", () => {
    expect(caseReplyKey(CASE, "inbound:gmail-1")).toBe(`reply:${CASE}:inbound:gmail-1`);
    expect(caseReplyKey(CASE.toUpperCase(), "inbound:gmail-1")).toBe(caseReplyKey(CASE, "inbound:gmail-1"));
    expect(caseNoteKey(CASE, inboundInteractionId("gmail-1"))).toBe(caseNoteKey(CASE, inboundInteractionId("gmail-1")));
    expect(caseNoteKey(CASE, inboundInteractionId("gmail-1"))).not.toBe(caseNoteKey(CASE, inboundInteractionId("gmail-2")));
    expect(caseNoteAssociationKey(CASE, inboundInteractionId("gmail-1"))).toBe(`note-association:${CASE}:inbound:gmail-1`);
  });
  it("the J2 reminder is keyed by its timer, so one timer is at most one reply and one note", () => {
    const trigger = j2TriggerEventId("timer-j2-1");
    expect(trigger).toBe("timer:timer-j2-1");
    expect(caseReplyKey(CASE, trigger)).toBe(`reply:${CASE}:timer:timer-j2-1`);
    expect(caseNoteKey(CASE, replyInteractionId(trigger))).toBe(`note:${CASE}:outbound:timer:timer-j2-1`);
  });
  it("an inbound and an outbound interaction never share a note key", () => {
    expect(caseNoteKey(CASE, inboundInteractionId("x"))).not.toBe(caseNoteKey(CASE, replyInteractionId("x")));
  });
  it("refuses a malformed case id or a part that could forge another key", () => {
    expect(() => caseReplyKey("not-a-uuid", "a")).toThrow("SAV_CASE_EFFECT_KEY_INVALID:caseId");
    for (const bad of ["", "a b", "a/b", "a\nb", "a;b", "x".repeat(201)]) {
      expect(() => caseReplyKey(CASE, bad), bad).toThrow("SAV_CASE_EFFECT_KEY_INVALID");
      expect(() => caseNoteKey(CASE, bad), bad).toThrow("SAV_CASE_EFFECT_KEY_INVALID");
    }
  });
  it("each effect has its own permission", () => {
    expect(SAV_CASE_EFFECT_PERMISSIONS).toEqual({ reply: "send_case_reply", note: "append_case_note", handoff: "notify_case_handoff", stage: "set_case_ticket_stage" });
  });
});

describe("approval binds payload, case version and recipient", () => {
  it("an exact approval passes", () => expect(checkCaseReplyApproval(proposal, approvalFor(proposal))).toBe("ok"));
  it("the recipient is compared case-insensitively and trimmed, in the hash too", () => {
    const loud = { ...proposal, recipient: "  CUSTOMER@example.invalid " };
    expect(caseReplyPayloadHash(loud)).toBe(caseReplyPayloadHash(proposal));
    expect(checkCaseReplyApproval(loud, approvalFor(proposal))).toBe("ok");
  });
  it.each([
    ["text", { ...proposal, text: `${proposal.text} ` }, "payload_changed"],
    ["subject", { ...proposal, subject: "Re: other" }, "payload_changed"],
    ["trigger", { ...proposal, triggerEventId: "inbound:gmail-2" }, "payload_changed"],
    ["inbound message", { ...proposal, inboundMessageId: "20000000-0000-4000-8000-000000000003" }, "payload_changed"],
    ["purpose", { ...proposal, purpose: "question" as const }, "payload_changed"],
    ["question", { ...proposal, question: { id: "q", text: "t", factKeys: [] } }, "payload_changed"],
    ["recipient", { ...proposal, recipient: "other@example.invalid" }, "payload_changed"],
  ] as const)("a validated reply whose %s changed is refused", (_name, changed, expected) => {
    expect(checkCaseReplyApproval(changed, approvalFor(proposal))).toBe(expected);
  });
  it("a different case version, a recipient that is not the one read, and a malformed approval are each refused", () => {
    expect(checkCaseReplyApproval({ ...proposal, caseVersion: 8 }, approvalFor({ ...proposal, caseVersion: 8 }, { caseVersion: 7 }))).toBe("version_changed");
    expect(checkCaseReplyApproval(proposal, approvalFor(proposal, { recipient: "someone.else@example.invalid" }))).toBe("recipient_changed");
    for (const broken of [null, undefined, approvalFor(proposal, { payloadHash: "abc" }), approvalFor(proposal, { approvedBy: "" }), approvalFor(proposal, { approvedAt: "yesterday" }), approvalFor(proposal, { caseVersion: 1.5 })]) {
      expect(checkCaseReplyApproval(proposal, broken as never)).toBe("approval_invalid");
    }
  });
  it("hashing is order-independent and does not depend on undefined fields", () => {
    expect(caseEffectHash({ a: 1, b: { c: 2, d: undefined } })).toBe(caseEffectHash({ b: { c: 2 }, a: 1 }));
    expect(caseEffectHash({ a: 1 })).not.toBe(caseEffectHash({ a: 2 }));
  });
});

describe("recipient is the stored sender of the last qualified inbound", () => {
  it("match, changed, unreadable", () => {
    expect(caseRecipientCheck("Customer@Example.invalid", "customer@example.invalid")).toBe("match");
    expect(caseRecipientCheck("customer@example.invalid", "quoted@example.invalid")).toBe("changed");
    expect(caseRecipientCheck("customer@example.invalid", null)).toBe("unreadable");
  });
});

describe("gate: what the executor may do at the moment of the marker", () => {
  const adverse: [string, Partial<CaseEffectLive>][] = [
    ["mode off", { mode: "off" }], ["intake paused", { pause: { intake: "actions_paused", v2: "running" } }], ["v2 fully paused", { pause: { intake: "running", v2: "fully_paused" } }],
    ["pause unreadable", { pause: { intake: "running", v2: "invalid" } }], ["lease expired", { leaseValid: false }], ["approval invalid", { approval: "approval_invalid" }], ["approval revoked", { approval: "approval_revoked" }],
    ["owner is a human", { admission: { admitted: false, reason: "owner_not_agent" } }], ["new customer input", { admission: { admitted: false, reason: "input_newer" } }],
    ["admission withdrawn", { admission: { admitted: false, reason: "not_admitted" } }], ["recipient changed", { recipient: "changed" }],
  ];

  it("a confirmed receipt is immutable: done, whatever the world looks like now", () => {
    for (const [, override] of adverse) expect(decideCaseEffect("confirmed", { ...good, ...override })).toEqual({ action: "done" });
    expect(decideCaseEffect("confirmed", good)).toEqual({ action: "done" });
  });

  it.each(["dispatched", "acked", "uncertain"] as CaseEffectLedgerState[])("%s is verify-only before every other check: no resend, no cancellation, whatever changed after the marker", state => {
    for (const [name, override] of adverse) expect(decideCaseEffect(state, { ...good, ...override }), name).toEqual({ action: "verify_only" });
    expect(decideCaseEffect(state, good)).toEqual({ action: "verify_only" });
  });

  it.each(["none", "planned"] as CaseEffectLedgerState[])("%s with everything in order dispatches", state => {
    expect(decideCaseEffect(state, good)).toEqual({ action: "dispatch" });
  });

  it("holds, without losing the effect, while off, paused, without a valid lease, on a policy rotation, or with an unreadable recipient", () => {
    expect(decideCaseEffect("planned", { ...good, mode: "off" })).toEqual({ action: "hold", code: "effects_off" });
    for (const pause of [{ intake: "actions_paused", v2: "running" }, { intake: "running", v2: "actions_paused" }, { intake: "fully_paused", v2: "running" }, { intake: "running", v2: "invalid" }] as const) {
      expect(decideCaseEffect("planned", { ...good, pause }), JSON.stringify(pause)).toEqual({ action: "hold", code: "paused" });
    }
    expect(decideCaseEffect("planned", { ...good, leaseValid: false })).toEqual({ action: "hold", code: "lease_expired" });
    expect(decideCaseEffect("planned", { ...good, admission: { admitted: false, reason: "policy_changed" } })).toEqual({ action: "hold", code: "policy_changed" });
    expect(decideCaseEffect("planned", { ...good, recipient: "unreadable" })).toEqual({ action: "hold", code: "recipient_unreadable" });
  });

  it("cancels a never-sent reply when the world moved: approval, owner, new customer input, admission, recipient", () => {
    expect(decideCaseEffect("planned", { ...good, approval: "payload_changed" })).toEqual({ action: "cancel", code: "payload_changed" });
    expect(decideCaseEffect("planned", { ...good, approval: "version_changed" })).toEqual({ action: "cancel", code: "version_changed" });
    expect(decideCaseEffect("planned", { ...good, approval: "recipient_changed" })).toEqual({ action: "cancel", code: "recipient_changed" });
    expect(decideCaseEffect("planned", { ...good, admission: { admitted: false, reason: "owner_not_agent" } })).toEqual({ action: "cancel", code: "owner_changed" });
    expect(decideCaseEffect("planned", { ...good, admission: { admitted: false, reason: "input_newer" } })).toEqual({ action: "cancel", code: "new_input" });
    expect(decideCaseEffect("planned", { ...good, admission: { admitted: false, reason: "no_admission" } })).toEqual({ action: "cancel", code: "admission_withdrawn" });
    expect(decideCaseEffect("planned", { ...good, recipient: "changed" })).toEqual({ action: "cancel", code: "recipient_changed" });
  });

  it("order: a pause or an expired lease holds before an owner change cancels (a paused world is not judged)", () => {
    const both: CaseEffectLive = { ...good, pause: { intake: "running", v2: "actions_paused" }, admission: { admitted: false, reason: "owner_not_agent" } };
    expect(decideCaseEffect("planned", both)).toEqual({ action: "hold", code: "paused" });
    expect(decideCaseEffect("planned", { ...both, pause: good.pause, leaseValid: false })).toEqual({ action: "hold", code: "lease_expired" });
    expect(decideCaseEffect("planned", { ...both, pause: good.pause })).toEqual({ action: "cancel", code: "owner_changed" });
  });
});
