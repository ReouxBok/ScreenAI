import { assessSavKnowledgeValidity, retrieveSavKnowledgeByRequest, savRetrievalRanking, SAV_RETRIEVAL_LIMITS, type SavRetrievalBackend, type SavRetrievalCandidate } from "../request-retrieval";
import { caseRequestSearchText, caseRequestSubject, SAV_CASE_SENSITIVE_FAMILIES, type CaseRequestFamily, type CaseSnapshot } from "./case-types";
import type { CaseKnowledgeCoverage, CaseKnowledgeCoverageStatus } from "./decision-contract";
import type { CaseInvestigationOwnerStop } from "./investigation-runner";
import { caseRequestCardRelevance, SAV_CASE_RELEVANCE_SEMANTIC_FLOOR, type CaseKnowledgePoolEntry, type CaseKnowledgeRelevance, type CaseKnowledgeRelevanceVerdict } from "./investigation-knowledge-ranking";

/*
 * SAV-7/SAV-19: which published, applicable cards the investigation may use, per open request of the case. Read only:
 * it goes through the intake's per-request retrieval (`retrieveSavKnowledgeByRequest`, validity rules of SAV72) with a
 * search backend passed in; it writes nothing and publishes nothing. A failed search is never read as an absence: the
 * whole read is `unavailable` and the runner waits, without a model call that would only hand the case off.
 * Sensitive requests are never searched: the gate keeps those cases with the team before any read.
 */

export type { CaseKnowledgeCoverage, CaseKnowledgeCoverageStatus };

export type CaseKnowledgeSelection = {
  /** Knowledge revision the search ran on (provenance of the decision). */
  revision: string | null;
  cards: SavRetrievalCandidate[];
  coverage: CaseKnowledgeCoverage[];
  /** Validity alerts of the search (expired, unverified, superseded versions...), by code and card key. */
  alerts: Array<{ code: string; sourceKey?: string }>;
  /**
   * Per searched request, each selected card's rank and relevance verdict against the candidates the vector search returned for it
   * (`investigation-knowledge-ranking.ts`). Read only by a pilot block's scope-first selection; never sent nor recorded as such.
   */
  relevance?: CaseKnowledgeRelevance[];
  /**
   * K3: per searched request, the valid candidates the vector search returned for its query (selected or not), as returned. Read only by a
   * pilot block's selection, to judge a scope card the search did not select; never sent nor recorded as such.
   */
  pool?: CaseKnowledgePoolEntry[];
};

/**
 * Why a budgeted search stopped before or instead of a paid embedding call (investigation-budgeted-retrieval.ts). Not a
 * search outage and never an absence of knowledge: the runner maps each to its own stop or wait.
 */
export type CaseKnowledgeStop =
  | { reason: "knowledge_paused" }
  | { reason: "knowledge_owner_stop"; owner: CaseInvestigationOwnerStop }
  | { reason: "knowledge_stale"; currentVersion: number | null }
  | { reason: "knowledge_budget_deferred"; detail: string }
  | { reason: "knowledge_usage_uncertain" }
  | { reason: "knowledge_calls_exhausted" }
  | { reason: "knowledge_busy" }
  /** The caller asked outside the bounds (input key, query count or size, limit, vector size): refused before any cost. */
  | { reason: "knowledge_request_invalid"; problem: CaseKnowledgeRequestProblem };

export type CaseKnowledgeRequestProblem = "input_key_invalid" | "query_count_invalid" | "query_text_invalid" | "limit_invalid" | "vector_dimension_invalid";

/**
 * `embeddingCalls`: embedding calls the budgeted search sent for this selection, when known. `currentRevision`: reads
 * the knowledge revision now, on the same backend (a database read, no embedding, no cost), so that the runner can see
 * the knowledge moved after the search (a publication, an archive, an AI switch all move it).
 */
export type CaseKnowledgeRead =
  | { status: "ready"; selection: CaseKnowledgeSelection; embeddingCalls?: number; currentRevision?: () => Promise<string> }
  | { status: "unavailable"; reason: "search_unavailable" | "revision_unstable" }
  | { status: "stopped"; stop: CaseKnowledgeStop };

const SUMMARY_MIN = 3, SUMMARY_MAX = 600;
const sensitive = (family: CaseRequestFamily) => (SAV_CASE_SENSITIVE_FAMILIES as readonly string[]).includes(family);

/**
 * What to search for one open request: a neutral, searchable subject of what the customer asks, or null when none is
 * known. Pole A's v10 port `caseRequestSearchText` by default: the masked summary V1 accepted for this request alone,
 * never the generic `summary` label the relay writes (its kind and the mail id), which would report false gaps.
 */
export type CaseSubjectPort = (request: OpenRequest) => string | null;
type OpenRequest = CaseSnapshot["body"]["openRequests"][number];

/** Why a request is not searched, as fixed codes for the console: no subject (with pole A's reason when it stored one), the label, or too short. */
function unsearchedBecause(row: OpenRequest, text: string | null): string[] {
  if (text === null) {
    const stored = caseRequestSubject(row);
    return stored.status === "absent" ? ["subject_unavailable", `subject_${stored.reason}`] : ["subject_unavailable"];
  }
  return text === row.summary.trim() ? ["subject_unavailable", "subject_generic"] : ["subject_too_short"];
}

/** SAV-92: the alias of the customer-words query among the retrieval's requests (the subjects' aliases are `q<n>`). */
const WORDS_ALIAS = "qw";
const cardKeyOf = (card: SavRetrievalCandidate) => `${card.id}:${card.contentVersionId}`;
const belowFloor = (card: SavRetrievalCandidate) => card.semanticScore !== null && Number.isFinite(card.semanticScore) && card.semanticScore < SAV_CASE_RELEVANCE_SEMANTIC_FLOOR;

/**
 * SAV-92, the merge of the two queries for ONE request (documented in FIX_V2_CONTEXT). The subject query's selection keeps its order and its
 * verdicts; its best card is always kept first, so the customer's words can never push out what V1's summary found best. The other slots
 * (up to the per-request source limit, unchanged) go to the best remaining cards of both queries, each scored by the retrieval's own ranking
 * against the query that found it. A card only the customer's words found is never kept under the absolute relevance floor.
 */
function mergeCustomerWords(subject: { query: string; cards: SavRetrievalCandidate[]; verdicts: CaseKnowledgeRelevanceVerdict[] } | null,
  words: { query: string; cards: SavRetrievalCandidate[]; verdicts: CaseKnowledgeRelevanceVerdict[] }) {
  const rows = new Map<string, { card: SavRetrievalCandidate; score: number; fromSubject: boolean; verdict: CaseKnowledgeRelevanceVerdict }>();
  subject?.cards.forEach((card, index) => rows.set(cardKeyOf(card), { card, score: savRetrievalRanking(subject.query, card).rankingScore, fromSubject: true, verdict: subject.verdicts[index]! }));
  words.cards.forEach((card, index) => {
    if (rows.has(cardKeyOf(card)) || belowFloor(card)) return;
    rows.set(cardKeyOf(card), { card, score: savRetrievalRanking(words.query, card).rankingScore, fromSubject: false, verdict: words.verdicts[index]! });
  });
  const pinned = subject?.cards[0] ? rows.get(cardKeyOf(subject.cards[0])) : undefined;
  const rest = [...rows.values()].filter(row => row !== pinned)
    .sort((a, b) => b.score - a.score || Number(b.fromSubject) - Number(a.fromSubject) || cardKeyOf(a.card).localeCompare(cardKeyOf(b.card)));
  return [...(pinned ? [pinned] : []), ...rest].slice(0, SAV_RETRIEVAL_LIMITS.sourcesPerRequest);
}

export async function selectCaseKnowledge(snapshot: CaseSnapshot, backend: SavRetrievalBackend,
  scope: { locale: string; audience: "support" | "lead"; now: Date; customerWords?: string | null }, subjectOf: CaseSubjectPort = caseRequestSearchText): Promise<CaseKnowledgeRead> {
  const open = snapshot.body.openRequests.filter(row => row.status === "open" && !sensitive(row.family));
  const subjects = new Map(open.map(row => [row, subjectOf(row)?.trim().slice(0, SUMMARY_MAX) ?? null]));
  // The relay's label is never a subject, whatever the port says (contract v10 §9.2).
  const searchable = (row: OpenRequest) => { const text = subjects.get(row) ?? null; return text !== null && text !== row.summary.trim() ? text : ""; };
  // Retrieval ids are bounded to 100 characters; case request ids may be longer, so the search gets local aliases.
  // Newest first: when more requests are open than the search may take, the latest messages are searched.
  const searched = open.map((row, index) => ({ row, alias: `q${index}`, summary: searchable(row) }))
    .filter(plan => plan.summary.length >= SUMMARY_MIN).sort((a, b) => b.row.openedAt.localeCompare(a.row.openedAt));
  const primary = searched[0];
  // SAV-92: the customer's own words, searched for ONE request: the primary (newest searched) one, or the only open request when none has a
  // subject (so a request V1 could not sum up is still searched). Only when the search has room for one more query (its limits are
  // unchanged); otherwise the request records `customer_words_query_budget`. Never a sensitive request (they are not in `open`).
  const words = scope.customerWords?.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX) ?? "";
  const wordsTarget = words.length >= SUMMARY_MIN ? primary?.row ?? (open.length === 1 ? open[0] : undefined) : undefined;
  const wordsDistinct = wordsTarget !== undefined && !searched.some(plan => plan.summary === words);
  const wordsSearched = wordsDistinct && searched.length < SAV_RETRIEVAL_LIMITS.requests;
  // The cards the backend returned, kept as they are: the decision is validated on the original cards, never on a copy.
  const returned = new Map<string, SavRetrievalCandidate>(), byQuery = new Map<string, SavRetrievalCandidate[]>();
  const capturing: SavRetrievalBackend = {
    readRevision: () => backend.readRevision(),
    search: async (queries, limit) => {
      const batches = await backend.search(queries, limit);
      for (const batch of batches ?? []) for (const card of batch) returned.set(`${card.id}:${card.contentVersionId}`, card);
      (batches ?? []).forEach((batch, index) => byQuery.set(queries[index]!, batch));
      return batches;
    },
  };
  const result = await retrieveSavKnowledgeByRequest({ requests: [...searched.map(plan => ({ id: plan.alias, summary: plan.summary })),
    ...(wordsSearched ? [{ id: WORDS_ALIAS, summary: words }] : [])],
    primaryRequestId: primary?.alias ?? (wordsSearched ? WORDS_ALIAS : null), locale: scope.locale, audience: scope.audience, now: scope.now }, capturing);
  const failed = result.requests.find(row => row.status === "search_unavailable" || row.status === "revision_unstable");
  if (failed) return { status: "unavailable", reason: failed.status === "revision_unstable" ? "revision_unstable" : "search_unavailable" };

  const cards = new Map<string, SavRetrievalCandidate>(), relevance: CaseKnowledgeRelevance[] = [], pool: CaseKnowledgePoolEntry[] = [];
  const wordsFound = wordsSearched ? result.requests.find(entry => entry.requestId === WORDS_ALIAS) : undefined;
  const context = { locale: scope.locale, audience: scope.audience, now: scope.now };
  const selectedOf = (keys: readonly string[]) => keys.flatMap(key => { const card = returned.get(key); return card ? [card] : []; });
  const coverage = open.map((row): CaseKnowledgeCoverage => {
    const plan = searched.find(entry => entry.row === row), found = plan && result.requests.find(entry => entry.requestId === plan.alias);
    const withWords = row === wordsTarget && wordsFound !== undefined;
    const wordsNote = row === wordsTarget && wordsDistinct && !wordsSearched ? ["customer_words_query_budget"] : [];
    if (!found && !withWords) return { requestId: row.id, family: row.family, status: "not_searched", knowledge: [], limitations: [...unsearchedBecause(row, subjects.get(row) ?? null), ...wordsNote] };
    // The scores the search already returned for each query: no new call decides relevance.
    const subjectSelected = found ? selectedOf(found.candidateKeys) : [];
    const subject = plan && found ? { query: plan.summary, cards: subjectSelected, verdicts: caseRequestCardRelevance(plan.summary, subjectSelected, byQuery.get(plan.summary) ?? [], context) } : null;
    let selected: Array<{ card: SavRetrievalCandidate; verdict: CaseKnowledgeRelevanceVerdict }>;
    if (withWords) {
      const wordsSelected = selectedOf(wordsFound!.candidateKeys);
      selected = mergeCustomerWords(subject, { query: words, cards: wordsSelected, verdicts: caseRequestCardRelevance(words, wordsSelected, byQuery.get(words) ?? [], context) });
    } else selected = subject!.cards.map((card, index) => ({ card, verdict: subject!.verdicts[index]! }));
    for (const { card } of selected) cards.set(cardKeyOf(card), card);
    const knowledge = selected.map(({ card }) => ({ knowledgeId: card.id, contentVersionId: card.contentVersionId }));
    selected.forEach(({ verdict }, rank) => relevance.push({ ...knowledge[rank]!, requestId: row.id, rank, verdict }));
    const queries = [...(plan && found ? [plan.summary] : []), ...(withWords ? [words] : [])];
    const seen = new Set<string>();
    for (const card of queries.flatMap(query => byQuery.get(query) ?? [])) {
      const key = cardKeyOf(card);
      if (seen.has(key) || !assessSavKnowledgeValidity(card, scope.locale, scope.audience, scope.now).eligible) continue;
      seen.add(key); pool.push({ requestId: row.id, card });
    }
    const statuses = [...(found ? [found.status] : []), ...(withWords ? [wordsFound!.status] : [])];
    // A card found but too large to be read whole is knowledge we could not use, not an absence of knowledge.
    const incomplete = !knowledge.length && statuses.includes("no_source") && queries.some(query => (byQuery.get(query) ?? []).some(card => card.sourceTooLarge === true));
    // Searched and nothing relevant: by either query (a card of the customer's words under the floor is not relevant).
    const nothing = statuses.includes("no_source") || (withWords && wordsFound!.status === "candidates");
    const status: CaseKnowledgeCoverageStatus = knowledge.length ? "covered" : nothing && !incomplete ? "no_applicable_knowledge" : "not_searched";
    const limitations = [...(found ? found.limitations : unsearchedBecause(row, subjects.get(row) ?? null)),
      ...(withWords ? ["customer_words_searched", ...wordsFound!.limitations.filter(code => !(found?.limitations ?? []).includes(code))] : []), ...wordsNote,
      ...(incomplete ? ["knowledge_source_incomplete"] : [])];
    return { requestId: row.id, family: row.family, status, knowledge, limitations };
  });
  return { status: "ready", selection: { revision: result.revision, cards: [...cards.values()], coverage, alerts: result.alerts, relevance, pool }, currentRevision: () => backend.readRevision() };
}
