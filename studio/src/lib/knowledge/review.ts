import "server-only";
import { and, eq, max } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, categories, contentItems, contentVersions, knowledgeFamilies, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjectionCandidates, knowledgeProjections, reviewEvents } from "@/db/schema";
import { parseContentInput } from "@/lib/content";
import { savContentHash } from "@/lib/sav/crypto";
import { assertKnowledgeUgoApproval, canonicalKnowledgeSchema } from "./contracts";
import { savProjectionBody } from "./conversion";
import { hubspotComparison, knowledgeComparisonInventory } from "./hubspot-import";

/** Approval creates an in-review SAV draft, never publishes or edits Chrome. */
export async function reviewKnowledgeCandidate(candidateId: string, input: { expectedRevisionId: string; decision: "approve" | "reject"; reason: string; document?: unknown; comparison?: { snapshot: string; acknowledged: boolean } }, actorEmail: string) {
  assertKnowledgeUgoApproval(actorEmail);
  if (input.reason.trim().length < 10) throw new Error("KNOWLEDGE_REVIEW_REASON_REQUIRED");
  return requireDb().transaction(async (tx) => {
    const [candidate] = await tx.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, candidateId)).for("update");
    if (!candidate || candidate.revisionId !== input.expectedRevisionId) throw new Error("KNOWLEDGE_CANDIDATE_STALE");
    if (candidate.status === "approved" && input.decision === "approve") return candidate;
    if (!["pending", "needs_recording", "not_applicable"].includes(candidate.status)) throw new Error("KNOWLEDGE_CANDIDATE_NOT_REVIEWABLE");
    if (input.decision === "reject") {
      const [updated] = await tx.update(knowledgeProjectionCandidates).set({ status: "rejected", reviewedBy: actorEmail, reviewedAt: new Date() }).where(eq(knowledgeProjectionCandidates.id, candidate.id)).returning();
      await tx.insert(auditLogs).values({ actorEmail, action: "knowledge_candidate_rejected", entityType: "knowledge_candidate", entityId: candidate.id, technicalMetadata: { revisionId: candidate.revisionId, sourceId: candidate.sourceId, reason: input.reason } });
      return updated;
    }
    if (candidate.targetSurface !== "sav" || candidate.status !== "pending") throw new Error("KNOWLEDGE_RECORDING_REQUIRED");
    await tx.select().from(knowledgeFamilies).where(eq(knowledgeFamilies.id, candidate.familyId)).for("update");
    const [originalRevision] = await tx.select().from(knowledgeFamilyRevisions).where(and(eq(knowledgeFamilyRevisions.id, candidate.revisionId), eq(knowledgeFamilyRevisions.familyId, candidate.familyId)));
    const [source] = await tx.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
    if (!originalRevision || !source) throw new Error("KNOWLEDGE_PROVENANCE_REQUIRED");
    let comparisonReview;
    if (source.evidence.importKind === "hubspot") {
      if (!input.comparison?.acknowledged) throw new Error("HUBSPOT_COMPARISON_REVIEW_REQUIRED");
      const comparison = hubspotComparison(candidate, await knowledgeComparisonInventory(tx));
      if (input.comparison.snapshot !== comparison.snapshot) throw new Error("HUBSPOT_COMPARISON_STALE");
      comparisonReview = { snapshot: comparison.snapshot, compared: comparison.compared,
        relatedVersions: comparison.findings.map(({ ref, versionId, signal }) => ({ ref, versionId, signal })),
        reviewedBy: actorEmail, reviewedAt: new Date().toISOString(), reason: input.reason };
    }
    const document = canonicalKnowledgeSchema.parse(input.document ?? originalRevision.document);
    if (!["shared", "sav_only"].includes(document.applicability) || !document.steps.length) throw new Error("KNOWLEDGE_NOT_APPLICABLE_TO_SAV");
    // Contextual variants are kept for review, not flattened into universal advice.
    if (document.steps.some((step) => step.variants.length)) throw new Error("KNOWLEDGE_VARIANT_CONTEXT_REQUIRED");
    if (document.validUntil && document.validUntil < new Date().toISOString().slice(0, 10)) throw new Error("KNOWLEDGE_EXPIRED");
    let revision = originalRevision;
    const hash = savContentHash(document);
    if (hash !== originalRevision.canonicalHash) {
      [revision] = await tx.select().from(knowledgeFamilyRevisions).where(and(eq(knowledgeFamilyRevisions.familyId, candidate.familyId), eq(knowledgeFamilyRevisions.canonicalHash, hash)));
      if (!revision) {
        const [{ latest }] = await tx.select({ latest: max(knowledgeFamilyRevisions.revision) }).from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.familyId, candidate.familyId));
        [revision] = await tx.insert(knowledgeFamilyRevisions).values({ familyId: candidate.familyId, revision: (latest ?? 0) + 1, canonicalHash: hash, document }).returning();
      }
    }
    const original = parseContentInput(candidate.proposedInput);
    const proposed = parseContentInput({ ...original, summary: document.objective, bodyMarkdown: savProjectionBody(document), metadata: {
      ...original.metadata, semanticSteps: document.steps, prerequisites: document.prerequisites, expectedResult: document.expectedResult, troubleshooting: document.escalation,
      sourceMetadata: { ...original.metadata.sourceMetadata, canonicalRevisionId: revision.id, canonicalObjective: document.objective, approvedCandidateId: candidate.id, ...(comparisonReview ? { comparisonReview } : {}) },
      resolution: { symptoms: document.supportContext?.symptoms ?? [document.objective], steps: document.steps.map((step) => step.instruction), exceptions: document.exceptions, escalation: document.escalation, productVersion: document.productVersion, ...(document.validUntil ? { validUntil: document.validUntil } : {}), supersedes: [], conflictsWith: [] },
    } });
    if (comparisonReview && proposed.bodyMarkdown.length > 12_000) throw new Error("HUBSPOT_PROCEDURE_TOO_LONG");
    const [category] = await tx.select().from(categories).where(eq(categories.slug, proposed.categorySlug));
    if (!category) throw new Error("CATEGORY_NOT_FOUND");
    let item;
    if (candidate.targetItemId) {
      [item] = await tx.select().from(contentItems).where(eq(contentItems.id, candidate.targetItemId)).for("update");
      if (!item || item.type !== "article" || item.agentKey !== "sav" || (item.currentDraftVersionId ?? item.publishedVersionId) !== candidate.baseVersionId) throw new Error("KNOWLEDGE_TARGET_STALE");
    } else {
      [item] = await tx.insert(contentItems).values({ slug: proposed.slug, type: "article", locale: proposed.locale, title: proposed.title, summary: proposed.summary, categoryId: category.id, visibility: proposed.visibility, agentKey: "sav", ownerEmail: proposed.ownerEmail }).returning();
    }
    const [{ latestVersion }] = await tx.select({ latestVersion: max(contentVersions.version) }).from(contentVersions).where(eq(contentVersions.itemId, item.id));
    const [version] = await tx.insert(contentVersions).values({ itemId: item.id, version: (latestVersion ?? 0) + 1, bodyMarkdown: proposed.bodyMarkdown, metadata: proposed.metadata, changeNote: input.reason, authorEmail: actorEmail }).returning();
    await tx.update(contentItems).set({ currentDraftVersionId: version.id, status: "in_review", updatedAt: new Date() }).where(eq(contentItems.id, item.id));
    await tx.update(knowledgeFamilyRevisions).set({ reviewState: "approved", reviewedBy: actorEmail, reviewedAt: new Date() }).where(eq(knowledgeFamilyRevisions.id, revision.id));
    await tx.update(knowledgeFamilies).set({ approvedRevisionId: revision.id }).where(eq(knowledgeFamilies.id, candidate.familyId));
    await tx.insert(knowledgeProjections).values({ familyId: candidate.familyId, revisionId: revision.id, surface: "sav", itemId: item.id, versionId: version.id });
    // Original provenance remains immutable even if Ugo corrects the canonical document.
    await tx.insert(reviewEvents).values({ itemId: item.id, versionId: version.id, action: "submitted", actorEmail, comment: input.reason });
    const diff = { before: candidate.diff.before, after: proposed.bodyMarkdown };
    const [updated] = await tx.update(knowledgeProjectionCandidates).set({ status: "approved", targetItemId: item.id, materializedVersionId: version.id, proposedInput: proposed, diff, reviewedBy: actorEmail, reviewedAt: new Date() }).where(eq(knowledgeProjectionCandidates.id, candidate.id)).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "knowledge_candidate_approved", entityType: "knowledge_candidate", entityId: candidate.id, technicalMetadata: { sourceId: source.id, sourceVersionId: source.sourceVersionId, originalRevisionId: originalRevision.id, approvedRevisionId: revision.id, versionId: version.id, diff: JSON.stringify(diff), canonicalBefore: JSON.stringify(originalRevision.document), canonicalAfter: JSON.stringify(document), reason: input.reason } });
    return updated;
  });
}
