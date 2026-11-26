import { afterEach, describe, expect, it, vi } from "vitest";
import { compactSavRetrievalResolution, retrieveSavKnowledgeByRequest, SAV_RETRIEVAL_LIMITS, SAV_RETRIEVAL_TRUNCATION_MARKER, truncateSavRetrievalText, type SavRetrievalCandidate } from "./request-retrieval";

// Fictional fiches only. A detailed procedure published through the knowledge MCP: its structured resolution repeats every
// prerequisite, exception and step in its delivery group, so body + resolution exceed one source bound while each fits.
const now = new Date("2026-10-15T12:00:00Z");
const utf8 = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
const availability = { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" };
const sentence = (label: string, size: number) => `${label} : vérifier dans le panneau fictif Exemple que le réglage attendu est bien présent. `.repeat(Math.ceil(size / 90)).slice(0, size);

function detailedProcedure(id: string, semanticScore = 0.95, bodyBytes = 0): SavRetrievalCandidate {
  const prerequisites = Array.from({ length: 4 }, (_, i) => sentence(`Prérequis ${i + 1}`, 200));
  const exceptions = Array.from({ length: 4 }, (_, i) => sentence(`Exception ${i + 1}`, 250));
  const steps = Array.from({ length: 8 }, (_, i) => ({ id: `${id}.step-${i + 1}`, userLabel: `Étape ${i + 1}`, instruction: sentence(`Instruction ${i + 1}`, 300),
    expectedResult: "", prerequisites: [], exceptions: [], escalation: "" }));
  const escalation = sentence("Escalade", 300), expectedResult = sentence("Résultat", 150);
  const content = [`# Fiche fictive ${id}`, ...prerequisites, ...steps.map(step => `${step.userLabel}\n${step.instruction}`), ...exceptions, expectedResult, escalation,
    ...(bodyBytes ? [sentence("Annexe", bodyBytes)] : [])].join("\n\n");
  return { id, contentVersionId: `${id}-v1`, title: `Procédure fictive détaillée ${id}`, content, source: `fixture/${id}`, verifiedAt: "2026-10-14T12:00:00Z", semanticScore,
    resolution: { steps: steps.map(step => step.instruction), symptoms: ["Incident fictif de connexion au service Exemple"], prerequisites, exceptions, escalation, expectedResult, troubleshooting: escalation,
      conflictsWith: [], supersedes: [],
      delivery: { version: 1, mode: "procedure", steps, groups: [{ id: "fiche.main", label: "Rétablir le service fictif Exemple", requiresHuman: false, prerequisites, exceptions, expectedResult, escalation,
        stepIds: steps.map(step => step.id) }] } },
    availability };
}
function smallCard(id: string, semanticScore: number): SavRetrievalCandidate {
  return { id, contentVersionId: `${id}-v1`, title: `Procédure fictive ${id}`, content: "Étape fictive vérifiable : ouvrir le panneau de diagnostic.", source: `fixture/${id}`,
    verifiedAt: "2026-10-14T12:00:00Z", semanticScore, resolution: { steps: ["Ouvrir le panneau de diagnostic."], symptoms: ["Incident fictif"], conflictsWith: [], supersedes: [] }, availability };
}
function backend(batches: SavRetrievalCandidate[][]) {
  return { readRevision: vi.fn(async () => "kb-1"), search: vi.fn(async () => batches) };
}
const one = [{ id: "alpha", summary: "Problème fictif de connexion au service Exemple" }];
const three = ["alpha", "beta", "gamma"].map(id => ({ id, summary: `Incident fictif distinct ${id}` }));
const on = () => vi.stubEnv("SAV_RETRIEVAL_CARD_SIZE_FIX", "on");

afterEach(() => vi.unstubAllEnvs());

describe("SAV retrieval card size (SAV_RETRIEVAL_CARD_SIZE_FIX)", () => {
  it("the fixture is the real shape: body and resolution each within the SQL bound, the card above it", () => {
    const fiche = detailedProcedure("fiche-a");
    expect(utf8(fiche.content)).toBeGreaterThan(4_000);
    expect(utf8(fiche.content)).toBeLessThanOrEqual(SAV_RETRIEVAL_LIMITS.sourceBytes);
    expect(utf8(fiche.resolution)).toBeLessThanOrEqual(SAV_RETRIEVAL_LIMITS.sourceBytes);
    expect(utf8({ content: fiche.content, resolution: fiche.resolution })).toBeGreaterThan(SAV_RETRIEVAL_LIMITS.sourceBytes);
  });

  it.each([undefined, "off", "true", "ON"])("flag %s: the detailed fiche is dropped as before, without naming it", async value => {
    if (value !== undefined) vi.stubEnv("SAV_RETRIEVAL_CARD_SIZE_FIX", value);
    const result = await retrieveSavKnowledgeByRequest({ requests: one, now }, backend([[detailedProcedure("fiche-a")]]));
    expect(result.sources).toEqual([]);
    expect(result.requests[0]).toMatchObject({ status: "budget_exceeded", candidateKeys: [], limitations: ["source_context_budget"] });
    expect(result.alerts).toEqual([]);
  });

  it("flag on: the detailed fiche is kept with its whole body and delivery; the top-level copies of the group texts are not sent twice", async () => {
    on();
    const fiche = detailedProcedure("fiche-a");
    const result = await retrieveSavKnowledgeByRequest({ requests: one, now }, backend([[fiche]]));
    expect(result.requests[0]).toMatchObject({ status: "candidates", candidateKeys: ["fiche-a:fiche-a-v1"], limitations: [] });
    expect(result.sources).toHaveLength(1);
    const [source] = result.sources;
    expect(source.content).toBe(fiche.content);
    expect(source.resolution?.delivery).toEqual(fiche.resolution!.delivery);
    expect(source.resolution).toMatchObject({ escalation: fiche.resolution!.escalation, symptoms: fiche.resolution!.symptoms });
    for (const field of ["prerequisites", "exceptions", "expectedResult", "troubleshooting"]) expect(source.resolution).not.toHaveProperty(field);
    expect(result.alerts).toEqual([]);
  });

  it("flag on: a 20 KB fiche is present whole when ranked", async () => {
    on();
    const fiche = detailedProcedure("fiche-longue", 0.95, 15_000);
    expect(utf8(fiche.content)).toBeGreaterThan(20_000);
    const result = await retrieveSavKnowledgeByRequest({ requests: one, now }, backend([[fiche, smallCard("small", 0.5)]]));
    expect(result.sources.map(source => source.id)).toEqual(["fiche-longue", "small"]);
    expect(result.sources[0].content).toBe(fiche.content);
    expect(utf8(result)).toBeLessThanOrEqual(SAV_RETRIEVAL_LIMITS.contextBytes);
  });

  it("flag on: over the overall bound, the lowest-ranked cards are shortened with a marker and named; none is dropped", async () => {
    on();
    const batches = three.map((request, i) => [detailedProcedure(`${request.id}-1`, 0.95 - i / 100), detailedProcedure(`${request.id}-2`, 0.6 - i / 100)]);
    const result = await retrieveSavKnowledgeByRequest({ requests: three, now }, backend(batches));
    expect(result.sources.map(source => source.id).sort()).toEqual(batches.flat().map(card => card.id).sort());
    expect(result.requests.every(row => row.status === "candidates" && row.candidateKeys.length === 2 && !row.limitations.includes("source_context_budget"))).toBe(true);
    expect(utf8(result)).toBeLessThanOrEqual(SAV_RETRIEVAL_LIMITS.contextBytes);
    const truncated = result.sources.filter(source => source.content.endsWith(SAV_RETRIEVAL_TRUNCATION_MARKER) || source.content === SAV_RETRIEVAL_TRUNCATION_MARKER.trimStart());
    expect(truncated.length).toBeGreaterThan(0);
    expect(result.alerts.filter(alert => alert.code === "source_truncated").map(alert => alert.sourceKey).sort()).toEqual(truncated.map(source => source.key).sort());
    // Lowest-ranked first: the second card of each request gives way before any first card, and the very best card stays whole.
    const placed = result.sources.map(source => source.id);
    expect(placed).toEqual(["alpha-1", "beta-1", "gamma-1", "alpha-2", "beta-2", "gamma-2"]);
    const firstTruncated = placed.findIndex(id => truncated.some(source => source.id === id));
    expect(placed.slice(firstTruncated).every(id => truncated.some(source => source.id === id))).toBe(true);
    expect(truncated.map(source => source.id)).toEqual(expect.arrayContaining(["alpha-2", "beta-2", "gamma-2"]));
    expect(result.sources[0].content).toBe(batches[0][0].content);
    expect(result.sources[0].resolution?.delivery).toEqual(batches[0][0].resolution!.delivery);
    for (const source of truncated) expect(source).toMatchObject({ title: expect.any(String), requestIds: [expect.any(String)] });
  });

  it("flag on: a single card far above the bound is still sent, shortened to fit", async () => {
    on();
    const huge = { ...smallCard("huge", 0.99), content: "Texte fictif très long. ".repeat(4_000) };
    const result = await retrieveSavKnowledgeByRequest({ requests: one, now }, backend([[huge]]));
    expect(result.sources.map(source => source.id)).toEqual(["huge"]);
    expect(result.sources[0].content.endsWith(SAV_RETRIEVAL_TRUNCATION_MARKER)).toBe(true);
    expect(huge.content.startsWith(result.sources[0].content.slice(0, -SAV_RETRIEVAL_TRUNCATION_MARKER.length))).toBe(true);
    expect(utf8(result)).toBeLessThanOrEqual(SAV_RETRIEVAL_LIMITS.contextBytes);
    expect(result.alerts).toEqual([{ code: "source_truncated", sourceKey: "huge:huge-v1" }]);
  });

  it("flag on: cards that fit select exactly as before", async () => {
    const batches = three.map((request, i) => [smallCard(`${request.id}-1`, 0.9 - i / 10), smallCard(`${request.id}-2`, 0.5), smallCard("shared", 0.4)]);
    const off = await retrieveSavKnowledgeByRequest({ requests: three, now }, backend(batches));
    on();
    expect(await retrieveSavKnowledgeByRequest({ requests: three, now }, backend(batches))).toEqual(off);
  });

  it("the compact form leaves a non-procedure resolution and texts absent from the delivery untouched", () => {
    const plain = { steps: ["Étape fictive"], prerequisites: ["Condition fictive"], exceptions: ["Exception fictive"], expectedResult: "Résultat fictif", troubleshooting: "Aide fictive" };
    expect(compactSavRetrievalResolution(plain)).toBe(plain);
    const fiche = detailedProcedure("fiche-a").resolution!;
    const extra = { ...fiche, steps: [], prerequisites: [...(fiche.prerequisites as string[]), "Prérequis hors groupe"], troubleshooting: "Dépannage distinct" } as Parameters<typeof compactSavRetrievalResolution>[0];
    expect(compactSavRetrievalResolution(extra)).toMatchObject({ prerequisites: ["Prérequis hors groupe"], troubleshooting: "Dépannage distinct" });
  });

  it("truncation removes at least the excess and keeps whole characters", () => {
    const text = "é".repeat(1_000);
    const cut = truncateSavRetrievalText(text, 300);
    expect(cut.endsWith(SAV_RETRIEVAL_TRUNCATION_MARKER)).toBe(true);
    expect(utf8(text) - utf8(cut)).toBeGreaterThanOrEqual(300);
    expect(cut).not.toContain("�");
    expect(truncateSavRetrievalText("court", 50)).toBe(SAV_RETRIEVAL_TRUNCATION_MARKER.trimStart());
  });
});
