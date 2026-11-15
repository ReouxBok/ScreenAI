import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ staff: vi.fn(), admin: vi.fn(), review: vi.fn(), deps: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireApiStaff: mocks.staff }));
vi.mock("@/lib/sav/intake/execution-policy", () => ({ executionAdministrator: mocks.admin }));
vi.mock("@/lib/sav/cases/case-reply-review", () => ({ CASE_REPLY_REVIEW_TEXT_MAX: 6000, reviewCaseReply: mocks.review }));
vi.mock("@/lib/sav/cases/case-reply-review-binding", () => ({ caseReplyReviewDeps: mocks.deps }));
import { POST } from "./route";

// SAV-92 route: administrators only, same origin, JSON, bounded body; the reviewer comes from the server-side check, never from the body.
const URL_ = "https://studio.example.invalid/api/internal/sav/v2/replies/review";
const token = `v1.30000000-0000-4000-8000-000000000001.${"a".repeat(64)}.4`;
const post = (body: unknown, origin = "https://studio.example.invalid", type = "application/json") =>
  new Request(URL_, { method: "POST", headers: { origin, "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.staff.mockResolvedValue({ actorId: "user_x", email: "admin@example.invalid", role: "admin" });
  mocks.admin.mockResolvedValue({ id: "20000000-0000-4000-8000-000000000003", email: "admin@example.invalid", role: "admin" });
  mocks.deps.mockReturnValue({ synthetic: true });
  mocks.review.mockResolvedValue({ ok: true, action: "approve", caseId: "c", validationId: "v", executionId: "e", send: "attempted" });
});

it("a member or a non-SAV administrator is refused with 403 before anything is read or decided", async () => {
  mocks.staff.mockRejectedValueOnce(Error("UNAUTHORIZED"));
  expect((await POST(post({ action: "approve", token }))).status).toBe(403);
  mocks.admin.mockRejectedValueOnce(Error("SAV_INTAKE_EXECUTION_UNAUTHORIZED"));
  expect((await POST(post({ action: "approve", token }))).status).toBe(403);
  expect(mocks.staff).toHaveBeenCalledWith("admin");
  expect(mocks.review).not.toHaveBeenCalled();
});
it("another origin, another content type, malformed or unknown fields, or a body too large: refused, nothing decided", async () => {
  expect((await POST(post({ action: "approve", token }, "https://other.example.invalid"))).status).toBe(400);
  expect((await POST(post({ action: "approve", token }, undefined, "text/plain"))).status).toBe(400);
  expect((await POST(post("{"))).status).toBe(400);
  expect((await POST(post({ action: "send", token }))).status).toBe(400);
  expect((await POST(post({ action: "approve", token, approverId: "someone-else" }))).status).toBe(400);
  expect((await POST(post({ action: "correct", token, text: "x".repeat(40_000) }))).status).toBe(413);
  expect(mocks.review).not.toHaveBeenCalled();
});
it("the reviewer is the server-side administrator; a refusal is 409 with its code; a crash is an uncertain result, never retried", async () => {
  const response = await POST(post({ action: "approve", token }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.review).toHaveBeenCalledWith({ action: "approve", token }, { staffUserId: "20000000-0000-4000-8000-000000000003", email: "admin@example.invalid" }, { synthetic: true });
  mocks.review.mockResolvedValueOnce({ ok: false, code: "case_version_changed" });
  const refused = await POST(post({ action: "approve", token }));
  expect(refused.status).toBe(409); expect(await refused.json()).toEqual({ ok: false, code: "case_version_changed" });
  mocks.review.mockRejectedValueOnce(Error("boom customer@example.invalid"));
  const crashed = await POST(post({ action: "approve", token }));
  expect(crashed.status).toBe(409); expect(await crashed.text()).toBe(JSON.stringify({ ok: false, code: "review_unconfirmed" }));
  expect(mocks.review).toHaveBeenCalledTimes(3);
});
