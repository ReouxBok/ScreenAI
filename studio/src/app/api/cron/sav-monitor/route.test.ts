import { afterEach, beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/sav/monitor", () => ({ runSavServerMonitor: d.run }));
import { GET } from "./route";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "synthetic-cron-secret"); });
afterEach(() => vi.unstubAllEnvs());
it("authenticates before any database, notification or monitoring work", async () => {
  expect((await GET(new Request("https://example.invalid/api/cron/sav-monitor"))).status).toBe(401); expect(d.run).not.toHaveBeenCalled();
  vi.stubEnv("CRON_SECRET", "");
  expect((await GET(new Request("https://example.invalid/api/cron/sav-monitor", { headers: { authorization: "Bearer " } }))).status).toBe(401); expect(d.run).not.toHaveBeenCalled();
});
it("returns monitoring coverage and safe failure without revealing raw errors", async () => {
  const request = () => new Request("https://example.invalid/api/cron/sav-monitor", { headers: { authorization: "Bearer synthetic-cron-secret" } });
  d.run.mockResolvedValue({ complete: false, delivery: "unconfigured" });
  expect(await (await GET(request())).json()).toEqual({ complete: false, delivery: "unconfigured" });
  d.run.mockRejectedValue(new Error("customer private data"));
  const failed = await GET(request()); expect(failed.status).toBe(500); expect(await failed.json()).toEqual({ error: "SAV_MONITOR_FAILED" });
});
