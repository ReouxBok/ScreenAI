import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ tick: vi.fn(), catchUp: vi.fn(), sleep: vi.fn(), next: vi.fn() }));
vi.mock("workflow", () => ({ sleep: f.sleep }));
vi.mock("./steps", () => ({ savHeartbeatTickStep: f.tick, savHeartbeatCatchUpStep: f.catchUp, continueSavHeartbeatStep: f.next }));
import { SAV_HEARTBEAT_ITERATIONS, savHeartbeatWorkflow } from "./index";

// Plain-Node run of the orchestration body ("use workflow"/"use step" are inert here), as in sav-intake-read-recovery.
beforeEach(() => {
  Object.values(f).forEach(fn => fn.mockReset());
  f.tick.mockResolvedValue({ alive: true, results: [] }); f.catchUp.mockResolvedValue({ status: "skipped", reason: "fresh" });
  f.next.mockResolvedValue({ continued: true, runId: "wrun_next" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("is bounded: 72 ticks 5 min apart (about 6 h), then exactly one continuation step", async () => {
  expect(SAV_HEARTBEAT_ITERATIONS).toBe(72);
  const result = await savHeartbeatWorkflow({ owner: "root#3", generation: 3 });
  expect(f.tick).toHaveBeenCalledTimes(72); expect(f.catchUp).toHaveBeenCalledTimes(72); expect(f.sleep).toHaveBeenCalledTimes(72);
  expect(f.sleep).toHaveBeenCalledWith("5m"); expect(f.tick).toHaveBeenCalledWith("root#3");
  expect(f.next).toHaveBeenCalledTimes(1); expect(f.next).toHaveBeenCalledWith({ owner: "root#3", generation: 3 });
  expect(result).toEqual({ continuedAs: "wrun_next", reason: null, iterations: 72, generation: 3 });
});

it("kill switch / singleton: a switched-OFF or superseded tick stops the loop at once, without catch-up, sleep or continuation", async () => {
  f.tick.mockResolvedValueOnce({ alive: true, results: [] }).mockResolvedValueOnce({ alive: false, reason: "switch_off" });
  expect(await savHeartbeatWorkflow({ owner: "old#0", generation: 0 })).toEqual({ stopped: "switch_off", iterations: 1, generation: 0 });
  expect(f.catchUp).toHaveBeenCalledTimes(1); expect(f.sleep).toHaveBeenCalledTimes(1); expect(f.next).not.toHaveBeenCalled();
  f.tick.mockReset(); f.tick.mockResolvedValue({ alive: false, reason: "superseded" });
  expect(await savHeartbeatWorkflow({ owner: "any#0", generation: 0 })).toEqual({ stopped: "superseded", iterations: 0, generation: 0 });
  expect(f.next).not.toHaveBeenCalled();
});

it("a failing or timed-out step is logged and the loop goes on; a failed continuation ends the run without throwing", async () => {
  f.tick.mockRejectedValueOnce(Error("step timeout")); f.catchUp.mockRejectedValueOnce(Error("pass crashed"));
  f.next.mockRejectedValue(Error("continue failed"));
  const result = await savHeartbeatWorkflow({ owner: "root#0", generation: 0 });
  expect(f.tick).toHaveBeenCalledTimes(72); expect(f.catchUp).toHaveBeenCalledTimes(71); expect(f.sleep).toHaveBeenCalledTimes(72);
  expect(console.error).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ continuedAs: null, reason: "continue_step_failed", iterations: 72, generation: 0 });
});
