import { reconcileSavTranslations } from "@/lib/sav/translations";
import { processPendingGmailReceipts, processPendingGmailSendActions } from "@/lib/sav/gmail";
import { continueHubspotBackfill, getHubspotBackfillState, processPendingHubspotActions, processPendingHubspotReceipts, processPendingPilotHubspotActionsAcrossBatches, shouldAttemptHubspotBackfill } from "@/lib/sav/hubspot";
import { processDueFollowups } from "@/lib/sav/followups";
import { processPendingSavMessages, processPendingSavPilotItems } from "@/lib/sav/service";
import { expireStaleEvaluationRuns } from "@/lib/evaluations";
import { enforceSavRetention } from "@/lib/sav/retention";
import { reconcileSavObservations } from "@/lib/sav/observations";
import { reconcileStaleTrainings } from "@/lib/training";
import { processPendingSavContextRefreshes, dispatchPendingSavEmailOpenings } from "@/lib/sav/dispatch";
import { refreshSavDashboardProjection, savSqlDashboardEnabled } from "@/lib/sav/dashboard-projection";

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
  const derivedDeadline=Date.now()+270000;
  const [gmail, hubspot] = await Promise.all([
    runStep("gmail_receipts", () => processPendingGmailReceipts(50)),
    runStep("hubspot_receipts", () => processPendingHubspotReceipts(50)),
  ]);
  const emailOpenings = await runStep("email_openings", () => dispatchPendingSavEmailOpenings(10));
  const contextRefreshes = await runStep("context_refreshes", () => processPendingSavContextRefreshes(5));
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
  const pendingMessages = await runStep("pending_messages", () => processPendingSavMessages(4));
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
  const observations = await runStep("resolution_observations", () => reconcileSavObservations(5,new Date(),{deadlineMs:Math.min(derivedDeadline,Date.now()+40000),maxComparisons:1}));
  const translations=await runStep("message_translations",()=>reconcileSavTranslations(2,{deadlineMs:derivedDeadline}));
  const retention = await runStep("retention", () => enforceSavRetention());
  const dashboardProjection = savSqlDashboardEnabled()
    ? await runStep("dashboard_projection", () => refreshSavDashboardProjection(100))
    : { status: "skipped" as const, durationMs: 0, data: { reason: "disabled" } };
  const payload = { gmail, hubspot, emailOpenings, contextRefreshes, trainings, evaluations, ticketActions, pilotItems, pendingMessages, pilotActions, followups, replies, statusActions, learningBackfill, observations, translations, retention, dashboardProjection };
  const hasStepFailure = Object.values(payload).some((step) => step.status === "error");
  return Response.json(payload, { status: hasStepFailure ? 500 : 200 });
}
