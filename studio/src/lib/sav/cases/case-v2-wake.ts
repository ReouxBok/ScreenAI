// V2 wake (local, OFF): the ONE call that composes the C-owned passes, in the only order that is safe. No route, no cron, no action calls it: the caller decides when.
//   1. handoff    sweep (`enqueueHandoffNotices`: an exhausted, accepted plan only) then the Slack pass (`runHandoffNoticePass`)
//   2. replies    `runCaseEffectsPass` (read-only verification of engaged effects first, then the supervised sends) on the existing executor
//   3. stages     `runCaseTicketStagePass` (« waiting for the customer » queued by the confirmed reply, « closed » queued by step 4)
//   2b. hand-over stages (SAV-92, only under `SAV_V2_HANDOFF_STAGE=on`) `enqueueHandoffStages`: « Nouveau », no owner, once per V2 hand-over
//   4. closures   `applyProvenResolutions`: a proven resolution ends the case `resolved` and queues the « closed » stage for the next wake
// Every port is REQUIRED: there is no default transport, so nothing can reach a provider by omission. A step that throws is reported in `failures`, never swallowed, and the
// next step still runs (the steps are independent; each one re-reads its own guards: pause, mode, lease, owner).
import "server-only";
import { applyProvenResolutions, type ProvenResolutionSweepResult } from "./case-resolution";
import { enqueueHandoffNotices, runHandoffNoticePass, type HandoffNoticePassResult, type HandoffNoticeRuntimeDeps, type HandoffNoticeSweepResult } from "./case-handoff-notice-store";
import { runCaseEffectsPass, type CaseRuntimeDeps, type CaseRuntimePassResult } from "./case-runtime-effects";
import { runCaseTicketStagePass, type TicketStagePassResult, type TicketStageRuntimeDeps } from "./case-ticket-stage-store";
import { enqueueHandoffStages, handoffActivationSinceMs, type HandoffStageSweepResult } from "./case-handoff-stage";
import { caseHandoffStageEnabled } from "./customer-return";

export type CaseV2WakeDeps = Readonly<{
  /** The approved execution policy `{ id, hash }` the sweeps queue under (the same the replies were queued under). */
  policy: Readonly<{ id: string; hash: string }>;
  /** Cases touched since this date are examined by the sweeps. */
  since: Date;
  /** Replies: the executor ports (Gmail, HubSpot reads), the CRM owner reader, the clock. */
  replies: CaseRuntimeDeps;
  /** Handoff: network (Slack) and CRM reader injected; env and deadline come from `replies`. */
  handoff: Omit<HandoffNoticeRuntimeDeps, "env" | "deadlineMs">;
  /** Stages: network (HubSpot) injected; env, deadline and the owner reader come from `replies`. */
  stages: Omit<TicketStageRuntimeDeps, "env" | "deadlineMs" | "readTicketOwner">;
}>;

export type CaseV2WakeResult = Readonly<{
  handoffSweep: HandoffNoticeSweepResult | null;
  handoff: HandoffNoticePassResult | null;
  replies: CaseRuntimePassResult | null;
  /** SAV-92 (17/11): present only under `SAV_V2_HANDOFF_STAGE=on`. */
  handoffStages?: HandoffStageSweepResult | null;
  stages: TicketStagePassResult | null;
  closures: ProvenResolutionSweepResult | null;
  /** Steps that threw: the step name and a closed error code. Nothing is erased. */
  failures: ReadonlyArray<Readonly<{ step: "handoff_sweep" | "handoff" | "replies" | "handoff_stages" | "stages" | "closures"; code: string }>>;
  /** Steps not started because `deadlineMs` was reached first. Nothing durable is lost: the next wake does them. */
  skippedByDeadline: ReadonlyArray<"handoff_sweep" | "handoff" | "replies" | "handoff_stages" | "stages" | "closures">;
}>;

/** One aggregate line per hand-over sweep (counts by refusal code, never a case id), so a check of the logs proves what the sweep did. */
function logSweep(name: "handoff_notice" | "handoff_stage", result: HandoffNoticeSweepResult | HandoffStageSweepResult | null | undefined) {
  if (result) console.info("sav_v2_handoff_sweep", { name, examined: result.examined, created: result.created, existing: result.existing, refused: result.refused,
    windowEnded: result.windowEnded, stoppedByDeadline: result.stoppedByDeadline });
}

const codeOf = (error: unknown) => (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);

export async function runCaseV2Wake(deps: CaseV2WakeDeps): Promise<CaseV2WakeResult> {
  const failures: Array<{ step: CaseV2WakeResult["failures"][number]["step"]; code: string }> = [], skipped: Array<CaseV2WakeResult["failures"][number]["step"]> = [];
  /** A step that has not started when the budget is spent is not started (nothing is lost: each step re-reads its own work at the next wake); one that started keeps its own signal. */
  async function step<T>(name: (typeof failures)[number]["step"], run: () => Promise<T>): Promise<T | null> {
    if (Date.now() >= deps.replies.deadlineMs) { skipped.push(name); return null; }
    try { return await run(); } catch (error) { failures.push({ step: name, code: codeOf(error) }); return null; }
  }
  const { env, deadlineMs, readTicketOwner } = deps.replies;
  // Ugo (25/11): the hand-over sweeps walk only the cases touched since the hand-over activation (`SAV_V2_HANDOFF_STAGE_SINCE`), not the whole policy window:
  // at 50 cases a wake, a window of weeks took hours per lap (and a lap walked while a switch was off skipped its cases until the next one). Their admissions
  // refuse anything recorded before that date anyway. Without a valid date (or with `SAV_V2_HANDOFF_STAGE` off): the policy window, as before. Closures keep it too.
  const activation = handoffActivationSinceMs(env());
  const handoffSince = activation === null ? deps.since : new Date(activation);
  const handoffSweep = await step("handoff_sweep", () => enqueueHandoffNotices({ policy: deps.policy, env, since: handoffSince, deadlineMs }));
  logSweep("handoff_notice", handoffSweep);
  const handoff = await step("handoff", () => runHandoffNoticePass({ ...deps.handoff, env, deadlineMs }));
  const replies = await step("replies", () => runCaseEffectsPass(deps.replies));
  // SAV-92 (17/11): only under `SAV_V2_HANDOFF_STAGE=on` (off: the step does not exist, the wake is the same as before). After the replies (a hand-over reply sent in this
  // wake queues its stage from its receipt), before the stages pass (which moves it in this same wake).
  const handoffStages = caseHandoffStageEnabled(env()) ? await step("handoff_stages", () => enqueueHandoffStages({ policy: deps.policy, env, since: handoffSince, deadlineMs })) : undefined;
  logSweep("handoff_stage", handoffStages);
  const stages = await step("stages", () => runCaseTicketStagePass({ ...deps.stages, env, deadlineMs, readTicketOwner }));
  const closures = await step("closures", () => applyProvenResolutions({ policy: deps.policy, env, since: deps.since, deadlineMs, currentPolicyRevision: deps.replies.currentPolicyRevision, readTicketOwner }));
  return { handoffSweep, handoff, replies, ...(handoffStages === undefined ? {} : { handoffStages }), stages, closures, failures, skippedByDeadline: skipped };
}
