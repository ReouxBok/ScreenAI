import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSavMessage } from "./intelligence";

const dependencies = vi.hoisted(() => ({ search: vi.fn(), agent: vi.fn(), crm: vi.fn() }));
vi.mock("@/lib/search", () => ({ searchKnowledge: dependencies.search }));
vi.mock("./agent/orchestrator", () => ({ runSavAdkAgent: dependencies.agent }));
vi.mock("./hubspot", () => ({ readSavHubspotContext: dependencies.crm }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("SAV analysis controls", () => {
  it.each(["off", "shadow", "pilot", "on"])("non-support mail bypasses models and CRM in %s", async (mode) => {
    vi.stubEnv("SAV_ADK_MODE", mode);
    vi.stubEnv("SAV_AI_ANALYSIS", "true");
    vi.stubEnv("SAV_GEMINI_API_KEY", "fixture");
    for (const input of [
      { subject: "Re: aide", body: "Merci beaucoup !" },
      { subject: "Rapport", body: "Retour lundi", autoSubmitted: "auto-replied" },
    ]) {
      const result = await analyzeSavMessage({ from: "client@example.com", ...input });
      expect(result.proposal.kind).toMatch(/^(?:no_ticket_needed|automatic_reply)$/);
      expect(result.replyDraft).toBeNull();
    }
    expect(dependencies.agent).not.toHaveBeenCalled();
    expect(dependencies.search).not.toHaveBeenCalled();
    expect(dependencies.crm).not.toHaveBeenCalled();
  });
  it("requires explicit review for an ambiguous HubSpot association", async () => {
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    dependencies.crm.mockResolvedValue({ contactFound: true, contactId: "c1", tickets: [], routing: { kind: "ambiguous", reason: "multiple_exact_subjects", candidateIds: ["1", "2"] } });
    const result = await analyzeSavMessage({ from: "client@example.com", subject: "Utilisation", body: "Comment changer la couleur ?" });
    expect(result.structuredProposal?.routing).toEqual({ kind: "review", reason: "multiple_exact_subjects", candidateIds: ["1", "2"] });
    expect(result.structuredProposal?.process.some((step) => ["create_ticket", "link_ticket"].includes(step.kind))).toBe(false);
    expect(result.proposal.requiresHumanApproval).toBe(true);
  });
  it("does not silently accept a missing mandatory analysis trace", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(analyzeSavMessage({ from: "client@example.com", subject: "Re: aide", body: "Merci !" }, { messageId: "unavailable" })).rejects.toThrow("SAV_ANALYSIS_TRACE_REQUIRED");
    logger.mockRestore();
  });
  it.each([false, true])("scans unknown senders and asks for the registration email only without a candidate: %s", async (hasCandidate) => {
    vi.stubEnv("SAV_AI_ANALYSIS", "false");
    const identityCandidates = hasCandidate ? [{ contactId: "31", name: "Jeanne Martin", email: "compte@example.com", phoneHint: "…5678", matchedBy: "phone", confirmed: false }] : [];
    dependencies.crm.mockResolvedValue({ contactFound: false, identityCandidates, tickets: [], routing: { kind: "new", reason: "no_contact" } });
    const result = await analyzeSavMessage({ from: "autre@example.com", displayName: "Jeanne Martin", subject: "Compte", body: "Comment retrouver mon compte ? Téléphone : 0612345678" });
    expect(dependencies.crm).toHaveBeenCalledWith(expect.objectContaining({ identityHints: { names: ["Jeanne Martin"], phones: ["0612345678"] } }));
    expect(result.proposal.requiresHumanApproval).toBe(true);
    expect(result.structuredProposal?.identityCandidates).toEqual(identityCandidates);
    expect(result.structuredProposal?.customerIdentity.verifiedByHuman).toBe(false);
    if (hasCandidate) expect(result.replyDraft).not.toContain("Quelle adresse email");
    else expect(result.replyDraft).toContain("Quelle adresse email utilisez-vous pour votre compte Limova");
  });
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
