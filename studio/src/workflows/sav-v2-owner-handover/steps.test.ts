import { expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sav/cases/owner-handover", () => ({ runOwnerHandover: run }));
import { resumeOwnerHandoverStep } from "./steps";
it("runs once with fresh environment and disables platform retries", async () => {
  expect(resumeOwnerHandoverStep.maxRetries).toBe(0);
  await resumeOwnerHandoverStep("880", "synthetic-token");
  expect(run).toHaveBeenCalledExactlyOnceWith("880", "synthetic-token", { env: process.env });
});
