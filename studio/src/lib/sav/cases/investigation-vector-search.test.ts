import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createSavTestDb } from "../../../../test/sav-db";
import { activeKnowledge, contentChunks, contentItems, contentVersions, knowledgeRevisions, savKnowledgeActivations } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown, embed: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
// The V1 embedding wrapper: counted, and only the V1 backend may reach it. No SDK is loaded.
vi.mock("@/lib/embeddings", () => ({ embedTexts: state.embed }));
import { createSavKnowledgeVectorIndex, createSavRequestRetrievalBackend, SAV_RETRIEVAL_EMBEDDING_DIMENSION } from "../request-retrieval-db";
import type { CaseRequestSubject, CaseSnapshot } from "./case-types";
import { caseBudgetedKnowledge, SAV_CASE_KNOWLEDGE_MAX_DIMENSION, type CaseEmbeddingSpendPort } from "./investigation-budgeted-retrieval";
import type { CaseCallLedgerPort } from "./investigation-call-ledger";
import { caseKnowledgeVectorSearchOnDb } from "./investigation-vector-search";

/*
 * Night 31/10, lot 2: the SAV knowledge index without embedding. The V1 backend is now a wrapper over it: same SQL and
 * parameters, same results, same embedding call. V2 searches it with the vectors its budgeted search paid for, and the
 * V1 embedding wrapper is never reached. Synthetic cards on an isolated database; no key, no SDK, fetch throws.
 */

const now = new Date("2026-10-15T12:00:00Z"), DIM = SAV_RETRIEVAL_EMBEDDING_DIMENSION, INPUT = "in:20000000-0000-4000-8000-000000000001";
const unit = (axis: number) => Array.from({ length: DIM }, (_, index) => index === axis ? 1 : 0);
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const executed: SQL[] = [];
const dialect = new PgDialect();
const recorded = () => executed.map(query => dialect.sqlToQuery(query));

async function seed(slug: string, options: { active?: boolean; published?: boolean; locale?: string; audience?: string; verifiedAt?: Date; aiEnabled?: boolean; content?: string; axis?: number } = {}) {
  const [item] = await f.db.insert(contentItems).values({ slug, type: "article", title: slug, ownerEmail: "staff@example.invalid", status: "published", agentKey: "sav", aiEnabled: options.aiEnabled ?? true,
    locale: options.locale ?? "fr-FR", verifiedAt: options.verifiedAt ?? new Date("2026-10-14T12:00:00Z") }).returning();
  const body = options.content ?? `Procédure synthétique ${slug} : ouvrir le diagnostic de test.`;
  const [version] = await f.db.insert(contentVersions).values({ itemId: item!.id, version: 1, bodyMarkdown: body,
    metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "Résultat fictif", troubleshooting: "", resolution: { audience: (options.audience ?? "support") as "support", symptoms: [slug], steps: [body], exceptions: [], escalation: "Revue humaine", productVersion: "test", supersedes: [], conflictsWith: [] } },
    changeNote: "Fixture isolée", authorEmail: "staff@example.invalid" }).returning();
  if (options.published !== false) await f.db.update(contentItems).set({ publishedVersionId: version!.id }).where(eq(contentItems.id, item!.id));
  if (options.active !== false) await f.db.insert(savKnowledgeActivations).values({ itemId: item!.id, versionId: version!.id, title: slug, activatedBy: "fixture" });
  await f.db.insert(contentChunks).values({ itemId: item!.id, versionId: version!.id, ordinal: 0, content: body, embedding: unit(options.axis ?? 0) });
  return { item: item!, version: version! };
}

beforeAll(async () => {
  f = await createSavTestDb();
  // Every statement the index sends is recorded, to compare the two paths byte for byte.
  state.db = new Proxy(f.db, { get: (target, prop, receiver) => prop === "execute" ? (query: SQL) => { executed.push(query); return target.execute(query); } : Reflect.get(target, prop, receiver) });
}, 30_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); }));
  await f.client.exec("TRUNCATE content_items, active_knowledge, knowledge_revisions CASCADE");
  await f.db.insert(knowledgeRevisions).values({ id: "kb-initial", actorEmail: "staff@example.invalid" });
  await f.db.insert(activeKnowledge).values({ singleton: true, revisionId: "kb-initial" });
  executed.length = 0;
  state.embed.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("SAV knowledge index without embedding: the V1 backend wraps it unchanged", () => {
  it("same statements, same parameters, same cards: the V1 backend with its embedding wrapper, and the index given the same vectors", async () => {
    await seed("connecteur alpha", { axis: 0 }); await seed("téléphone beta", { axis: 1 });
    await seed("inactive", { active: false }); await seed("lead", { audience: "lead" }); await seed("stale", { verifiedAt: new Date("2026-01-01") }); await seed("en", { locale: "en-US" });
    await seed("trop grande", { content: "é".repeat(13_000), axis: 2 });
    const queries = ["Connecteur alpha en erreur", "Téléphone beta ne répond plus", "Source trop grande"], vectors = [unit(0), unit(1), unit(2)];
    state.embed.mockImplementation(async () => vectors);
    const v1 = await createSavRequestRetrievalBackend({ now }).search(queries, 24);
    const v1Statements = recorded();
    expect(state.embed.mock.calls).toEqual([[queries, "RETRIEVAL_QUERY", { scope: "sav" }]]);
    executed.length = 0;
    const index = createSavKnowledgeVectorIndex({ now });
    expect(await index.available()).toBe(true);
    const v2 = await index.searchByVectors(queries, vectors, 24);
    expect(recorded()).toEqual(v1Statements);
    expect(v2).toEqual(v1);
    expect(v2.map(batch => batch.map(card => card.title))).toEqual([expect.arrayContaining(["connecteur alpha"]), expect.arrayContaining(["téléphone beta"]), expect.arrayContaining(["trop grande"])]);
    expect(v2.flat().map(card => card.title)).not.toEqual(expect.arrayContaining(["inactive"]));
    expect(v2.flat().find(card => card.title === "trop grande")).toMatchObject({ sourceTooLarge: true, content: "" });
    expect(state.embed).toHaveBeenCalledTimes(1);
  });

  it("the budgeted search's vector-size bound is the index's", () => {
    expect(SAV_CASE_KNOWLEDGE_MAX_DIMENSION).toBe(SAV_RETRIEVAL_EMBEDDING_DIMENSION);
  });

  it("revision and availability read the same rows; an empty catalogue answers unavailable without any embedding", async () => {
    const index = createSavKnowledgeVectorIndex({ now });
    expect(await index.readRevision()).toBe("kb-initial");
    expect(await index.available()).toBe(false);
    expect(await createSavRequestRetrievalBackend({ now }).search(["Source fictive"], 24)).toEqual([[]]);
    expect(state.embed).not.toHaveBeenCalled();
    await seed("autre langue", { locale: "en-US" });
    expect(await index.available()).toBe(false);
  });

  it.each([
    ["four queries", ["a", "b", "c", "d"], [unit(0), unit(0), unit(0), unit(0)], 24, "SAV_RETRIEVAL_DB_BUDGET"],
    ["a limit above the budget", ["a"], [unit(0)], 25, "SAV_RETRIEVAL_DB_BUDGET"],
    ["a fractional limit", ["a"], [unit(0)], 1.5, "SAV_RETRIEVAL_DB_BUDGET"],
    ["fewer vectors than queries", ["a", "b"], [unit(0)], 24, "SAV_RETRIEVAL_EMBEDDING_INVALID"],
    ["a short vector", ["a"], [[1, 0, 0]], 24, "SAV_RETRIEVAL_EMBEDDING_INVALID"],
    ["a non-finite value", ["a"], [[Number.NaN, ...unit(0).slice(1)]], 24, "SAV_RETRIEVAL_EMBEDDING_INVALID"],
  ])("the index refuses %s before any statement", async (_name, queries, vectors, limit, error) => {
    await expect(createSavKnowledgeVectorIndex({ now }).searchByVectors(queries, vectors, limit)).rejects.toThrow(error);
    expect(executed).toEqual([]);
  });

  it("the V1 backend keeps its own checks and order: budget first, no statement and no embedding for no query, an invalid embedding refused", async () => {
    const backend = createSavRequestRetrievalBackend({ now });
    await expect(backend.search(["a", "b", "c", "d"], 24)).rejects.toThrow("SAV_RETRIEVAL_DB_BUDGET");
    expect(await backend.search([], 24)).toEqual([]);
    expect(executed).toEqual([]);
    await seed("source test");
    state.embed.mockImplementation(async (texts: string[]) => texts.map(() => [1, 2, 3]));
    await expect(backend.search(["Source test"], 24)).rejects.toThrow("SAV_RETRIEVAL_EMBEDDING_INVALID");
  });
});

describe("V2 budgeted search on the index: the paid vectors are searched, the V1 embedding wrapper is never reached", () => {
  const subject = (text: string): CaseRequestSubject => ({ status: "available", text, provenance: { source: "v1_accepted_analysis", field: "ticketSummary",
    runId: "30000000-0000-4000-8000-000000000001", runVersion: 1, resultHash: "result-hash", validatorRevision: "validator-r1", acceptedAt: "2026-10-15T08:59:00Z" } });
  const snapshot = { caseId: "10000000-0000-4000-8000-000000000001", version: 4, owner: "agent",
    body: { openRequests: [{ id: "r1", summary: "Demande relevée.", family: "access", status: "open", openedAt: "2026-10-15T09:00:00Z", subject: subject("Connecteur alpha en erreur") },
      { id: "r2", summary: "Demande relevée.", family: "usage", status: "open", openedAt: "2026-10-15T09:00:00Z", subject: subject("Export gamma impossible") }] } } as unknown as CaseSnapshot;
  function ports(options: { usage?: { inputTokens?: number } | null } = {}) {
    const log: string[] = [], settled: unknown[] = [], embedded: string[][] = [];
    const ledger: CaseCallLedgerPort = {
      reserve: async input => { log.push(`reserve:${input.purpose}`); return { status: "reserved", token: "t1", leaseUntil: now.toISOString() }; },
      markDispatched: async () => { log.push("dispatched"); }, settle: async input => { log.push(`settle:${input.result.status}`); }, release: async () => { log.push("release"); },
    };
    const spend: CaseEmbeddingSpendPort = { reserve: async () => { log.push("spend"); return { status: "allowed", reservationId: "res-1" }; }, settle: async input => { settled.push(input); }, release: async () => undefined };
    const knowledge = caseBudgetedKnowledge({
      holder: "sav-v2-investigation", leaseSeconds: 60, scope: { locale: "fr-FR", audience: "support" }, now: () => now, ledger, spend,
      vectors: caseKnowledgeVectorSearchOnDb({ locale: "fr-FR", audience: "support", now }),
      // SYN transport: the alpha axis for the first query, an unused axis for the second. Never a key or the network.
      embed: async ({ texts }) => { embedded.push([...texts]); return { vectors: texts.map((_, index) => unit(index === 0 ? 0 : 9)), usage: options.usage ?? null }; },
      pauseState: async () => "running", readTicketOwner: async () => "v2", readCase: async () => ({ snapshot, events: [] }),
    });
    return { knowledge, log, settled, embedded };
  }

  it("one paid batch, then the index: each request is linked to the active card and version the index returns", async () => {
    const alpha = await seed("connecteur alpha", { axis: 0 });
    const p = ports({ usage: { inputTokens: 9 } });
    const read = await p.knowledge(snapshot, { inputKey: INPUT });
    // As in V1, the index has no relevance floor: its semantic half returns the nearest active cards even when far
    // (r2's vector is orthogonal). Coverage says a valid card was found, not that it fits; that is the model's and the
    // validator's. Recorded in LOT2_REPORT as an observation, not changed here.
    const ref = { knowledgeId: alpha.item.id, contentVersionId: alpha.version.id };
    expect(read).toMatchObject({ status: "ready", selection: { revision: "kb-initial", coverage: [
      { requestId: "r1", status: "covered", knowledge: [ref] }, { requestId: "r2", status: "covered", knowledge: [ref] }] } });
    expect(p.embedded).toEqual([["Connecteur alpha en erreur", "Export gamma impossible"]]);
    expect(p.log).toEqual(["reserve:knowledge_embedding", "spend", "dispatched", "settle:ok"]);
    expect(p.settled).toEqual([{ reservationId: "res-1", usage: { inputTokens: 9 }, uncertain: false }]);
    expect(state.embed).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("an empty catalogue: no reservation, no paid batch, no V1 embedding", async () => {
    const p = ports();
    expect(await p.knowledge(snapshot, { inputKey: INPUT })).toMatchObject({ status: "ready", selection: { coverage: [{ status: "no_applicable_knowledge" }, { status: "no_applicable_knowledge" }] } });
    expect({ log: p.log, embedded: p.embedded.length, v1: state.embed.mock.calls.length }).toEqual({ log: [], embedded: 0, v1: 0 });
  });

  it("a card too large to be read whole: the request is not searched, not « no applicable knowledge »", async () => {
    await seed("connecteur alpha", { axis: 0, content: "é".repeat(13_000) });
    const read = await ports().knowledge(snapshot, { inputKey: INPUT });
    expect(read).toMatchObject({ status: "ready", selection: { cards: [], coverage: [{ requestId: "r1", status: "not_searched", limitations: expect.arrayContaining(["knowledge_source_incomplete"]) }, { requestId: "r2" }] } });
  });
});

describe("scope-first knowledge (11/11): the exact read of a scope source, without any embedding", () => {
  it("the active exact version is read with the search's fields; another version, an inactive card or a non-id is absent", async () => {
    const alpha = await seed("connecteur alpha", { axis: 0 }), inactive = await seed("inactive", { active: false }), stale = await seed("stale", { verifiedAt: new Date("2026-01-01") });
    // A second, never activated version of the same card: never read in place of the active one.
    const [draft] = await f.db.insert(contentVersions).values({ itemId: alpha.item.id, version: 2, bodyMarkdown: "Brouillon synthétique", metadata: alpha.version.metadata,
      changeNote: "Fixture isolée", authorEmail: "staff@example.invalid" }).returning();
    const index = createSavKnowledgeVectorIndex({ now });
    const read = await index.readExact([{ knowledgeId: alpha.item.id, contentVersionId: alpha.version.id }, { knowledgeId: alpha.item.id, contentVersionId: draft!.id },
      { knowledgeId: inactive.item.id, contentVersionId: inactive.version.id }, { knowledgeId: stale.item.id, contentVersionId: stale.version.id }, { knowledgeId: "not-a-uuid", contentVersionId: "x" }]);
    expect(read.map(card => [card.id, card.contentVersionId])).toEqual([[alpha.item.id, alpha.version.id]]);
    const searched = (await index.searchByVectors(["Connecteur alpha"], [unit(0)], 24))[0]!.find(card => card.id === alpha.item.id)!;
    expect(read[0]).toEqual({ ...searched, semanticScore: null });
    expect(await index.readExact([])).toEqual([]);
    await expect(index.readExact(Array.from({ length: 201 }, () => ({ knowledgeId: alpha.item.id, contentVersionId: alpha.version.id })))).rejects.toThrow("SAV_RETRIEVAL_DB_BUDGET");
    expect(state.embed).not.toHaveBeenCalled();
  });
});
