import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), prepare: vi.fn(), token: vi.fn(), read: vi.fn(), queue: vi.fn(), execute: vi.fn(), dispatch: vi.fn(), audit: vi.fn(), revalidate: vi.fn(), stage: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => ({ insert: () => ({ values: mocks.audit }) }) }));
vi.mock("@/lib/sav/dispatch", () => ({ dispatchSavTicketCommand: mocks.dispatch }));
vi.mock("@/lib/sav/hubspot", () => ({ processManualSavTicketActionImmediately: mocks.execute }));
vi.mock("@/lib/sav/auth", () => ({ requireSavApiStaff: mocks.auth }));
vi.mock("@/lib/sav/manual-ticket-preview", () => ({ prepareSavManualTicketPreview: mocks.prepare, readSavTicketPreviewToken: mocks.token, readSavManualTicketPreviewContext: mocks.read }));
vi.mock("@/lib/sav/manual-tickets", () => ({ queueSavManualTicket: mocks.queue }));
vi.mock("@/lib/sav/config", () => ({ savReleaseStage: mocks.stage }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
import { prepareTicketPreviewAction, confirmTicketPreviewAction } from "./ticket-preview-actions";
const input = { threadId: "10000000-0000-4000-8000-000000000001", reviewId: "10000000-0000-4000-8000-000000000002", ticketId: "401", distinctIssueReason: "" };
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ email: "ugo@limova.ai" }); mocks.stage.mockReturnValue("v0"); mocks.prepare.mockResolvedValue({ token: "encrypted", details: {}, expiresAt: 99 }); mocks.token.mockReturnValue({ command: { ...input, kind: "link_ticket", returnOperation: "reactivate" } }); mocks.read.mockResolvedValue({ messageId: "latest", crm: { status: "ready" } }); mocks.queue.mockResolvedValue({ id: "action" }); });
afterEach(() => vi.restoreAllMocks());
it("executes the action confirmed by the V0 selector immediately after durable queueing", async () => {
  mocks.execute.mockResolvedValue({ status: "completed" });
  await confirmTicketPreviewAction("encrypted");
  expect(mocks.execute).toHaveBeenCalledWith("action");
  expect(mocks.queue.mock.invocationCallOrder[0]).toBeLessThan(mocks.execute.mock.invocationCallOrder[0]);
});
it("preparation returns only a preview and never queues a mutation", async () => {
  expect((await prepareTicketPreviewAction(input)).preview?.token).toBe("encrypted");
  expect(mocks.prepare).toHaveBeenCalledWith(input, "ugo@limova.ai"); expect(mocks.queue).not.toHaveBeenCalled();
});
it("requires server authentication before preparing or confirming", async () => {
  mocks.auth.mockRejectedValue(new Error("forbidden"));
  await expect(prepareTicketPreviewAction(input)).rejects.toThrow("forbidden");
  await expect(confirmTicketPreviewAction("encrypted")).rejects.toThrow("forbidden");
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.queue).not.toHaveBeenCalled();
});
it("confirms exactly the signed command with a fresh server-only context", async () => {
  mocks.execute.mockResolvedValue({ status: "pending" });
  expect(await confirmTicketPreviewAction("encrypted")).toEqual({ actionId: "action", status: "pending", error: null });
  expect(mocks.read).toHaveBeenCalledWith(input.threadId);
  expect(mocks.queue).toHaveBeenCalledWith({ ...input, kind: "link_ticket", returnOperation: "reactivate", previewToken: "encrypted" }, "ugo@limova.ai", { messageId: "latest", crm: { status: "ready" } });
});
it.each(["completed", "pending"])("reports the durable %s result on the real confirmation handler", async status => {
  mocks.execute.mockResolvedValue({ status });
  expect(await confirmTicketPreviewAction("encrypted")).toEqual({ actionId: "action", status, error: null });
});
it("retains the durable command and reports a stale execution without suggesting success", async () => {
  mocks.execute.mockResolvedValue({ status: "failed", errorCode: "SAV_PROPOSAL_STALE" });
  expect(await confirmTicketPreviewAction("encrypted")).toMatchObject({ actionId: "action", status: "failed", error: expect.stringContaining("proposition validée a changé") });
  expect(mocks.queue).toHaveBeenCalledTimes(1);
});
it("preserves a queued command when immediate execution throws", async () => {
  mocks.execute.mockRejectedValue(new Error("synthetic unavailable worker"));
  expect(await confirmTicketPreviewAction("encrypted")).toEqual({ actionId: "action", status: "deferred", error: null });
  expect(mocks.queue).toHaveBeenCalledTimes(1);
});
it("refuses invalid preview and unavailable CRM without enqueuing", async () => {
  mocks.token.mockImplementationOnce(() => { throw new Error("SAV_TICKET_PREVIEW_EXPIRED"); });
  expect((await confirmTicketPreviewAction("tampered")).error).toContain("aperçu a expiré");
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.queue).not.toHaveBeenCalled();
  mocks.read.mockResolvedValue({ crm: { status: "partial" } });
  expect((await confirmTicketPreviewAction("encrypted")).actionId).toBeNull(); expect(mocks.queue).not.toHaveBeenCalled();
});
it("does not enable the preview flow in V1", async () => {
  mocks.stage.mockReturnValue("v1");
  expect((await prepareTicketPreviewAction(input)).preview).toBeNull();
  expect((await confirmTicketPreviewAction("encrypted")).actionId).toBeNull();
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.queue).not.toHaveBeenCalled();
});

it("combined confirmation keeps interaction proof and workflow recovery only while pending",async()=>{
 mocks.execute.mockResolvedValue({status:"pending"});
 await confirmTicketPreviewAction("encrypted");
 expect(mocks.dispatch).toHaveBeenCalledWith("action");
 expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({action:"sav_ticket_confirm_succeeded",actorEmail:"ugo@limova.ai",technicalMetadata:expect.objectContaining({actionId:"action"})}));
 mocks.dispatch.mockClear();mocks.execute.mockResolvedValue({status:"completed"});
 await confirmTicketPreviewAction("encrypted");expect(mocks.dispatch).not.toHaveBeenCalled();
});
