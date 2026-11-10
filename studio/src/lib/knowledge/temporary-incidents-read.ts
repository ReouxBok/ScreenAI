import { and, desc, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { knowledgeFamilies, knowledgeFamilyRevisions, knowledgeProjections } from "@/db/schema";
import { isTemporaryIncidentApproved, temporaryIncidentSchema, type TemporaryIncident } from "./temporary-incidents";

type Reader = Pick<ReturnType<typeof requireDb>, "select" | "selectDistinct">;

/** Read-only admin preview (SAV-79). States are reported as observed; nothing here publishes or activates. */
export type TemporaryIncidentPreviewRow = {
  familyId: string; familyTitle: string; revisionId: string; revision: number;
  revisionApproved: boolean; reviewState: string; incidentApproved: boolean; expired: boolean;
  incident: TemporaryIncident | null; errors: string[];
};

export async function listTemporaryIncidentPreview(limit = 100, now: Date = new Date(), db: Reader = requireDb()): Promise<TemporaryIncidentPreviewRow[]> {
  const rows = await db.select({ family: knowledgeFamilies, revision: knowledgeFamilyRevisions }).from(knowledgeFamilyRevisions)
    .innerJoin(knowledgeFamilies, eq(knowledgeFamilies.id, knowledgeFamilyRevisions.familyId))
    .where(sql`${knowledgeFamilyRevisions.document} ? 'temporaryIncident'`)
    .orderBy(desc(knowledgeFamilyRevisions.createdAt)).limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(({ family, revision }) => {
    const parsed = temporaryIncidentSchema.safeParse((revision.document as { temporaryIncident?: unknown }).temporaryIncident);
    const revisionApproved = family.approvedRevisionId === revision.id;
    return { familyId: family.id, familyTitle: family.title, revisionId: revision.id, revision: revision.revision,
      revisionApproved, reviewState: revision.reviewState,
      incidentApproved: isTemporaryIncidentApproved({ approved: revisionApproved, reviewState: revision.reviewState, reviewedBy: revision.reviewedBy }),
      expired: parsed.success ? Date.parse(parsed.data.validUntil) <= now.getTime() : false,
      incident: parsed.success ? parsed.data : null, errors: parsed.success ? [] : [...new Set(parsed.error.issues.map((issue) => issue.message))] };
  });
}

/**
 * SAV-79 R-T1: an improvement draft can be rebuilt from the published version, which never carries
 * the incident. Returns the incident of the approved revision of the item's SAV family so the caller
 * keeps it instead of silently dropping it. Ending an incident goes through revocation or expiry, never omission.
 */
export async function inheritedTemporaryIncident(itemId: string, db: Reader): Promise<TemporaryIncident | undefined> {
  const families = await db.selectDistinct({ id: knowledgeFamilies.id, approvedRevisionId: knowledgeFamilies.approvedRevisionId }).from(knowledgeProjections)
    .innerJoin(knowledgeFamilies, eq(knowledgeFamilies.id, knowledgeProjections.familyId))
    .where(and(eq(knowledgeProjections.itemId, itemId), eq(knowledgeProjections.surface, "sav")));
  if (families.length !== 1 || !families[0].approvedRevisionId) return undefined; // Ambiguity is already refused at submission.
  const [revision] = await db.select({ document: knowledgeFamilyRevisions.document }).from(knowledgeFamilyRevisions)
    .where(eq(knowledgeFamilyRevisions.id, families[0].approvedRevisionId)).limit(1);
  const stored = (revision?.document as { temporaryIncident?: unknown } | undefined)?.temporaryIncident;
  if (stored === undefined) return undefined;
  return temporaryIncidentSchema.parse(stored); // An invalid stored incident fails loudly instead of being dropped.
}
