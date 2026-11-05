import { describe, expect, it, vi } from "vitest";
import { authorizeCaseReplyDecision, canTransitionCaseReplyValidation, caseReplyApprovability, checkCaseReplySeen, denyAllCaseReplyAuthorizer, SAV_CASE_REPLY_VALIDATION_STATES, type CaseReplyAuthorizationRequest, type CaseReplyAuthorizer } from "./case-reply-validation";

const APPROVER = "20000000-0000-4000-8000-000000000003";
const request: CaseReplyAuthorizationRequest = { action: "approve", approverId: APPROVER, caseId: "10000000-0000-4000-8000-000000000001", replyKey: "reply:x:y", payloadHash: "a".repeat(64), purpose: "question" };
const stored = { payloadHash: "a".repeat(64), caseVersion: 4, recipient: "customer@example.invalid" };

describe("the authorization port refuses unless it answers an explicit, well-formed yes", () => {
  it("an explicit yes with a plain tag is the only way through", async () => {
    expect(await authorizeCaseReplyDecision(() => ({ allowed: true, basis: "fixture.policy:v1" }), request)).toEqual({ allowed: true, basis: "fixture.policy:v1" });
    expect(await authorizeCaseReplyDecision(async () => ({ allowed: true, basis: "fixture" }), request)).toEqual({ allowed: true, basis: "fixture" });
  });

  it("nothing wired, the deny-all default, an explicit no: refused, and the port is told what it decides on", async () => {
    expect(await authorizeCaseReplyDecision(undefined, request)).toEqual({ allowed: false, code: "authorizer_missing" });
    expect(await authorizeCaseReplyDecision(null, request)).toEqual({ allowed: false, code: "authorizer_missing" });
    expect(await authorizeCaseReplyDecision(denyAllCaseReplyAuthorizer, request)).toEqual({ allowed: false, code: "not_authorized" });
    const seen = vi.fn<CaseReplyAuthorizer>(() => ({ allowed: false }));
    expect(await authorizeCaseReplyDecision(seen, request)).toEqual({ allowed: false, code: "not_authorized" });
    expect(seen).toHaveBeenCalledWith(request);
  });

  it.each([
    ["undefined", undefined], ["null", null], ["a string", "yes"], ["an empty object", {}], ["allowed as a string", { allowed: "true", basis: "x" }], ["allowed as 1", { allowed: 1, basis: "x" }],
    ["no basis", { allowed: true }], ["an empty basis", { allowed: true, basis: "" }], ["a basis that is an address", { allowed: true, basis: "someone@example.invalid" }], ["a basis with spaces", { allowed: true, basis: "a b" }],
    ["a basis that is not a string", { allowed: true, basis: 7 }], ["a too long basis", { allowed: true, basis: "a".repeat(81) }],
  ])("an absent or malformed decision is refused: %s", async (_name, answer) => {
    expect(await authorizeCaseReplyDecision((() => answer) as unknown as CaseReplyAuthorizer, request)).toEqual({ allowed: false, code: "decision_absent" });
  });

  it("a port that throws, rejects or never answers is refused, and an approver that is not a staff UUID never reaches the port", async () => {
    expect(await authorizeCaseReplyDecision(() => { throw Error("boom"); }, request)).toEqual({ allowed: false, code: "authorizer_failed" });
    expect(await authorizeCaseReplyDecision(async () => { throw Error("boom"); }, request)).toEqual({ allowed: false, code: "authorizer_failed" });
    vi.useFakeTimers();
    try {
      const pending = authorizeCaseReplyDecision(() => new Promise(() => { }), request);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await pending).toEqual({ allowed: false, code: "authorizer_failed" });
    } finally { vi.useRealTimers(); }
    const never = vi.fn<CaseReplyAuthorizer>(() => ({ allowed: true, basis: "x" }));
    for (const approverId of ["", "staff@example.invalid", "not-a-uuid", "20000000-0000-4000-8000-00000000000"]) {
      expect(await authorizeCaseReplyDecision(never, { ...request, approverId })).toEqual({ allowed: false, code: "approver_invalid" });
    }
    expect(never).not.toHaveBeenCalled();
  });
});

describe("what the person saw must still be what is stored", () => {
  it("matches only on the same payload hash, case version and recipient (case-insensitive)", () => {
    expect(checkCaseReplySeen(stored, { ...stored, recipient: " Customer@Example.invalid " })).toBe("ok");
    expect(checkCaseReplySeen(stored, { ...stored, payloadHash: "b".repeat(64) })).toBe("payload_changed");
    expect(checkCaseReplySeen(stored, { ...stored, caseVersion: 5 })).toBe("version_changed");
    expect(checkCaseReplySeen(stored, { ...stored, recipient: "other@example.invalid" })).toBe("recipient_changed");
  });

  it("a malformed sight is invalid, never a match", () => {
    expect(checkCaseReplySeen(stored, { ...stored, payloadHash: "short" })).toBe("approval_invalid");
    expect(checkCaseReplySeen(stored, { ...stored, caseVersion: 4.5 })).toBe("approval_invalid");
    expect(checkCaseReplySeen(stored, { ...stored, recipient: "  " })).toBe("approval_invalid");
  });
});

describe("states", () => {
  it("only a proposal can be decided and an approval can be withdrawn; nothing else moves, and a revoked or declined reply is never re-approved", () => {
    for (const to of ["approved", "declined", "superseded"] as const) expect(canTransitionCaseReplyValidation("proposed", to)).toBe(true);
    expect(canTransitionCaseReplyValidation("proposed", "revoked")).toBe(false);
    expect(canTransitionCaseReplyValidation("approved", "revoked")).toBe(true);
    for (const from of SAV_CASE_REPLY_VALIDATION_STATES.filter(state => state !== "proposed")) {
      for (const to of SAV_CASE_REPLY_VALIDATION_STATES) expect(canTransitionCaseReplyValidation(from, to)).toBe(from === "approved" && to === "revoked");
    }
    expect(canTransitionCaseReplyValidation("proposed", "proposed")).toBe(false);
  });

  it("approvability is honest: off means no button, a decided reply means no button", () => {
    expect(caseReplyApprovability("off", "proposed")).toEqual({ ok: false, reason: "effects_off" });
    expect(caseReplyApprovability("supervised", "proposed")).toEqual({ ok: true });
    for (const state of ["approved", "declined", "superseded", "revoked"] as const) expect(caseReplyApprovability("supervised", state)).toEqual({ ok: false, reason: "already_decided" });
  });
});
