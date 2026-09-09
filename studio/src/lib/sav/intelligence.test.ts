import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSavMessage } from "./intelligence";

const dependencies = vi.hoisted(() => ({ search: vi.fn(), agent: vi.fn() }));
vi.mock("@/lib/search", () => ({ searchKnowledge: dependencies.search }));
vi.mock("./agent/orchestrator", () => ({ runSavAdkAgent: dependencies.agent }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("SAV analysis controls", () => {
  it.each(["off", "shadow", "pilot", "on"])("disabling AI prevents both engines and embeddings in %s", async (mode) => {
    vi.stubEnv("SAV_ADK_MODE", mode);
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    const network = vi.fn(() => { throw new Error("No network expected"); });
    vi.stubGlobal("fetch", network);
    const analysis = await analyzeSavMessage({ from: "client@example.com", subject: "Utilisation", body: "Comment changer la couleur ?" });
    expect(analysis.model).toBe("rules-v1");
    expect(dependencies.agent).not.toHaveBeenCalled();
    expect(dependencies.search).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("a successful, confident legacy fallback cannot authorize an autonomous answer", async () => {
    vi.stubEnv("SAV_ADK_MODE", "on");
    vi.stubEnv("SAV_AI_ANALYSIS", "true");
    vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    dependencies.agent.mockRejectedValue(new Error("SAV_REQUIRED_TOOL_UNAVAILABLE"));
    dependencies.search.mockResolvedValue({ revision: "fixture", results: [{ id: "card", title: "Procédure", content: "Procédure", score: 0.9 }] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      category: "how_to", urgency: "normal", ticketRequired: true, reasonCode: "known_procedure",
      explanation: "La procédure correspond au problème.", confidence: 0.99, requiresHuman: false,
      replyDraft: "Voici la procédure.", internalNote: "Procédure connue.",
    }) }] } }] })));
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Utilisation", body: "Comment changer la couleur ?" });
    expect(result.proposal).toMatchObject({ kind: "human_review_required", requiresHumanApproval: true, reasonCode: "agent_runtime_degraded" });
    expect(result.replyDraft).not.toContain("Voici la procédure.");
  });
});
