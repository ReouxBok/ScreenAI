import { beforeEach, expect, it, vi } from "vitest";
const steps = vi.hoisted(() => ({ calls: [] as string[], analysis: "observed" }));
vi.mock("./steps", () => ({
  analyseSavIntakeWakeStep: async (id: string) => { steps.calls.push(`analyse:${id}`); return { stage: "analysis", state: steps.analysis }; },
  executeSavIntakeWakeStep: async (id: string) => { steps.calls.push(`execute:${id}`); return { stage: "execution", state: "confirmed" }; },
  finishSavIntakeWakeStep: async (id: string) => { steps.calls.push(`finish:${id}`); return { projected: true }; },
}));
import { processSavIntakeWakeWorkflow } from "./index";

// Plain-Node run of the orchestration body: the "use workflow" directive is inert
// here; the Workflow compiler and runtime are exercised by `next typegen`/build only.
beforeEach(() => { steps.calls = []; });
it.each([["observed", true], ["done", true], ["waiting", false], ["skipped", false]])("analysis %s → execution step %s", async (analysis, executes) => {
  steps.analysis = analysis;
  const result = await processSavIntakeWakeWorkflow("run-1");
  expect(steps.calls).toEqual(executes ? ["analyse:run-1", "execute:run-1", "finish:run-1"] : ["analyse:run-1", "finish:run-1"]);
  expect(result).toEqual({ analysis, execution: executes ? "confirmed" : null });
});
