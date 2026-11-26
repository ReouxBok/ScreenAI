import { retrieveSavKnowledgeByRequest, type SavRetrievalBackend, type SavRetrievalCandidate } from "../request-retrieval";
import { createCaseBudgetedRetrieval, type CaseBudgetedRetrievalDeps } from "./investigation-budgeted-retrieval";
import type { CaseInvestigationModelRequest } from "./investigation-runner";
import { smartRetrievalCodes, smartRetrievalRequests, smartSourcesOf } from "./smart/smart-knowledge";
import type { SmartLiveSearch } from "./smart/smart-live-search";

/*
 * Live search (26/11): the circuit side of `chercher_fiches` in production. Kept OUT of `smart/`: it reaches the runner and the call ledger,
 * which the smart entry points (shadow, bench, self-test) must never import (`smart-imports.test.ts`). Wired by the V2 factory only.
 */

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
