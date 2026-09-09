import { describe, expect, it } from "vitest";
import { savModeAllowsWrite, savWriteDenial, type SavWriteContext } from "./action-policy";

const baseline: SavWriteContext = {
  mode: "on", writesDisabled: false, kind: "send_reply", actorType: "ai",
  pilotBatchId: null, status: "running", aiPaused: false, messageId: "m1",
  latestInboundId: "m1", followup: false, threadStatus: "ai_processing",
  actionCreatedAt: new Date("2026-09-09T12:01:00Z"), latestInboundCreatedAt: new Date("2026-09-09T12:00:00Z"),
};

describe("SAV write authorization at execution time", () => {
  it.each(["shadow", "assist", "semi", "on"] as const)("never writes pilot actions in %s", (mode) => {
    expect(savWriteDenial({ ...baseline, mode, pilotBatchId: "batch", actorType: "human" })).toBe("SAV_PILOT_WRITE_BLOCKED");
  });
  it("honors a kill switch after an action was queued", () => {
    expect(savWriteDenial({ ...baseline, writesDisabled: true })).toBe("SAV_WRITES_DISABLED");
  });
  it("invalidates both automatic and approved drafts after a new inbound", () => {
    for (const actorType of ["ai", "human"]) expect(savWriteDenial({ ...baseline, actorType, latestInboundId: "m2" })).toBe("SAV_REPLY_OBSOLETE");
  });
  it("does not send a solution after human takeover but allows its acknowledgement", () => {
    expect(savWriteDenial({ ...baseline, aiPaused: true })).toBe("SAV_THREAD_PAUSED");
    expect(savWriteDenial({ ...baseline, kind: "request_human", aiPaused: true })).toBeNull();
  });
  it("cancels a queued followup when a new mail arrives or the thread leaves awaiting_customer", () => {
    expect(savWriteDenial({ ...baseline, followup: true })).toBe("SAV_FOLLOWUP_OBSOLETE");
    expect(savWriteDenial({ ...baseline, followup: true, threadStatus: "awaiting_customer", latestInboundCreatedAt: new Date("2026-09-09T12:02:00Z") })).toBe("SAV_REPLY_OBSOLETE");
  });
  it.each([
    ["shadow", "ai", "SAV_WRITES_DISABLED"], ["shadow", "human", "SAV_WRITES_DISABLED"],
    ["assist", "ai", "SAV_HUMAN_APPROVAL_REQUIRED"], ["assist", "human", null],
    ["semi", "ai", "SAV_HUMAN_APPROVAL_REQUIRED"], ["semi", "human", null],
    ["on", "ai", null], ["on", "human", null],
  ] as const)("%s/%s regular reply", (mode, actorType, expected) => {
    expect(savWriteDenial({ ...baseline, mode, actorType })).toBe(expected);
  });
  it("does not replay cancelled or succeeded actions", () => {
    for (const status of ["cancelled", "succeeded"]) expect(savWriteDenial({ ...baseline, status })).toBe("SAV_ACTION_NO_LONGER_PENDING");
  });
  it.each(["ai", "human", "system"])("checks all external action kinds for %s", (actor) => {
    const kinds = ["create_ticket", "link_ticket", "log_email", "create_note", "update_ticket_status", "request_human", "send_reply"];
    for (const kind of kinds) {
      expect(savModeAllowsWrite("shadow", kind, actor)).toBe(false);
      expect(savModeAllowsWrite("on", kind, actor)).toBe(true);
      expect(savModeAllowsWrite("assist", kind, actor)).toBe(actor === "human" || ["log_email", "update_ticket_status"].includes(kind));
      expect(savModeAllowsWrite("semi", kind, actor)).toBe(kind !== "send_reply" || actor === "human");
    }
    expect(savModeAllowsWrite("on", "unknown_operation", actor)).toBe(false);
  });
  it("prevents an outdated awaiting-customer status from overwriting a human takeover", () => {
    expect(savWriteDenial({ ...baseline, kind: "update_ticket_status", statusTarget: "awaiting_customer", aiPaused: true })).toBe("SAV_THREAD_PAUSED");
    expect(savWriteDenial({ ...baseline, kind: "update_ticket_status", statusTarget: "awaiting_customer", latestInboundId: "m2" })).toBe("SAV_REPLY_OBSOLETE");
  });
});
