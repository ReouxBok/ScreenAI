import { beforeEach, describe, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ auth: vi.fn(), review: vi.fn(), verdict: vi.fn(), queue: vi.fn(), send: vi.fn(), enabled: vi.fn(), qualify: vi.fn(), redirect: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/sav/auth", () => ({ requireSavApiStaff: d.auth }));
vi.mock("@/lib/sav/review", () => ({ reviewSavProposal: d.review }));
vi.mock("@/lib/sav/draft-verdicts", () => ({ reviewSavDraft: d.verdict }));
vi.mock("@/lib/sav/manual-replies", () => ({ queueSavManualReply: d.queue, assertSavManualReplyEnabled: d.enabled }));
vi.mock("@/lib/sav/gmail", () => ({ processPendingGmailSendActions: d.send }));
vi.mock("@/lib/sav/observations", () => ({ qualifySavObservation: d.qualify }));
vi.mock("next/cache", () => ({ revalidatePath: d.revalidate }));
vi.mock("next/navigation", () => ({ redirect: d.redirect }));
import { reviewDraftAction, reviewProposalAction, sendStudioReplyAction, saveReplyDraftAction, qualifyObservationAction } from "./actions";
function form() { const f = new FormData(); for (const name of ["threadId", "messageId", "decisionId", "agentRunId", "draftId", "observationId", "cycleId"])
    f.set(name, "10000000-0000-4000-8000-000000000001"); f.set("sourceHash", "x".repeat(43)); f.set("status", "rejected"); f.set("actorEmail", "forged@example.invalid"); return f; }
beforeEach(() => { vi.clearAllMocks(); d.auth.mockResolvedValue({ email: "ugo@limova.ai" }); d.redirect.mockImplementation((u: string) => { throw new Error(`REDIRECT:${u}`); }); d.queue.mockResolvedValue({ id: "queued", status: "pending" }); d.send.mockResolvedValue({ processed: [] }); });
describe("independent authenticated V0 POST handlers", () => {
    it.each([reviewDraftAction, reviewProposalAction, sendStudioReplyAction, qualifyObservationAction, saveReplyDraftAction])("authenticates before every mutation", async (action) => { d.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN")); await expect(action(form())).rejects.toThrow("SAV_ACCESS_FORBIDDEN"); for (const fn of [d.review, d.verdict, d.queue, d.send, d.qualify])
        expect(fn).not.toHaveBeenCalled(); });
    it.each([reviewDraftAction, reviewProposalAction, sendStudioReplyAction])("rejects editable draft fields forged into the form", async (action) => { const f = form(); f.set("replyDraft", "FORGED"); await expect(action(f)).rejects.toThrow("SAV_DRAFT_READ_ONLY"); for (const fn of [d.review, d.verdict, d.queue, d.send])
        expect(fn).not.toHaveBeenCalled(); });
    it("records refusal under authenticated actor with no send or dossier correction", async () => { await expect(reviewDraftAction(form())).rejects.toThrow("draft_reviewed"); expect(d.verdict).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", reason: "" }), "ugo@limova.ai"); expect(d.review).not.toHaveBeenCalled(); expect(d.queue).not.toHaveBeenCalled(); });
    it("sends the accepted stored artifact without creating an editable version", async () => { await expect(sendStudioReplyAction(form())).rejects.toThrow("reply_queued"); expect(d.queue).toHaveBeenCalledWith({ threadId: "10000000-0000-4000-8000-000000000001", draftId: "10000000-0000-4000-8000-000000000001" }, "ugo@limova.ai"); expect(d.verdict).not.toHaveBeenCalled(); expect(d.review).not.toHaveBeenCalled(); });
    it("blocks the old edit handler", async () => { await expect(saveReplyDraftAction(form())).rejects.toThrow("SAV_DRAFT_READ_ONLY"); expect(d.verdict).not.toHaveBeenCalled(); });
});
