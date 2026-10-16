import { z } from "zod";
import { diagnosticKnowledgeSchema } from "@/lib/knowledge/diagnostic-contract";
import { savSupportDeliveryProjectionSchema } from "@/lib/knowledge/support-delivery";

export const SAV_REQUEST_RETRIEVAL_REVISION = "sav-request-retrieval-2026-10-15.v1";
export const SAV_RETRIEVAL_LIMITS = Object.freeze({
  requests: 3, queriesPerAttempt: 3, candidatesPerQuery: 24,
  sourcesPerRequest: 3, sources: 6, sourceBytes: 12_000, contextBytes: 36_000,
  attempts: 2, queryCharacters: 900,
});
const requestSchema = z.object({
  id: z.string().min(1).max(100), summary: z.string().trim().min(3).max(600),
  product: z.string().max(200).nullish(), feature: z.string().max(200).nullish(),
});
export type SavRetrievalRequest = z.infer<typeof requestSchema>;
export type SavRetrievalCandidate = {
  id: string; contentVersionId: string; title: string; content: string; source: string;
  verifiedAt: string | null; semanticScore: number | null;
  sourceTooLarge?: boolean;
  resolution: { steps?: unknown; symptoms?: unknown; validUntil?: unknown; conflictsWith?: unknown; supersedes?: unknown; [key: string]: unknown } | null;
  availability: { active: boolean; published: boolean; indexed: boolean; archived: boolean; aiEnabled: boolean; locale: string; audience: string };
};
export type SavKnowledgeValidityReason = "available" | "inactive" | "unpublished" | "unindexed" | "archived" | "disabled" | "locale" | "audience" | "invalid_resolution" | "invalid_expiry" | "expired" | "unverified" | "stale" | "source_budget";
const DAY = 86_400_000;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const day = (value: Date) => value.toISOString().slice(0, 10);
const strings = z.array(z.string());
const resolutionProjection = z.object({
  delivery: savSupportDeliveryProjectionSchema.optional(),
  diagnostic: diagnosticKnowledgeSchema.optional(),
  steps: strings.min(1), symptoms: strings.optional(), exceptions: strings.optional(),
  prerequisites: strings.optional(), expectedResult: z.string().optional(), troubleshooting: z.string().optional(),
  escalation: z.string().optional(), productVersion: z.string().optional(), audience: z.string().optional(),
  validUntil: z.string().optional(), conflictsWith: strings.optional(), supersedes: strings.optional(),
}).transform(value => value.delivery?.mode === "procedure" ? { ...value, steps: [] } : value);

/** Ranking and a valid publication are not proof that a card supports a claim. */
export function assessSavKnowledgeValidity(candidate: SavRetrievalCandidate, locale: string, audience: string, now: Date) {
  const a = candidate.availability;
  const reject = (reason: SavKnowledgeValidityReason) => ({ eligible: false as const, reason, revalidationDue: false });
  if (a.archived) return reject("archived");
  if (!a.active) return reject("inactive");
  if (!a.published) return reject("unpublished");
  if (!a.indexed || !candidate.contentVersionId) return reject("unindexed");
  if (!a.aiEnabled) return reject("disabled");
  if (a.locale !== locale) return reject("locale");
  if (a.audience !== audience) return reject("audience");
  if (candidate.sourceTooLarge) return reject("source_budget");
  const resolution = candidate.resolution;
  if (!resolution || !resolutionProjection.safeParse(resolution).success || !Array.isArray(resolution.steps) || resolution.steps.some(step => typeof step !== "string" || !step.trim()) || !candidate.content.trim()) return reject("invalid_resolution");
  if ((resolution.audience ?? "support") !== audience) return reject("audience");
  let expiry: string | null = null;
  if (resolution.validUntil !== undefined && resolution.validUntil !== "") {
    if (typeof resolution.validUntil !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(resolution.validUntil)) return reject("invalid_expiry");
    const date = new Date(`${resolution.validUntil}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || day(date) !== resolution.validUntil) return reject("invalid_expiry");
    expiry = resolution.validUntil;
    if (expiry < day(now)) return reject("expired");
  }
  const verified = candidate.verifiedAt ? Date.parse(candidate.verifiedAt) : NaN;
  if (!Number.isFinite(verified) || verified > now.getTime()) return reject("unverified");
  if (now.getTime() - verified > 90 * DAY) return reject("stale");
  return { eligible: true as const, reason: "available" as const,
    revalidationDue: now.getTime() - verified >= 75 * DAY || Boolean(expiry && expiry <= day(new Date(now.getTime() + 15 * DAY))) };
}

const stopWords = new Set(["avec", "pour", "dans", "comment", "quoi", "faire", "peut", "plus", "pas", "les", "des", "une", "mon", "mes", "sur", "est", "sont", "limova", "bonjour", "merci", "the", "and", "with", "how"]);
export function savRetrievalTokens(text: string) {
  return [...new Set(text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(token => token.length >= 2 && !stopWords.has(token));
}
export function savWholeTokenCoverage(query: string, text: string) {
  const terms = savRetrievalTokens(query), candidateTerms = new Set(savRetrievalTokens(text));
  return terms.length ? terms.filter(term => candidateTerms.has(term)).length / terms.length : 0;
}
/** This configurable score orders candidates only; it never grants grounding. */
export function savRetrievalRanking(query: string, candidate: SavRetrievalCandidate, semanticWeight = 0.75) {
  if (!Number.isFinite(semanticWeight) || semanticWeight < 0 || semanticWeight > 1) throw new Error("SAV_RETRIEVAL_RANKING_CONFIG_INVALID");
  const symptoms = Array.isArray(candidate.resolution?.symptoms) ? candidate.resolution.symptoms.filter(value => typeof value === "string").join(" ") : "";
  const lexicalScore = savWholeTokenCoverage(query, `${candidate.title} ${symptoms}`);
  const semanticScore = candidate.semanticScore !== null && Number.isFinite(candidate.semanticScore) ? Math.max(-1, Math.min(1, candidate.semanticScore)) : null;
  return { semanticScore, lexicalScore, rankingScore: semanticScore === null ? lexicalScore : semanticWeight * (semanticScore + 1) / 2 + (1 - semanticWeight) * lexicalScore };
}

export type SavRetrievalCalibrationCase = { query: string; candidates: SavRetrievalCandidate[]; relevantKeys: string[] };
/** Offline labeled ranking evaluation; returns aggregates, never the private cases. */
export function calibrateSavRetrievalRanking(cases: SavRetrievalCalibrationCase[], now: Date) {
  if (!cases.length || cases.some(test => !test.relevantKeys.length || new Set(test.relevantKeys).size !== test.relevantKeys.length)) throw new Error("SAV_RETRIEVAL_CALIBRATION_LABELS_REQUIRED");
  const alternatives = [0.75, 0.5, 1, 0.25, 0].map(semanticWeight => {
    let precision = 0, recall = 0, reciprocalRank = 0, top1 = 0;
    for (const test of cases) {
      const relevant = new Set(test.relevantKeys);
      const ranked = test.candidates.filter(candidate => assessSavKnowledgeValidity(candidate, "fr-FR", "support", now).eligible)
        .map(candidate => ({ key: `${candidate.id}:${candidate.contentVersionId}`, score: savRetrievalRanking(test.query, candidate, semanticWeight).rankingScore }))
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
      const unique = [...new Map(ranked.map(row => [row.key, row])).values()];
      const first = unique.findIndex(row => relevant.has(row.key));
      reciprocalRank += first < 0 ? 0 : 1 / (first + 1);
      if (first === 0) top1++;
      const selected = unique.slice(0, SAV_RETRIEVAL_LIMITS.sourcesPerRequest);
      const found = selected.filter(row => relevant.has(row.key)).length;
      precision += selected.length ? found / selected.length : 0;
      recall += found / relevant.size;
    }
    return { semanticWeight, cases: cases.length, top1Accuracy: top1 / cases.length, meanReciprocalRank: reciprocalRank / cases.length,
      precisionAt3: precision / cases.length, recallAt3: recall / cases.length };
  });
  const best = [...alternatives].sort((a, b) => b.meanReciprocalRank - a.meanReciprocalRank || b.recallAt3 - a.recallAt3 || b.precisionAt3 - a.precisionAt3)[0];
  return { selectedWeight: best.semanticWeight, alternatives, caveat: "Ranking labels measure source ordering; they do not prove claim support or provider/model quality." };
}

export type SavRetrievalBackend = {
  readRevision(): Promise<string>;
  search(queries: readonly string[], limit: number): Promise<SavRetrievalCandidate[][]>;
};
type RequestStatus = "candidates" | "no_source" | "budget_exceeded" | "search_unavailable" | "revision_unstable";
type RequestResult = { requestId: string; status: RequestStatus; candidateKeys: string[]; limitations: string[] };
export type SavRequestRetrievalSource = Omit<SavRetrievalCandidate, "availability" | "semanticScore"> & {
  key: string; requestIds: string[]; grounding: "unassessed";
  signals: { requestId: string; semanticScore: number | null; lexicalScore: number; rankingScore: number }[];
};
export type SavRequestRetrievalResult = {
  contractRevision: string; revision: string | null; requests: RequestResult[]; sources: SavRequestRetrievalSource[];
  alerts: { code: string; sourceKey?: string }[];
  metrics: { attempts: number; queryCount: number; embeddingBatchesUpperBound: number; serializedBytes: number; contextTextTokensUpperBound: number };
};

/** Association check only. Citation/claim verification remains mandatory downstream. */
export function assertSavRequestCandidateLinks(result: SavRequestRetrievalResult, sections: Array<{ requestId: string; sourceIds: string[] }>) {
  if (new Set(sections.map(section => section.requestId)).size !== sections.length) throw new Error("SAV_RETRIEVAL_COVERAGE_IDS_INVALID");
  const selected = new Set(sections.flatMap(section => section.sourceIds));
  for (const section of sections) {
    const request = result.requests.find(request => request.requestId === section.requestId);
    if (!request || section.sourceIds.some(sourceId => !result.sources.some(source => source.id === sourceId && request.candidateKeys.includes(source.key)))) throw new Error("SAV_REQUEST_SOURCE_NOT_RETRIEVED");
  }
  for (const source of result.sources) {
    if (!selected.has(source.id)) continue;
    const conflicts = source.resolution?.conflictsWith;
    if (Array.isArray(conflicts) && conflicts.some(id => typeof id === "string" && selected.has(id))) throw new Error("SAV_CONTRADICTORY_RESOLUTION_CARDS");
  }
}

export async function retrieveSavKnowledgeByRequest(input: {
  requests: SavRetrievalRequest[]; primaryRequestId?: string | null; locale?: string; audience?: "support" | "lead"; now?: Date;
}, backend: SavRetrievalBackend): Promise<SavRequestRetrievalResult> {
  const requests = z.array(requestSchema).max(15).parse(input.requests);
  if (new Set(requests.map(request => request.id)).size !== requests.length) throw new Error("SAV_RETRIEVAL_REQUEST_IDS_INVALID");
  if (input.primaryRequestId && !requests.some(request => request.id === input.primaryRequestId)) throw new Error("SAV_RETRIEVAL_PRIMARY_REQUEST_INVALID");
  const now = input.now ?? new Date(), locale = input.locale ?? "fr-FR", audience = input.audience ?? "support";
  if (!Number.isFinite(now.getTime()) || !/^[a-z]{2}-[A-Z]{2}$/.test(locale)) throw new Error("SAV_RETRIEVAL_CONTEXT_INVALID");
  const ordered = [...requests].sort((a, b) => Number(b.id === input.primaryRequestId) - Number(a.id === input.primaryRequestId));
  const chosen = ordered.slice(0, SAV_RETRIEVAL_LIMITS.requests);
  const planned = chosen.map(request => ({ request, query: [request.product, request.feature, request.summary].filter(Boolean).join(" — ") }));
  const queryable = planned.filter(plan => plan.query.length <= SAV_RETRIEVAL_LIMITS.queryCharacters);
  const queries = [...new Set(queryable.map(plan => plan.query))];
  const metrics = { attempts: 0, queryCount: 0, embeddingBatchesUpperBound: 0, serializedBytes: 0, contextTextTokensUpperBound: 0 };
  const finish = (revision: string | null, rows: RequestResult[], sources: SavRequestRetrievalSource[], alerts: SavRequestRetrievalResult["alerts"]) => {
    const result = { contractRevision: SAV_REQUEST_RETRIEVAL_REVISION, revision, requests: rows, sources, alerts, metrics };
    // Byte accounting is a conservative upper bound for context text tokens,
    // not a provider usage measurement or the complete generation prompt.
    for (let i = 0; i < 4; i++) {
      metrics.serializedBytes = bytes(result);
      metrics.contextTextTokensUpperBound = metrics.serializedBytes;
    }
    return result;
  };
  const unavailable = (status: RequestStatus, code: string) => finish(null, requests.map(request => ({ requestId: request.id, status, candidateKeys: [], limitations: [code] })), [], [{ code }]);
  if (!requests.length) return finish(null, [], [], []);
  if (!queries.length) return unavailable("budget_exceeded", "request_or_query_budget");
  for (let attempt = 0; attempt < SAV_RETRIEVAL_LIMITS.attempts; attempt++) {
    metrics.attempts++;
    try {
      const revision = await backend.readRevision();
      metrics.queryCount += queries.length;
      if (queries.length) metrics.embeddingBatchesUpperBound++;
      const batches = queries.length ? await backend.search(queries, SAV_RETRIEVAL_LIMITS.candidatesPerQuery) : [];
      if (batches.length !== queries.length || batches.some(batch => batch.length > SAV_RETRIEVAL_LIMITS.candidatesPerQuery)) throw new Error("SAV_RETRIEVAL_BACKEND_CONTRACT_INVALID");
      if (await backend.readRevision() !== revision) {
        if (attempt + 1 < SAV_RETRIEVAL_LIMITS.attempts) continue;
        return unavailable("revision_unstable", "knowledge_revision_unstable");
      }
      const alerts: SavRequestRetrievalResult["alerts"] = [];
      const versionSets = new Map<string, Set<string>>();
      const payloads = new Map<string, string>(), inconsistent = new Set<string>();
      for (const batch of batches) for (const candidate of batch) {
        const versions = versionSets.get(candidate.id) ?? new Set<string>();
        versions.add(candidate.contentVersionId); versionSets.set(candidate.id, versions);
        const key = `${candidate.id}:${candidate.contentVersionId}`;
        const payload = JSON.stringify([candidate.title, candidate.content, candidate.resolution, candidate.verifiedAt]);
        if (payloads.has(key) && payloads.get(key) !== payload) inconsistent.add(key);
        payloads.set(key, payload);
      }
      const conflicted = new Set([...versionSets].filter(([, versions]) => versions.size > 1).map(([id]) => id));
      for (const id of conflicted) alerts.push({ code: "multiple_versions_for_active_card", sourceKey: id });
      for (const key of inconsistent) alerts.push({ code: "inconsistent_version_payload", sourceKey: key });
      const selections = new Map<string, Array<{ candidate: SavRetrievalCandidate; signals: ReturnType<typeof savRetrievalRanking> }>>();
      for (const plan of queryable) {
        const candidates = batches[queries.indexOf(plan.query)];
        const sorted = candidates.filter(candidate => {
          if (conflicted.has(candidate.id) || inconsistent.has(`${candidate.id}:${candidate.contentVersionId}`)) return false;
          const validity = assessSavKnowledgeValidity(candidate, locale, audience, now);
          if (!validity.eligible) { alerts.push({ code: validity.reason, sourceKey: `${candidate.id}:${candidate.contentVersionId}` }); return false; }
          if (validity.revalidationDue) alerts.push({ code: "revalidation_due", sourceKey: `${candidate.id}:${candidate.contentVersionId}` });
          return true;
        }).map(candidate => ({ candidate, signals: savRetrievalRanking(plan.query, candidate) }))
          .sort((a, b) => b.signals.rankingScore - a.signals.rankingScore || a.candidate.id.localeCompare(b.candidate.id));
        const unique = new Map<string, typeof sorted[number]>();
        for (const row of sorted) if (!unique.has(`${row.candidate.id}:${row.candidate.contentVersionId}`)) unique.set(`${row.candidate.id}:${row.candidate.contentVersionId}`, row);
        selections.set(plan.request.id, [...unique.values()]);
      }
      const rows: RequestResult[] = requests.map(request => ({ requestId: request.id,
        status: queryable.some(plan => plan.request.id === request.id) ? "no_source" : "budget_exceeded", candidateKeys: [],
        limitations: queryable.some(plan => plan.request.id === request.id) ? [] : ["request_or_query_budget"] }));
      for (const plan of queryable) if (batches[queries.indexOf(plan.query)].length === SAV_RETRIEVAL_LIMITS.candidatesPerQuery) {
        rows.find(row => row.requestId === plan.request.id)!.limitations.push("candidate_population_bounded");
      }
      const sources = new Map<string, SavRequestRetrievalSource>();
      // Round-robin avoids spending the whole source budget on the first request.
      for (let slot = 0; slot < SAV_RETRIEVAL_LIMITS.sourcesPerRequest; slot++) for (const plan of queryable) {
        const selected = selections.get(plan.request.id)?.[slot];
        if (!selected) continue;
        const { candidate, signals } = selected, key = `${candidate.id}:${candidate.contentVersionId}`;
        const row = rows.find(row => row.requestId === plan.request.id)!;
        const existing = sources.get(key);
        if (existing) {
          if (!existing.requestIds.includes(row.requestId)) { existing.requestIds.push(row.requestId); existing.signals.push({ requestId: row.requestId, ...signals }); }
          row.candidateKeys.push(key); row.status = "candidates"; continue;
        }
        const source: SavRequestRetrievalSource = { id: candidate.id, contentVersionId: candidate.contentVersionId, title: candidate.title,
          content: candidate.content, source: candidate.source, verifiedAt: candidate.verifiedAt, resolution: resolutionProjection.parse(candidate.resolution),
          key, requestIds: [row.requestId], grounding: "unassessed", signals: [{ requestId: row.requestId, ...signals }] };
        if (sources.size >= SAV_RETRIEVAL_LIMITS.sources || bytes(source) > SAV_RETRIEVAL_LIMITS.sourceBytes
          || bytes({ rows, sources: [...sources.values(), source], alerts: alerts.slice(0, 60) }) > SAV_RETRIEVAL_LIMITS.contextBytes - 1_500) {
          if (!row.limitations.includes("source_context_budget")) row.limitations.push("source_context_budget");
          if (!row.candidateKeys.length) row.status = "budget_exceeded";
          continue;
        }
        sources.set(key, source); row.candidateKeys.push(key); row.status = "candidates";
      }
      const uniqueAlerts = [...new Map(alerts.map(alert => [`${alert.code}:${alert.sourceKey ?? ""}`, alert])).values()];
      const shownAlerts = uniqueAlerts.slice(0, 60);
      if (uniqueAlerts.length > 60) shownAlerts.push({ code: "additional_validity_alerts_omitted" });
      const result = finish(revision, rows, [...sources.values()], shownAlerts);
      if (bytes(result) > SAV_RETRIEVAL_LIMITS.contextBytes) return unavailable("budget_exceeded", "context_budget");
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "KNOWLEDGE_REVISION_CHANGED_DURING_SEARCH" && attempt + 1 < SAV_RETRIEVAL_LIMITS.attempts) continue;
      return unavailable("search_unavailable", "knowledge_search_unavailable");
    }
  }
  return unavailable("revision_unstable", "knowledge_revision_unstable");
}
