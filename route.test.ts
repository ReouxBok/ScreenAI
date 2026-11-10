import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), run: vi.fn(), ports: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireApiStaff: mocks.auth }));
vi.mock("@/lib/sav/cases/manual-qualification-runtime", () => ({ manualQualificationPorts: mocks.ports }));
vi.mock("@/lib/sav/cases/manual-qualification", async original => ({ ...await original<typeof import("@/lib/sav/cases/manual-qualification")>(), manualQualification: mocks.run }));
import { POST } from "./route";
const messageId = "10000000-0000-4000-8000-000000000001";
function request(body: unknown, origin = "https://studio.example.invalid") { return new Request("https://studio.example.invalid/api/internal/sav/v2/manual", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ email: "ugo@limova.ai", role: "admin" }); mocks.run.mockResolvedValue({ status: "ready" }); });
it("requires the existing admin check and Ugo identity before any runtime port", async () => {
  mocks.auth.mockRejectedValueOnce(Error("UNAUTHORIZED")); expect((await POST(request({ operation: "preview", messageId }))).status).toBe(403);
  mocks.auth.mockResolvedValue({ email: "other@example.invalid", role: "admin" }); expect((await POST(request({ operation: "preview", messageId }))).status).toBe(403);
  expect(mocks.auth).toHaveBeenCalledWith("admin"); expect(mocks.ports).not.toHaveBeenCalled();
});
it("rejects cross-origin, oversized bodies, batches and parameter overrides", async () => {
  expect((await POST(request({ operation: "preview", messageId }, "https://other.example.invalid"))).status).toBe(400);
  expect((await POST(request({ text: "x".repeat(2050) }))).status).toBe(413);
  expect((await POST(request([{ operation: "preview", messageId }]))).status).toBe(400);
  expect((await POST(request({ operation: "preview", messageId, env: {} }))).status).toBe(400);
  expect(mocks.run).not.toHaveBeenCalled();
});
it("a malformed body is a non-executed request, not an uncertain passage", async () => {
  const raw = new Request("https://studio.example.invalid/api/internal/sav/v2/manual", { method: "POST", headers: { origin: "https://studio.example.invalid", "content-type": "application/json" }, body: "{" });
  const result = await POST(raw); expect(result.status).toBe(400); expect(await result.json()).toEqual({ error: "invalid_request" }); expect(mocks.run).not.toHaveBeenCalled();
});
it("returns guarded status without caching, and never leaks an uncertain provider error", async () => {
  const response = await POST(request({ operation: "preview", messageId })); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  mocks.run.mockRejectedValueOnce(Error("private-provider-detail"));
  const failed = await POST(request({ operation: "preview", messageId })); expect(failed.status).toBe(409);
  expect(await failed.text()).toBe('{"error":"manual_pass_unconfirmed","next":"inspect_case_before_retry"}');
});
