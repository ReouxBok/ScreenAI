import { retrieveSavKnowledgeByRequest, type SavRetrievalBackend, type SavRetrievalCandidate } from "../request-retrieval";
import { caseRequestSearchText, caseRequestSubject, SAV_CASE_SENSITIVE_FAMILIES, type CaseRequestFamily, type CaseSnapshot } from "./case-types";
import type { CaseKnowledgeCoverage, CaseKnowledgeCoverageStatus } from "./decision-contract";
import type { CaseInvestigationOwnerStop } from "./investigation-runner";
import { caseRequestCardRelevance, type CaseKnowledgeRelevance } from "./investigation-knowledge-ranking";

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

export async function selectCaseKnowledge(snapshot: CaseSnapshot, backend: SavRetrievalBackend, scope: { locale: string; audience: "support" | "lead"; now: Date }, subjectOf: CaseSubjectPort = caseRequestSearchText): Promise<CaseKnowledgeRead> {
  const open = snapshot.body.openRequests.filter(row => row.status === "open" && !sensitive(row.family));
  const subjects = new Map(open.map(row => [row, subjectOf(row)?.trim().slice(0, SUMMARY_MAX) ?? null]));
  // The relay's label is never a subject, whatever the port says (contract v10 §9.2).
  const searchable = (row: OpenRequest) => { const text = subjects.get(row) ?? null; return text !== null && text !== row.summary.trim() ? text : ""; };
  // Retrieval ids are bounded to 100 characters; case request ids may be longer, so the search gets local aliases.
  // Newest first: when more requests are open than the search may take, the latest messages are searched.
  const searched = open.map((row, index) => ({ row, alias: `q${index}`, summary: searchable(row) }))
    .filter(plan => plan.summary.length >= SUMMARY_MIN).sort((a, b) => b.row.openedAt.localeCompare(a.row.openedAt));
  const primary = searched[0];
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
  const result = await retrieveSavKnowledgeByRequest({ requests: searched.map(plan => ({ id: plan.alias, summary: plan.summary })),
    primaryRequestId: primary?.alias ?? null, locale: scope.locale, audience: scope.audience, now: scope.now }, capturing);
  const failed = result.requests.find(row => row.status === "search_unavailable" || row.status === "revision_unstable");
  if (failed) return { status: "unavailable", reason: failed.status === "revision_unstable" ? "revision_unstable" : "search_unavailable" };

  const cards = new Map<string, SavRetrievalCandidate>(), relevance: CaseKnowledgeRelevance[] = [];
  const coverage = open.map((row): CaseKnowledgeCoverage => {
    const plan = searched.find(entry => entry.row === row), found = plan && result.requests.find(entry => entry.requestId === plan.alias);
    if (!found) return { requestId: row.id, family: row.family, status: "not_searched", knowledge: [], limitations: unsearchedBecause(row, subjects.get(row) ?? null) };
    const selected = found.candidateKeys.flatMap(key => {
      const card = returned.get(key);
      if (!card) return [];
      cards.set(key, card);
      return [card];
    });
    const knowledge = selected.map(card => ({ knowledgeId: card.id, contentVersionId: card.contentVersionId }));
    // The scores the search already returned for this very query: no new call decides relevance.
    caseRequestCardRelevance(plan.summary, selected, byQuery.get(plan.summary) ?? [], { locale: scope.locale, audience: scope.audience, now: scope.now })
      .forEach((verdict, rank) => relevance.push({ ...knowledge[rank]!, requestId: row.id, rank, verdict }));
    // A card found but too large to be read whole is knowledge we could not use, not an absence of knowledge.
    const incomplete = !knowledge.length && found.status === "no_source" && (byQuery.get(plan.summary) ?? []).some(card => card.sourceTooLarge === true);
    const status: CaseKnowledgeCoverageStatus = knowledge.length ? "covered" : found.status === "no_source" && !incomplete ? "no_applicable_knowledge" : "not_searched";
    return { requestId: row.id, family: row.family, status, knowledge, limitations: [...found.limitations, ...(incomplete ? ["knowledge_source_incomplete"] : [])] };
  });
  return { status: "ready", selection: { revision: result.revision, cards: [...cards.values()], coverage, alerts: result.alerts, relevance }, currentRevision: () => backend.readRevision() };
}
