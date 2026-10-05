import { describe, expect, it } from "vitest";
import { savV0WriteDenial, transitionSavProposal, type SavProposalState } from "./v0-contract";

describe("V0 contract", () => {
  it.each(["ai", "system"])("never sends customer emails for %s", (actor) => {
    for (const kind of ["send_reply", "request_human"]) expect(savV0WriteDenial(kind, actor)).toBe("SAV_V0_EMAIL_DISABLED");
  });
  it("permits human reply candidates but not automatic transfer acknowledgements", () => {
    expect(savV0WriteDenial("send_reply", "human")).toBeNull();
    expect(savV0WriteDenial("request_human", "human")).toBe("SAV_V0_EMAIL_DISABLED");
  });
  it.each(["create_ticket", "link_ticket", "log_email", "create_note", "update_ticket_status"])("requires explicit human approval for %s", (kind) => {
    expect(savV0WriteDenial(kind, "human")).toBeNull();
    for (const actor of ["ai", "system", "unknown"]) expect(savV0WriteDenial(kind, actor)).toBe("SAV_HUMAN_APPROVAL_REQUIRED");
  });
  it("fails closed on unknown operations", () => {
    expect(savV0WriteDenial("unrecognized", "human")).toBe("SAV_V0_ACTION_DISABLED");
  });
  it("separates analysis, human review and ticket creation", () => {
    expect(transitionSavProposal("pending_analysis", "analysis_ready")).toBe("proposed");
    expect(transitionSavProposal("proposed", "validate")).toBe("validated");
    expect(transitionSavProposal("proposed", "correct")).toBe("validated");
    expect(transitionSavProposal("proposed", "reject")).toBe("rejected");
    expect(transitionSavProposal("analysis_failed", "retry_analysis")).toBe("pending_analysis");
    expect(() => transitionSavProposal("obsolete", "validate")).toThrow("SAV_INVALID_PROPOSAL_TRANSITION");
    expect(() => transitionSavProposal("validated", "analysis_ready")).toThrow();
  });
  it.each(["pending_analysis", "proposed", "validated", "rejected", "obsolete", "human_owned", "analysis_failed"] as SavProposalState[])("invalidates %s on new inbound without resuming human takeover", (state) => {
    expect(transitionSavProposal(state, "new_inbound")).toBe(state === "human_owned" ? "human_owned" : "obsolete");
    expect(transitionSavProposal(state, "takeover")).toBe("human_owned");
  });
});
