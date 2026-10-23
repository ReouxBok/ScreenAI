import { analyseSavIntakeWakeStep, executeSavIntakeWakeStep, finishSavIntakeWakeStep } from "./steps";

/** Carries only the internal run id; each step re-reads the durable stage and
 * authority server side, so a replayed workflow resumes where the data is. */
export async function processSavIntakeWakeWorkflow(runId: string) {
  "use workflow";
  const analysis = await analyseSavIntakeWakeStep(runId);
  const execution = analysis.state === "observed" || analysis.state === "done" ? await executeSavIntakeWakeStep(runId) : null;
  await finishSavIntakeWakeStep(runId);
  return { analysis: analysis.state, execution: execution?.state ?? null };
}
