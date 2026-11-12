import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ panel: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/sav/cases/block-switch-admin", () => ({ readSavBlockSwitchPanel: mocks.panel, setSavBlockSwitch: mocks.set }));
import { GET, POST } from "./route";
const URL_ = "https://studio.example.invalid/api/internal/sav/v2/blocks";
const post = (body: unknown, origin = "https://studio.example.invalid") => new Request(URL_, { method: "POST", headers: { origin, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const valid = { blockId: "access", mode: "draft", paused: false, reason: "Qualification en brouillon" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.panel.mockResolvedValue({ globalAutoReply: false, blocks: [{ blockId: "access", mode: "auto", paused: false, effective: "draft", setting: null, invalid: false, history: [] }] });
  mocks.set.mockResolvedValue({ revision: "sav-block-switch.v1", ...valid, setBy: "admin@example.invalid", setAt: "2026-11-12T10:00:00.000Z" });
});

it("non-administrator: GET and POST refused with 403, nothing written", async () => {
  mocks.panel.mockRejectedValueOnce(Error("SAV_BLOCK_SWITCH_UNAUTHORIZED"));
  expect((await GET()).status).toBe(403);
  mocks.set.mockRejectedValueOnce(Error("SAV_BLOCK_SWITCH_UNAUTHORIZED"));
  const refused = await POST(post(valid));
  expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ error: "forbidden" });
});
it("GET returns the panel uncached, without any budget amount", async () => {
  const response = await GET();
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ blocks: [{ blockId: "access", effective: "draft" }] });
  expect(body).not.toMatch(/USD|budget/i);
});
it("POST requires same origin, JSON, a bounded body and a reason; a refused command is 400 and names its code only", async () => {
  expect((await POST(post(valid, "https://other.example.invalid"))).status).toBe(400);
  expect((await POST(post("{"))).status).toBe(400);
  expect((await POST(post({ ...valid, reason: "x".repeat(5000) }))).status).toBe(413);
  expect(mocks.set).not.toHaveBeenCalled();
  mocks.set.mockRejectedValueOnce(Object.assign(Error("invalid"), { name: "ZodError" }));
  const missing = await POST(post({ ...valid, reason: "" }));
  expect(missing.status).toBe(400); expect(await missing.json()).toEqual({ error: "invalid_request" });
});
it("POST stores through the admin function and returns the new state", async () => {
  const response = await POST(post(valid));
  expect(response.status).toBe(200);
  expect(mocks.set).toHaveBeenCalledWith(valid);
  expect(await response.json()).toMatchObject({ ok: true, setting: { blockId: "access", mode: "draft", setBy: "admin@example.invalid" } });
});
