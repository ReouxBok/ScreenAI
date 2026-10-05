import type { SavAutomationMode, SavReleaseStage } from "./config";
import { savV0WriteDenial } from "./v0-contract";

export function savModeAllowsWrite(mode: SavAutomationMode, kind: string, actorType: string, followup = false, releaseStage: SavReleaseStage = "v0") {
  if (mode === "shadow") return false;
  if (releaseStage === "v0") return savV0WriteDenial(kind, actorType) === null;
  if (!["send_reply", "request_human", "create_ticket", "link_ticket", "log_email", "create_note", "update_ticket_status"].includes(kind)) return false;
  // V1 may automate intake, never customer replies, followups or processing.
  if (releaseStage === "v1" && actorType !== "human" && !["create_ticket", "link_ticket", "log_email"].includes(kind)) return false;
  if (mode === "assist") return actorType === "human";
  if (mode === "semi" && kind === "send_reply") return actorType === "human" || followup;
  return true;
}

export type SavWriteContext = {
  mode: SavAutomationMode;
  releaseStage?: SavReleaseStage;
  writesDisabled: boolean;
  kind: string;
  actorType: string;
  pilotBatchId: string | null;
  status: string;
  aiPaused: boolean;
  messageId: string | null;
  latestInboundId: string | null;
  followup: boolean;
  threadStatus: string;
  actionCreatedAt: Date;
  latestInboundCreatedAt: Date | null;
  statusTarget?: string;
  manualReplyConfirmed?: boolean;
};

/** Re-evaluated by workers, not an authorization frozen when a draft is made. */
export function savWriteDenial(input: SavWriteContext): string | null {
  if (input.pilotBatchId) return "SAV_PILOT_WRITE_BLOCKED";
  if (input.writesDisabled || input.mode === "shadow") return "SAV_WRITES_DISABLED";
  if (!["pending", "running"].includes(input.status)) return "SAV_ACTION_NO_LONGER_PENDING";
  if ((input.releaseStage ?? "v0") === "v0") {
    const denial = savV0WriteDenial(input.kind, input.actorType);
    if (denial) return denial;
    if (input.kind === "send_reply" && (!input.manualReplyConfirmed || input.followup)) return "SAV_REPLY_MANUAL_APPROVAL_REQUIRED";
  }
  const email = input.kind === "send_reply" || input.kind === "request_human";
  if (!savModeAllowsWrite(input.mode, input.kind, input.actorType, input.followup, input.releaseStage)) return "SAV_HUMAN_APPROVAL_REQUIRED";
  if (input.kind === "send_reply") {
    // A transfer acknowledgement is deliberately separate from a solution.
    if (input.aiPaused) return "SAV_THREAD_PAUSED";
    if (input.followup && input.threadStatus !== "awaiting_customer") return "SAV_FOLLOWUP_OBSOLETE";
    if (!input.followup && (!input.messageId || input.messageId !== input.latestInboundId)) return "SAV_REPLY_OBSOLETE";
  }
  if (input.kind === "update_ticket_status" && input.statusTarget === "awaiting_customer") {
    if (input.aiPaused) return "SAV_THREAD_PAUSED";
    if (!input.messageId || input.messageId !== input.latestInboundId) return "SAV_REPLY_OBSOLETE";
  }
  if (email && input.latestInboundCreatedAt && input.latestInboundCreatedAt > input.actionCreatedAt) return "SAV_REPLY_OBSOLETE";
  return null;
}

export function isSavWriteCancellation(code: string) {
  return ["SAV_PILOT_WRITE_BLOCKED", "SAV_ACTION_NO_LONGER_PENDING", "SAV_THREAD_PAUSED", "SAV_FOLLOWUP_OBSOLETE", "SAV_REPLY_OBSOLETE"].includes(code);
}
