import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeSavMessage, type SavEvaluationResources } from "./intelligence";
import { savSemanticPlan, type SavUnderstandingV1 } from "./understanding";
import { coverageFixture, geminiFixture, understandingFixture } from "../../../test/sav-understanding-fixtures";
import type { SavAgentOutput } from "./agent/contracts";

const deps = vi.hoisted(() => ({ search: vi.fn(), agent: vi.fn(), crm: vi.fn(), understand: vi.fn(), coherence: vi.fn() }));
vi.mock("@/lib/search", () => ({ searchKnowledge: deps.search }));
vi.mock("./agent/orchestrator", () => ({ runSavAdkAgent: deps.agent }));
vi.mock("./hubspot", () => ({ readSavHubspotContext: deps.crm }));
vi.mock("./understanding-model", () => ({ understandSavMessage: deps.understand }));
vi.mock("./reply-coherence", () => ({ checkSavReplyCoherence: deps.coherence }));

const modes = ["off", "shadow", "pilot", "on"] as const;
const input = { from: "fixture@example.invalid", subject: "Re: Résiliation", body: "Je ne veux pas résilier. Mon agent coupe après mon achat à 79 euros.\nOn Tuesday, Support wrote:\nJe veux un remboursement." };
function outputFor(u: SavUnderstandingV1) {
  const coverage = coverageFixture(u);
  return { category: savSemanticPlan(u).category, urgency: "normal", ticketRequired: true, reasonCode: "fixture_support", explanation: "Le problème produit doit être vérifié.", confidence: 0.99, requiresHuman: true,
    responseKind: "handoff", replyDraft: coverage.map(c => c.text).join("\n\n"), internalNote: "Dossier fictif à vérifier.", coverage, citations: [] as SavAgentOutput["citations"], evidenceIds: [] };
}
function adkResult(u: SavUnderstandingV1) {
  return { output: outputFor(u), evidence: [], toolTrace: [], model: "fixture-model", promptRevision: "fixture-prompt", inputHash: "fixture-in", outputHash: "fixture-out", durationMs: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30, knowledgeRevision: "fixture-kb", ticketRouting: { kind: "new", contactId: "fixture-contact", reason: "fixture" } };
}
function coherence(status = "passed") {
  return { status, issues: status === "rejected" ? ["unsupported_advice"] : [], promptRevision: "fixture-coherence", model: "fixture-model", inputHash: "fixture-in", outputHash: status === "unavailable" ? null : "fixture-out", durationMs: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30, errorCode: status === "passed" ? null : status === "rejected" ? "SAV_REPLY_COHERENCE_REJECTED" : "SAV_AI_HTTP_500" };
}
function evaluation(mode: typeof modes[number], network: typeof fetch): SavEvaluationResources {
  return { apiKey: "fixture-key", model: "fixture-model", mode, pilot: mode === "pilot", searchKnowledge: deps.search, readHubspotContext: deps.crm, fetch: network };
}
beforeEach(() => {
  vi.stubEnv("SAV_AI_ANALYSIS", "true"); vi.stubEnv("SAV_GEMINI_API_KEY", "fixture-key");
  deps.search.mockResolvedValue({ revision: "fixture-kb", results: [] });
  deps.crm.mockResolvedValue({ contactFound: true, contactId: "fixture-contact", tickets: [], routing: { kind: "new", reason: "fixture" } });
  deps.coherence.mockResolvedValue(coherence());
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external request"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("SAV shared semantic pipeline with synthetic provider outputs", () => {
  it.each(modes)("understands once before retrieval and preserves technical meaning in %s", async mode => {
    const u = understandingFixture(); u.requests[0].financialScope = "incidental_price";
    deps.understand.mockResolvedValue(u); deps.agent.mockResolvedValue(adkResult(u));
    const network = vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)));
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(deps.understand).toHaveBeenCalledOnce();
    expect(result.category).toBe("technical"); expect(result.replyDraft).toBe(outputFor(u).replyDraft);
    expect(result.understanding).toEqual(u); expect(result.structuredProposal?.understanding).toEqual(u);
    expect(result.replyAssessment?.coherence?.status).toBe("passed"); expect(deps.coherence).toHaveBeenCalledOnce();
    if (mode === "off" || mode === "shadow") {
      expect(deps.search).toHaveBeenCalledWith(expect.objectContaining({ query: savSemanticPlan(u).retrievalQuery }));
      expect(deps.search.mock.invocationCallOrder[0]).toBeGreaterThan(deps.understand.mock.invocationCallOrder[0]);
      expect(network).toHaveBeenCalledOnce();
      const sent = JSON.parse(String(network.mock.calls[0]?.[1]?.body));
      expect(sent.contents[0].parts[0].text).toContain(u.requests[0].summary);
    }
    if (mode !== "off") expect(deps.agent).toHaveBeenCalledWith(expect.objectContaining({ understanding: u }), expect.any(Object));
  });
  it.each(modes)("keeps supplied facts and questions in the contract with no late identity boilerplate in %s", async mode => {
    const u = understandingFixture();
    u.knownFacts = [{ id: "fact-email", key: "registration_email", text: "account@example.invalid", evidenceIds: ["evidence-1"] }];
    deps.understand.mockResolvedValue(u); deps.agent.mockResolvedValue(adkResult(u));
    deps.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "no_contact" } });
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, vi.fn<typeof fetch>(async () => geminiFixture(outputFor(u)))) });
    expect(result.replyDraft).toBe(outputFor(u).replyDraft); expect(result.replyDraft).not.toMatch(/Quelle adresse|Which email/);
    expect(result.ticketRouting).toMatchObject({ kind: "review", reason: "customer_identity_unverified" });
    expect(result.structuredProposal?.customerIdentity.verifiedByHuman).toBe(false);
  });
  it.each(modes)("keeps mixed technical and refund requests in a standard financial handoff in %s", async mode => {
    const u = understandingFixture(); u.requests.push({ ...u.requests[0], id: "refund", summary: "Demander un remboursement.", nature: "financial_operation", financialScope: "support_account" });
    deps.understand.mockResolvedValue(u); const network = vi.fn();
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(result.category).toBe("technical"); expect(result.proposal.reasonCode).toBe("finance_human_only");
    expect(result.replyDraft).toContain("Les questions financières");
    for (const request of u.requests) expect(result.replyDraft).toContain(request.summary);
    expect(deps.understand).toHaveBeenCalledOnce(); expect(deps.search).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(deps.coherence).not.toHaveBeenCalled();
  });
  it.each(modes)("forbids every cancellation draft including mixed finance and missing identity in %s", async mode => {
    const u = understandingFixture(); u.requests.push({ ...u.requests[0], id: "cancel", nature: "cancellation", summary: "Mettre fin à l’abonnement." });
    deps.understand.mockResolvedValue(u); deps.crm.mockResolvedValue({ contactFound: false, tickets: [], routing: { kind: "new", reason: "no_contact" } });
    const network = vi.fn(); const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(result.proposal.reasonCode).toBe("cancellation_human_only"); expect(result.replyDraft).toBeNull(); expect(result.structuredProposal?.replyDraft).toBeNull();
    expect(deps.search).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it.each(modes)("does not invent a semantic classification after an unavailable understanding in %s", async mode => {
    const u = understandingFixture({ status: "unavailable", language: "unknown", requests: [], primaryRequestId: null, evidence: [], uncertainties: [{ code: "provider_unavailable", requestIds: [] }] }); u.trace.errorCode = "SAV_AI_HTTP_402";
    deps.understand.mockResolvedValue(u); const network = vi.fn();
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(result).toMatchObject({ category: "other", replyDraft: null, proposal: { reasonCode: "understanding_unavailable", confidence: 0, requiresHumanApproval: true } });
    expect(result.diagnostics).toContainEqual({ phase: "generation", errorCode: "SAV_AI_HTTP_402" });
    expect(deps.search).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it.each(modes)("uses a lead template only after qualifying a prospect in %s", async mode => {
    const u = understandingFixture(); u.requests[0].nature = "commercial"; u.customerRelationship = { kind: "prospect", evidenceIds: ["evidence-1"] };
    deps.understand.mockResolvedValue(u);
    const template = "Bonjour, voici le formulaire fictif : https://example.invalid/demo.";
    deps.search.mockResolvedValue({ revision: "fixture-lead", results: [{ id: "lead", contentVersionId: "lead-v1", title: "Fixture", content: template, score: 0.9, verifiedAt: new Date().toISOString(), resolution: { audience: "lead", symptoms: ["Découverte"], steps: ["Consulter le formulaire"], escalation: "Humain", conflictsWith: [], supersedes: [], responseTemplate: template } }] });
    const network = vi.fn(); const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, network) });
    expect(result.replyDraft).toBe(template); expect(result.ticketRouting?.kind).toBe("none");
    expect(deps.search).toHaveBeenCalledWith(expect.objectContaining({ savAudience: "lead" }));
    expect(deps.search.mock.invocationCallOrder[0]).toBeGreaterThan(deps.understand.mock.invocationCallOrder[0]);
    expect(network).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled();
  });
  it.each(["existing_customer", "unknown"] as const)("does not apply a prospect template to %s", async kind => {
    const u = understandingFixture(); u.requests[0].nature = "commercial"; u.customerRelationship = { kind, evidenceIds: kind === "unknown" ? [] : ["evidence-1"] }; deps.understand.mockResolvedValue(u);
    const network = vi.fn(); const result = await analyzeSavMessage(input, { evaluation: evaluation("off", network) });
    expect(result.replyDraft).toBeNull(); expect(result.proposal.reasonCode).toBe("commercial_context_to_review");
    expect(deps.search).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it.each(modes)("runs no semantic/model/CRM work for reliable technical automation headers in %s", async mode => {
    const result = await analyzeSavMessage({ ...input, autoSubmitted: "auto-replied" }, { evaluation: evaluation(mode, vi.fn()) });
    expect(result.proposal.kind).toBe("automatic_reply"); expect(result.replyDraft).toBeNull();
    expect(deps.understand).not.toHaveBeenCalled(); expect(deps.crm).not.toHaveBeenCalled(); expect(deps.search).not.toHaveBeenCalled(); expect(deps.agent).not.toHaveBeenCalled();
  });
  it.each(["rejected", "unavailable"])("replaces a %s coherence verdict with a marked contextual human handoff", async status => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u); deps.coherence.mockResolvedValue(coherence(status));
    const answer = outputFor(u); answer.coverage[0].text = "Cette réponse fournisseur doit être supprimée."; answer.replyDraft = answer.coverage[0].text;
    const network = vi.fn<typeof fetch>(async () => geminiFixture(answer)); const result = await analyzeSavMessage(input, { evaluation: evaluation("off", network) });
    expect(result.replyDraft).not.toContain("doit être supprimée"); expect(result.replyDraft).toContain(u.requests[0].summary);
    expect(result.replyAssessment).toMatchObject({ kind: "human_handoff", coherence: { status } });
    expect(result.proposal.confidence).toBe(0); expect(network).toHaveBeenCalledOnce(); expect(deps.coherence).toHaveBeenCalledOnce();
  });
  it.each(["off", "on"] as const)("rejects missing secondary request coverage in %s", async mode => {
    const u = understandingFixture(); u.requests.push({ ...u.requests[0], id: "second", summary: "Une seconde demande explicite." }); deps.understand.mockResolvedValue(u);
    const incomplete = outputFor(u); incomplete.coverage = incomplete.coverage.slice(0, 1); incomplete.replyDraft = incomplete.coverage[0].text;
    deps.agent.mockResolvedValue({ ...adkResult(u), output: incomplete });
    const result = await analyzeSavMessage(input, { evaluation: evaluation(mode, vi.fn<typeof fetch>(async () => geminiFixture(incomplete))) });
    expect(result.replyAssessment?.kind).toBe("human_handoff"); expect(result.replyDraft).toContain("seconde demande");
    expect(result.diagnostics).toContainEqual({ phase: "generation", errorCode: "SAV_REPLY_INCONSISTENT_WITH_UNDERSTANDING" }); expect(deps.coherence).not.toHaveBeenCalled();
  });
  it("does not retry another composer after ADK failure", async () => {
    deps.understand.mockResolvedValue(understandingFixture()); deps.agent.mockRejectedValue(new Error("SAV_ADK_TIMEOUT"));
    const network = vi.fn(); const result = await analyzeSavMessage(input, { evaluation: evaluation("on", network) });
    expect(result.proposal.reasonCode).toBe("agent_runtime_degraded"); expect(result.replyAssessment?.kind).toBe("human_handoff");
    expect(deps.agent).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled(); expect(deps.search).not.toHaveBeenCalled();
  });
  it("retains both claims and the exact version when two claims cite the same card", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u);
    const first = "Consultez le panneau de diagnostic fictif."; const second = "Relevez le code d’erreur affiché dans ce panneau.";
    deps.search.mockResolvedValue({ revision: "fixture-kb", results: [{ id: "card", contentVersionId: "card-version-1", title: "Procédure fictive", content: `${first}\n${second}`, score: 0.9, verifiedAt: new Date().toISOString(), resolution: { steps: [first, second], conflictsWith: [] } }] });
    const answer = outputFor(u); answer.responseKind = "solution";
    answer.coverage[0] = { ...answer.coverage[0], kind: "solution", text: `${first} ${second}`, sourceIds: ["card"] }; answer.replyDraft = answer.coverage[0].text;
    answer.citations = [{ sourceId: "card", claim: "Ouvrir le diagnostic", quote: first }, { sourceId: "card", claim: "Relever le code", quote: second }];
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", vi.fn<typeof fetch>(async () => geminiFixture(answer))) });
    expect(result.replyDraft).toBe(answer.replyDraft);
    expect(result.evidence.filter(e => e.sourceId === "card")).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentVersionId: "card-version-1", claim: "Ouvrir le diagnostic", excerpt: first }),
      expect.objectContaining({ contentVersionId: "card-version-1", claim: "Relever le code", excerpt: second }),
    ]));
  });
  it("does not display an ungrounded solution even under human review", async () => {
    const u = understandingFixture(); deps.understand.mockResolvedValue(u); const answer = outputFor(u);
    answer.responseKind = "solution"; answer.coverage[0] = { ...answer.coverage[0], kind: "solution", text: "Cliquez sur un bouton inventé.", sourceIds: ["missing-card"] }; answer.replyDraft = answer.coverage[0].text;
    answer.citations = [{ sourceId: "missing-card", claim: "Cliquer sur ce bouton", quote: "Une quote qui n’a jamais été fournie." }];
    const result = await analyzeSavMessage(input, { evaluation: evaluation("off", vi.fn<typeof fetch>(async () => geminiFixture(answer))) });
    expect(result.replyDraft).not.toContain("bouton inventé"); expect(result.replyAssessment?.kind).toBe("human_handoff");
    expect(deps.coherence).not.toHaveBeenCalled(); expect(result.diagnostics?.some(d => d.errorCode === "SAV_UNKNOWN_EVIDENCE")).toBe(true);
  });
  it.each([{ messageId: "fixture" }, { pilotBatchId: "fixture" }])("forbids any persisted identity on an evaluation run: %j", async persisted => {
    await expect(analyzeSavMessage(input, { ...persisted, evaluation: evaluation("off", vi.fn()) })).rejects.toThrow("SAV_EVALUATION_PERSISTENCE_FORBIDDEN");
    expect(deps.understand).not.toHaveBeenCalled(); expect(deps.crm).not.toHaveBeenCalled();
  });
});
