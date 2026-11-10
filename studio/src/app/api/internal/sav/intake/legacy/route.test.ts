import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ staff: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/sav/intake/console-auth", () => ({ requireIntakeConsoleStaff: d.staff }));
vi.mock("@/lib/sav/intake/legacy-started", () => ({ readLegacyStartedInventory: d.read }));
import * as route from "./route";
const url = "https://studio.example.invalid/api/internal/sav/intake/legacy";
beforeEach(() => { vi.clearAllMocks(); d.staff.mockResolvedValue({ role: "admin" }); d.read.mockResolvedValue({ readOnly: true, startedMails: { total: 0 } }); });

it("is administrator-only: a member, an unauthenticated caller or an auth failure never reads anything", async () => {
  d.staff.mockResolvedValueOnce({ role: "member" });
  expect((await route.GET(new Request(url))).status).toBe(403);
  d.staff.mockRejectedValueOnce(Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED"));
  expect((await route.GET(new Request(url))).status).toBe(403);
  expect(d.read).not.toHaveBeenCalled();
});
it("returns the read-only inventory, uncached, with the default and an explicit page size", async () => {
  const response = await route.GET(new Request(url));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ inventory: { readOnly: true, startedMails: { total: 0 } } });
  expect(d.read).toHaveBeenLastCalledWith({ limit: 50 });
  await route.GET(new Request(`${url}?limit=7`)); expect(d.read).toHaveBeenLastCalledWith({ limit: 7 });
});
it.each(["0", "101", "abc", "1.5", ""])("refuses an invalid page size (%s)", async limit => {
  expect((await route.GET(new Request(`${url}?limit=${limit}`))).status).toBe(400); expect(d.read).not.toHaveBeenCalled();
});
it("exposes no way to change anything: GET only", () => {
  expect(Object.keys(route).filter(key => /^(POST|PUT|PATCH|DELETE)$/.test(key))).toEqual([]);
});
it("a read failure is a 503 without detail", async () => {
  d.read.mockRejectedValueOnce(Error("db password leaked here"));
  const response = await route.GET(new Request(url));
  expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("password");
});
