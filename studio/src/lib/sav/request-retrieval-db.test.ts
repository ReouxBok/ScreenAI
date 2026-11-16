import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { activeKnowledge, contentChunks, contentItems, contentVersions, knowledgeRevisions, reviewEvents, savKnowledgeActivations } from "@/db/schema";
const vector = () => [1, ...new Array<number>(767).fill(0)];
const state = vi.hoisted(() => ({ db: null as unknown, embed: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("@/lib/embeddings", () => ({ embedTexts: state.embed }));
import { searchSavKnowledgeByRequest, createSavKnowledgeVectorIndex } from "./request-retrieval-db";
const now = new Date("2026-10-15T12:00:00Z");
let f: Awaited<ReturnType<typeof createSavTestDb>>;
async function seed(slug: string, options: { active?: boolean; published?: boolean; locale?: string; audience?: string; verifiedAt?: Date; validUntil?: string; aiEnabled?: boolean; content?: string } = {}) {
  const [item] = await f.db.insert(contentItems).values({ slug, type: "article", title: slug, ownerEmail: "staff@example.invalid", status: "published", agentKey: "sav", aiEnabled: options.aiEnabled ?? true, locale: options.locale ?? "fr-FR", verifiedAt: options.verifiedAt ?? new Date("2026-10-14T12:00:00Z") }).returning();
  const body = options.content ?? `Procédure synthétique ${slug} : ouvrir le diagnostic de test.`;
  const [version] = await f.db.insert(contentVersions).values({ itemId: item.id, version: 1, bodyMarkdown: body,
    metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "Résultat fictif", troubleshooting: "", resolution: { audience: (options.audience ?? "support") as "support", symptoms: [slug], steps: [body], exceptions: [], escalation: "Revue humaine", productVersion: "test", ...(options.validUntil ? { validUntil: options.validUntil } : {}), supersedes: [], conflictsWith: [] } }, changeNote: "Fixture isolée", authorEmail: "staff@example.invalid" }).returning();
  if (options.published !== false) await f.db.update(contentItems).set({ publishedVersionId: version.id }).where(eq(contentItems.id, item.id));
  if (options.active !== false) await f.db.insert(savKnowledgeActivations).values({ itemId: item.id, versionId: version.id, title: slug, activatedBy: "fixture" });
  await f.db.insert(contentChunks).values({ itemId: item.id, versionId: version.id, ordinal: 0, content: body, embedding: vector() });
  return { item, version };
}
describe("SAV72 production query against an isolated database", () => {
  beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
  afterAll(async () => { await f.client.close(); });
  beforeEach(async () => {
    await f.client.exec("TRUNCATE content_items, active_knowledge, knowledge_revisions CASCADE");
    state.embed.mockReset().mockImplementation(async (queries: string[]) => queries.map(vector));
    await f.db.insert(knowledgeRevisions).values({ id: "kb-initial", actorEmail: "staff@example.invalid" });
    await f.db.insert(activeKnowledge).values({ singleton: true, revisionId: "kb-initial" });
  });
  it("batches embeddings and keeps independent request mappings and whole active versions", async () => {
    const a = await seed("connecteur alpha"), b = await seed("téléphone beta");
    const result = await searchSavKnowledgeByRequest({ requests: [{ id: "a", summary: "Connecteur alpha en erreur" }, { id: "b", summary: "Téléphone beta ne répond plus" }], now });
    expect(state.embed).toHaveBeenCalledTimes(1);
    expect(state.embed.mock.calls[0]).toEqual([["Connecteur alpha en erreur", "Téléphone beta ne répond plus"], "RETRIEVAL_QUERY", { scope: "sav" }]);
    expect(result.requests[0].candidateKeys[0]).toBe(`${a.item.id}:${a.version.id}`);
    expect(result.requests[1].candidateKeys[0]).toBe(`${b.item.id}:${b.version.id}`);
    expect(result.sources[0].grounding).toBe("unassessed");
    expect(result.sources[0].resolution).toMatchObject({ prerequisites: [], expectedResult: "Résultat fictif" });
  });
  it("excludes inactive, unpublished, disabled, stale, wrong audience and malformed dates", async () => {
    await seed("inactive", { active: false }); await seed("unpublished", { published: false });
    await seed("disabled", { aiEnabled: false }); await seed("stale", { verifiedAt: new Date("2026-01-01") });
    await seed("lead", { audience: "lead" }); await seed("expired", { validUntil: "2026-10-01" }); await seed("invalid", { validUntil: "2027-02-31" });
    await seed("different-locale", { locale: "en-US" });
    const result = await searchSavKnowledgeByRequest({ requests: [{ id: "a", summary: "Recherche fictive" }], now });
    expect(result.sources).toEqual([]); expect(result.requests[0].status).toBe("no_source");
    expect(result.alerts.map(alert => alert.code)).toEqual(expect.arrayContaining(["expired", "invalid_expiry"]));
  });
  it("retains the explicitly active version while a newer published draft is pending activation", async () => {
    const { item, version } = await seed("ancienne version encore active");
    const [newer] = await f.db.insert(contentVersions).values({ itemId: item.id, version: 2, bodyMarkdown: "Nouveau texte non activé", metadata: version.metadata, changeNote: "Fixture nouvelle version", authorEmail: "staff@example.invalid" }).returning();
    await f.db.update(contentItems).set({ publishedVersionId: newer.id }).where(eq(contentItems.id, item.id));
    await f.db.insert(contentChunks).values({ itemId: item.id, versionId: newer.id, ordinal: 0, content: "Nouveau texte non activé", embedding: vector() });
    const result = await searchSavKnowledgeByRequest({ requests: [{ id: "a", summary: "Version active" }], now });
    expect(result.sources[0].contentVersionId).toBe(version.id); expect(result.sources[0].content).not.toContain("Nouveau texte");
  });
  it.each([true, false])("does not renew an old active verification when another version is published (historical review %s)", async withReview => {
    const { item, version } = await seed("version ancienne");
    await f.db.update(contentVersions).set({ createdAt: new Date("2026-06-01") }).where(eq(contentVersions.id, version.id));
    await f.db.update(savKnowledgeActivations).set({ activatedAt: new Date("2026-06-03") }).where(eq(savKnowledgeActivations.itemId, item.id));
    if (withReview) await f.db.insert(reviewEvents).values({ itemId: item.id, versionId: version.id, action: "approved", actorEmail: "staff@example.invalid", createdAt: new Date("2026-06-02") });
    const [newer] = await f.db.insert(contentVersions).values({ itemId: item.id, version: 2, bodyMarkdown: "Nouvelle publication non activée", metadata: version.metadata, changeNote: "Fixture", authorEmail: "staff@example.invalid", createdAt: new Date("2026-10-14T10:00:00Z") }).returning();
    await f.db.update(contentItems).set({ publishedVersionId: newer.id }).where(eq(contentItems.id, item.id));
    await f.db.insert(contentChunks).values({ itemId: item.id, versionId: newer.id, ordinal: 0, content: "Nouvelle publication non activée", embedding: vector() });
    const result = await searchSavKnowledgeByRequest({ requests: [{ id: "a", summary: "Version ancienne" }], now });
    expect(result.sources).toEqual([]);
    const [unchanged] = await f.db.select().from(contentItems).where(eq(contentItems.id, item.id));
    expect(unchanged.verifiedAt?.toISOString()).toBe("2026-10-14T12:00:00.000Z");
  });
  it("retries one complete revision when activation changes during the embedding batch", async () => {
    await seed("source test");
    await f.db.insert(knowledgeRevisions).values({ id: "kb-next", actorEmail: "staff@example.invalid" });
    state.embed.mockImplementationOnce(async (queries: string[]) => { await f.db.update(activeKnowledge).set({ revisionId: "kb-next" }).where(eq(activeKnowledge.singleton, true)); return queries.map(vector); });
    const result = await searchSavKnowledgeByRequest({ requests: [{ id: "a", summary: "Source test" }], now });
    expect(result.revision).toBe("kb-next"); expect(state.embed).toHaveBeenCalledTimes(2);
  });
  it("avoids embeddings for an empty catalogue and exposes large cards as unavailable", async () => {
    const empty = await searchSavKnowledgeByRequest({ requests: [{ id: "a", summary: "Source fictive" }], now });
    expect(empty.sources).toEqual([]); expect(state.embed).not.toHaveBeenCalled();
    await seed("source trop grande", { content: "é".repeat(13_000) });
    const large = await searchSavKnowledgeByRequest({ requests: [{ id: "a", summary: "Source trop grande" }], now });
    expect(large.sources).toEqual([]); expect(large.alerts[0].code).toBe("source_budget");
  });
  it.each(["body", "resolution"] as const)("V2 keeps an oversized SQL %s unavailable in search and exact reads", async oversized => {
    const { item, version } = await seed("source hors borne", { content: oversized === "body" ? "x".repeat(512_001) : "Procédure synthétique." });
    if (!("resolution" in version.metadata)) throw Error("Synthetic article required");
    await f.db.update(contentVersions).set({ metadata: { ...version.metadata, resolution: { ...version.metadata.resolution!, steps: [oversized === "resolution" ? "x".repeat(12_001) : "Ouvrir le panneau fictif."] } } }).where(eq(contentVersions.id, version.id));
    const index = createSavKnowledgeVectorIndex({ now, compact: true });
    const search = await index.searchByVectors(["source hors borne"], [vector()], 24);
    const exact = await index.readExact([{ knowledgeId: item.id, contentVersionId: version.id }]);
    for (const card of [search[0][0], ...exact]) {
      expect(card.sourceTooLarge).toBe(true);
      if (oversized === "body") expect(card.content).toBe("");
      else expect(card.resolution).toBeNull();
    }
  });
  it("V2 opt-in preserves a large active version beyond the passage budget; OFF stays identical and invalid cards stay rejected", async () => {
    const body = Array.from({ length: 25 }, (_, i) => `## Présentation ${i}\n${"Documentation synthétique générale. ".repeat(22)}`).join("\n\n")
      + "\n\n## Prérequis\nDisposer du panneau fictif.\n\n## Étapes\nDiagnostic zéphyr : ouvrir le panneau dédié.\n\n## Exceptions\nNe jamais appliquer aux invités.\n\n## Version\nSYN-2026.11";
    const { item, version } = await seed("diagnostic zéphyr", { content: body });
    if (!("resolution" in version.metadata)) throw Error("Synthetic article required");
    await f.db.update(contentVersions).set({ metadata: { ...version.metadata, resolution: { ...version.metadata.resolution!, steps: ["Ouvrir le panneau fictif."], exceptions: ["Ne jamais appliquer aux invités."] } } }).where(eq(contentVersions.id, version.id));
    const queries = ["diagnostic zéphyr", "panneau fictif"], vectors = queries.map(vector);
    const legacy = await createSavKnowledgeVectorIndex({ now }).searchByVectors(queries, vectors, 24);
    expect(await createSavKnowledgeVectorIndex({ now, compact: false }).searchByVectors(queries, vectors, 24)).toEqual(legacy);
    expect(legacy[0][0]).toMatchObject({ content: "", sourceTooLarge: true });
    const index = createSavKnowledgeVectorIndex({ now, compact: true });
    const on = await index.searchByVectors(queries, vectors, 24);
    expect(on[0][0]).toEqual(on[1][0]);
    for (const card of [on[0][0], ...(await index.readExact([{ knowledgeId: item.id, contentVersionId: version.id }]))]) {
      expect(card).toMatchObject({ id: item.id, contentVersionId: version.id, sourceTooLarge: false });
      expect(card.content).toContain("Diagnostic zéphyr");
      expect(card.content).toContain("Disposer du panneau fictif.");
      expect(card.content).toContain("SYN-2026.11");
      expect(JSON.stringify(card)).toContain("Ne jamais appliquer aux invités.");
      // Unknown prose can qualify the procedure: keep the complete source for
      // prompt preflight rather than treating a passage-budget refusal as an
      // oversized source or silently deleting sections to fit 12,000 bytes.
      expect(card.content).toBe(body);
      expect(Buffer.byteLength(JSON.stringify(card))).toBeGreaterThan(12_000);
    }
    await f.db.update(contentItems).set({ aiEnabled: false }).where(eq(contentItems.id, item.id));
    expect((await index.searchByVectors(queries, vectors, 24)).flat()).toEqual([]);
    expect(await index.readExact([{ knowledgeId: item.id, contentVersionId: version.id }])).toEqual([]);
    process.stdout.write(JSON.stringify([{ fixture: "db-large-card", beforeBytes: Buffer.byteLength(body), afterBytes: Buffer.byteLength(on[0][0].content), sourceReadBound: 512_000 }]) + "\n");
  });

});
