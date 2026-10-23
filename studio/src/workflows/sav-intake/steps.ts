import "server-only";
import { analyseSavIntakeWake, executeSavIntakeWake, finishSavIntakeWake } from "@/lib/sav/intake/event-pipeline";

export async function analyseSavIntakeWakeStep(runId: string) {
  "use step";
  // Model attempts are bounded by the run ledger; a step retry would bypass the wake bound.
  return analyseSavIntakeWake(runId);
}
analyseSavIntakeWakeStep.maxRetries = 0;

export async function executeSavIntakeWakeStep(runId: string) {
  "use step";
  // Effects are fenced by execution leases; uncertain outcomes are reconciled, never retried.
  return executeSavIntakeWake(runId);
}
executeSavIntakeWakeStep.maxRetries = 0;

export async function finishSavIntakeWakeStep(runId: string) {
  "use step";
  const { projected } = await finishSavIntakeWake(runId);
  return { projected };
}
finishSavIntakeWakeStep.maxRetries = 1;
