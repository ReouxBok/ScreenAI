import { createSavKnowledgeVectorIndex, SAV_RETRIEVAL_EMBEDDING_DIMENSION } from "../../request-retrieval-db";
import { retrieveSavKnowledgeByRequest, savCustomerProcedureSteps, savRetrievalCardSizeFixOn, type SavRetrievalBackend, type SavRequestRetrievalResult } from "../../request-retrieval";
import type { SmartKnowledgePort, SmartKnowledgeResult } from "./smart-agent";
import type { SmartSource } from "./smart-checks";
import type { SmartEmbedPort } from "./smart-model";

/*
 * Agent SAV intelligent, lot C (20/11): the knowledge of one turn through the EXISTING search, unchanged (`retrieveSavKnowledgeByRequest` and the
 * SAV vector index `createSavKnowledgeVectorIndex`): the SAV cards currently admissible (SAV articles, published, AI enabled, indexed, French,
 * support audience, checked within 90 days, valid, not expired), at most 39 today, 3 needs, 3 cards per need, 6 in all. The only difference is
 * who pays the query embedding: the shadow's own ledger (`embed` port), never V2's budget. No theme filter yet (lot C of the plan, later).
 */

/** The search requests of a reading: each need's search words (its ask when it has none), bounded like V1's. */
export function smartRetrievalRequests(needs: Parameters<SmartKnowledgePort>[0]) {
  return needs.map(need => ({ id: need.id, summary: (need.search?.trim() || need.ask.trim()).slice(0, 600) })).filter(request => request.summary.length >= 3);
}

/** The cards of a retrieval result, with the needs each one was found for (a card of need A never supports need B). */
export function smartSourcesOf(result: SavRequestRetrievalResult): SmartSource[] {
  return result.sources.map(source => ({
    cardId: source.id, version: source.contentVersionId, title: source.title, content: source.content,
    // SAV_RETRIEVAL_CARD_SIZE_FIX on: a procedure card's customer steps, as the V1 planner reads them (never an internal step).
    steps: (savRetrievalCardSizeFixOn() ? savCustomerProcedureSteps(source.resolution) : null)
      ?? (Array.isArray(source.resolution?.steps) ? (source.resolution!.steps as unknown[]).filter((step): step is string => typeof step === "string") : []),
    needIds: [...source.requestIds],
    validUntil: typeof source.resolution?.validUntil === "string" && source.resolution.validUntil ? source.resolution.validUntil : null,
  }));
}

/** Closed codes of a retrieval result (statuses per need, then validity alerts), never a card's text. */
export function smartRetrievalCodes(result: SavRequestRetrievalResult): string[] {
  return [...new Set([...result.requests.map(row => `${row.requestId}:${row.status}`), ...result.requests.flatMap(row => row.limitations),
    ...result.alerts.map(alert => alert.code)])].slice(0, 30);
}

/** The production port: the existing index and search, the query embedding through `embed` (the shadow's ledger). */
export function smartDbKnowledge(deps: Readonly<{ now: () => Date; embed: SmartEmbedPort }>): SmartKnowledgePort {
  return async needs => {
    const requests = smartRetrievalRequests(needs);
    if (!requests.length) return { status: "ok", sources: [], codes: ["no_searchable_need"] } satisfies SmartKnowledgeResult;
    const now = deps.now(), index = createSavKnowledgeVectorIndex({ locale: "fr-FR", audience: "support", now, compact: true });
    const backend: SavRetrievalBackend = {
      readRevision: () => index.readRevision(),
      async search(queries, limit) {
        if (!queries.length) return [];
        if (!(await index.available())) return queries.map(() => []);
        const embedded = await deps.embed(queries);
        if (embedded.status !== "ok") throw Error(`SMART_EMBED_${embedded.problem}`);
        if (embedded.vectors.some(vector => vector.length !== SAV_RETRIEVAL_EMBEDDING_DIMENSION)) throw Error("SMART_EMBED_INVALID");
        return index.searchByVectors(queries, embedded.vectors, limit);
      },
    };
    try {
      const result = await retrieveSavKnowledgeByRequest({ requests, locale: "fr-FR", audience: "support", now }, backend);
      return { status: result.revision === null ? "unavailable" : "ok", sources: smartSourcesOf(result), codes: smartRetrievalCodes(result) };
    } catch {
      return { status: "unavailable", sources: [], codes: ["search_failed"] };
    }
  };
}
