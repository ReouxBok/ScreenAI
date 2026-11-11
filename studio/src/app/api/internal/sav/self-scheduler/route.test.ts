import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ admin: vi.fn(), read: vi.fn(), set: vi.fn(), ensure: vi.fn() }));
vi.mock("@/lib/sav/intake/execution-policy", () => ({ executionAdministrator: f.admin }));
vi.mock("@/lib/sav/self-scheduler-store", () => ({ readSelfSchedulerState: f.read, setSelfSchedulerSwitch: f.set }));
vi.mock("@/lib/sav/self-scheduler-heartbeat", () => ({ ensureSavHeartbeat: f.ensure }));
import { GET, POST } from "./route";

const URL_ = "https://studio.example.invalid/api/internal/sav/self-scheduler";
const post = (body: unknown, origin = "https://studio.example.invalid") => new Request(URL_, { method: "POST", body: JSON.stringify(body), headers: { origin, "content-type": "application/json" } });
beforeEach(() => {
  Object.values(f).forEach(fn => fn.mockReset());
  f.admin.mockResolvedValue({ email: "admin@example.invalid", role: "admin" });
  f.set.mockImplementation(async (input: { enabled: boolean }) => ({ enabled: input.enabled }));
  f.ensure.mockResolvedValue({ started: true });
});

it("refuses non-administrators and foreign origins before any write", async () => {
  f.admin.mockRejectedValue(Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED"));
  expect((await GET()).status).toBe(403); expect((await POST(post({ action: "enable", reason: "outage" }))).status).toBe(403);
  f.admin.mockResolvedValue({ email: "admin@example.invalid" });
  expect((await POST(post({ action: "enable", reason: "outage" }, "https://evil.example.invalid"))).status).toBe(403);
  expect((await POST(post({ action: "enable" }))).status).toBe(400);
  expect((await POST(post({ action: "enable", reason: "outage", extra: 1 }))).status).toBe(400);
  expect(f.set).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled();
});

it("enable records actor and reason then starts the heartbeat; disable only switches OFF", async () => {
  expect(await (await POST(post({ action: "enable", reason: "Vercel cron outage" }))).json()).toEqual({ switch: { enabled: true }, heartbeat: { started: true } });
  expect(f.set).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, actor: "admin@example.invalid", reason: "Vercel cron outage" }));
  f.ensure.mockClear();
  expect(await (await POST(post({ action: "disable", reason: "Vercel recovered" }))).json()).toEqual({ switch: { enabled: false } });
  expect(f.ensure).not.toHaveBeenCalled();
  f.read.mockResolvedValue({ switch: { enabled: false } });
  expect(await (await GET()).json()).toEqual({ state: { switch: { enabled: false } } });
});
