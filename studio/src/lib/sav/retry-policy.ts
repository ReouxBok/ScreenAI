import { isSavWriteCancellation } from "./action-policy";

export function savActionFailurePlan(errorCode: string, attemptCount: number, now = new Date()) {
  if (/REPLY_MANUAL_|KNOWLEDGE_CHANGED_REANALYSIS_REQUIRED|MANUAL_RECONCILIATION_REQUIRED|PROPOSAL_STALE|EXISTING_TICKET_REQUIRES_LINK|DISTINCT_ISSUE_CONFIRMATION_REQUIRED|GMAIL_THREAD_CHANGED|GMAIL_PREFLIGHT_INCOMPLETE|HUBSPOT_CONTACT_REQUIRED|LINK_TARGET_INVALID|VALIDATED_CURRENT_PROPOSAL_REQUIRED/.test(errorCode)) return { status: "failed" as const, scheduledAt: null, terminal: true };
  if (isSavWriteCancellation(errorCode)) return { status: "cancelled" as const, scheduledAt: null, terminal: true };
  const permanent = /(?:_HTTP_40[01345678]|_HTTP_422|RECIPIENT_BLOCKED|MATCH_AMBIGUOUS|MISSING|NOT_FOUND|INVALID|CANNOT_RESOLVE)/.test(errorCode)
    && !/(?:_HTTP_408|_HTTP_429)/.test(errorCode);
  if (permanent || attemptCount >= 5) return { status: "failed" as const, scheduledAt: null, terminal: true };
  const delayMinutes = Math.min(60, 2 ** Math.max(0, attemptCount - 1));
  return { status: "pending" as const, scheduledAt: new Date(now.getTime() + delayMinutes * 60_000), terminal: false };
}
