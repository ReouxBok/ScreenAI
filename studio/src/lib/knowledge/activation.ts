import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { activeKnowledge, auditLogs, contentChunks, contentItems, contentVersions, knowledgeRevisions, savKnowledgeActivations, savKnowledgePublicationAttempts, savLearningCandidates, savResolutionEvidence } from "@/db/schema";
import { assertKnowledgeUgoApproval } from "./contracts";
import { assertOnboardingPublicationSource } from "./onboarding-import";
import { publish } from "@/lib/workflow";
import { closeSavLearningReservationTx } from "@/lib/sav/learning-admission";

/** Publication indexes a reviewed version; activation remains a separate Ugo decision. */
export async function publishSavKnowledgeVersion(input: { itemId: string; expectedVersionId: string }, actorEmail: string) {
  assertKnowledgeUgoApproval(actorEmail);
  const db = requireDb();
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, input.itemId));
  if (!item || item.slug === "sav-master-playbook" || item.agentKey !== "sav" || item.type !== "article") throw new Error("SAV_KNOWLEDGE_SCOPE_REQUIRED");
  const [version] = await db.select().from(contentVersions).where(and(eq(contentVersions.id, input.expectedVersionId), eq(contentVersions.itemId, item.id)));
  if (!version || item.currentDraftVersionId !== version.id) throw new Error("KNOWLEDGE_REVIEW_STALE");
  if (item.publishedVersionId === version.id && item.status === "published") {
    const [current] = await db.select().from(activeKnowledge).where(eq(activeKnowledge.singleton, true));
    return { revision: current?.revisionId ?? "kb_empty" };
  }
  const attempt = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(contentItems).where(eq(contentItems.id, item.id)).for("update");
    if (current.currentDraftVersionId !== version.id || current.status !== "in_review") throw new Error("KNOWLEDGE_REVIEW_STALE");
    const [pending] = await tx.select().from(savKnowledgePublicationAttempts).where(and(eq(savKnowledgePublicationAttempts.itemId, item.id), eq(savKnowledgePublicationAttempts.status, "indexing"))).orderBy(desc(savKnowledgePublicationAttempts.createdAt)).limit(1);
    if (pending && pending.createdAt.getTime() > Date.now() - 10 * 60_000) throw new Error("KNOWLEDGE_PUBLICATION_PENDING");
    if (pending) await tx.update(savKnowledgePublicationAttempts).set({ status: "failed", errorCode: "KNOWLEDGE_PUBLICATION_INTERRUPTED", completedAt: new Date() }).where(eq(savKnowledgePublicationAttempts.id, pending.id));
    const [created] = await tx.insert(savKnowledgePublicationAttempts).values({ itemId: item.id, versionId: input.expectedVersionId, status: "indexing", actorEmail }).returning();
    return created;
  });
  try {
    const result = await publish(item.id, actorEmail, { expectedVersionId: input.expectedVersionId });
    await db.update(savKnowledgePublicationAttempts).set({ status: "published", completedAt: new Date() }).where(eq(savKnowledgePublicationAttempts.id, attempt.id));
    return result;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "KNOWLEDGE_INDEXING_FAILED";
    await db.update(savKnowledgePublicationAttempts).set({ status: "failed", errorCode: code, completedAt: new Date() }).where(eq(savKnowledgePublicationAttempts.id, attempt.id));
    throw error;
  }
}

export async function activateSavKnowledgeVersion(input: { itemId: string; expectedPublishedVersionId: string; expectedActiveVersionId: string | null }, actorEmail: string) {
  assertKnowledgeUgoApproval(actorEmail);
  return requireDb().transaction(async (tx) => {
    const [requested] = await tx.select().from(contentVersions).where(and(eq(contentVersions.id, input.expectedPublishedVersionId), eq(contentVersions.itemId, input.itemId)));
    if (!requested) throw new Error("VERSION_NOT_INDEXED");
    const { assertWorkspacePublicationSource } = await import("./proposals");
    await assertWorkspacePublicationSource(requested.metadata, tx, true);
    const [item] = await tx.select().from(contentItems).where(eq(contentItems.id, input.itemId)).for("update");
    if (!item || item.slug === "sav-master-playbook" || item.agentKey !== "sav" || item.type !== "article" || item.status === "archived") throw new Error("SAV_KNOWLEDGE_SCOPE_REQUIRED");
    const [active] = await tx.select().from(savKnowledgeActivations).where(eq(savKnowledgeActivations.itemId, item.id));
    if (item.publishedVersionId !== input.expectedPublishedVersionId || (active?.versionId ?? null) !== input.expectedActiveVersionId) throw new Error("KNOWLEDGE_ACTIVATION_STALE");
    const [version] = await tx.select().from(contentVersions).where(and(eq(contentVersions.id, input.expectedPublishedVersionId), eq(contentVersions.itemId, item.id)));
    const [chunk] = await tx.select({ id: contentChunks.id }).from(contentChunks).where(and(eq(contentChunks.itemId, item.id), eq(contentChunks.versionId, input.expectedPublishedVersionId))).limit(1);
    if (!version || !chunk) throw new Error("VERSION_NOT_INDEXED");
    await assertOnboardingPublicationSource(version.metadata, tx, true);
    await assertWorkspacePublicationSource(version.metadata, tx, true);
    const title = typeof version.metadata.sourceMetadata?.sourceTitle === "string" ? version.metadata.sourceMetadata.sourceTitle : typeof version.metadata.sourceMetadata?.knowledgeTitle === "string" ? version.metadata.sourceMetadata.knowledgeTitle : item.title;
    const values = { itemId: item.id, versionId: version.id, title, activatedBy: actorEmail, activatedAt: new Date() };
    await tx.insert(savKnowledgeActivations).values(values).onConflictDoUpdate({ target: savKnowledgeActivations.itemId, set: values });
    // Activating an older/unrelated version does not activate a pending amendment.
    const learned = await tx.select({ id: savLearningCandidates.id }).from(savLearningCandidates)
      .innerJoin(savResolutionEvidence, and(eq(savResolutionEvidence.sourceRef, savLearningCandidates.sourceRef), eq(savResolutionEvidence.itemId, item.id), eq(savResolutionEvidence.versionId, version.id), eq(savResolutionEvidence.outcome, "human_resolution")))
      .where(and(eq(savLearningCandidates.contentItemId, item.id), eq(savLearningCandidates.status, "approved")));
    for (const candidate of learned) await closeSavLearningReservationTx(tx, candidate.id);
    await tx.update(contentItems).set({ aiEnabled: true, updatedAt: new Date() }).where(eq(contentItems.id, item.id));
    const revision = `kb_sav_activation_${crypto.randomUUID()}`;
    await tx.insert(knowledgeRevisions).values({ id: revision, actorEmail });
    await tx.insert(activeKnowledge).values({ singleton: true, revisionId: revision }).onConflictDoUpdate({ target: activeKnowledge.singleton, set: { revisionId: revision, updatedAt: new Date() } });
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_knowledge_version_activated", entityType: "content", entityId: item.id, technicalMetadata: { versionId: version.id, previousVersionId: active?.versionId ?? null } });
    return values;
  });
}
