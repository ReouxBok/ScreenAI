import { assessSavKnowledgeValidity, type SavRetrievalCandidate } from "../request-retrieval";
import { caseAccessSourceProblem, type CaseBlockScope } from "./investigation-access-scope";
import { isSensitiveCaseFamily, type CaseKnowledgeCoverage } from "./decision-contract";
import { caseRequestSearchText, type CaseSnapshot } from "./case-types";
import type { CaseScopedKnowledge } from "./investigation-knowledge-ranking";
import { incidentContext, incidentContextSchema, type IncidentBinding, type IncidentContext, type IncidentReader } from "./investigation-incidents-contract";

/** Only an exact already-retrieved ANSWER source for the admitted open request establishes the projection lookup. */
export function caseIncidentBindings(snapshot: CaseSnapshot, cards: SavRetrievalCandidate[], coverage: CaseKnowledgeCoverage[] | null,
  accessScope: CaseBlockScope | null | undefined, locale: string, audience: string, now: Date): IncidentBinding[] {
  if (!accessScope || !coverage) return [];
  return coverage.flatMap(row => {
    const request = snapshot.body.openRequests.find(request => request.id === row.requestId && request.status === "open");
    if (!request || row.family !== request.family || row.status !== "covered") return [];
    return row.knowledge.flatMap(ref => {
      const card = cards.find(card => card.id === ref.knowledgeId && card.contentVersionId === ref.contentVersionId);
      if (!card || !assessSavKnowledgeValidity(card, locale, audience, now).eligible || caseAccessSourceProblem(accessScope, ref)) return [];
      return [{ requestId: request.id, family: request.family, ...ref }];
    });
  });
}

/** Promote proven matches, including exact versions read outside the ordinary ranking. */
export function prioritizeCaseIncidentKnowledge(scoped: CaseScopedKnowledge, context: IncidentContext, fetched: SavRetrievalCandidate[]): CaseScopedKnowledge {
  const priority = context.entries.filter(entry => entry.priority).map(entry => entry.proof);
  if (!priority.length) return scoped;
  const key = (ref: { knowledgeId: string; contentVersionId: string }) => `${ref.knowledgeId}:${ref.contentVersionId}`;
  const cardKey = (card: SavRetrievalCandidate) => `${card.id}:${card.contentVersionId}`;
  const priorityKeys = new Set(priority.map(key));
  const cards = new Map(scoped.knowledge.map(card => [cardKey(card), card]));
  for (const card of fetched) {
    const cardRef = cardKey(card);
    if (priorityKeys.has(cardRef) && !cards.has(cardRef)) cards.set(cardRef, card);
  }
  const first = <T,>(items: T[], preferred: (item: T) => boolean) => [...items.filter(preferred), ...items.filter(item => !preferred(item))];
  const added = [...scoped.added];
  const coverage = scoped.coverage.map(row => {
    const refs = priority.filter(ref => ref.requestId === row.requestId && cards.has(key(ref)));
    if (!refs.length) return row;
    const preferred = new Set(refs.map(key));
    const newRefs = refs.filter(ref => !row.knowledge.some(other => key(other) === key(ref)))
      .map(({ requestId, knowledgeId, contentVersionId }) => ({ requestId, knowledgeId, contentVersionId }));
    added.push(...newRefs);
    const knowledge = [...row.knowledge, ...newRefs.map(({ knowledgeId, contentVersionId }) => ({ knowledgeId, contentVersionId }))];
    return { ...row, status: "covered" as const, knowledge: first(knowledge, ref => preferred.has(key(ref))) };
  });
  return {
    ...scoped, knowledge: first([...cards.values()], card => priorityKeys.has(cardKey(card))), coverage, added,
    scopeKeys: new Set([...scoped.scopeKeys, ...priorityKeys]),
    scopeLeftOut: scoped.scopeLeftOut.filter(ref => !priorityKeys.has(key(ref))),
    dropped: scoped.dropped.filter(ref => !priorityKeys.has(key(ref))),
  };
}

export function caseTemporaryKnowledgeRequestTexts(snapshot: CaseSnapshot) {
  const requests = snapshot.body.openRequests;
  const texts = new Map<string, string>();
  if (requests.some(row => row.status !== "resolved" && isSensitiveCaseFamily(row.family))) return texts;
  for (const row of requests) {
    const text = caseRequestSearchText(row);
    if (row.status === "open" && text) texts.set(row.id, text);
  }
  return texts;
}

export function parseIncidentContext(raw: unknown): IncidentContext | null {
  const parsed = incidentContextSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  return incidentContext(value.bindings, value.entries, value.scope).fingerprint === value.fingerprint ? value : null;
}

/** Same reader as generation, with fresh approval/lifecycle reads. Any missing or altered proof blocks a prepared reply. */
export async function revalidateIncidentContext(raw: unknown, reader: IncidentReader | undefined, now: Date): Promise<boolean> {
  const stored = parseIncidentContext(raw);
  if (!stored || !reader) return false;
  try {
    const fresh = await reader(stored.bindings, now);
    return fresh.ok && parseIncidentContext(fresh.context)?.fingerprint === stored.fingerprint;
  } catch { return false; }
}
