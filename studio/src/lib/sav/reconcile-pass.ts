import "server-only";
import { refreshIntakeConsole } from "@/lib/sav/intake/console-store";
import { reconcileHandledIntakeGmailRead } from "@/lib/sav/intake/gmail-read";
import { ensureIntakeObservations } from "@/lib/sav/intake/observation-binding";
import { reconcileIntakeHumanChoices } from "@/lib/sav/intake/human-worker";
import { reconcileIntakeExecutor } from "@/lib/sav/intake/executor";
import { reconcileTicketSafetyNet } from "@/lib/sav/intake/ticket-safety-net";
import { reconcileSavIntakeRuntime } from "@/lib/sav/intake/runtime";
import { dispatchPendingSavIntakeWakes } from "@/lib/sav/intake/event-dispatch";
import { reconcileSavTranslations } from "@/lib/sav/translations";
import { processPendingGmailReceipts, processPendingGmailSendActions } from "@/lib/sav/gmail";
import { continueHubspotBackfill, getHubspotBackfillState, processPendingHubspotActions, processPendingHubspotReceipts, processPendingPilotHubspotActionsAcrossBatches, shouldAttemptHubspotBackfill } from "@/lib/sav/hubspot";
import { expireStaleEvaluationRuns } from "@/lib/evaluations";
import { enforceSavRetention } from "@/lib/sav/retention";
import { reconcileSavObservations } from "@/lib/sav/observations";
import { reconcileStaleTrainings } from "@/lib/training";
import { processPendingSavContextRefreshes, dispatchPendingSavEmailOpenings } from "@/lib/sav/dispatch";
import { refreshSavDashboardProjection, savSqlDashboardEnabled } from "@/lib/sav/dashboard-projection";
import { randomUUID } from "node:crypto";
import { recordSavWorkerPulse } from "@/lib/sav/monitor";
import { savV2OwnerHandoverEnabled, savV2OwnerHandoverPollEnabled } from "@/lib/sav/cases/owner-handover-config";
import { savAppTicketsMode } from "@/lib/sav/cases/app-tickets-config";

export type SavReconcileTrigger = "vercel_cron" | "gmail_webhook" | "heartbeat_workflow";
export type SavReconcilePassOptions = { trigger: SavReconcileTrigger; pulseId?: string; budgetMs?: number };

/** The cron's log shape stays exactly as before; only a fallback pass names its trigger. */
const triggerField = (trigger: SavReconcileTrigger) => trigger === "vercel_cron" ? {} : { trigger };

function safeErrorCode(error: unknown) {
  return (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160);
}

/** V2 catch-up (SAV-11): the wake relays only the executions it confirms itself. An execution this worker confirms, or a wake that crashed after
 * V1's confirmation, reaches its case here, from V1's records only. The V2 case code is loaded only when the relay is on, as in the wake. */
async function sweepMissedCaseRelays() {
  if (process.env.SAV_CASE_RECORDING !== "on") return { skipped: "recording_off" };
  if (process.env.SAV_V2_ENTRY !== "on") return (await import("@/lib/sav/cases/intake-boundary")).sweepCaseRelays({ limit: 50 });
  const entry = await import("@/lib/sav/cases/v2-entry");
  const relays = await (await import("@/lib/sav/cases/intake-boundary")).sweepCaseRelays({ limit: 50, deps: entry.v2EntryRelayDeps(process.env) });
  return { relays, continuations: await entry.sweepCaseContinuations({ env: process.env }) };
}

async function runWorkerStep<T>(trigger: SavReconcileTrigger, name: string, operation: () => Promise<T>) {
  const startedAt = Date.now();
  try {
    const data = await operation();
    const result = { status: "ok" as const, durationMs: Date.now() - startedAt, data };
    console.info("sav_worker_step", { name, status: result.status, durationMs: result.durationMs, ...triggerField(trigger) });
    return result;
  } catch (error) {
    const result = { status: "error" as const, durationMs: Date.now() - startedAt, errorCode: safeErrorCode(error) };
    console.error("sav_worker_step", { name, status: result.status, durationMs: result.durationMs, errorCode: result.errorCode, ...triggerField(trigger) });
    return result;
  }
}

/** One sav-reconcile pass, shared by the Vercel cron (primary path, unchanged) and the self-scheduler fallback
 * (lib/sav/self-scheduler.ts). It records the same worker pulse; a fallback pass adds `trigger` to its step logs. */
export async function runSavReconcilePass(options: SavReconcilePassOptions) {
  const trigger = options.trigger;
  const runStep = <T,>(name: string, operation: () => Promise<T>) => runWorkerStep(trigger, name, operation);
  const pulseId = options.pulseId ?? randomUUID(), pulseStartedAt = new Date().toISOString();
  await recordSavWorkerPulse(pulseId, pulseStartedAt);
  try {
  const derivedDeadline=Date.now()+(options.budgetMs ?? 270000);
  const [gmail, hubspot] = await Promise.all([
    runStep("gmail_receipts", () => processPendingGmailReceipts(50)),
    runStep("hubspot_receipts", () => processPendingHubspotReceipts(50)),
  ]);
  // SAV-96 repair: HubSpot sends no webhook, so a bounded search of the tickets owned by the V2 owner feeds the same markers (off: no call).
  const ownerHandoverPoll = savV2OwnerHandoverPollEnabled() ? await runStep<Awaited<ReturnType<typeof import("@/lib/sav/cases/owner-handover-poll").pollSavOwnerHandovers>>>("v2_owner_handover_poll", async () =>
    (await import("@/lib/sav/cases/owner-handover-poll")).pollSavOwnerHandovers({ deadlineMs: derivedDeadline })) : undefined;
  const ownerHandovers = savV2OwnerHandoverEnabled() ? await runStep("v2_owner_handovers", async () =>
    (await import("@/lib/sav/cases/owner-handover")).sweepDueOwnerHandovers(derivedDeadline)) : undefined;
  // SAV-138: tickets created from the Limova app (no mail), SAV_APP_TICKETS_MODE=shadow|live. Off (default): no HubSpot call, absent from the payload, except
  // the once-only hand-back of live rows left mid-way when live was switched off (one bounded database read when there is none).
  const appTickets = savAppTicketsMode() !== "off" ? await runStep<Awaited<ReturnType<typeof import("@/lib/sav/cases/app-tickets").reconcileSavAppTickets>>>("v2_app_tickets", async () =>
    (await import("@/lib/sav/cases/app-tickets")).reconcileSavAppTickets({ deadlineMs: derivedDeadline }))
    : await (await import("@/lib/sav/cases/app-tickets")).reconcileSavAppTickets({ deadlineMs: derivedDeadline })
      .then(result => "released" in result && result.released ? { status: "ok" as const, durationMs: 0, data: result } : undefined)
      .catch(() => { console.warn("sav_v2_app_tickets", { mode: "off", status: "release_failed" }); return undefined; });
  const emailOpenings = await runStep("email_openings", () => dispatchPendingSavEmailOpenings(10));
  const contextRefreshes = await runStep("context_refreshes", () => processPendingSavContextRefreshes(5));
  const [trainings, evaluations] = await Promise.all([
    runStep("training_sessions", () => reconcileStaleTrainings()),
    runStep("evaluation_runs", () => expireStaleEvaluationRuns()),
  ]);
  // Ticket creation must precede reply sending, and status updates follow the
  // Gmail action. Keeping these steps ordered prevents orphaned conversations.
  const ticketActions = await runStep("hubspot_ticket_actions", () => processPendingHubspotActions(50));
  const intakeObservation = await runStep("intake_observation", () => reconcileSavIntakeRuntime({ deadlineMs: derivedDeadline }));
  // Redispatches wakes lost after commit; the inline analysis above stays the fallback.
  const intakeWakes = await runStep("intake_wakes", () => dispatchPendingSavIntakeWakes());
  const intakeChoices = await runStep<Awaited<ReturnType<typeof reconcileIntakeHumanChoices>> | { skipped: string }>("intake_choices", () => Date.now()+45_000>derivedDeadline?Promise.resolve({skipped:"deadline"}):reconcileIntakeHumanChoices());
  const intakeExecution = await runStep<Awaited<ReturnType<typeof reconcileIntakeExecutor>> | { skipped: string }>("intake_execution",()=>Date.now()+60_000>derivedDeadline?Promise.resolve({skipped:"deadline"}):reconcileIntakeExecutor({deadlineMs:derivedDeadline}));
  // SAV-88: a mail whose analysis is blocked or older than 24 h without ticket gets the V1 ticket rules without a model (observe by default).
  const ticketSafetyNet = await runStep<Awaited<ReturnType<typeof reconcileTicketSafetyNet>> | { skipped: string }>("intake_ticket_safety_net", () => Date.now()+30_000>derivedDeadline ? Promise.resolve({skipped:"deadline"}) : reconcileTicketSafetyNet({ deadlineMs: Math.min(derivedDeadline, Date.now()+60_000) }));
  const caseRelays = await runStep<Awaited<ReturnType<typeof sweepMissedCaseRelays>> | { skipped: string }>("case_relays", () => Date.now()+20_000>derivedDeadline ? Promise.resolve({skipped:"deadline"}) : sweepMissedCaseRelays());
  const intakeTracking = await runStep("intake_tracking", () => ensureIntakeObservations({ deadlineMs: derivedDeadline }));
  const intakeConsole = await runStep("intake_console", () => refreshIntakeConsole(20));
  // SAV-95: recovery of acknowledgement closures (off unless SAV_ACK_CLOSE=on; the wake after the projection is the fast path).
  const ackClosures = await runStep<Awaited<ReturnType<typeof import("@/lib/sav/intake/ack-closure-store").reconcileAckClosures>> | { skipped: string }>("intake_ack_closure", async () => {
    if (process.env.SAV_ACK_CLOSE !== "on") return { skipped: "off" };
    if (Date.now() + 20_000 > derivedDeadline) return { skipped: "deadline" };
    return (await import("@/lib/sav/intake/ack-closure-store")).reconcileAckClosures(3, Math.min(derivedDeadline, Date.now() + 20_000));
  });
  // V1 routing (23/11): recovery of live forwards/archives (off unless SAV_INTAKE_ROUTING_MODE=live; the wake after the analysis is the fast path).
  const intakeRouting = await runStep<Awaited<ReturnType<typeof import("@/lib/sav/intake/routing-store").reconcileIntakeRoutings>> | { skipped: string }>("intake_routing", async () => {
    if (process.env.SAV_INTAKE_ROUTING_MODE !== "live") return { skipped: "off" };
    if (Date.now() + 20_000 > derivedDeadline) return { skipped: "deadline" };
    return (await import("@/lib/sav/intake/routing-store")).reconcileIntakeRoutings(3, Math.min(derivedDeadline, Date.now() + 20_000));
  });
  const intakeRead = await runStep<Awaited<ReturnType<typeof reconcileHandledIntakeGmailRead>> | { skipped: string }>("intake_gmail_read", () => Date.now()+1000>=derivedDeadline ? Promise.resolve({skipped:"deadline"}) : reconcileHandledIntakeGmailRead(3,Math.min(derivedDeadline,Date.now()+30000)));
  // Four model runs leave enough headroom for the 45 s grounded-agent budget,
  // a guarded legacy fallback and the remaining integrations inside the 300 s
  // function deadline. A 10-mail batch advances over at most three passages.
  const pilotActions = await runStep("pilot_hubspot_actions", () => processPendingPilotHubspotActionsAcrossBatches(100));
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
    ? await runStep("dashboard_projection", () => refreshSavDashboardProjection(25, undefined, { deadlineMs: derivedDeadline }))
    : { status: "skipped" as const, durationMs: 0, data: { reason: "disabled" } };
  const caseReminders = await runStep("v2_case_j2", async () => {
    if (process.env.SAV_V2_J2 !== "on" || process.env.SAV_CASE_RECORDING !== "on" || process.env.SAV_V2_ENTRY !== "on") return { skipped: "j2_off" };
    if (Date.now() + 20_000 > derivedDeadline) return { skipped: "deadline" };
    const { reconcileCaseJ2 } = await import("@/lib/sav/cases/v2-j2-binding");
    return reconcileCaseJ2({ env: process.env, deadlineMs: derivedDeadline });
  });
  // SAV-97 production self-test of the Access skill on the FICTIONAL corpus (Ugo 18/11): only when SAV_V2_ACCESS_SKILL_SELFTEST=run, independent of the
  // skill's own switch; a small batch per pass, its own capped ledger, no case, ticket, mail, HubSpot or Gmail. Off: absent from the payload, nothing loaded.
  const accessSkillSelfTest = process.env.SAV_V2_ACCESS_SKILL_SELFTEST === "run" ? await runStep("v2_access_skill_selftest", async () => {
    if (Date.now() + 90_000 > derivedDeadline) return { skipped: "deadline" };
    const { runAccessSkillSelfTestPass } = await import("@/lib/sav/cases/access-skill/access-skill-selftest");
    return runAccessSkillSelfTestPass({ env: () => process.env, now: () => new Date(), deadlineMs: derivedDeadline });
  }) : undefined;
  // Agent SAV intelligent (20/11): the new agent in SHADOW mode only, when SAV_V2_SMART_AGENT=shadow; its own capped ledger, no case, ticket, mail, HubSpot,
  // Gmail or Slack, nothing queued. Any other value: absent from the payload, nothing loaded.
  const smartShadow = process.env.SAV_V2_SMART_AGENT === "shadow" ? await runStep("v2_smart_shadow", async () => {
    if (Date.now() + 90_000 > derivedDeadline) return { skipped: "deadline" };
    const { runSmartShadowPass } = await import("@/lib/sav/cases/smart/smart-shadow");
    return runSmartShadowPass({ env: () => process.env, now: () => new Date(), deadlineMs: derivedDeadline });
  }) : undefined;
  // Bounded REPLAY of the shadow (25/11): only when SAV_V2_SMART_SHADOW_REPLAY is a valid run id; AFTER the shadow, on the time left; its own run ledger,
  // no case, ticket, mail, HubSpot, Gmail or Slack. Absent or invalid: absent from the payload, nothing loaded.
  const smartShadowReplay = /^[a-z0-9-]{6,40}$/.test(process.env.SAV_V2_SMART_SHADOW_REPLAY ?? "") ? await runStep("v2_smart_shadow_replay", async () => {
    if (Date.now() + 90_000 > derivedDeadline) return { skipped: "deadline" };
    const { runSmartReplayPass } = await import("@/lib/sav/cases/smart/smart-shadow-replay");
    return runSmartReplayPass({ env: () => process.env, now: () => new Date(), deadlineMs: derivedDeadline });
  }) : undefined;
  const smartBenchSelfTest =process.env.SAV_V2_SMART_BENCH_SELFTEST === "run" ? await runStep("v2_smart_bench_selftest", async () => {
    if (Date.now() + 90_000 > derivedDeadline) return { skipped: "deadline" };
    const { runSmartBenchSelfTestPass } = await import("@/lib/sav/cases/smart/smart-bench-selftest");
    return runSmartBenchSelfTestPass({ env: () => process.env, now: () => new Date(), deadlineMs: derivedDeadline });
  }) : undefined;
  // V2 effects (replies, handoff notices, ticket stages, closures) have their own worker: /api/cron/sav-v2-effects (11/11).
  const payload = { ...(ownerHandoverPoll ? { ownerHandoverPoll } : {}), ...(ownerHandovers ? { ownerHandovers } : {}), ...(appTickets ? { appTickets } : {}), ...(accessSkillSelfTest ? { accessSkillSelfTest } : {}), ...(smartShadow ? { smartShadow } : {}), ...(smartShadowReplay ? { smartShadowReplay } : {}), ...(smartBenchSelfTest ? { smartBenchSelfTest } : {}), caseReminders, ticketSafetyNet, ackClosures, intakeRouting, intakeRead, intakeWakes, intakeTracking, intakeChoices, intakeConsole, intakeExecution, caseRelays, intakeObservation, gmail, hubspot, emailOpenings, contextRefreshes, trainings, evaluations, ticketActions, pilotActions, replies, statusActions, learningBackfill, observations, translations, retention, dashboardProjection };
  const hasStepFailure = Object.values(payload).some((step) => step.status === "error");
  await recordSavWorkerPulse(pulseId, pulseStartedAt, hasStepFailure);
  return { payload, hasStepFailure, pulseId };
  } catch (error) {
    await recordSavWorkerPulse(pulseId, pulseStartedAt, true);
    throw error;
  }
}
