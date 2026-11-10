import "server-only";
import { and, eq, or } from "drizzle-orm";
import { requireDb } from "@/db";
import { knowledgeFamilies, knowledgeFamilyRevisions, knowledgeProjections } from "@/db/schema";
import { INCIDENT_RUNTIME_LIMIT, incidentBindingSchema, incidentContext, incidentHash, type IncidentReader, type IncidentBinding, type IncidentContext, type IncidentRead } from "@/lib/sav/cases/investigation-incidents-contract";
import { isTemporaryIncidentApproved, selectTemporaryIncident, temporaryIncidentSchema } from "./temporary-incidents";
import { canonicalKnowledgeSchema } from "./contracts";

/** Exact SAV projection of a source already selected for this request, never a keyword/category lookup. */
export type IncidentProjection = { knowledgeId: string; contentVersionId: string; projectionRevisionId: string; familyId: string;
  approvedRevisionId: string | null; revisionId: string | null; revision: number | null; canonicalHash: string | null;
  reviewState: string | null; reviewedBy: string | null; reviewedAt: Date | null; document: unknown };
type ProjectionPort = (bindings: IncidentBinding[]) => Promise<IncidentProjection[]>;

export function createTemporaryIncidentReader(read: ProjectionPort): IncidentReader {
  return async (raw, now): Promise<IncidentRead> => {
    if (!Array.isArray(raw) || !Number.isFinite(now.getTime())) return { ok: false, problem: "invalid" };
    if (raw.length > INCIDENT_RUNTIME_LIMIT) return { ok: false, problem: "scope_limit" };
    const bindings: IncidentBinding[] = [];
    try {
      for (const value of raw) {
        const binding = incidentBindingSchema.parse(value);
        if (!bindings.some(row => JSON.stringify(row) === JSON.stringify(binding))) bindings.push(binding);
      }
      bindings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    } catch { return { ok: false, problem: "invalid" }; }
    if (!bindings.length) return { ok: true, context: incidentContext([], [], "scope_missing") };
    let rows: IncidentProjection[];
    try { rows = await read(bindings); } catch { return { ok: false, problem: "read_failed" }; }
    if (!Array.isArray(rows)) return { ok: false, problem: "read_failed" };
    if (rows.length > INCIDENT_RUNTIME_LIMIT) return { ok: false, problem: "scope_limit" };
    const entries: IncidentContext["entries"] = [];
    let bound = false;
    for (const binding of bindings) {
      const matches = rows.filter(row => row.knowledgeId === binding.knowledgeId && row.contentVersionId === binding.contentVersionId);
      if (matches.length > 1) return { ok: false, problem: "conflict" };
      const row = matches[0];
      if (!row || !row.approvedRevisionId || row.projectionRevisionId !== row.approvedRevisionId || row.revisionId !== row.approvedRevisionId) continue;
      const approved = isTemporaryIncidentApproved({ approved: true, reviewState: row.reviewState ?? "", reviewedBy: row.reviewedBy });
      if (!approved || !row.reviewedAt || row.reviewedAt.getTime() > now.getTime()) continue;
      bound = true;
      const canonical = canonicalKnowledgeSchema.safeParse(row.document);
      if (!canonical.success) return { ok: false, problem: "invalid" };
      const rawIncident = canonical.data.temporaryIncident;
      if (rawIncident === undefined) continue;
      const parsed = temporaryIncidentSchema.safeParse(rawIncident);
      if (!parsed.success || !row.revision || !row.canonicalHash) return { ok: false, problem: "invalid" };
      const incident = parsed.data;
      // Product area is descriptive data of this exact approved canonical family. No product label is inferred from a mail.
      const selected = selectTemporaryIncident([{ incident, review: { approved: true, reviewState: row.reviewState!, reviewedBy: row.reviewedBy } }],
        { family: binding.family, productArea: incident.scope.productArea, now });
      if (selected.kind === "invalid" || selected.kind === "ambiguous") return { ok: false, problem: "conflict" };
      if (selected.kind !== "apply") continue;
      const proof = { requestId: binding.requestId, knowledgeId: binding.knowledgeId, contentVersionId: binding.contentVersionId, familyId: row.familyId,
        canonicalRevisionId: row.revisionId!, canonicalRevision: row.revision, canonicalHash: row.canonicalHash,
        approvalHash: incidentHash({ state: row.reviewState, reviewer: row.reviewedBy, at: row.reviewedAt.toISOString() }),
        incidentId: incident.id, incidentRevision: incident.revision, incidentHash: incidentHash(incident) };
      const previous = entries.find(entry => entry.proof.requestId === binding.requestId);
      if (previous && previous.proof.incidentHash !== proof.incidentHash) return { ok: false, problem: "conflict" };
      entries.push({ proof, title: incident.title, productArea: incident.scope.productArea, reply: selected.reply, fixLevel: incident.fix.level,
        fixStatement: selected.fixStatement, infoToCollect: selected.infoToCollect, validUntil: selected.validUntil, grantsActions: false });
    }
    return { ok: true, context: incidentContext(bindings, entries, entries.length ? "bound" : bound ? "not_applicable" : "scope_missing") };
  };
}

/** Bounded SELECT only: current approved canonical revision joined to the EXACT SAV item/version projection. */
export const readRuntimeTemporaryIncidents: IncidentReader = createTemporaryIncidentReader(async bindings => {
  return requireDb().transaction(async tx => {
    const rows = await tx.select({ knowledgeId: knowledgeProjections.itemId, contentVersionId: knowledgeProjections.versionId,
      projectionRevisionId: knowledgeProjections.revisionId, familyId: knowledgeFamilies.id, approvedRevisionId: knowledgeFamilies.approvedRevisionId,
      revisionId: knowledgeFamilyRevisions.id, revision: knowledgeFamilyRevisions.revision, canonicalHash: knowledgeFamilyRevisions.canonicalHash,
      reviewState: knowledgeFamilyRevisions.reviewState, reviewedBy: knowledgeFamilyRevisions.reviewedBy, reviewedAt: knowledgeFamilyRevisions.reviewedAt,
      document: knowledgeFamilyRevisions.document }).from(knowledgeProjections)
      .innerJoin(knowledgeFamilies, eq(knowledgeFamilies.id, knowledgeProjections.familyId))
      .leftJoin(knowledgeFamilyRevisions, and(eq(knowledgeFamilyRevisions.id, knowledgeFamilies.approvedRevisionId), eq(knowledgeFamilyRevisions.familyId, knowledgeFamilies.id)))
      .where(and(eq(knowledgeProjections.surface, "sav"), or(...bindings.map(row => and(eq(knowledgeProjections.itemId, row.knowledgeId),
        eq(knowledgeProjections.versionId, row.contentVersionId)))))).limit(INCIDENT_RUNTIME_LIMIT + 1);
    return rows;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
});
