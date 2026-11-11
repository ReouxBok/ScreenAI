import { assessSavKnowledgeValidity, type SavRetrievalCandidate } from "../request-retrieval";
import { caseAccessSourceProblem, type CaseAccessScope } from "./investigation-access-scope";
import type { CaseKnowledgeCoverage } from "./decision-contract";
import type { CaseSnapshot } from "./case-types";
import { incidentContext, incidentContextSchema, type IncidentBinding, type IncidentContext, type IncidentReader } from "./investigation-incidents-contract";

/** Only an exact already-retrieved ANSWER source for the admitted open request establishes the projection lookup. */
export function caseIncidentBindings(snapshot: CaseSnapshot, cards: SavRetrievalCandidate[], coverage: CaseKnowledgeCoverage[] | null,
  accessScope: CaseAccessScope | null | undefined, locale: string, audience: string, now: Date): IncidentBinding[] {
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
