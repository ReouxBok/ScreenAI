import { describe, expect, it } from "vitest";
import { isSavWriteCancellation, isSavV0RetiredActor, SAV_V0_ENGINE_RETIRED, savModeAllowsWrite, savWriteDenial, type SavWriteContext } from "./action-policy";
import { savActionFailurePlan } from "./retry-policy";

const baseline: SavWriteContext = {
  mode: "on", releaseStage: "v4", writesDisabled: false, kind: "send_reply", actorType: "human",
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
    // The old engine's own drafts no longer reach this check: they are retired first (see "retired V0 engine" below).
    expect(savWriteDenial({ ...baseline, actorType: "human", latestInboundId: "m2" })).toBe("SAV_REPLY_OBSOLETE");
    expect(savWriteDenial({ ...baseline, actorType: "ai", latestInboundId: "m2" })).toBe(SAV_V0_ENGINE_RETIRED);
  });
  it("does not send a solution after human takeover but allows its acknowledgement", () => {
    expect(savWriteDenial({ ...baseline, aiPaused: true })).toBe("SAV_THREAD_PAUSED");
    expect(savWriteDenial({ ...baseline, kind: "request_human", aiPaused: true })).toBeNull();
  });
  it("cancels a queued followup when a new mail arrives or the thread leaves awaiting_customer", () => {
    expect(savWriteDenial({ ...baseline, followup: true })).toBe("SAV_FOLLOWUP_OBSOLETE");
    expect(savWriteDenial({ ...baseline, followup: true, threadStatus: "awaiting_customer", latestInboundCreatedAt: new Date("2026-09-09T12:02:00Z") })).toBe("SAV_REPLY_OBSOLETE");
    // A follow-up of the old engine is machine-authored: retired whatever the thread looks like.
    expect(savWriteDenial({ ...baseline, actorType: "ai", followup: true, threadStatus: "awaiting_customer" })).toBe(SAV_V0_ENGINE_RETIRED);
  });
  it.each([
    ["shadow", "ai", SAV_V0_ENGINE_RETIRED], ["shadow", "human", "SAV_WRITES_DISABLED"],
    ["assist", "ai", SAV_V0_ENGINE_RETIRED], ["assist", "human", null],
    ["semi", "ai", SAV_V0_ENGINE_RETIRED], ["semi", "human", null],
    ["on", "ai", SAV_V0_ENGINE_RETIRED], ["on", "human", null],
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
      // Only a person's command still executes: the machine authors (ai, system) are retired in every mode.
      expect(savModeAllowsWrite("on", kind, actor, false, "v4")).toBe(actor === "human");
      expect(savModeAllowsWrite("assist", kind, actor, false, "v4")).toBe(actor === "human");
      expect(savModeAllowsWrite("semi", kind, actor, false, "v4")).toBe(actor === "human");
    }
    expect(savModeAllowsWrite("on", "unknown_operation", actor)).toBe(false);
  });
  it("enforces V0 even when automation is on or an old reply was approved by a human", () => {
    for (const releaseStage of [undefined, "v0"] as const) {
      for (const actorType of ["ai", "human", "system"]) {
        expect(savWriteDenial({ ...baseline, releaseStage, actorType })).toBe(actorType === "human" ? "SAV_REPLY_MANUAL_APPROVAL_REQUIRED" : SAV_V0_ENGINE_RETIRED);
        expect(savWriteDenial({ ...baseline, releaseStage, actorType, kind: "create_ticket" })).toBe(actorType === "human" ? null : SAV_V0_ENGINE_RETIRED);
      }
    }
  });
  it("allows only a distinct confirmed human reply in V0, never a followup", () => {
    expect(savWriteDenial({ ...baseline, releaseStage: "v0", actorType: "human", manualReplyConfirmed: true })).toBeNull();
    expect(savWriteDenial({ ...baseline, releaseStage: "v0", actorType: "human", manualReplyConfirmed: true, followup: true })).toBe("SAV_REPLY_MANUAL_APPROVAL_REQUIRED");
  });
  it.each(["assist", "semi", "on"] as const)("allows a confirmed V0 human reply in %s while keeping the agent paused", (mode) => {
    const manual = { ...baseline, mode, releaseStage: "v0" as const, actorType: "human", manualReplyConfirmed: true, aiPaused: true };
    expect(savWriteDenial(manual)).toBeNull();
    expect(savWriteDenial({ ...manual, manualReplyConfirmed: false })).toBe("SAV_REPLY_MANUAL_APPROVAL_REQUIRED");
    expect(savWriteDenial({ ...manual, actorType: "ai" })).toBe(SAV_V0_ENGINE_RETIRED);
    expect(savWriteDenial({ ...manual, followup: true })).toBe("SAV_REPLY_MANUAL_APPROVAL_REQUIRED");
    expect(savWriteDenial({ ...manual, latestInboundId: "new" })).toBe("SAV_REPLY_OBSOLETE");
    expect(savWriteDenial({ ...manual, writesDisabled: true })).toBe("SAV_WRITES_DISABLED");
    for (const releaseStage of ["v1", "v2", "v3", "v4"] as const) expect(savWriteDenial({ ...manual, releaseStage })).toBe("SAV_THREAD_PAUSED");
  });
  it("prevents an outdated awaiting-customer status from overwriting a human takeover", () => {
    expect(savWriteDenial({ ...baseline, kind: "update_ticket_status", statusTarget: "awaiting_customer", aiPaused: true })).toBe("SAV_THREAD_PAUSED");
    expect(savWriteDenial({ ...baseline, kind: "update_ticket_status", statusTarget: "awaiting_customer", latestInboundId: "m2" })).toBe("SAV_REPLY_OBSOLETE");
  });
  it("does not enable replies, followups or ticket processing in V1", () => {
    for (const kind of ["send_reply", "request_human", "create_note", "update_ticket_status"]) {
      for (const actorType of ["ai", "system"]) {
        expect(savModeAllowsWrite("on", kind, actorType, true, "v1")).toBe(false);
      }
    }
    // V1 used to let the machine create tickets; the old engine is retired, so only a person's command does.
    expect(savModeAllowsWrite("on", "create_ticket", "ai", false, "v1")).toBe(false);
    expect(savModeAllowsWrite("on", "create_ticket", "human", false, "v1")).toBe(true);
  });
});

describe("retired V0 engine (SAV-9)", () => {
  const kinds = ["send_reply", "request_human", "create_ticket", "link_ticket", "create_note", "log_email", "update_ticket_status", "draft_reply", "unknown_operation"];
  const stages = ["v0", "v1", "v2", "v3", "v4", undefined] as const;
  const modes = ["shadow", "assist", "semi", "on"] as const;

  it("names who is retired: every author except a person", () => {
    expect(["ai", "system", "", "robot", "HUMAN"].map(isSavV0RetiredActor)).toEqual([true, true, true, true, true]);
    expect(isSavV0RetiredActor("human")).toBe(false);
  });
  it("no stage, mode, kind, status, thread or follow-up flag lets a machine-authored action execute, and no environment value is read", () => {
    const previous = { ...process.env };
    try {
      process.env.SAV_RELEASE_STAGE = "v4"; process.env.SAV_AUTOMATION_MODE = "on"; process.env.SAV_WRITES_DISABLED = "false";
      process.env.SAV_AUTO_REPLY_ROLLOUT_PERCENT = "100"; process.env.SAV_PILOT_MODE = "false";
      for (const releaseStage of stages) for (const mode of modes) for (const kind of kinds) for (const actorType of ["ai", "system"]) {
        for (const followup of [false, true]) for (const status of ["pending", "running"]) {
          expect(savModeAllowsWrite(mode, kind, actorType, followup, releaseStage)).toBe(false);
          expect(savWriteDenial({ ...baseline, releaseStage, mode, kind, actorType, followup, status })).toBe(SAV_V0_ENGINE_RETIRED);
          expect(savWriteDenial({ ...baseline, releaseStage, mode, kind, actorType, followup, status, aiPaused: true, writesDisabled: true })).toBe(SAV_V0_ENGINE_RETIRED);
        }
      }
    } finally { process.env = previous; }
  });
  it("only the pilot-batch block comes before the retirement; a person's command keeps every existing guard", () => {
    expect(savWriteDenial({ ...baseline, actorType: "ai", pilotBatchId: "batch" })).toBe("SAV_PILOT_WRITE_BLOCKED");
    expect(savWriteDenial({ ...baseline, actorType: "human", writesDisabled: true })).toBe("SAV_WRITES_DISABLED");
    expect(savWriteDenial({ ...baseline, actorType: "human", status: "succeeded" })).toBe("SAV_ACTION_NO_LONGER_PENDING");
    expect(savWriteDenial({ ...baseline, actorType: "human", mode: "assist" })).toBeNull();
  });
  it("a retired action that reaches a worker is failed with its own code, never retried, never cancelled as if it had been handled", () => {
    expect(isSavWriteCancellation(SAV_V0_ENGINE_RETIRED)).toBe(false);
    for (const attempt of [0, 1, 5]) expect(savActionFailurePlan(SAV_V0_ENGINE_RETIRED, attempt)).toEqual({ status: "failed", scheduledAt: null, terminal: true });
  });
  it("a person's command is unchanged in every stage and mode that allowed it before", () => {
    for (const kind of ["create_ticket", "link_ticket", "create_note", "log_email", "update_ticket_status"]) {
      expect(savModeAllowsWrite("on", kind, "human", false, "v0")).toBe(true);
      expect(savModeAllowsWrite("assist", kind, "human", false, "v4")).toBe(true);
    }
    expect(savModeAllowsWrite("shadow", "send_reply", "human", false, "v4")).toBe(false);
  });
});
