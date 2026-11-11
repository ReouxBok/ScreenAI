import { afterEach, beforeEach, expect, it, vi } from "vitest";
const effects = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock("@/lib/sav/cases/v2-effects-binding", () => ({ reconcileCaseV2Effects: effects.reconcile }));
const monitor = vi.hoisted(() => ({ pulse: vi.fn() }));
vi.mock("@/lib/sav/monitor", () => ({ recordSavWorkerPulse: monitor.pulse }));
import { GET } from "./route";

// The V2 effects catch-up (11/11), moved out of sav-reconcile: same secret, same switches, same function, its own schedule.
const request = (authorization?: string) => new Request("http://localhost/api/cron/sav-v2-effects", authorization ? { headers: { authorization } } : {});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("CRON_SECRET", "synthetic-local-cron-token");
  vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  effects.reconcile.mockResolvedValue({ skipped: "effects_off" }); monitor.pulse.mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("authenticates with the cron secret before anything", async () => {
  expect((await GET(request())).status).toBe(401);
  expect((await GET(request("Bearer wrong"))).status).toBe(401);
  vi.stubEnv("CRON_SECRET", "");
  expect((await GET(request("Bearer "))).status).toBe(401);
  expect(effects.reconcile).not.toHaveBeenCalled();
  expect(monitor.pulse).not.toHaveBeenCalled(); // an unauthenticated call is not a heartbeat
});

it("keeps both V2 switches closed, then honors the effects switch (as the step did in sav-reconcile)", async () => {
  const auth = "Bearer synthetic-local-cron-token";
  expect(await (await GET(request(auth))).json()).toMatchObject({ caseEffects: { data: { skipped: "v2_off" } } });
  vi.stubEnv("SAV_V2_ENTRY", "on");
  expect(await (await GET(request(auth))).json()).toMatchObject({ caseEffects: { data: { skipped: "v2_off" } } });
  expect(effects.reconcile).not.toHaveBeenCalled();
  vi.stubEnv("SAV_CASE_RECORDING", "on");
  const response = await GET(request(auth));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ caseEffects: { status: "ok", data: { skipped: "effects_off" } } });
  expect(effects.reconcile).toHaveBeenCalledTimes(1);
  const [input] = effects.reconcile.mock.calls[0]!;
  expect(input.env).toBe(process.env);
  expect(input.deadlineMs - Date.now()).toBeGreaterThan(260_000);
  expect(input.deadlineMs - Date.now()).toBeLessThanOrEqual(270_000);
});

it("a failed catch-up answers 500 with a closed code, never the error text", async () => {
  vi.stubEnv("SAV_V2_ENTRY", "on"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  effects.reconcile.mockRejectedValue(Error("SAV_V2_WAKE_FAILED_replies client@example.invalid"));
  const response = await GET(request("Bearer synthetic-local-cron-token"));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ caseEffects: { status: "error", durationMs: expect.any(Number), errorCode: "SAV_V2_WAKE_FAILED_replies_client_example.invalid" } });
});

it("vercel.json schedules the catch-up every 10 minutes with GET, next to the unchanged sav-reconcile", async () => {
  const { readFileSync } = await import("node:fs");
  const config = JSON.parse(readFileSync(new URL("../../../../../vercel.json", import.meta.url), "utf8")) as { schedules: Record<string, { schedule: string; path: string; requestMethod: string }> };
  expect(config.schedules["sav-v2-effects"]).toEqual({ schedule: "*/10 * * * *", path: "/api/cron/sav-v2-effects", requestMethod: "GET" });
  expect(config.schedules["sav-reconcile"]).toEqual({ schedule: "*/5 * * * *", path: "/api/cron/sav-reconcile", requestMethod: "GET" });
});

it("records its own pulse (sav-v2-effects) at the start and at the end, failed when the catch-up fails", async () => {
  const auth = "Bearer synthetic-local-cron-token";
  vi.stubEnv("SAV_V2_ENTRY", "on"); vi.stubEnv("SAV_CASE_RECORDING", "on");
  await GET(request(auth));
  expect(monitor.pulse).toHaveBeenCalledTimes(2);
  const [start, end] = monitor.pulse.mock.calls;
  expect(start).toEqual([expect.any(String), expect.any(String), undefined, "sav-v2-effects"]);
  expect(end).toEqual([start![0], start![1], false, "sav-v2-effects"]);
  monitor.pulse.mockClear(); effects.reconcile.mockRejectedValue(Error("SYNTHETIC_DOWN"));
  expect((await GET(request(auth))).status).toBe(500);
  expect(monitor.pulse.mock.calls.map(call => [call[2], call[3]])).toEqual([[undefined, "sav-v2-effects"], [true, "sav-v2-effects"]]);
  monitor.pulse.mockClear(); vi.stubEnv("SAV_V2_ENTRY", "");
  await GET(request(auth));
  expect(monitor.pulse.mock.calls.map(call => [call[2], call[3]])).toEqual([[undefined, "sav-v2-effects"], [false, "sav-v2-effects"]]);
});
