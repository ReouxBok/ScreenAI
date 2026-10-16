import { beforeEach, describe, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ context: vi.fn(), enqueue: vi.fn(), ticket: vi.fn(), approveLearning: vi.fn(), rejectLearning: vi.fn(), auth: vi.fn(), review: vi.fn(), verdict: vi.fn(), queue: vi.fn(), send: vi.fn(), enabled: vi.fn(), qualify: vi.fn(), redirect: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/sav/dispatch", () => ({ enqueueSavContextRefresh: d.enqueue }));
vi.mock("@/lib/sav/auth", () => ({ requireSavApiStaff: d.auth }));
vi.mock("@/lib/sav/learning", () => ({ approveLearningCandidate: d.approveLearning, rejectLearningCandidate: d.rejectLearning }));
vi.mock("@/lib/sav/review", () => ({ reviewSavProposal: d.review }));
vi.mock("@/lib/sav/draft-verdicts", () => ({ reviewSavDraft: d.verdict }));
vi.mock("@/lib/sav/manual-replies", () => ({ queueSavManualReply: d.queue, assertSavManualReplyEnabled: d.enabled }));
vi.mock("@/lib/sav/gmail", () => ({ processPendingGmailSendActions: d.send }));
vi.mock("@/lib/sav/observations", () => ({ qualifySavObservation: d.qualify }));
vi.mock("next/cache", () => ({ revalidatePath: d.revalidate }));
vi.mock("next/navigation", () => ({ redirect: d.redirect }));
vi.mock("@/lib/sav/dossier-context", () => ({ collectLatestSavDossierContext: d.context }));
vi.mock("@/lib/sav/manual-tickets", () => ({ queueSavManualTicket: d.ticket }));
import { createTicketAction, linkTicketAction, refreshSavContextAction, reviewLearningAction, reviewDraftAction, reviewProposalAction, sendStudioReplyAction, saveReplyDraftAction, qualifyObservationAction } from "./actions";
function form() { const f = new FormData(); for (const name of ["threadId", "messageId", "decisionId", "agentRunId", "draftId", "observationId", "cycleId"])
    f.set(name, "10000000-0000-4000-8000-000000000001"); f.set("sourceHash", "x".repeat(43)); f.set("status", "rejected"); f.set("actorEmail", "forged@example.invalid"); return f; }
beforeEach(() => { vi.clearAllMocks(); d.auth.mockResolvedValue({ email: "ugo@limova.ai" }); d.enqueue.mockResolvedValue("10000000-0000-4000-8000-000000000009"); d.redirect.mockImplementation((u: string) => { throw new Error(`REDIRECT:${u}`); }); d.queue.mockResolvedValue({ id: "queued", status: "pending" }); d.send.mockResolvedValue({ processed: [] }); });
describe("independent authenticated V0 POST handlers", () => {
    it.each([reviewDraftAction, reviewProposalAction, sendStudioReplyAction, qualifyObservationAction, saveReplyDraftAction])("authenticates before every mutation", async (action) => { d.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN")); await expect(action(form())).rejects.toThrow("SAV_ACCESS_FORBIDDEN"); for (const fn of [d.review, d.verdict, d.queue, d.send, d.qualify])
        expect(fn).not.toHaveBeenCalled(); });
    it.each([reviewDraftAction, reviewProposalAction, sendStudioReplyAction])("rejects editable draft fields forged into the form", async (action) => { const f = form(); f.set("replyDraft", "FORGED"); await expect(action(f)).rejects.toThrow("SAV_DRAFT_READ_ONLY"); for (const fn of [d.review, d.verdict, d.queue, d.send])
        expect(fn).not.toHaveBeenCalled(); });
    it("records refusal under authenticated actor with no send or dossier correction", async () => { await expect(reviewDraftAction(form())).rejects.toThrow("draft_reviewed"); expect(d.verdict).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", reason: "" }), "ugo@limova.ai"); expect(d.review).not.toHaveBeenCalled(); expect(d.queue).not.toHaveBeenCalled(); });
    it("sends the accepted stored artifact without creating an editable version", async () => { await expect(sendStudioReplyAction(form())).rejects.toThrow("reply_queued"); expect(d.queue).toHaveBeenCalledWith({ threadId: "10000000-0000-4000-8000-000000000001", draftId: "10000000-0000-4000-8000-000000000001" }, "ugo@limova.ai"); expect(d.verdict).not.toHaveBeenCalled(); expect(d.review).not.toHaveBeenCalled(); });
    it("blocks the old edit handler", async () => { await expect(saveReplyDraftAction(form())).rejects.toThrow("SAV_DRAFT_READ_ONLY"); expect(d.verdict).not.toHaveBeenCalled(); });
});

it.each([["SAV_OBSERVATION_SYNC_IN_PROGRESS","sync_in_progress"],["SAV_OBSERVATION_STALE","stale"]])("explains the source refusal %s without exposing a raw exception",async(error,notice)=>{
 const f=form();f.set("candidateId","10000000-0000-4000-8000-000000000001");f.set("decision","approve");
 d.approveLearning.mockRejectedValue(new Error(error));
 await expect(reviewLearningAction(f)).rejects.toThrow(`REDIRECT:/studio/sav/resolutions?review=${notice}`);
 expect(d.approveLearning).toHaveBeenCalledWith(f.get("candidateId"),"ugo@limova.ai");
});
it("authenticates before candidate approval",async()=>{
 d.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN"));await expect(reviewLearningAction(form())).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
 expect(d.approveLearning).not.toHaveBeenCalled();
});

describe("ticket context refresh", () => {
  it.each([createTicketAction, linkTicketAction])("refreshes before queueing and preserves the chosen target", async (action) => {
    d.context.mockResolvedValue({ crm: { status: "ready" } });
    const f = form(); f.set("reviewId", "review"); f.set("ticketId", "99");
    await expect(action(f)).rejects.toThrow("ticket_queued");
    expect(d.context).toHaveBeenCalledWith(f.get("threadId"));
    expect(d.context.mock.invocationCallOrder[0]).toBeLessThan(d.ticket.mock.invocationCallOrder[0]);
    expect(d.ticket).toHaveBeenCalledWith(expect.objectContaining(action === linkTicketAction ? { ticketId: "99", kind: "link_ticket" } : { kind: "create_ticket" }), "ugo@limova.ai");
  });
  it.each([createTicketAction, linkTicketAction])("rejects an incomplete refresh without queueing", async (action) => {
    for (const status of ["partial", "error"]) {
      d.context.mockResolvedValue({ crm: { status } });
      await expect(action(form())).rejects.toThrow("SAV_CONTEXT_REFRESH_FAILED");
      expect(d.ticket).not.toHaveBeenCalled();
    }
    d.context.mockRejectedValue(new Error("private database error"));
    await expect(action(form())).rejects.toThrow("SAV_CONTEXT_REFRESH_FAILED");
    expect(d.ticket).not.toHaveBeenCalled();
  });
  it.each([createTicketAction, linkTicketAction, refreshSavContextAction])("authenticates before refreshing", async (action) => {
    d.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN"));
    await expect(action(form())).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    expect(d.context).not.toHaveBeenCalled(); expect(d.enqueue).not.toHaveBeenCalled(); expect(d.ticket).not.toHaveBeenCalled();
  });
});

it("registers a background refresh without queueing a ticket or waiting for CRM", async () => {
  await expect(refreshSavContextAction(form())).rejects.toThrow("?context=refreshing&refreshId=10000000-0000-4000-8000-000000000009");
  expect(d.enqueue).toHaveBeenCalledWith(form().get("threadId"), "ugo@limova.ai");
  expect(d.context).not.toHaveBeenCalled(); expect(d.ticket).not.toHaveBeenCalled();
});
it("keeps the manual refresh failure on the readable dossier without a fake request ID", async () => {
  d.enqueue.mockRejectedValue(new Error("PRIVATE_REFRESH_FAILURE"));
  await expect(refreshSavContextAction(form())).rejects.toThrow("?context=failed");
  expect(d.redirect.mock.calls[0][0]).not.toContain("refreshId="); expect(d.ticket).not.toHaveBeenCalled();
});
