import "server-only";
import { maybeRunCatchUp, maybeRunV2Effects, runSavHeartbeatTick } from "@/lib/sav/self-scheduler";
import { continueSavHeartbeat } from "@/lib/sav/self-scheduler-heartbeat";
import type { SavHeartbeatState } from "./index";

/** The beat (singleton and database switch, re-read every tick) and the light checks: watch renewal, monitor, memory
 * retention, each bounded by its own lease. */
export async function savHeartbeatTickStep(owner: string) {
  "use step";
  return runSavHeartbeatTick(owner);
}
// Never retried by the runtime: the next tick, 5 min later, is the retry.
savHeartbeatTickStep.maxRetries = 0;

/** At most one sav-reconcile pass (270 s budget) when the last one started more than 12 min ago. */
export async function savHeartbeatCatchUpStep() {
  "use step";
  const result = await maybeRunCatchUp("heartbeat_workflow");
  return { status: result.status, reason: result.reason ?? null };
}
savHeartbeatCatchUpStep.maxRetries = 0;

/** At most one sav-v2-effects pass (270 s budget, the cron route's function) when the last one started more than 12 min ago.
 * Its own step, like the catch-up: two 270 s passes never share one step's function deadline. */
export async function savHeartbeatV2EffectsStep() {
  "use step";
  const result = await maybeRunV2Effects("heartbeat_workflow");
  return { status: result.status, reason: result.reason ?? null };
}
savHeartbeatV2EffectsStep.maxRetries = 0;

/** Hands the singleton to the next generation and starts it once (see continueSavHeartbeat). */
export async function continueSavHeartbeatStep(state: SavHeartbeatState) {
  "use step";
  return continueSavHeartbeat(state);
}
// A retry could start a second run of the same generation: never retried; a lost continuation is restarted by a trigger.
continueSavHeartbeatStep.maxRetries = 0;
