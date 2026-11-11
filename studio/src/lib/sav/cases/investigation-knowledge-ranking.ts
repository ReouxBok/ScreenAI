import { assessSavKnowledgeValidity, savRetrievalRanking, type SavRetrievalCandidate } from "../request-retrieval";
import type { KnowledgeRef } from "./case-types";
import type { CaseKnowledgeCoverage } from "./decision-contract";
import type { CaseBlockScope } from "./investigation-access-scope";

/*
 * Scope-first, ranked knowledge (11/11). On a pilot block (Access or another block with its approved scope), the block's scope sources go
 * to the model FIRST and are never dropped; when the search did not return one, it is read at its exact approved version (active, valid
 * now, never a stale version). The other retrieved cards follow, ranked, only when they are relevant to a request: the first card of each
 * request, any card without a usable score, and any card in the upper half of the gap between the request's typical candidate (median of
 * the candidates the vector search returned) and its best card. Pure: no model, embedding, network, database or clock of its own.
 * A case without a block scope never comes here (unchanged).
 */

export type CaseKnowledgeRelevanceVerdict = "top" | "relevant" | "low" | "unscored";
/** One (request, card) pair the search selected: its rank within the request (0 = the request's best) and its verdict. */
export type CaseKnowledgeRelevance = KnowledgeRef & { requestId: string; rank: number; verdict: CaseKnowledgeRelevanceVerdict };
export type CaseKnowledgeDropCode = "low_relevance" | "input_budget";
export type CaseKnowledgeDrop = KnowledgeRef & { code: CaseKnowledgeDropCode };

/** Fewer scored, valid candidates than this for a request: no population to judge against, every card is kept (`unscored`). */
export const SAV_CASE_RELEVANCE_MIN_POPULATION = 5;
/** Where the threshold sits between the median candidate (0) and the request's best card (1). */
export const SAV_CASE_RELEVANCE_GAP_SHARE = 0.5;

const keyOf = (ref: KnowledgeRef) => `${ref.knowledgeId}:${ref.contentVersionId}`;
const cardKey = (card: SavRetrievalCandidate) => `${card.id}:${card.contentVersionId}`;
const refOf = (card: SavRetrievalCandidate): KnowledgeRef => ({ knowledgeId: card.id, contentVersionId: card.contentVersionId });
const scored = (card: SavRetrievalCandidate) => card.semanticScore !== null && Number.isFinite(card.semanticScore);

/**
 * Verdicts for the cards selected for one request, in their retrieval order, judged with the retrieval's own ranking (`savRetrievalRanking`,
 * same query) against the candidates the vector search returned for that query. Never drops the request's first card.
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
    if (rank === 0) return "top";
    if (threshold === null || !scored(card)) return "unscored";
    return savRetrievalRanking(query, card).rankingScore >= threshold ? "relevant" : "low";
  });
}

export type CaseScopedKnowledge = Readonly<{
  /** Scope cards first (in the scope's order), then the kept out-of-scope cards, best first. */
  knowledge: SavRetrievalCandidate[];
  /** What the model and the validator read: dropped cards unlinked, scope cards linked to the block's searched requests. */
  coverage: CaseKnowledgeCoverage[];
  scopeKeys: ReadonlySet<string>;
  dropped: CaseKnowledgeDrop[];
  /** Scope cards linked to a request the search had not linked them to (fetched, or retrieved for another request). */
  added: Array<KnowledgeRef & { requestId: string }>;
  /** Scope sources neither retrieved nor readable at their exact, active, valid version: not sent. */
  unavailable: KnowledgeRef[];
  /** Per request: the refs linked before any drop, for the record's limitation codes. */
  linkedBefore: ReadonlyMap<string, ReadonlySet<string>>;
}>;

/**
 * Scope first, then ranked relevance. `fetched`: scope cards read at their exact version (already checked active and valid by the caller).
 * A card is dropped as `low_relevance` only when every verdict it has is `low` and it is not the last card of any request.
 */
export function arrangeCaseScopedKnowledge(input: Readonly<{
  cards: readonly SavRetrievalCandidate[]; coverage: readonly CaseKnowledgeCoverage[]; relevance: readonly CaseKnowledgeRelevance[];
  scope: CaseBlockScope; fetched: readonly SavRetrievalCandidate[];
}>): CaseScopedKnowledge {
  const byKey = new Map(input.cards.map(card => [cardKey(card), card]));
  const scopeCards: SavRetrievalCandidate[] = [], unavailable: KnowledgeRef[] = [];
  for (const source of input.scope.sources) {
    const key = keyOf(source);
    const found = byKey.get(key) ?? input.fetched.find(card => cardKey(card) === key && !input.cards.some(other => other.id === card.id));
    if (found) scopeCards.push(found); else unavailable.push({ knowledgeId: source.knowledgeId, contentVersionId: source.contentVersionId });
  }
  const scopeKeys = new Set(scopeCards.map(cardKey));
  const verdicts = (card: SavRetrievalCandidate) => input.relevance.filter(row => keyOf(row) === cardKey(card));
  const linkedBefore = new Map(input.coverage.map(row => [row.requestId, new Set(row.knowledge.map(keyOf))]));
  const lowOnly = new Set(input.cards.filter(card => !scopeKeys.has(cardKey(card))).filter(card => {
    const rows = verdicts(card);
    return rows.length > 0 && rows.every(row => row.verdict === "low");
  }).map(cardKey));
  // Invariant: a request never loses its last card to relevance (its first card is always `top`, this only guards the invariant).
  for (const row of input.coverage) {
    const left = row.knowledge.filter(ref => !lowOnly.has(keyOf(ref)));
    if (!left.length) for (const ref of row.knowledge) lowOnly.delete(keyOf(ref));
  }
  const rankOf = (card: SavRetrievalCandidate) => Math.min(...verdicts(card).map(row => row.rank), Number.MAX_SAFE_INTEGER);
  const others = input.cards.map((card, index) => ({ card, index })).filter(({ card }) => !scopeKeys.has(cardKey(card)) && !lowOnly.has(cardKey(card)))
    .sort((a, b) => rankOf(a.card) - rankOf(b.card) || a.index - b.index).map(({ card }) => card);
  const dropped = input.cards.filter(card => lowOnly.has(cardKey(card))).map(card => ({ ...refOf(card), code: "low_relevance" as const }));
  const added: CaseScopedKnowledge["added"] = [];
  const coverage = input.coverage.map((row): CaseKnowledgeCoverage => {
    const knowledge = row.knowledge.filter(ref => !lowOnly.has(keyOf(ref)));
    // The block's scope sources support the block's searched requests: linked, so that the model may cite them for those requests.
    if (row.family === input.scope.family && row.status !== "not_searched") for (const card of scopeCards) {
      if (knowledge.some(ref => keyOf(ref) === cardKey(card))) continue;
      knowledge.push(refOf(card));
      added.push({ ...refOf(card), requestId: row.requestId });
    }
    return { ...row, status: knowledge.length ? "covered" : row.status, knowledge, limitations: [...row.limitations] };
  });
  return { knowledge: [...scopeCards, ...others], coverage, scopeKeys, dropped, added, unavailable, linkedBefore };
}

/**
 * Over the input budget: the lowest-ranked out-of-scope card is dropped, again and again, until `fits` or none is left; a scope card is
 * never dropped. A request left without any card is `not_searched` with the retrieval's existing `source_context_budget` limitation.
 */
export function trimCaseScopedKnowledge(scoped: CaseScopedKnowledge, fits: (knowledge: SavRetrievalCandidate[], coverage: CaseKnowledgeCoverage[]) => boolean): CaseScopedKnowledge {
  let knowledge = scoped.knowledge, coverage = scoped.coverage;
  const dropped = [...scoped.dropped];
  while (!fits(knowledge, coverage)) {
    const last = [...knowledge].reverse().find(card => !scoped.scopeKeys.has(cardKey(card)));
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
    const notes = [
      ...scoped.dropped.filter(drop => before.has(keyOf(drop))).map(drop => `knowledge_dropped:${drop.code}:${drop.knowledgeId}`),
      ...scoped.added.filter(link => link.requestId === row.requestId).map(link => `block_scope_source_added:${link.knowledgeId}`),
    ];
    return notes.length ? { ...row, limitations: [...row.limitations, ...notes] } : row;
  });
}
