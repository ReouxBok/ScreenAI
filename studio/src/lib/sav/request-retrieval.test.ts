import { describe, expect, it, vi } from "vitest";
import { assessSavKnowledgeValidity, assertSavRequestCandidateLinks, calibrateSavRetrievalRanking, retrieveSavKnowledgeByRequest, savRetrievalRanking, savWholeTokenCoverage, SAV_RETRIEVAL_LIMITS, type SavRetrievalCandidate } from "./request-retrieval";

const now = new Date("2026-10-15T12:00:00Z");
function card(id = "card-a", patch: Partial<SavRetrievalCandidate> = {}): SavRetrievalCandidate {
  return { id, contentVersionId: `${id}-v1`, title: `Procédure fictive ${id}`, content: "Étape fictive vérifiable : ouvrir le panneau de diagnostic.", source: `fixture/${id}`, verifiedAt: "2026-10-14T12:00:00Z", semanticScore: 0.8,
    resolution: { steps: ["Ouvrir le panneau de diagnostic."], symptoms: ["Incident fictif"], conflictsWith: [], supersedes: [] },
    availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" }, ...patch };
}
const requests = ["alpha", "beta", "gamma"].map(id => ({ id, summary: `Incident distinct ${id}` }));
function backend(batches: SavRetrievalCandidate[][] = [[card()]]) {
  return { readRevision: vi.fn(async () => "kb-1"), search: vi.fn<(queries: readonly string[], limit: number) => Promise<SavRetrievalCandidate[][]>>().mockResolvedValue(batches) };
}
describe("SAV72 request retrieval contract", () => {
  it("searches independent requests, preserving association and exact versions", async () => {
    const b = backend(requests.map(request => [card(request.id)]));
    const result = await retrieveSavKnowledgeByRequest({ requests, now }, b);
    expect(b.search).toHaveBeenCalledWith(requests.map(request => request.summary), 24);
    expect(result.requests.map(row => row.candidateKeys)).toEqual(requests.map(request => [`${request.id}:${request.id}-v1`]));
    expect(result.sources.every(source => source.grounding === "unassessed")).toBe(true);
    expect(result.metrics).toMatchObject({ queryCount: 3, attempts: 1, embeddingBatchesUpperBound: 1 });
  });
  it("prioritizes the primary request and exposes every unsearched request", async () => {
    const input = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, summary: `Demande fictive ${i}` }));
    const b = backend([[card("last")], [], []]);
    const result = await retrieveSavKnowledgeByRequest({ requests: input, primaryRequestId: "r14", now }, b);
    expect(b.search.mock.calls[0][0]).toEqual([input[14].summary, input[0].summary, input[1].summary]);
    expect(result.requests).toHaveLength(15);
    expect(result.requests.filter(row => row.status === "budget_exceeded")).toHaveLength(12);
  });
  it("deduplicates queries and merges source identities without merging equal titles", async () => {
    const b = backend([[card("first"), card("second", { title: card("first").title })]]);
    const result = await retrieveSavKnowledgeByRequest({ requests: [{ id: "a", summary: "Même demande" }, { id: "b", summary: "Même demande" }], now }, b);
    expect(b.search.mock.calls[0][0]).toHaveLength(1);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].requestIds).toEqual(["a", "b"]);
  });
  it("refuses cross-request sources and conflicting selected cards", async () => {
    const a = card("a", { resolution: { steps: ["Étape A"], conflictsWith: ["b"] } }), b = card("b");
    const result = await retrieveSavKnowledgeByRequest({ requests: requests.slice(0, 2), now }, backend([[a], [b]]));
    expect(() => assertSavRequestCandidateLinks(result, [{ requestId: "alpha", sourceIds: ["b"] }])).toThrow("SOURCE_NOT_RETRIEVED");
    expect(() => assertSavRequestCandidateLinks(result, [{ requestId: "alpha", sourceIds: ["a"] }, { requestId: "beta", sourceIds: ["b"] }])).toThrow("CONTRADICTORY");
    expect(() => assertSavRequestCandidateLinks(result, [{ requestId: "alpha", sourceIds: ["a"] }])).not.toThrow();
  });
  it("restarts the complete batch once and discards the first revision", async () => {
    const b = backend();
    b.readRevision.mockResolvedValueOnce("old").mockResolvedValueOnce("new").mockResolvedValue("new");
    b.search.mockResolvedValueOnce([[card("old")]]).mockResolvedValueOnce([[card("new")]]);
    const result = await retrieveSavKnowledgeByRequest({ requests: requests.slice(0, 1), now }, b);
    expect(result.revision).toBe("new"); expect(result.sources[0].id).toBe("new");
    expect(b.search).toHaveBeenCalledTimes(2); expect(result.metrics.attempts).toBe(2);
  });
  it("caps revision churn and returns no mixed evidence", async () => {
    const b = backend(); let revision = 0;
    b.readRevision.mockImplementation(async () => `kb-${revision++}`);
    const result = await retrieveSavKnowledgeByRequest({ requests: requests.slice(0, 1), now }, b);
    expect(result.sources).toEqual([]); expect(result.requests[0].status).toBe("revision_unstable");
    expect(b.search).toHaveBeenCalledTimes(2);
  });
  it("does not retry a provider failure or return partial successful sources", async () => {
    const b = backend(); b.search.mockRejectedValueOnce(new Error("provider failed private body"));
    const result = await retrieveSavKnowledgeByRequest({ requests: requests.slice(0, 1), now }, b);
    expect(result.requests[0].status).toBe("search_unavailable"); expect(result.sources).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private body"); expect(b.search).toHaveBeenCalledTimes(1);
  });
  it("discards inconsistent versions and payloads instead of picking a convenient one", async () => {
    for (const second of [card("a", { contentVersionId: "other-version" }), card("a", { content: "Autre fragment non interchangeable" })]) {
      const result = await retrieveSavKnowledgeByRequest({ requests: requests.slice(0, 2), now }, backend([[card("a")], [second]]));
      expect(result.sources).toEqual([]); expect(result.alerts).toHaveLength(1);
    }
  });
  it("exposes bounded candidate populations and never truncates a source silently", async () => {
    const large = card("large", { title: requests[0].summary, semanticScore: 1, content: "é".repeat(6_000) });
    const b = backend([[large, ...Array.from({ length: 23 }, (_, i) => card(`card-${i}`))]]);
    const result = await retrieveSavKnowledgeByRequest({ requests: requests.slice(0, 1), now }, b);
    expect(result.requests[0].limitations).toContain("candidate_population_bounded");
    expect(result.requests[0].limitations).toContain("source_context_budget");
    expect(result.sources.some(source => source.id === "large")).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(SAV_RETRIEVAL_LIMITS.contextBytes);
  });
  it("rejects duplicate request IDs and avoids work for over-budget queries", async () => {
    const b = backend();
    await expect(retrieveSavKnowledgeByRequest({ requests: [requests[0], requests[0]], now }, b)).rejects.toThrow("REQUEST_IDS");
    const result = await retrieveSavKnowledgeByRequest({ requests: [{ id: "large", summary: "s".repeat(600), product: "p".repeat(200), feature: "f".repeat(200) }], now }, b);
    expect(result.requests[0].status).toBe("budget_exceeded"); expect(b.search).not.toHaveBeenCalled();
  });
  it("matches whole tokens and keeps semantic signals separate from proof", () => {
    expect(savWholeTokenCoverage("art", "partie article partenaire")).toBe(0);
    expect(savWholeTokenCoverage("clé API", "Cle API du connecteur")).toBe(1);
    expect(savRetrievalRanking("réseau sécurisé", card("a", { semanticScore: 0.99 }))).toMatchObject({ semanticScore: 0.99, lexicalScore: 0 });
  });
  it("projects only resolution fields while retaining procedure conditions and outcomes", async () => {
    const source = card("a", { resolution: { steps: ["Étape fictive"], prerequisites: ["Condition indispensable"], expectedResult: "Résultat attendu", exceptions: ["Ne pas appliquer au cas B"], privateExtra: "UNRELATED_METADATA" } });
    const result = await retrieveSavKnowledgeByRequest({ requests: requests.slice(0, 1), now }, backend([[source]]));
    expect(result.sources[0].resolution).toMatchObject({ prerequisites: ["Condition indispensable"], expectedResult: "Résultat attendu", exceptions: ["Ne pas appliquer au cas B"] });
    expect(JSON.stringify(result)).not.toContain("UNRELATED_METADATA");
  });
  it("calibrates ordering on positive and hard-negative labels without using a proof threshold", () => {
    const plain = { symptoms: [], steps: ["Étape fictive"], conflictsWith: [], supersedes: [] };
    const cases = [
      { query: "alpha beta gamma delta", candidates: [card("positive", { title: "alpha", semanticScore: 0.82, resolution: plain }), card("negative", { title: "alpha beta gamma delta", semanticScore: 0.1, resolution: plain })], relevantKeys: ["positive:positive-v1"] },
      { query: "connecteur synchronisation", candidates: [card("positive", { title: "connecteur synchronisation", semanticScore: 0.62, resolution: plain }), card("negative", { title: "publication graphique", semanticScore: 0.79, resolution: plain })], relevantKeys: ["positive:positive-v1"] },
    ];
    const result = calibrateSavRetrievalRanking(cases, now);
    expect(result.selectedWeight).toBe(0.75);
    expect(result.alternatives.find(row => row.semanticWeight === result.selectedWeight)).toMatchObject({ top1Accuracy: 1, recallAt3: 1, precisionAt3: 0.5 });
    expect(JSON.stringify(result)).not.toContain("connecteur synchronisation");
    expect(() => calibrateSavRetrievalRanking([], now)).toThrow("LABELS_REQUIRED");
  });
});

describe("SAV72 source validity", () => {
  it.each([
    ["inactive", { active: false }], ["unpublished", { published: false }], ["unindexed", { indexed: false }],
    ["archived", { archived: true }], ["disabled", { aiEnabled: false }], ["locale", { locale: "en-US" }], ["audience", { audience: "lead" }],
  ] as const)("excludes %s even with a strong semantic signal", (reason, patch) => {
    const source = card(); source.availability = { ...source.availability, ...patch };
    expect(assessSavKnowledgeValidity(source, "fr-FR", "support", now)).toMatchObject({ eligible: false, reason });
  });
  it.each([
    ["invalid_resolution", { resolution: null }], ["invalid_expiry", { resolution: { steps: ["Étape"], validUntil: "2027-02-31" } }],
    ["expired", { resolution: { steps: ["Étape"], validUntil: "2026-10-14" } }], ["unverified", { verifiedAt: null }],
    ["unverified", { verifiedAt: "2026-10-16" }], ["stale", { verifiedAt: "2026-01-01" }], ["source_budget", { sourceTooLarge: true }],
  ] as Array<[string, Partial<SavRetrievalCandidate>]>)("rejects %s without rewriting verification dates", (reason, patch) => {
    const source = card("a", patch), before = JSON.stringify(source);
    expect(assessSavKnowledgeValidity(source, "fr-FR", "support", now)).toMatchObject({ eligible: false, reason });
    expect(JSON.stringify(source)).toBe(before);
  });
  it("keeps a card valid through its expiry day and alerts before verification ages out", () => {
    const source = card("a", { verifiedAt: "2026-07-30T12:00:00Z", resolution: { steps: ["Étape"], validUntil: "2026-10-15" } });
    expect(assessSavKnowledgeValidity(source, "fr-FR", "support", now)).toEqual({ eligible: true, reason: "available", revalidationDue: true });
  });
});
