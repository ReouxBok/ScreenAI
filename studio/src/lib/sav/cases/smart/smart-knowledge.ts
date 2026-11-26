import { createSavKnowledgeVectorIndex, SAV_RETRIEVAL_EMBEDDING_DIMENSION } from "../../request-retrieval-db";
import { retrieveSavKnowledgeByRequest, savCustomerProcedureSteps, savRetrievalCardSizeFixOn, type SavRetrievalBackend, type SavRetrievalCandidate, type SavRequestRetrievalResult } from "../../request-retrieval";
import { createCaseBudgetedRetrieval, type CaseBudgetedRetrievalDeps } from "../investigation-budgeted-retrieval";
import type { CaseInvestigationModelRequest } from "../investigation-runner";
import type { SmartKnowledgePort, SmartKnowledgeResult } from "./smart-agent";
import type { SmartSource } from "./smart-checks";
import type { SmartLiveSearch } from "./smart-live-search";
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

/**
 * Live search (26/11): `chercher_fiches` in production (`SAV_V2_SMART_LIVE_SEARCH=on`, smart-live-search.ts): the same engine on the circuit's budgeted search
 * of one case input (V2 index, V2 embedding budget, the input's call ledger). One budgeted retrieval per turn: a stop is final for it.
 */
export function smartCaseLiveSearch(deps: Omit<CaseBudgetedRetrievalDeps, "snapshot" | "inputKey"> & Readonly<{ scope: Readonly<{ locale: string; audience: "support" | "lead" }>; now: () => Date }>) {
  return (request: Pick<CaseInvestigationModelRequest, "snapshot" | "inputKey">): SmartLiveSearch => {
    const retrieval = createCaseBudgetedRetrieval({ ...deps, snapshot: request.snapshot, inputKey: request.inputKey });
    return async needs => {
      const requests = smartRetrievalRequests(needs);
      if (!requests.length) return { status: "ok", sources: [], cards: [], codes: ["no_searchable_need"] };
      // The original cards, as the circuit keeps them (`selectCaseKnowledge`): the proposal is built on them, never on a copy.
      const returned = new Map<string, SavRetrievalCandidate>();
      const capturing: SavRetrievalBackend = {
        readRevision: () => retrieval.backend.readRevision(),
        search: async (queries, limit) => {
          const batches = await retrieval.backend.search(queries, limit);
          for (const batch of batches ?? []) for (const card of batch) returned.set(`${card.id}:${card.contentVersionId}`, card);
          return batches;
        },
      };
      try {
        const result = await retrieveSavKnowledgeByRequest({ requests, locale: deps.scope.locale, audience: deps.scope.audience, now: deps.now() }, capturing);
        const stopped = retrieval.stop();
        if (stopped) return { status: "unavailable", sources: [], cards: [], codes: [`live_${stopped.reason}`] };
        const sources = smartSourcesOf(result);
        return { status: result.revision === null ? "unavailable" : "ok", sources, codes: smartRetrievalCodes(result),
          cards: sources.flatMap(source => { const card = returned.get(`${source.cardId}:${source.version}`); return card ? [card] : []; }) };
      } catch {
        const stopped = retrieval.stop();
        return { status: "unavailable", sources: [], cards: [], codes: [stopped ? `live_${stopped.reason}` : "live_search_failed"] };
      }
    };
  };
}
