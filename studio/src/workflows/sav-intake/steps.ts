import "server-only";
import { analyseSavIntakeWake, executeSavIntakeWake, finishSavIntakeWake } from "@/lib/sav/intake/event-pipeline";

/** V2 (11/11): the budget a step grants to an immediate V2 send, from the step's start. Steps run with the platform's maximum duration (at least 300 s);
 * 240 s leaves room for the step's own work. An immediate send needs 60 s left, else the reply waits for the effects catch-up. */
const V2_IMMEDIATE_STEP_BUDGET_MS = 240_000;

export async function analyseSavIntakeWakeStep(runId: string) {
  "use step";
  // Model attempts are bounded by the run ledger; a step retry would bypass the wake bound.
  return analyseSavIntakeWake(runId, { v2ImmediateDeadlineMs: Date.now() + V2_IMMEDIATE_STEP_BUDGET_MS });
}
analyseSavIntakeWakeStep.maxRetries = 0;

export async function executeSavIntakeWakeStep(runId: string) {
  "use step";
  // Effects are fenced by execution leases; uncertain outcomes are reconciled, never retried.
  return executeSavIntakeWake(runId, { v2ImmediateDeadlineMs: Date.now() + V2_IMMEDIATE_STEP_BUDGET_MS });
}
executeSavIntakeWakeStep.maxRetries = 0;

export async function finishSavIntakeWakeStep(runId: string) {
  "use step";
  const { projected } = await finishSavIntakeWake(runId);
  return { projected };
}
finishSavIntakeWakeStep.maxRetries = 1;
