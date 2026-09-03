import { processPendingGmailReceipts, processPendingGmailSendActions } from "@/lib/sav/gmail";
import { continueHubspotBackfill, getHubspotBackfillState, processPendingHubspotActions, processPendingHubspotReceipts, processPendingPilotHubspotActionsAcrossBatches, shouldAttemptHubspotBackfill } from "@/lib/sav/hubspot";
import { processDueFollowups } from "@/lib/sav/followups";
import { processPendingSavPilotItems } from "@/lib/sav/service";
import { expireStaleEvaluationRuns } from "@/lib/evaluations";
import { reconcileStaleTrainings } from "@/lib/training";

export const runtime = "nodejs";
export const maxDuration = 300;

function safeErrorCode(error: unknown) {
  return (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160);
}

async function runStep<T>(name: string, operation: () => Promise<T>) {
  const startedAt = Date.now();
  try {
    const data = await operation();
    const result = { status: "ok" as const, durationMs: Date.now() - startedAt, data };
    console.info("sav_worker_step", { name, status: result.status, durationMs: result.durationMs });
    return result;
  } catch (error) {
    const result = { status: "error" as const, durationMs: Date.now() - startedAt, errorCode: safeErrorCode(error) };
    console.error("sav_worker_step", { name, status: result.status, durationMs: result.durationMs, errorCode: result.errorCode });
    return result;
  }
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const [gmail, hubspot] = await Promise.all([
    runStep("gmail_receipts", () => processPendingGmailReceipts(50)),
    runStep("hubspot_receipts", () => processPendingHubspotReceipts(50)),
  ]);
  const [trainings, evaluations] = await Promise.all([
    runStep("training_sessions", () => reconcileStaleTrainings()),
    runStep("evaluation_runs", () => expireStaleEvaluationRuns()),
  ]);
  // Ticket creation must precede reply sending, and status updates follow the
  // Gmail action. Keeping these steps ordered prevents orphaned conversations.
  const ticketActions = await runStep("hubspot_ticket_actions", () => processPendingHubspotActions(50));
  // Four model runs leave enough headroom for the 45 s grounded-agent budget,
  // a guarded legacy fallback and the remaining integrations inside the 300 s
  // function deadline. A 10-mail batch advances over at most three passages.
  const pilotItems = await runStep("pilot_items", () => processPendingSavPilotItems(4));
  const pilotActions = await runStep("pilot_hubspot_actions", () => processPendingPilotHubspotActionsAcrossBatches(100));
  const followups = await runStep("followups", () => processDueFollowups(50));
  const replies = await runStep("gmail_replies", () => processPendingGmailSendActions(50));
  const statusActions = await runStep("hubspot_status_actions", () => processPendingHubspotActions(50));
  const backfillState = await getHubspotBackfillState().catch(() => null);
  const learningBackfill = process.env.SAV_HUBSPOT_BACKFILL_ENABLED === "false"
    ? { status: "skipped" as const, durationMs: 0, data: { reason: "disabled" } }
    : !shouldAttemptHubspotBackfill(backfillState)
      ? { status: "skipped" as const, durationMs: 0, data: { reason: "configuration_required", retry: "automatic_within_30_minutes_or_manual" } }
    : await runStep("hubspot_learning_backfill", () => continueHubspotBackfill(1, 10));
  return Response.json({ gmail, hubspot, trainings, evaluations, ticketActions, pilotItems, pilotActions, followups, replies, statusActions, learningBackfill });
}
