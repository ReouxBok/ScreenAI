import "server-only";
import { and, desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, contentItems, contentVersions, knowledgeFamilies, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjections } from "@/db/schema";
import { savContentHash } from "@/lib/sav/crypto";
import { canonicalKnowledgeSchema } from "./contracts";

const registrationSchema = z.object({
  canonicalKey: z.string().trim().min(3).max(200), title: z.string().trim().min(1).max(500), document: canonicalKnowledgeSchema,
  versionBySource: z.boolean().default(false),
  source: z.object({ ref: z.string().trim().min(3).max(500), hash: z.string().regex(/^(?:[A-Za-z0-9_-]{43}|[a-f0-9]{64})$/), versionId: z.uuid().optional(), evidence: z.record(z.string(), z.unknown()).default({}) }),
  projection: z.object({ surface: z.enum(["sav", "onboarding"]), itemId: z.uuid(), versionId: z.uuid(), technicalBindings: z.array(z.object({ semanticStepId: z.string(), actionOrder: z.number().int().min(1).max(100) }).strict()).max(50).default([]) }).optional(),
});

export async function registerCanonicalKnowledge(rawInput: unknown, actorEmail: string) {
  const input = registrationSchema.parse(rawInput);
  const canonicalHash = savContentHash(input.versionBySource ? { document: input.document, sourceHash: input.source.hash } : input.document);
  return requireDb().transaction(async (tx) => {
    if (input.projection) {
      const [version] = await tx.select({ version: contentVersions, item: contentItems }).from(contentVersions)
        .innerJoin(contentItems, eq(contentItems.id, contentVersions.itemId)).where(eq(contentVersions.id, input.projection.versionId)).limit(1);
      if (!version || version.item.id !== input.projection.itemId) throw new Error("KNOWLEDGE_PROJECTION_VERSION_MISMATCH");
      if ((input.projection.surface === "sav" && (version.item.type !== "article" || version.item.agentKey !== "sav"))
        || (input.projection.surface === "onboarding" && version.item.type !== "onboarding")) throw new Error("KNOWLEDGE_PROJECTION_TYPE_MISMATCH");
      const steps = new Set(input.document.steps.map((step) => step.id));
      if (input.projection.technicalBindings.some((binding) => !steps.has(binding.semanticStepId))) throw new Error("KNOWLEDGE_UNKNOWN_SEMANTIC_BINDING");
      if (input.projection.surface === "sav" && input.projection.technicalBindings.length) throw new Error("KNOWLEDGE_SAV_DOM_FORBIDDEN");
      if (input.projection.surface === "onboarding") {
        const metadata = version.version.metadata as { actionSteps?: Array<{ order: number }> };
        const recordedOrders = new Set((metadata.actionSteps ?? []).map((action) => action.order));
        if (input.projection.technicalBindings.some((binding) => !recordedOrders.has(binding.actionOrder))) throw new Error("KNOWLEDGE_UNRECORDED_ACTION_BINDING");
      }
    }
    await tx.insert(knowledgeFamilies).values({ canonicalKey: input.canonicalKey, title: input.title, createdBy: actorEmail }).onConflictDoNothing();
    const [family] = await tx.select().from(knowledgeFamilies).where(eq(knowledgeFamilies.canonicalKey, input.canonicalKey)).for("update");
    // Preserve old imports and their decisions when retrying after evidence versioning was introduced.
    const [existingSource] = input.versionBySource ? await tx.select().from(knowledgeFamilySources).where(and(eq(knowledgeFamilySources.familyId, family.id), eq(knowledgeFamilySources.sourceRef, input.source.ref), eq(knowledgeFamilySources.sourceHash, input.source.hash))).limit(1) : [];
    let [revision] = await tx.select().from(knowledgeFamilyRevisions).where(and(eq(knowledgeFamilyRevisions.familyId, family.id), existingSource ? eq(knowledgeFamilyRevisions.id, existingSource.revisionId) : eq(knowledgeFamilyRevisions.canonicalHash, canonicalHash))).limit(1);
    if (existingSource && (!revision || savContentHash(canonicalKnowledgeSchema.parse(revision.document)) !== savContentHash(input.document))) throw new Error("KNOWLEDGE_SOURCE_MAPPING_CONFLICT");
    if (!revision) {
      const [{ value }] = await tx.select({ value: max(knowledgeFamilyRevisions.revision) }).from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.familyId, family.id));
      [revision] = await tx.insert(knowledgeFamilyRevisions).values({ familyId: family.id, revision: (value ?? 0) + 1, canonicalHash, document: input.document }).returning();
      await tx.insert(auditLogs).values({ actorEmail, action: "knowledge_revision_proposed", entityType: "knowledge_family", entityId: family.id, technicalMetadata: { revisionId: revision.id, canonicalHash } });
    }
    await tx.insert(knowledgeFamilySources).values({ familyId: family.id, revisionId: revision.id, sourceRef: input.source.ref, sourceHash: input.source.hash, sourceVersionId: input.source.versionId, evidence: input.source.evidence }).onConflictDoNothing();
    const [source] = await tx.select().from(knowledgeFamilySources).where(and(eq(knowledgeFamilySources.familyId, family.id), eq(knowledgeFamilySources.sourceRef, input.source.ref), eq(knowledgeFamilySources.sourceHash, input.source.hash))).limit(1);
    if (source.revisionId !== revision.id) throw new Error("KNOWLEDGE_SOURCE_MAPPING_CONFLICT");
    if (input.projection) {
      const [existing] = await tx.select().from(knowledgeProjections).where(and(eq(knowledgeProjections.itemId, input.projection.itemId), eq(knowledgeProjections.versionId, input.projection.versionId), eq(knowledgeProjections.surface, input.projection.surface))).limit(1);
      if (existing && (existing.familyId !== family.id || existing.revisionId !== revision.id)) throw new Error("KNOWLEDGE_PROJECTION_MAPPING_CONFLICT");
      await tx.insert(knowledgeProjections).values({ familyId: family.id, revisionId: revision.id, ...input.projection }).onConflictDoNothing();
    }
    return { family, revision, source };
  });
}

export async function findCanonicalFamilyForItem(itemId: string) {
  const rows = await requireDb().select({ family: knowledgeFamilies }).from(knowledgeProjections)
    .innerJoin(knowledgeFamilies, eq(knowledgeFamilies.id, knowledgeProjections.familyId)).where(eq(knowledgeProjections.itemId, itemId));
  const unique = new Map(rows.map((row) => [row.family.id, row.family]));
  if (unique.size > 1) throw new Error("KNOWLEDGE_ITEM_FAMILY_AMBIGUOUS");
  return unique.values().next().value ?? null;
}

export async function getCanonicalFamily(familyId: string) {
  const db = requireDb();
  const [family] = await db.select().from(knowledgeFamilies).where(eq(knowledgeFamilies.id, familyId)).limit(1);
  if (!family) throw new Error("KNOWLEDGE_FAMILY_NOT_FOUND");
  const revisions = await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.familyId, familyId)).orderBy(desc(knowledgeFamilyRevisions.revision));
  const sources = await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.familyId, familyId));
  const projections = await db.select().from(knowledgeProjections).where(eq(knowledgeProjections.familyId, familyId));
  return { family, revisions, sources, projections };
}
