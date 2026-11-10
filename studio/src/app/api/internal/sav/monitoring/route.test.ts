import { beforeEach, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sav/daily-review-read", () => ({ readDailyReviewSnapshot: read }));
import { GET } from "./route";
const url = "https://studio.example.invalid/api/internal/sav/monitoring";
beforeEach(() => { vi.clearAllMocks(); read.mockResolvedValue({ revision: "sav-daily-review-read.v1", missing: ["worker_start_telemetry"] }); });
it("exposes a private no-store read model without worker dispatch", async () => {
  const r = await GET(new Request(`${url}?limit=2`)); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(read).toHaveBeenCalledWith({ limit: 2 }); expect(await r.json()).toHaveProperty("missing");
});
it("maps the canonical authentication refusal to forbidden without details", async () => {
  read.mockRejectedValue(Error("DAILY_REVIEW_UNAUTHORIZED")); const r = await GET(new Request(url)); expect(r.status).toBe(403); expect(await r.json()).toEqual({ error: "forbidden" });
});
it("does not silently accept duplicate query parameters", async () => {
  await GET(new Request(`${url}?limit=1&limit=2`)); expect(read).toHaveBeenCalledWith({ limit: 2, duplicate: true });
});
it.each(["DAILY_REVIEW_WINDOW_INVALID", "SECRET provider text customer@example.invalid"])("exposes bounded errors only (%s)", async error => {
  read.mockRejectedValue(Error(error)); const r = await GET(new Request(url)); expect(r.status).toBe(error.startsWith("DAILY_") ? 400 : 503);
  expect(await r.text()).not.toMatch(/SECRET|customer@/);
});
