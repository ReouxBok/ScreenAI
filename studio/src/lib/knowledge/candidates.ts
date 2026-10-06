import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, contentItems, contentVersions, knowledgeFamilies, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjectionCandidates, knowledgeProjections, savLearningCandidates, savResolutionEvidence } from "@/db/schema";
import { parseContentInput, articleMetadataSchema, onboardingMetadataSchema, type ContentInput } from "@/lib/content";
import { savContentHash } from "@/lib/sav/crypto";
import { registerCanonicalKnowledge, findCanonicalFamilyForItem } from "./families";
import { canonicalFromOnboarding, canonicalFromSav, publicKnowledgeText, savProjectionBody } from "./conversion";

async function sourceContent(itemId: string, versionId: string) {
  const [row] = await requireDb().select({ item: contentItems, version: contentVersions }).from(contentItems)
    .innerJoin(contentVersions, eq(contentVersions.itemId, contentItems.id)).where(and(eq(contentItems.id, itemId), eq(contentVersions.id, versionId))).limit(1);
  if (!row) throw new Error("KNOWLEDGE_SOURCE_VERSION_MISMATCH");
  return row;
}

export async function storeCandidate(input: {
  familyId: string; revisionId: string; sourceId: string; targetSurface: "sav" | "onboarding";
  status: "pending" | "needs_recording" | "not_applicable"; explanation: string; proposedInput: ContentInput | null;
}, actorEmail: string) {
  return requireDb().transaction(async (tx) => {
    // The family lock serializes deduplication and competing source conversions.
    await tx.select({ id: knowledgeFamilies.id }).from(knowledgeFamilies).where(eq(knowledgeFamilies.id, input.familyId)).for("update");
    const projections = await tx.select({ projection: knowledgeProjections, item: contentItems }).from(knowledgeProjections)
      .innerJoin(contentItems, eq(contentItems.id, knowledgeProjections.itemId)).where(and(eq(knowledgeProjections.familyId, input.familyId), eq(knowledgeProjections.surface, input.targetSurface))).orderBy(desc(knowledgeProjections.createdAt));
    const targets = new Map(projections.map((row) => [row.item.id, row]));
    if (targets.size > 1) throw new Error("KNOWLEDGE_TARGET_PROJECTION_AMBIGUOUS");
    if (projections.some((row) => row.projection.revisionId === input.revisionId && row.item.status !== "archived")) return { disposition: "already_projected" as const, candidate: null };
    const target = projections[0]?.item;
    const baseVersionId = target?.currentDraftVersionId ?? target?.publishedVersionId ?? null;
    const [base] = baseVersionId ? await tx.select().from(contentVersions).where(eq(contentVersions.id, baseVersionId)).limit(1) : [];
    const proposedInput = input.proposedInput ? parseContentInput({ ...input.proposedInput, ...(target ? { slug: target.slug, title: target.title, ownerEmail: target.ownerEmail } : {}) }) : {};
    const [created] = await tx.insert(knowledgeProjectionCandidates).values({ familyId: input.familyId, revisionId: input.revisionId, sourceId: input.sourceId,
      targetSurface: input.targetSurface, targetItemId: target?.id, baseVersionId, status: input.status, explanation: input.explanation,
      proposedInput, diff: { before: base?.bodyMarkdown ?? "", after: "bodyMarkdown" in proposedInput ? String(proposedInput.bodyMarkdown) : "" }, createdBy: actorEmail,
    }).onConflictDoNothing().returning();
    if (created) await tx.insert(auditLogs).values({ actorEmail, action: "knowledge_projection_proposed", entityType: "knowledge_candidate", entityId: created.id, technicalMetadata: { familyId: input.familyId, targetSurface: input.targetSurface, status: input.status } });
    const [existing] = created ? [created] : await tx.select().from(knowledgeProjectionCandidates).where(and(eq(knowledgeProjectionCandidates.revisionId, input.revisionId), eq(knowledgeProjectionCandidates.targetSurface, input.targetSurface))).limit(1);
    return { disposition: "candidate" as const, candidate: existing };
  });
}

export async function proposeSavFromOnboarding(itemId: string, versionId: string, actorEmail: string) {
  const { item, version } = await sourceContent(itemId, versionId);
  if (item.type !== "onboarding") throw new Error("KNOWLEDGE_ONBOARDING_SOURCE_REQUIRED");
  const metadata = onboardingMetadataSchema.parse(version.metadata);
  const existing = await findCanonicalFamilyForItem(item.id);
  const familyKey = existing?.canonicalKey ?? `content:${item.id}`;
  const conversion = canonicalFromOnboarding(familyKey, metadata, item.locale);
  const trainingSessionId = typeof metadata.sourceMetadata?.trainingSessionId === "string" ? metadata.sourceMetadata.trainingSessionId : null;
  const registered = await registerCanonicalKnowledge({ canonicalKey: familyKey, title: publicKnowledgeText(item.title), document: conversion.document,
    source: { ref: trainingSessionId ? `training:${trainingSessionId}` : `content:${item.id}`, hash: savContentHash({ body: version.bodyMarkdown, metadata: version.metadata }), versionId,
      evidence: { trainingSessionId, sourceItemId: item.id, sourceVersionId: version.id } },
    projection: { surface: "onboarding", itemId, versionId, technicalBindings: conversion.bindings },
  }, actorEmail);
  const document = conversion.document;
  const proposedInput = conversion.applicable ? parseContentInput({ type: "article", slug: `sav-${registered.family.id}`, locale: item.locale,
    title: publicKnowledgeText(item.title), summary: document.objective, categorySlug: "depannage", visibility: "charly_only", agentKey: "sav", ownerEmail: actorEmail,
    bodyMarkdown: savProjectionBody(document), changeNote: "Projection SAV proposée depuis un tutoriel ; validation Ugo requise", metadata: {
      intents: [document.objective], limovaPaths: [], prerequisites: document.prerequisites, expectedResult: document.expectedResult, troubleshooting: document.escalation,
      semanticSteps: document.steps,
      sourceMetadata: { canonicalFamilyId: registered.family.id, canonicalRevisionId: registered.revision.id, canonicalObjective: document.objective, trainingSessionId, sourceVersionId: version.id },
      resolution: { symptoms: [document.objective], steps: document.steps.map((step) => step.instruction), exceptions: document.exceptions, escalation: document.escalation, productVersion: document.productVersion, supersedes: [], conflictsWith: [] },
    } }) : null;
  return storeCandidate({ familyId: registered.family.id, revisionId: registered.revision.id, sourceId: registered.source.id, targetSurface: "sav", status: conversion.applicable ? "pending" : "not_applicable", explanation: conversion.explanation, proposedInput }, actorEmail);
}

/** A human-reviewed resolution is evidence for a candidate, not publication. */
export async function proposeOnboardingFromSav(candidateId: string, actorEmail: string) {
  const db = requireDb();
  const [learning] = await db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id, candidateId)).limit(1);
  if (!learning || learning.status !== "approved" || !learning.reviewedBy || !learning.reviewedAt || !learning.contentItemId) throw new Error("KNOWLEDGE_HUMAN_VALIDATED_RESOLUTION_REQUIRED");
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, learning.contentItemId)).limit(1);
  if (!item || item.type !== "article" || item.agentKey !== "sav") throw new Error("KNOWLEDGE_SAV_SOURCE_REQUIRED");
  const [reviewedEvidence] = await db.select().from(savResolutionEvidence).where(and(eq(savResolutionEvidence.itemId, item.id), eq(savResolutionEvidence.sourceRef, learning.sourceRef), eq(savResolutionEvidence.outcome, "human_resolution"))).orderBy(desc(savResolutionEvidence.createdAt)).limit(1);
  if (!reviewedEvidence) throw new Error("KNOWLEDGE_REVIEWED_VERSION_EVIDENCE_REQUIRED");
  // A later, unreviewed edit of the article must not masquerade as a resolution.
  const { version } = await sourceContent(item.id, reviewedEvidence.versionId);
  const metadata = articleMetadataSchema.parse(version.metadata);
  if (!metadata.resolution?.steps.length) throw new Error("KNOWLEDGE_RESOLUTION_STEPS_REQUIRED");
  const existing = await findCanonicalFamilyForItem(item.id);
  const familyKey = existing?.canonicalKey ?? `content:${item.id}`;
  const objective = typeof metadata.sourceMetadata?.canonicalObjective === "string" ? metadata.sourceMetadata.canonicalObjective : item.title;
  const conversion = canonicalFromSav(familyKey, metadata, item.locale, objective);
  const registered = await registerCanonicalKnowledge({ canonicalKey: familyKey, title: publicKnowledgeText(item.title), document: conversion.document,
    source: { ref: `sav-learning:${learning.id}`, hash: savContentHash({ body: version.bodyMarkdown, metadata: version.metadata }), versionId: version.id,
      evidence: { learningCandidateId: learning.id, ticketIds: learning.evidenceTicketIds, sourceRef: learning.sourceRef, reviewedBy: learning.reviewedBy, reviewedAt: learning.reviewedAt.toISOString(), sourceVersionId: version.id } },
    projection: { surface: "sav", itemId: item.id, versionId: version.id },
  }, actorEmail);
  const document = conversion.document;
  // No selectors, routes or executable actions are invented from written support.
  const proposedInput = conversion.applicable ? parseContentInput({ type: "onboarding", slug: `onboarding-${registered.family.id}`, locale: item.locale,
    title: publicKnowledgeText(item.title), summary: document.objective, categorySlug: "bien-demarrer", visibility: "charly_only", agentKey: "charly", ownerEmail: actorEmail,
    bodyMarkdown: `${savProjectionBody(document)}\n\n## Démonstration requise\n\nCe candidat n’est pas exécutable. Enregistrer le parcours réel et faire valider les cibles, les résultats et la connaissance par Ugo.`,
    changeNote: "Parcours candidat depuis une résolution humaine ; tutoriel requis", metadata: { objective: document.objective, proposalSignals: [document.objective], qualificationQuestions: [], expectedPages: [], successCriteria: [document.expectedResult || "Résultat à confirmer pendant la démonstration."], branches: [], fallbacks: [document.escalation], actionSteps: [], semanticSteps: document.steps,
      sourceMetadata: { canonicalFamilyId: registered.family.id, canonicalRevisionId: registered.revision.id, canonicalObjective: document.objective, needsRecording: true, learningCandidateId: learning.id, sourceVersionId: version.id } } }) : null;
  return storeCandidate({ familyId: registered.family.id, revisionId: registered.revision.id, sourceId: registered.source.id, targetSurface: "onboarding", status: conversion.applicable ? "needs_recording" : "not_applicable", explanation: conversion.explanation, proposedInput }, actorEmail);
}

export async function listKnowledgeProjectionCandidates(limit = 100) {
  const db = requireDb();
  const rows = await db.select({ candidate: knowledgeProjectionCandidates, family: knowledgeFamilies, revision: knowledgeFamilyRevisions, source: knowledgeFamilySources })
    .from(knowledgeProjectionCandidates).innerJoin(knowledgeFamilies, eq(knowledgeFamilies.id, knowledgeProjectionCandidates.familyId))
    .innerJoin(knowledgeFamilyRevisions, eq(knowledgeFamilyRevisions.id, knowledgeProjectionCandidates.revisionId))
    .innerJoin(knowledgeFamilySources, eq(knowledgeFamilySources.id, knowledgeProjectionCandidates.sourceId))
    .orderBy(desc(knowledgeProjectionCandidates.createdAt)).limit(Math.max(1, Math.min(250, limit)));
  return rows.map((row) => ({ ...row, canonicalKey: row.family.canonicalKey }));
}
