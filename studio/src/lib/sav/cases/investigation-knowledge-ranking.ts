import { assessSavKnowledgeValidity, savRetrievalRanking, type SavRetrievalCandidate } from "../request-retrieval";
import { SAV_CASE_ACCESS_BLOCK_ID, type KnowledgeRef } from "./case-types";
import type { CaseKnowledgeCoverage } from "./decision-contract";
import type { CaseBlockScope } from "./investigation-access-scope";

/*
 * Scope-first, ranked knowledge (11/11), filtered by relevance (K3, 12/11). On a pilot block (Access or another block with its approved
 * scope), the block's scope cards go to the model FIRST, but only when they are relevant to one of the block's requests: a scope card the
 * search scored at or above the absolute floor for such a request (among the cards it selected or the candidates it returned), or one the
 * search selected without a usable score. The block's template card (`use: "answer"` with a `firstReply`) is always kept; when the search
 * did not return it, it is read at its exact approved version (active, valid now, never a stale version). The other retrieved cards follow,
 * ranked, only when they are relevant to a request: never below the absolute floor (not even a request's first card); above it, the first
 * card of each request, any card without a usable score, and any card in the upper half of the gap between the request's typical
 * candidate (median of the candidates the vector search returned) and its best card. Scope cards are linked to the requests of their BLOCK
 * (not of their family). Over the input bound, out-of-scope cards go first, then the scope cards from the least relevant; never the template.
 * Reading is not support: an automated reply may still cite only the block's `answer` cards at their exact version (decision-validator).
 * Pure: no model, embedding, network, database or clock of its own. A case without a block scope never comes here (unchanged).
 */

export type CaseKnowledgeRelevanceVerdict = "top" | "relevant" | "low" | "unscored" | "below_floor";
/** One (request, card) pair the search selected: its rank within the request (0 = the request's best) and its verdict. */
export type CaseKnowledgeRelevance = KnowledgeRef & { requestId: string; rank: number; verdict: CaseKnowledgeRelevanceVerdict };
export type CaseKnowledgeDropCode = "low_relevance" | "below_floor" | "input_budget";
export type CaseKnowledgeDrop = KnowledgeRef & { code: CaseKnowledgeDropCode };
/** A valid candidate the vector search returned for one request's query (selected or not), with its own score. */
export type CaseKnowledgePoolEntry = Readonly<{ requestId: string; card: SavRetrievalCandidate }>;
/** Why a scope card was not read: below the absolute floor for every request of its block, or never returned by the search for one. */
export type CaseScopeLeftOut = KnowledgeRef & { code: "below_floor" | "not_retrieved" };

/**
 * K3: the absolute floor of relevance, on the vector search's own cosine score (`semanticScore`) of a card for a request's query. Below it a
 * card is never read, whatever its rank. Provisional value: the 11/11 off-topic integration cards scored about 0.6 and the login card 0.8 in
 * the synthetic replay; the evaluation set (K6) calibrates it before any widening. A card without a score is not judged by the floor.
 */
export const SAV_CASE_RELEVANCE_SEMANTIC_FLOOR = 0.65;
/** Fewer scored, valid candidates than this for a request: no population to judge against, every card is kept (`unscored`). */
export const SAV_CASE_RELEVANCE_MIN_POPULATION = 5;
/** Where the threshold sits between the median candidate (0) and the request's best card (1). */
export const SAV_CASE_RELEVANCE_GAP_SHARE = 0.5;

const keyOf = (ref: KnowledgeRef) => `${ref.knowledgeId}:${ref.contentVersionId}`;
const cardKey = (card: SavRetrievalCandidate) => `${card.id}:${card.contentVersionId}`;
const refOf = (card: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: card.id, contentVersionId: card.contentVersionId });
const scored = (card: SavRetrievalCandidate) => card.semanticScore !== null && Number.isFinite(card.semanticScore);
const belowFloor = (card: SavRetrievalCandidate) => scored(card) && card.semanticScore! < SAV_CASE_RELEVANCE_SEMANTIC_FLOOR;
const isTemplate = (source: CaseBlockScope["sources"][number]) => source.use === "answer" && source.firstReply !== undefined;
const scopeBlockOf = (scope: CaseBlockScope) => "blockId" in scope ? scope.blockId : SAV_CASE_ACCESS_BLOCK_ID;
/** Without the case's admission at hand, only the family `access` names a block (Access); another request has none, so nothing is linked to it. */
export const caseCoverageFamilyBlock = (row: Pick<CaseKnowledgeCoverage, "family">) => row.family === "access" ? SAV_CASE_ACCESS_BLOCK_ID : null;

/**
 * Verdicts for the cards selected for one request, in their retrieval order, judged with the retrieval's own ranking (`savRetrievalRanking`,
 * same query) against the candidates the vector search returned for that query. Below the absolute floor, `below_floor` whatever the rank;
 * otherwise the request's first card is always `top`.
 */
export function caseRequestCardRelevance(query: string, selected: readonly SavRetrievalCandidate[], population: readonly SavRetrievalCandidate[],
  context: Readonly<{ locale: string; audience: string; now: Date }>): CaseKnowledgeRelevanceVerdict[] {
  const pool = [...new Map(population.filter(card => scored(card) && assessSavKnowledgeValidity(card, context.locale, context.audience, context.now).eligible)
    .map(card => [cardKey(card), savRetrievalRanking(query, card).rankingScore])).values()].sort((a, b) => a - b);
  const top = selected[0];
  const best = top && scored(top) ? savRetrievalRanking(query, top).rankingScore : null;
  const middle = pool.length >> 1, median = pool.length % 2 ? pool[middle]! : ((pool[middle - 1] ?? 0) + (pool[middle] ?? 0)) / 2;
  const judged = best !== null && pool.length >= SAV_CASE_RELEVANCE_MIN_POPULATION && best > median;
  const threshold = judged ? median + (best - median) * SAV_CASE_RELEVANCE_GAP_SHARE : null;
  return selected.map((card, rank) => {
    if (belowFloor(card)) return "below_floor";
    if (rank === 0) return "top";
    if (threshold === null || !scored(card)) return "unscored";
    return savRetrievalRanking(query, card).rankingScore >= threshold ? "relevant" : "low";
  });
}

export type CaseScopedKnowledge = Readonly<{
  /** Kept scope cards first (template first, then most relevant first), then the kept out-of-scope cards, best first. */
  knowledge: SavRetrievalCandidate[];
  /** What the model and the validator read: dropped cards unlinked, kept scope cards linked to the block's searched requests. */
  coverage: CaseKnowledgeCoverage[];
  /** The kept scope cards (`templateKeys` among them): what a budget trims last. */
  scopeKeys: ReadonlySet<string>;
  /** The block's template cards: never dropped. */
  templateKeys: ReadonlySet<string>;
  /** Cards the search had selected for a request and that are not read (relevance or budget). */
  dropped: CaseKnowledgeDrop[];
  /** Scope cards the search had not selected for a request and that are not read (below the floor, or never returned). Ids and codes only. */
  scopeLeftOut: CaseScopeLeftOut[];
  /** Scope cards linked to a request the search had not linked them to (fetched, or retrieved for another request). */
  added: Array<KnowledgeRef & { requestId: string }>;
  /** Template sources neither retrieved nor readable at their exact, active, valid version: not sent. */
  unavailable: KnowledgeRef[];
  /** Per request: the refs linked before any drop, for the record's limitation codes. */
  linkedBefore: ReadonlyMap<string, ReadonlySet<string>>;
}>;

/**
 * Scope first when relevant, then ranked relevance (K3). `fetched`: template cards read at their exact version (already checked active and
 * valid by the caller). `pool`: the valid candidates the search returned per request (their scores judge a scope card it did not select).
 * `blockOf`: the block of a request (`caseRequestBlockId`); by default only an `access` request has one. An out-of-scope card is dropped as
 * `below_floor` when every verdict it has is `below_floor`, and as `low_relevance` when every verdict is `low` (or below the floor) and it is
 * not the last card of any request. A request left without any card by the floor alone is `no_applicable_knowledge` (nothing relevant found).
 */
export function arrangeCaseScopedKnowledge(input: Readonly<{
  cards: readonly SavRetrievalCandidate[]; coverage: readonly CaseKnowledgeCoverage[]; relevance: readonly CaseKnowledgeRelevance[];
  scope: CaseBlockScope; fetched: readonly SavRetrievalCandidate[]; pool?: readonly CaseKnowledgePoolEntry[];
  blockOf?: (row: CaseKnowledgeCoverage) => string | null;
}>): CaseScopedKnowledge {
  const blockOf = input.blockOf ?? caseCoverageFamilyBlock, scopeBlock = scopeBlockOf(input.scope), pool = input.pool ?? [];
  const blockRows = input.coverage.filter(row => blockOf(row) === scopeBlock);
  const blockRequests = new Set(blockRows.map(row => row.requestId));
  const byKey = new Map(input.cards.map(card => [cardKey(card), card]));
  const verdicts = (key: string) => input.relevance.filter(row => keyOf(row) === key);
  const scopeCards: Array<{ card: SavRetrievalCandidate; template: boolean; score: number }> = [], unavailable: KnowledgeRef[] = [];
  const scopeLeftOut: CaseScopeLeftOut[] = [];
  for (const source of input.scope.sources) {
    const key = keyOf(source), ref = { knowledgeId: source.knowledgeId, contentVersionId: source.contentVersionId };
    const inPool = pool.filter(entry => cardKey(entry.card) === key);
    const card = byKey.get(key) ?? inPool[0]?.card
      ?? (isTemplate(source) ? input.fetched.find(other => cardKey(other) === key && !input.cards.some(found => found.id === other.id)) : undefined);
    // Its relevance for the block's own requests: the scores the search gave it there (selected or merely returned).
    const selectedFor = verdicts(key).filter(row => blockRequests.has(row.requestId));
    const scores = [...(selectedFor.length && byKey.has(key) ? [byKey.get(key)!] : []), ...inPool.filter(entry => blockRequests.has(entry.requestId)).map(entry => entry.card)]
      .filter(scored).map(found => found.semanticScore!);
    const best = scores.length ? Math.max(...scores) : null;
    if (isTemplate(source)) {
      if (card) scopeCards.push({ card, template: true, score: best ?? Number.POSITIVE_INFINITY }); else unavailable.push(ref);
      continue;
    }
    const relevant = best !== null ? best >= SAV_CASE_RELEVANCE_SEMANTIC_FLOOR : selectedFor.some(row => row.verdict !== "below_floor");
    if (card && relevant) { scopeCards.push({ card, template: false, score: best ?? SAV_CASE_RELEVANCE_SEMANTIC_FLOOR }); continue; }
    // Selected by the search but not relevant to its block: judged like any other card below (it may still be read for another request).
    if (!byKey.has(key)) scopeLeftOut.push({ ...ref, code: best !== null ? "below_floor" : "not_retrieved" });
  }
  scopeCards.sort((a, b) => Number(b.template) - Number(a.template) || b.score - a.score);
  const scopeKeys = new Set(scopeCards.map(row => cardKey(row.card)));
  const templateKeys = new Set(scopeCards.filter(row => row.template).map(row => cardKey(row.card)));
  const linkedBefore = new Map(input.coverage.map(row => [row.requestId, new Set(row.knowledge.map(keyOf))]));
  const outOfScope = input.cards.filter(card => !scopeKeys.has(cardKey(card)));
  const belowOnly = new Set(outOfScope.filter(card => {
    const rows = verdicts(cardKey(card));
    return rows.length > 0 && rows.every(row => row.verdict === "below_floor");
  }).map(cardKey));
  const lowOnly = new Set(outOfScope.filter(card => !belowOnly.has(cardKey(card))).filter(card => {
    const rows = verdicts(cardKey(card));
    return rows.length > 0 && rows.every(row => row.verdict === "low" || row.verdict === "below_floor");
  }).map(cardKey));
  const gone = (key: string) => lowOnly.has(key) || belowOnly.has(key);
  // Invariant: a request never loses its last card to RELATIVE relevance (its first card above the floor is always `top`); the floor may empty it.
  for (const row of input.coverage) {
    const left = row.knowledge.filter(ref => !gone(keyOf(ref)));
    if (!left.length) for (const ref of row.knowledge) lowOnly.delete(keyOf(ref));
  }
  const rankOf = (card: SavRetrievalCandidate) => Math.min(...verdicts(cardKey(card)).map(row => row.rank), Number.MAX_SAFE_INTEGER);
  const others = input.cards.map((card, index) => ({ card, index })).filter(({ card }) => !scopeKeys.has(cardKey(card)) && !gone(cardKey(card)))
    .sort((a, b) => rankOf(a.card) - rankOf(b.card) || a.index - b.index).map(({ card }) => card);
  const dropped: CaseKnowledgeDrop[] = input.cards.filter(card => gone(cardKey(card))).map(card => ({ ...refOf(card),
    code: belowOnly.has(cardKey(card)) ? "below_floor" as const : "low_relevance" as const }));
  const added: CaseScopedKnowledge["added"] = [];
  const coverage = input.coverage.map((row): CaseKnowledgeCoverage => {
    const knowledge = row.knowledge.filter(ref => !gone(keyOf(ref)));
    // The kept scope cards support the BLOCK's searched requests: linked, so that the model may cite them for those requests.
    if (blockRequests.has(row.requestId) && row.status !== "not_searched") for (const { card } of scopeCards) {
      if (knowledge.some(ref => keyOf(ref) === cardKey(card))) continue;
      knowledge.push(refOf(card));
      added.push({ ...refOf(card), requestId: row.requestId });
    }
    const emptiedByFloor = !knowledge.length && row.status === "covered" && row.knowledge.length > 0;
    return { ...row, status: knowledge.length ? "covered" : emptiedByFloor ? "no_applicable_knowledge" : row.status, knowledge, limitations: [...row.limitations] };
  });
  return { knowledge: [...scopeCards.map(row => row.card), ...others], coverage, scopeKeys, templateKeys, dropped, scopeLeftOut, added, unavailable, linkedBefore };
}

/**
 * Over the input bound: the lowest-ranked out-of-scope card is dropped, again and again, then the least relevant scope card, until `fits`
 * or only the template is left; a template card is never dropped. A request left without any card is `not_searched` with the retrieval's
 * existing `source_context_budget` limitation.
 */
export function trimCaseScopedKnowledge(scoped: CaseScopedKnowledge, fits: (knowledge: SavRetrievalCandidate[], coverage: CaseKnowledgeCoverage[]) => boolean): CaseScopedKnowledge {
  let knowledge = scoped.knowledge, coverage = scoped.coverage;
  const dropped = [...scoped.dropped];
  while (!fits(knowledge, coverage)) {
    const reversed = [...knowledge].reverse();
    const last = reversed.find(card => !scoped.scopeKeys.has(cardKey(card))) ?? reversed.find(card => !scoped.templateKeys.has(cardKey(card)));
    if (!last) break;
    const key = cardKey(last);
    knowledge = knowledge.filter(card => cardKey(card) !== key);
    coverage = coverage.map(row => {
      if (!row.knowledge.some(ref => keyOf(ref) === key)) return row;
      const left = row.knowledge.filter(ref => keyOf(ref) !== key);
      return left.length ? { ...row, knowledge: left }
        : { ...row, status: "not_searched", knowledge: left, limitations: row.limitations.includes("source_context_budget") ? row.limitations : [...row.limitations, "source_context_budget"] };
    });
    dropped.push({ ...refOf(last), code: "input_budget" });
  }
  return dropped.length === scoped.dropped.length ? scoped : { ...scoped, knowledge, coverage, dropped };
}

/** The coverage as recorded: what the model read, plus fixed codes with the card id for every drop or scope link on that request. */
export function caseScopedRecordCoverage(scoped: CaseScopedKnowledge): CaseKnowledgeCoverage[] {
  return scoped.coverage.map(row => {
    const before = scoped.linkedBefore.get(row.requestId) ?? new Set<string>();
    const added = scoped.added.filter(link => link.requestId === row.requestId), read = new Set(row.knowledge.map(keyOf));
    // A scope card linked here then trimmed for the budget is recorded as dropped, never as added.
    const linked = (key: string) => before.has(key) || added.some(link => keyOf(link) === key);
    const notes = [
      ...scoped.dropped.filter(drop => linked(keyOf(drop))).map(drop => `knowledge_dropped:${drop.code}:${drop.knowledgeId}`),
      ...added.filter(link => read.has(keyOf(link))).map(link => `block_scope_source_added:${link.knowledgeId}`),
    ];
    return notes.length ? { ...row, limitations: [...row.limitations, ...notes] } : row;
  });
}
