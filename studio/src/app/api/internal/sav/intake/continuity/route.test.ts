import { beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ admin: vi.fn(), preview: vi.fn(), approve: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/lib/sav/intake/execution-policy", () => ({ executionAdministrator: d.admin,
  intakeExecutionConfig: () => ({ policyId: "target" }), readIntakeExecutionAuthority: async () => ({ policy: {} }) }));
vi.mock("@/lib/sav/intake/runtime-contract", () => ({ savIntakeRuntimeConfig: () => ({ configHash: "runtime" }) }));
vi.mock("@/lib/sav/intake/execution-adapters", () => ({ createIntakeExecutorAdapters: () => ({ dispatch: d.dispatch }) }));
vi.mock("@/lib/sav/intake/execution-continuity", () => ({ previewIntakeExecutionContinuity: d.preview, approveIntakeExecutionContinuity: d.approve }));
import { GET, POST } from "./route";
const origin = "https://studio.example.invalid", url = `${origin}/api/internal/sav/intake/continuity`;
const sourcePolicyId = "10000000-0000-4000-8000-000000000001", executionId = "10000000-0000-4000-8000-000000000002";
const selection = { sourcePolicyId, executionIds: [executionId] }, command = { ...selection, expectedHash: "a".repeat(64), oldDeploymentFencedAndDrained: true };
const post = (body: unknown, headers: Record<string,string> = {}) => new Request(url, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); d.admin.mockResolvedValue({ id: "admin" }); d.preview.mockResolvedValue({ hash: command.expectedHash }); d.approve.mockResolvedValue({ id: "receipt", executionIds: [executionId] }); });
it("requires administrator authentication for preview and approval", async () => {
  d.admin.mockRejectedValue(Error("UNAUTHORIZED"));
  expect((await GET(new Request(`${url}?sourcePolicyId=${sourcePolicyId}&executionIds=${executionId}`))).status).toBe(403);
  expect((await POST(post(command))).status).toBe(403);
  expect(d.preview).not.toHaveBeenCalled(); expect(d.approve).not.toHaveBeenCalled();
});
it("previews an explicit selection without approving or dispatching", async () => {
  const result = await GET(new Request(`${url}?sourcePolicyId=${sourcePolicyId}&executionIds=${executionId}`));
  expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(d.preview).toHaveBeenCalledWith(sourcePolicyId, expect.any(Object), [executionId]);
  expect(d.approve).not.toHaveBeenCalled(); expect(d.dispatch).not.toHaveBeenCalled();
});
it.each(["https://other.example.invalid", "null", ""])("refuses cross-origin approval (%s)", async badOrigin => {
  expect((await POST(post(command, { origin: badOrigin }))).status).toBe(403); expect(d.approve).not.toHaveBeenCalled();
});
it.each([{ ...command, oldDeploymentFencedAndDrained: false }, { ...command, expectedHash: "bad" }, { ...command, executionIds: [] },
  { ...command, executionIds: [executionId, executionId] }, { ...command, injectedAuthority: "allow" }])("rejects an invalid command", async invalid => {
  expect((await POST(post(invalid))).status).toBe(400); expect(d.approve).not.toHaveBeenCalled();
});
it("bounds request size before parsing and never exposes unexpected errors", async () => {
  expect((await POST(post({ ...command, padding: "x".repeat(9000) }))).status).toBe(400);
  d.approve.mockRejectedValue(Error("SECRET must never be returned"));
  const response = await POST(post(command)); expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("SECRET"); expect(d.dispatch).not.toHaveBeenCalled();
});
it("approves the exact preview locally without provider action", async () => {
  const result = await POST(post(command)); expect(result.status).toBe(200);
  expect(d.approve).toHaveBeenCalledWith(sourcePolicyId, command.expectedHash, expect.any(Object), [executionId]);
  expect(await result.json()).toMatchObject({ receipt: { id: "receipt" }, providerActions: 0, modelCalls: 0 }); expect(d.dispatch).not.toHaveBeenCalled();
});
