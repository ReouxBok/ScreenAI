import { expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ sleep: vi.fn(), resume: vi.fn() }));
vi.mock("workflow", () => ({ sleep: f.sleep }));
vi.mock("./steps", () => ({ resumeOwnerHandoverStep: f.resume }));
import { processSavV2OwnerHandoverWorkflow } from "./index";
it("sleeps until wakeAt then invokes one step with the ticket and marker", async () => {
  await processSavV2OwnerHandoverWorkflow("880", "synthetic-token", "2026-11-16T12:00:00Z");
  expect(f.sleep).toHaveBeenCalledWith(new Date("2026-11-16T12:00:00Z"));
  expect(f.resume).toHaveBeenCalledExactlyOnceWith("880", "synthetic-token");
  expect(f.sleep.mock.invocationCallOrder[0]).toBeLessThan(f.resume.mock.invocationCallOrder[0]!);
});
