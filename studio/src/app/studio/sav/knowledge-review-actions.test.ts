import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ auth: vi.fn(), select: vi.fn(), preview: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/sav/auth", () => ({ requireSavApiStaff: state.auth }));
vi.mock("@/db", () => ({ requireDb: () => ({ select: () => ({ from: () => ({ where: state.select }) }) }) }));
vi.mock("@/lib/knowledge/hubspot-import", () => ({ prepareHubspotReview: state.preview, importHubspotKnowledge: vi.fn() }));
vi.mock("@/lib/knowledge/review", () => ({ reviewKnowledgeCandidate: state.review }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));

import { previewHubspotReviewAction, reviewKnowledgeAction } from "./actions";
const candidateId = "10000000-0000-4000-8000-000000000001";
const revisionId = "10000000-0000-4000-8000-000000000002";
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({ candidateId, revisionId, decision: "approve", document: "{}", reason: "Procédure synthétique relue", actorEmail: "ugo@limova.ai" })) data.set(key, value);
  return data;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.auth.mockResolvedValue({ email: "contact@limova.ai", role: "member" });
  state.select.mockResolvedValue([{ id: candidateId, revisionId, status: "pending", targetSurface: "sav" }]);
  state.preview.mockResolvedValue({ snapshot: "comparison" });
});
describe("delegated SAV knowledge review POST handlers", () => {
  it("uses the authenticated contact session for HubSpot comparison and review", async () => {
    expect(await previewHubspotReviewAction(form())).toMatchObject({ error: null, comparison: { snapshot: "comparison" } });
    expect(state.preview).toHaveBeenCalledTimes(1);
    await expect(reviewKnowledgeAction(form())).rejects.toThrow("result=draft_ready");
    expect(state.review).toHaveBeenCalledWith(candidateId, expect.objectContaining({ decision: "approve" }), "contact@limova.ai");
  });
  it("rejects a Chrome destination before preparing a HubSpot comparison", async () => {
    state.select.mockResolvedValue([{ id: candidateId, revisionId, status: "pending", targetSurface: "onboarding" }]);
    expect(await previewHubspotReviewAction(form())).toMatchObject({ error: "KNOWLEDGE_CANDIDATE_STALE" });
    expect(state.preview).not.toHaveBeenCalled();
  });
  it("rejects non-delegated admins even when the submitted actor is forged", async () => {
    state.auth.mockResolvedValue({ email: "reouven@limova.ai", role: "owner" });
    await expect(previewHubspotReviewAction(form())).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    expect(state.select).not.toHaveBeenCalled();
  });
  it.each([previewHubspotReviewAction, reviewKnowledgeAction])("requires a SAV session before reading or reviewing", async (action) => {
    state.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN"));
    await expect(action(form())).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    expect(state.select).not.toHaveBeenCalled(); expect(state.review).not.toHaveBeenCalled();
  });
});
