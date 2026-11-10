import { describe, expect, it, vi } from "vitest";
import { assessSavKnowledgeValidity, assertSavRequestCandidateLinks, calibrateSavRetrievalRanking, retrieveSavKnowledgeByRequest, savPersonalAccessIntent, savRetrievalRanking, savWholeTokenCoverage, SAV_RETRIEVAL_LIMITS, type SavRetrievalCandidate } from "./request-retrieval";

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

describe("personal access intent (review d70a A02/A04/A05/A09): synonyms ranked, other services and people not", () => {
  // Synthetic catalogue shaped like the confusable cards (own login vs connecting a service, a workspace, a member); no real card or id.
  const syn = (id: string, title: string, symptom: string) => card(id, { title, resolution: { steps: ["Étape synthétique."], symptoms: [symptom], conflictsWith: [], supersedes: [] } });
  const catalogue = [
    syn("login", "Se connecter avec le code reçu par e-mail", "Expliquer la connexion à son espace avec le code reçu par e-mail."),
    syn("space", "Retrouver l’accès à son espace", "Aider le client à retrouver le bon compte et un espace déjà accessible."),
    syn("linkedin", "Connecter LinkedIn pour publier", "Expliquer la connexion LinkedIn."),
    syn("meta", "Connecter Facebook ou Instagram", "Expliquer la connexion Facebook ou Instagram."),
    syn("integration", "Trouver et connecter une intégration", "Trouver un service et connecter le bon compte."),
    syn("google", "Connecter Gmail ou Calendar", "Expliquer la connexion d’un compte Google."),
    syn("outlook", "Connecter Outlook ou un calendrier compatible", "Expliquer comment connecter Outlook à l’outil."),
    syn("chat", "Utiliser les conversations", "Où ouvrir une conversation ? Je ne retrouve pas le menu."),
    syn("seo", "Rédiger un audit de site", "Je veux analyser le référencement de mon site."),
    syn("member", "Inviter un membre dans l’organisation", "Expliquer où ajouter des utilisateurs à l’organisation."),
    syn("email", "Changer son adresse e-mail", "Expliquer le changement de l’adresse e-mail de connexion."),
  ];
  const top3 = (query: string) => [...catalogue].sort((a, b) => savRetrievalRanking(query, b).rankingScore - savRetrievalRanking(query, a).rankingScore).slice(0, 3).map(row => row.id);
  it.each([
    ["A01", "Re: Découvrir. Bonjour, j’ai tenté de me connecter à mon espace avec mon adresse d’inscription, sans succès."],
    ["A02", "Pourquoi je ne peux pas accéder au site ?"],
    ["A03", "J’ouvre le chat mais je n’arrive pas à me connecter à la plateforme pour travailler. J’ai déjà payé."],
    ["A04", "Je n’arrive pas à accéder à mon compte. J’ai pris un abonnement avec un essai aujourd’hui."],
    ["A05", "Objet : problème de connexion à mon compte. Je vous ai déjà envoyé une capture."],
    ["A06", "J’ai déjà essayé le bon lien et la bonne adresse e-mail, mais je ne reçois aucun code de connexion."],
    ["A08", "J’ai déjà essayé le bon lien et la bonne adresse e-mail, je ne reçois aucun code. J’ai aussi vérifié les spams, rien."],
    ["A09", "J’ai déjà essayé le bon lien et la bonne adresse, je ne reçois aucun code. Spams vérifiés. L’écran affiche « identifiant introuvable »."],
  ])("%s: the login card is in the TOP 3", (_id, query) => {
    expect(savPersonalAccessIntent(query)).toBe(true);
    expect(top3(query)).toContain("login");
  });
  it.each([
    "Je n’arrive pas à connecter mon Gmail.",
    "Comment me connecter à Outlook depuis l’outil ?",
    "Je voudrais inviter un collaborateur dans mon organisation.",
    "Combien d’utilisateurs puis-je ajouter, quel est le quota ?",
    "La fenêtre de connexion LinkedIn reste bloquée.",
    "Je n’arrive pas à accéder au site web de mon client depuis mon intégration WordPress.",
  ])("negative « %s »: no personal access intent, the login card is not first", query => {
    expect(savPersonalAccessIntent(query)).toBe(false);
    expect(top3(query)[0]).not.toBe("login");
  });
  it("the boost reads the card's own words, never an id: the same card under another id ranks the same", () => {
    const query = "Je n’arrive pas à accéder à mon compte.";
    const renamed = { ...catalogue[0]!, id: "other-id", contentVersionId: "other-id-v9" };
    expect(savRetrievalRanking(query, renamed).rankingScore).toBe(savRetrievalRanking(query, catalogue[0]!).rankingScore);
  });
});
