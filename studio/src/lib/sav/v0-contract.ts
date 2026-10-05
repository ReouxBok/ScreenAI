/** V0 is a supervised cockpit: manual replies only, no autonomous sending. */
export function savV0WriteDenial(kind: string, actorType: string): string | null {
  if (kind === "request_human" || kind === "send_reply" && actorType !== "human") return "SAV_V0_EMAIL_DISABLED";
  if (kind === "send_reply") return null;
  if (!["create_ticket", "link_ticket", "log_email", "create_note", "update_ticket_status"].includes(kind)) {
    return "SAV_V0_ACTION_DISABLED";
  }
  return actorType === "human" ? null : "SAV_HUMAN_APPROVAL_REQUIRED";
}

export type SavProposalState = "pending_analysis" | "proposed" | "validated" | "rejected" | "obsolete" | "human_owned" | "analysis_failed";
export type SavProposalEvent = "analysis_ready" | "analysis_failed" | "retry_analysis" | "validate" | "reject" | "correct" | "new_inbound" | "takeover";

/** Invalid commands fail closed. Ticket creation is deliberately not a review event. */
export function transitionSavProposal(state: SavProposalState, event: SavProposalEvent): SavProposalState {
  if (event === "takeover") return "human_owned";
  if (event === "new_inbound") return state === "human_owned" ? "human_owned" : "obsolete";
  if (state === "pending_analysis" && event === "analysis_ready") return "proposed";
  if (state === "pending_analysis" && event === "analysis_failed") return "analysis_failed";
  if (state === "analysis_failed" && event === "retry_analysis") return "pending_analysis";
  if (state === "proposed" && ["validate", "correct"].includes(event)) return "validated";
  if (state === "proposed" && event === "reject") return "rejected";
  throw new Error("SAV_INVALID_PROPOSAL_TRANSITION");
}
