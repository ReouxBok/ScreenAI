import { sleep } from "workflow";
import { continueSavHeartbeatStep, savHeartbeatCatchUpStep, savHeartbeatTickStep, savHeartbeatV2EffectsStep } from "./steps";

/** Fallback heartbeat of the self-scheduler (lib/sav/self-scheduler.ts): a bounded loop of ticks 4 min apart plus their steps (about 5 to 6 h),
 * then a fresh run of itself on the latest deployment (continueSavHeartbeat documents "latest" and rollbacks), so the event
 * log stays small. One owner per run; a tick that finds the switch OFF or another fresh owner stops the loop with no
 * continuation. A failing or timed-out step is logged and the loop goes on: a crash never ends the heartbeat. */
export const SAV_HEARTBEAT_ITERATIONS = 72;
export type SavHeartbeatState = { owner: string; generation: number };
export type SavHeartbeatResult = { stopped: string; iterations: number; generation: number }
  | { continuedAs: string | null; reason: string | null; iterations: number; generation: number };

export async function savHeartbeatWorkflow(state: SavHeartbeatState): Promise<SavHeartbeatResult> {
  "use workflow";
  for (let iteration = 0; iteration < SAV_HEARTBEAT_ITERATIONS; iteration++) {
    let ticked = false;
    try {
      const tick = await savHeartbeatTickStep(state.owner);
      if (!tick.alive) return { stopped: tick.reason, iterations: iteration, generation: state.generation };
      ticked = true;
      await savHeartbeatCatchUpStep();
    } catch {
      console.error("sav_self_scheduler_heartbeat", { status: "step_failed", iteration, generation: state.generation });
    }
    // After a live tick, the V2 effects pass is guarded on its own: a failed catch-up pass does not skip it.
    if (ticked) {
      try {
        await savHeartbeatV2EffectsStep();
      } catch {
        console.error("sav_self_scheduler_heartbeat", { status: "v2_effects_step_failed", iteration, generation: state.generation });
      }
    }
    // 4 min plus the steps: sav-reconcile about every 5 min once the fallback runs it (SELF_SCHEDULER_TIMING).
    await sleep("4m");
  }
  try {
    const next = await continueSavHeartbeatStep(state);
    return { continuedAs: next.continued ? next.runId : null, reason: next.continued ? null : next.reason, iterations: SAV_HEARTBEAT_ITERATIONS, generation: state.generation };
  } catch {
    return { continuedAs: null, reason: "continue_step_failed", iterations: SAV_HEARTBEAT_ITERATIONS, generation: state.generation };
  }
}
