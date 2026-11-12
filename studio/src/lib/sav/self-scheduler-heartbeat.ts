import "server-only";
import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { savHeartbeatWorkflow, type SavHeartbeatState } from "@/workflows/sav-heartbeat";
import { abandonSavHeartbeatStart, handOffSavHeartbeat, requestSavHeartbeatStart } from "@/lib/sav/self-scheduler-store";
import { SELF_SCHEDULER_TIMING, savCodeRevision, savSelfSchedulerDisabled, savSelfSchedulerProduction } from "@/lib/sav/self-scheduler";

type Env = Record<string, string | undefined>;
type Start = (state: SavHeartbeatState, options?: { deploymentId: "latest" }) => Promise<{ runId: string }>;
const defaultStart: Start = (state, options) => options ? start(savHeartbeatWorkflow, [state], options) : start(savHeartbeatWorkflow, [state]);
/** One owner per run: `<root>#<generation>`. A generation is started once (handOffSavHeartbeat), so no two runs share one. */
export const savHeartbeatOwner = (root: string, generation: number) => `${root}#${generation}`;
const rootOf = (owner: string) => owner.split("#")[0];

/** Starts the heartbeat workflow when the database switch is ON and none beat in the last 15 min (or the live one runs
 * other code). Production only: a preview or a local server never runs the fallback against shared data. Never throws. */
export async function ensureSavHeartbeat(options: { trigger: "gmail_webhook" | "administrator"; env?: Env; start?: Start }) {
  const env = options.env ?? process.env;
  if (savSelfSchedulerDisabled(env)) return { started: false as const, reason: "disabled" };
  if (!savSelfSchedulerProduction(env)) return { started: false as const, reason: "not_production" };
  const state: SavHeartbeatState = { owner: savHeartbeatOwner(randomUUID(), 0), generation: 0 };
  let request: Awaited<ReturnType<typeof requestSavHeartbeatStart>>;
  try {
    request = await requestSavHeartbeatStart({ owner: state.owner, revision: savCodeRevision(env), now: new Date(), staleMs: SELF_SCHEDULER_TIMING.heartbeatStaleMs });
  } catch {
    console.error("sav_self_scheduler_heartbeat", { trigger: options.trigger, status: "request_failed" });
    return { started: false as const, reason: "request_failed" };
  }
  if (!request.start) return { started: false as const, reason: request.reason };
  try {
    const run = await (options.start ?? defaultStart)(state);
    console.info("sav_self_scheduler_heartbeat", { trigger: options.trigger, status: "started", reason: request.reason, runId: run.runId });
    return { started: true as const, reason: request.reason, runId: run.runId };
  } catch {
    await abandonSavHeartbeatStart(state.owner).catch(() => undefined);
    console.error("sav_self_scheduler_heartbeat", { trigger: options.trigger, status: "start_failed" });
    return { started: false as const, reason: "start_failed" };
  }
}

/** Continuation (continue-as-new) of a heartbeat run that finished its bounded loop. The singleton row is first handed
 * to the next generation's owner (refused when the switch is OFF or this run no longer owns it, which ends the chain),
 * then that run is started with deploymentId "latest": on Vercel it runs on the most recent production deployment, so
 * a heartbeat never outlives a deployment by more than one loop (about 6 h; a webhook or the administrator replaces it
 * sooner). After a rollback, "latest" still means the most recent deployment, not the promoted one: turn the switch OFF
 * (the current run stops at its next tick) and back ON from the restored deployment. Never throws. */
export async function continueSavHeartbeat(state: SavHeartbeatState, options: { env?: Env; start?: Start } = {}) {
  const env = options.env ?? process.env;
  if (savSelfSchedulerDisabled(env)) return { continued: false as const, reason: "disabled" };
  const next: SavHeartbeatState = { owner: savHeartbeatOwner(rootOf(state.owner), state.generation + 1), generation: state.generation + 1 };
  try {
    const handOff = await handOffSavHeartbeat({ from: state.owner, to: next.owner, revision: savCodeRevision(env), now: new Date() });
    if (!handOff.handedOff) return { continued: false as const, reason: handOff.reason };
  } catch {
    console.error("sav_self_scheduler_heartbeat", { status: "handoff_failed" });
    return { continued: false as const, reason: "handoff_failed" };
  }
  try {
    const run = await (options.start ?? defaultStart)(next, { deploymentId: "latest" });
    console.info("sav_self_scheduler_heartbeat", { status: "continued", generation: next.generation, runId: run.runId });
    return { continued: true as const, runId: run.runId };
  } catch {
    await abandonSavHeartbeatStart(next.owner).catch(() => undefined);
    console.error("sav_self_scheduler_heartbeat", { status: "continue_failed" });
    return { continued: false as const, reason: "start_failed" };
  }
}
