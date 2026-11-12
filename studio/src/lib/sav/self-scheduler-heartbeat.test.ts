import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ request: vi.fn(), abandon: vi.fn(), handOff: vi.fn(), start: vi.fn() }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/sav-heartbeat", () => ({ savHeartbeatWorkflow: () => undefined }));
vi.mock("@/lib/sav/self-scheduler-store", () => ({ requestSavHeartbeatStart: f.request, abandonSavHeartbeatStart: f.abandon, handOffSavHeartbeat: f.handOff }));
vi.mock("@/lib/sav/self-scheduler", () => ({ SELF_SCHEDULER_TIMING: { heartbeatStaleMs: 900_000 },
  savCodeRevision: (env: Record<string, string | undefined>) => env.VERCEL_DEPLOYMENT_ID ?? null,
  savSelfSchedulerProduction: (env: Record<string, string | undefined>) => env.VERCEL_ENV === "production",
  savSelfSchedulerDisabled: (env: Record<string, string | undefined>) => env.SAV_SELF_SCHEDULER_DISABLED === "1" }));
import { continueSavHeartbeat, ensureSavHeartbeat } from "./self-scheduler-heartbeat";

const production = { VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_synthetic" };
beforeEach(() => {
  Object.values(f).forEach(fn => fn.mockReset());
  f.start.mockResolvedValue({ runId: "wrun_1" }); f.abandon.mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});

it("starts one heartbeat only when the store grants it (switch ON, none alive in 15 min), owner <root>#0, this deployment's revision", async () => {
  f.request.mockResolvedValueOnce({ start: true, reason: "absent" }).mockResolvedValueOnce({ start: false, reason: "alive" }).mockResolvedValueOnce({ start: false, reason: "switch_off" });
  expect(await ensureSavHeartbeat({ trigger: "gmail_webhook", env: production, start: f.start })).toEqual({ started: true, reason: "absent", runId: "wrun_1" });
  expect(await ensureSavHeartbeat({ trigger: "gmail_webhook", env: production, start: f.start })).toEqual({ started: false, reason: "alive" });
  expect(await ensureSavHeartbeat({ trigger: "gmail_webhook", env: production, start: f.start })).toEqual({ started: false, reason: "switch_off" });
  expect(f.start).toHaveBeenCalledTimes(1);
  const { owner } = f.request.mock.calls[0][0];
  expect(owner).toMatch(/^[0-9a-f-]{36}#0$/);
  expect(f.request.mock.calls[0][0]).toMatchObject({ revision: "dpl_synthetic", staleMs: 900_000 });
  expect(f.start.mock.calls[0][0]).toEqual({ owner, generation: 0 });
});

it("never starts outside production or with the env hard stop, and a failed enqueue frees the slot without throwing", async () => {
  expect(await ensureSavHeartbeat({ trigger: "administrator", env: { VERCEL_ENV: "preview" }, start: f.start })).toEqual({ started: false, reason: "not_production" });
  expect(await ensureSavHeartbeat({ trigger: "administrator", env: { ...production, SAV_SELF_SCHEDULER_DISABLED: "1" }, start: f.start })).toEqual({ started: false, reason: "disabled" });
  expect(f.request).not.toHaveBeenCalled();
  f.request.mockResolvedValue({ start: true, reason: "stale" }); f.start.mockRejectedValue(Error("queue down"));
  expect(await ensureSavHeartbeat({ trigger: "gmail_webhook", env: production, start: f.start })).toEqual({ started: false, reason: "start_failed" });
  expect(f.abandon).toHaveBeenCalledWith(f.request.mock.calls[0][0].owner);
  f.request.mockRejectedValue(Error("db down"));
  expect(await ensureSavHeartbeat({ trigger: "gmail_webhook", env: production, start: f.start })).toEqual({ started: false, reason: "request_failed" });
});

it("continuation: hands the row to <root>#<n+1> before starting it on the latest deployment; refused hand-off starts nothing", async () => {
  f.handOff.mockResolvedValueOnce({ handedOff: true });
  expect(await continueSavHeartbeat({ owner: "root#4", generation: 4 }, { env: production, start: f.start })).toEqual({ continued: true, runId: "wrun_1" });
  expect(f.handOff.mock.calls[0][0]).toMatchObject({ from: "root#4", to: "root#5", revision: "dpl_synthetic" });
  expect(f.start).toHaveBeenCalledWith({ owner: "root#5", generation: 5 }, { deploymentId: "latest" });
  expect(f.handOff.mock.invocationCallOrder[0]).toBeLessThan(f.start.mock.invocationCallOrder[0]);
  for (const reason of ["switch_off", "not_owner"]) {
    f.handOff.mockResolvedValueOnce({ handedOff: false, reason });
    expect(await continueSavHeartbeat({ owner: "root#4", generation: 4 }, { env: production, start: f.start })).toEqual({ continued: false, reason });
  }
  expect(f.start).toHaveBeenCalledTimes(1);
  f.handOff.mockResolvedValueOnce({ handedOff: true }); f.start.mockRejectedValueOnce(Error("latest unavailable"));
  expect(await continueSavHeartbeat({ owner: "root#4", generation: 4 }, { env: production, start: f.start })).toEqual({ continued: false, reason: "start_failed" });
  expect(f.abandon).toHaveBeenCalledWith("root#5");
});
