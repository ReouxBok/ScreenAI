import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/sav/reanalysis/route";
const state = vi.hoisted(() => ({ current: vi.fn(), db: vi.fn(), run: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ currentUser: state.current }));
vi.mock("./reanalysis-database", () => ({ withReanalysisDatabase: state.db }));
vi.mock("./reanalysis-server", async original => ({ ...await original<typeof import("./reanalysis-server")>(), runSavReanalysisServer: state.run }));
beforeEach(() => {
  vi.resetAllMocks();
  state.current.mockResolvedValue({ id: "fixture", primaryEmailAddress: { emailAddress: "ugo@limova.ai", verification: { status: "verified" } } });
  state.db.mockImplementation(async work => work()); state.run.mockResolvedValue({ fixture: true });
});
afterEach(() => vi.unstubAllEnvs());
function request(body: unknown = { op: "capabilities" }, origin = "https://studio.limova.ai") {
  return new Request("https://studio.limova.ai/api/internal/sav/reanalysis", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
describe("internal reanalysis route", () => {
  it.each([null, "contact@limova.ai", "reouven@limova.ai", "unknown@example.invalid"])("rejects non-Ugo actors before database/model access: %s", async email => {
    state.current.mockResolvedValue(email ? { id: "fixture", primaryEmailAddress: { emailAddress: email, verification: { status: "verified" } } } : null);
    expect((await POST(request())).status).toBe(403); expect(state.db).not.toHaveBeenCalled(); expect(state.run).not.toHaveBeenCalled();
  });
  it("requires a verified email and same origin", async () => {
    state.current.mockResolvedValueOnce({ id: "fixture", primaryEmailAddress: { emailAddress: "ugo@limova.ai", verification: { status: "unverified" } } });
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request({ op: "capabilities" }, "https://attacker.example.invalid"))).status).toBe(400);
    expect(state.db).not.toHaveBeenCalled();
  });
  it("bounds the body and refuses unrecognized executable inputs before database access", async () => {
    expect((await POST(request({ payload: "a".repeat(131_073) }))).status).toBe(413);
    expect((await POST(request({ op: "capabilities", modelCallback: "untrusted" }))).status).toBe(400);
    expect(state.db).not.toHaveBeenCalled();
  });
  it("runs only a validated request within the dedicated boundary and sends private no-store responses", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.db).toHaveBeenCalledOnce(); expect(state.run).toHaveBeenCalledWith({ op: "capabilities" });
    state.run.mockRejectedValueOnce(new Error("secret customer text"));
    const refused = await POST(request()); expect(refused.status).toBe(409); expect(JSON.stringify(await refused.json())).not.toContain("secret customer");
  });
});
