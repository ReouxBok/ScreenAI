import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ sleep: vi.fn(), resume: vi.fn(), send: vi.fn() }));
vi.mock("workflow", () => ({ sleep: f.sleep }));
vi.mock("./steps", () => ({ resumeSavV2CaseAfterSettleStep: f.resume, sendSavV2QueuedReplyStep: f.send }));
import { processSavV2CaseSettleWakeWorkflow, processSavV2ReplySendWorkflow } from "./index";
beforeEach(() => { Object.values(f).forEach(fn => fn.mockReset()); });

it("settle wake: sleeps until the durable date, then ONE continuation step of that case", async () => {
  f.resume.mockResolvedValue({ status: "queued" });
  expect(await processSavV2CaseSettleWakeWorkflow("synthetic-case", "2026-11-16T11:26:43.000Z")).toEqual({ status: "queued" });
  expect(f.sleep).toHaveBeenCalledWith(new Date("2026-11-16T11:26:43.000Z"));
  expect(f.resume).toHaveBeenCalledTimes(1);
  expect(f.resume).toHaveBeenCalledWith("synthetic-case", "2026-11-16T11:26:43.000Z");
  expect(f.sleep.mock.invocationCallOrder[0]).toBeLessThan(f.resume.mock.invocationCallOrder[0]!);
  expect(f.send).not.toHaveBeenCalled();
});

it("separate send: ONE send step for the execution, no sleep", async () => {
  f.send.mockResolvedValue({ supervised: "confirmed" });
  expect(await processSavV2ReplySendWorkflow("synthetic-execution")).toEqual({ supervised: "confirmed" });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenCalledWith("synthetic-execution");
  expect(f.sleep).not.toHaveBeenCalled();
});
