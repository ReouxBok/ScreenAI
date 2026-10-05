import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const dependencies = vi.hoisted(() => ({ auth: vi.fn(), opened: vi.fn(), revalidate: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/sav/auth", () => ({ requireSavApiStaff: dependencies.auth }));
vi.mock("@/lib/sav/opened-email", () => ({ recordSavEmailOpened: dependencies.opened }));
vi.mock("next/cache", () => ({ revalidatePath: dependencies.revalidate }));
vi.mock("next/navigation", () => ({ redirect: dependencies.redirect }));
import { openSavEmailAction } from "./open-email-actions";
const threadId = "10000000-0000-4000-8000-000000000001";
const messageId = "10000000-0000-4000-8000-000000000002";
function form() { const data = new FormData(); data.set("threadId", threadId); data.set("messageId", messageId); data.set("actorEmail", "untrusted@example.invalid"); return data; }
beforeEach(() => {
  vi.clearAllMocks();
  dependencies.auth.mockResolvedValue({ email: "ugo@limova.ai", role: "admin" });
  dependencies.opened.mockResolvedValue({ notice: "filed", auditId: "fixture" });
  dependencies.redirect.mockImplementation((url: string) => { throw new Error(`REDIRECT:${url}`); });
});
afterEach(() => vi.unstubAllEnvs());
describe("authenticated POST to open and file a SAV email", () => {
  it("uses the authenticated actor, not client-provided identity, then opens the dossier", async () => {
    await expect(openSavEmailAction(form())).rejects.toThrow(`REDIRECT:/studio/sav/${threadId}?filing=filed`);
    expect(dependencies.opened).toHaveBeenCalledWith({ threadId, messageId }, "ugo@limova.ai");
    expect(dependencies.auth.mock.invocationCallOrder[0]).toBeLessThan(dependencies.opened.mock.invocationCallOrder[0]);
  });
  it("denies unauthorized access without recording/moving any message", async () => {
    dependencies.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN"));
    await expect(openSavEmailAction(form())).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    expect(dependencies.opened).not.toHaveBeenCalled(); expect(dependencies.redirect).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs before any mutation or redirect", async () => {
    const data = form(); data.set("threadId", "../../another-page");
    await expect(openSavEmailAction(data)).rejects.toThrow();
    expect(dependencies.opened).not.toHaveBeenCalled(); expect(dependencies.redirect).not.toHaveBeenCalled();
  });
  it("still opens the dossier with an honest failure notice when Gmail filing fails", async () => {
    dependencies.opened.mockRejectedValue(new Error("fixture-only"));
    await expect(openSavEmailAction(form())).rejects.toThrow(`REDIRECT:/studio/sav/${threadId}?filing=SAV_GMAIL_FILING_FAILED`);
  });
});
