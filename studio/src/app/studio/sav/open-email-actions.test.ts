import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const dependencies = vi.hoisted(() => ({ auth: vi.fn(), enqueue: vi.fn(), opened: vi.fn(), localOpened: vi.fn(), revalidate: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/sav/auth", () => ({ requireSavApiStaff: dependencies.auth }));
vi.mock("@/lib/sav/opened-email", () => ({ recordSavEmailOpened: dependencies.opened, recordSavDossierOpened: dependencies.localOpened }));
vi.mock("next/cache", () => ({ revalidatePath: dependencies.revalidate }));
vi.mock("next/navigation", () => ({ redirect: dependencies.redirect }));
vi.mock("@/lib/sav/dispatch", () => ({ enqueueSavContextRefresh: dependencies.enqueue }));
import { openSavEmailAction, recordSavDossierOpenedAction } from "./open-email-actions";
const threadId = "10000000-0000-4000-8000-000000000001";
const messageId = "10000000-0000-4000-8000-000000000002";
function form() { const data = new FormData(); data.set("threadId", threadId); data.set("messageId", messageId); data.set("actorEmail", "untrusted@example.invalid"); return data; }
beforeEach(() => {
  vi.resetAllMocks();
  dependencies.enqueue.mockResolvedValue("10000000-0000-4000-8000-000000000003");
  dependencies.auth.mockResolvedValue({ email: "ugo@limova.ai", role: "admin" });
  dependencies.opened.mockResolvedValue({ notice: "filed", auditId: "fixture" });
  dependencies.redirect.mockImplementation((url: string) => { throw new Error(`REDIRECT:${url}`); });
});
afterEach(() => vi.unstubAllEnvs());
describe("authenticated POST to open and file a SAV email", () => {
  it("uses the authenticated actor, not client-provided identity, then opens the dossier", async () => {
    await expect(openSavEmailAction(form())).rejects.toThrow(`REDIRECT:/studio/sav/${threadId}?filing=filed`);
    expect(dependencies.enqueue).toHaveBeenCalledWith(threadId, "ugo@limova.ai");
    expect(dependencies.enqueue.mock.invocationCallOrder[0]).toBeLessThan(dependencies.redirect.mock.invocationCallOrder[0]);
    expect(dependencies.opened).toHaveBeenCalledWith({ threadId, messageId }, "ugo@limova.ai");
    expect(dependencies.auth.mock.invocationCallOrder[0]).toBeLessThan(dependencies.opened.mock.invocationCallOrder[0]);
  });
  it("denies unauthorized access without recording/moving any message", async () => {
    dependencies.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN"));
    await expect(openSavEmailAction(form())).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    expect(dependencies.enqueue).not.toHaveBeenCalled(); expect(dependencies.opened).not.toHaveBeenCalled(); expect(dependencies.redirect).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs before any mutation or redirect", async () => {
    const data = form(); data.set("threadId", "../../another-page");
    await expect(openSavEmailAction(data)).rejects.toThrow();
    expect(dependencies.enqueue).not.toHaveBeenCalled(); expect(dependencies.opened).not.toHaveBeenCalled(); expect(dependencies.redirect).not.toHaveBeenCalled();
  });
  it("still opens the dossier with an honest failure notice when Gmail filing fails", async () => {
    dependencies.opened.mockRejectedValue(new Error("fixture-only"));
    await expect(openSavEmailAction(form())).rejects.toThrow(`REDIRECT:/studio/sav/${threadId}?filing=SAV_GMAIL_FILING_FAILED`);
  });
});

it("redirects with a request ID only after background refresh was registered", async () => {
  await expect(openSavEmailAction(form())).rejects.toThrow("&context=refreshing&refreshId=10000000-0000-4000-8000-000000000003");
});
it("keeps the dossier readable if refresh scheduling fails before registering a request", async () => {
  dependencies.enqueue.mockRejectedValue(new Error("SAV_CONTEXT_REFRESH_UNAVAILABLE"));
  await expect(openSavEmailAction(form())).rejects.toThrow(`REDIRECT:/studio/sav/${threadId}?filing=filed&context=failed&returnTo=`);
  expect(dependencies.redirect.mock.calls[0][0]).not.toContain("refreshId=");
  expect(dependencies.opened).toHaveBeenCalledWith({ threadId, messageId }, "ugo@limova.ai");
});
it("still opens with separate failure notices when refresh and filing both fail", async () => {
  dependencies.enqueue.mockRejectedValue(new Error("PRIVATE_REFRESH_FAILURE"));
  dependencies.opened.mockRejectedValue(new Error("PRIVATE_FILING_FAILURE"));
  await expect(openSavEmailAction(form())).rejects.toThrow(`?filing=SAV_GMAIL_FILING_FAILED&context=failed&returnTo=`);
  expect(dependencies.redirect.mock.calls[0][0]).not.toContain("PRIVATE_");
});

it("records direct displayed opening through authenticated local POST only", async () => {
  dependencies.localOpened.mockResolvedValue({ opened: true });
  expect(await recordSavDossierOpenedAction(threadId, messageId)).toEqual({ ok: true });
  expect(dependencies.localOpened).toHaveBeenCalledWith({ threadId, messageId }, "ugo@limova.ai");
  expect(dependencies.enqueue).not.toHaveBeenCalled(); expect(dependencies.opened).not.toHaveBeenCalled();
});
it("reports a local opening failure without filing or enriching", async () => {
  dependencies.localOpened.mockRejectedValue(new Error("fixture"));
  expect(await recordSavDossierOpenedAction(threadId, messageId)).toEqual({ ok: false });
  expect(dependencies.enqueue).not.toHaveBeenCalled(); expect(dependencies.opened).not.toHaveBeenCalled();
});
