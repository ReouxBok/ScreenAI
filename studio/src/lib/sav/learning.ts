import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import {
  categories,
  contentItems,
  contentVersions,
  savObservationCycles, savResolutionObservations, savLearningCandidates,
  savResolutionEvidence,
} from "@/db/schema";
import type { ArticleMetadata } from "@/db/schema";
import { saveDraft } from "@/lib/workflow";
import { decryptSavPayload } from "./crypto";
import { proposeOnboardingFromSav } from "@/lib/knowledge/candidates";
import { assertKnowledgeUgoApproval } from "@/lib/knowledge/contracts";
import { closeSavLearningReservationTx } from "./learning-admission";
import { assertSavLearningAdmitted, isSavAutomaticLearning } from "./learning-origin";

type LearningPatch = {
  subject: string;
  finalHumanResolution: string;
  sourceSnapshotId: string;
  provenance?: "human_resolution" | "ai_resolution" | "ticket_content" | "pilot_human_review";
  customerConfirmed?: boolean;
  sourceMessageId?: string | null;
  cycleSourceHash?: string;
  conditions?: string[];
  expectedResult?: string;
  limitations?: string[];
};

function plainText(value: string) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\]\s*\(/g, "] (")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 20_000);
}

function decryptCandidatePatch(proposedPatch: Record<string, unknown>) {
  const ciphertext = proposedPatch.ciphertext;
  if (typeof ciphertext !== "string") throw new Error("SAV_LEARNING_PATCH_INVALID");
  return decryptSavPayload<LearningPatch>(ciphertext);
}
function candidatePatch(candidate: typeof savLearningCandidates.$inferSelect) { return decryptCandidatePatch(candidate.proposedPatch); }

export async function listLearningCandidates(limit = 100) {
  const candidates = await requireDb().select({
    id: savLearningCandidates.id,
    hubspotTicketId: savLearningCandidates.hubspotTicketId,
    contentItemId: savLearningCandidates.contentItemId,
    status: savLearningCandidates.status,
    explanation: savLearningCandidates.explanation,
    evidenceTicketIds: savLearningCandidates.evidenceTicketIds,
    evidenceCaseCount: savLearningCandidates.evidenceCaseCount,
    createdAt: savLearningCandidates.createdAt,
    reviewedBy: savLearningCandidates.reviewedBy,
    reviewedAt: savLearningCandidates.reviewedAt,
    proposedPatch: savLearningCandidates.proposedPatch,
    createdBy: savLearningCandidates.createdBy,
    sourceRef: savLearningCandidates.sourceRef,
    admitted: sql<boolean>`exists(select 1 from sav.learning_admission_attempts attempt where attempt.candidate_id = ${savLearningCandidates.id})`,
    syncLeaseUntil: savResolutionObservations.leaseUntil,
  }).from(savLearningCandidates)
    .leftJoin(savObservationCycles, eq(savLearningCandidates.sourceRef, sql`'sav-observation:' || ${savObservationCycles.id}::text`))
    .leftJoin(savResolutionObservations, eq(savResolutionObservations.id, savObservationCycles.observationId)).orderBy(desc(savLearningCandidates.createdAt)).limit(Math.min(250, Math.max(1, limit)));
  return candidates.map((row) => {
    const { syncLeaseUntil, ...candidate } = row;
    const syncInProgress = Boolean(syncLeaseUntil && syncLeaseUntil > new Date());
    try {
      const patch = decryptCandidatePatch(candidate.proposedPatch);
      return {
        ...candidate,
        proposedPatch: undefined,
        syncInProgress,
        historical: isSavAutomaticLearning(candidate) && !candidate.admitted,
        proposedSubject: plainText(patch.subject).slice(0, 500),
        proposedResolution: plainText(patch.finalHumanResolution).slice(0, 4_000),
        proposedConditions: (patch.conditions ?? []).map((value) => plainText(value).slice(0, 500)),
        proposedExpectedResult: plainText(patch.expectedResult ?? "").slice(0, 500),
        proposedLimitations: (patch.limitations ?? []).map((value) => plainText(value).slice(0, 500)),
        evidenceCaseCount: candidate.evidenceCaseCount,
      };
    } catch {
      return {
        ...candidate,
        proposedPatch: undefined,
        syncInProgress,
        historical: true,
        proposedSubject: "Proposition illisible",
        proposedResolution: "Le contenu chiffré de cette proposition n’a pas pu être relu.",
        proposedConditions: [],
        proposedExpectedResult: "",
        proposedLimitations: [],
      };
    }
  });
}

export async function approveLearningCandidate(candidateId: string, actorEmail: string) {
  assertKnowledgeUgoApproval(actorEmail);
  const result = await requireDb().transaction(async (tx) => {
  const db = tx;
  const [source] = await db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id,candidateId));
  if(source?.sourceRef.startsWith("sav-observation:")) {
    const [cycle] = await db.select().from(savObservationCycles).where(eq(savObservationCycles.id,source.sourceRef.slice("sav-observation:".length)));
    if(cycle) await db.select().from(savResolutionObservations).where(eq(savResolutionObservations.id,cycle.observationId)).for("update");
  }
  const [candidate] = await db.select().from(savLearningCandidates)
    .where(eq(savLearningCandidates.id, candidateId)).for("update");
  if (!candidate) throw new Error("SAV_LEARNING_CANDIDATE_NOT_PENDING");
  if (candidate.status === "pending") await assertSavLearningAdmitted(candidate, db);
  if(candidate.sourceRef.startsWith("sav-observation:")) {
    const patch = candidatePatch(candidate);
    const [cycle]=await db.select().from(savObservationCycles).where(eq(savObservationCycles.id,candidate.sourceRef.slice("sav-observation:".length)));
    const [observation]=cycle?await db.select().from(savResolutionObservations).where(eq(savResolutionObservations.id,cycle.observationId)).for("update"):[];
    if (observation?.leaseUntil && observation.leaseUntil > new Date()) throw new Error("SAV_OBSERVATION_SYNC_IN_PROGRESS");
    if(!cycle || !observation?.closed || cycle.cycle!==observation.cycle || cycle.candidateId!==candidate.id || cycle.qualification!=="resolved" || observation.sourceErrors.length || patch.cycleSourceHash!==cycle.sourceHash)throw new Error("SAV_OBSERVATION_STALE");
  }
  if (candidate.status === "approved" && candidate.contentItemId) {
    const [evidence] = await db.select().from(savResolutionEvidence).where(and(eq(savResolutionEvidence.itemId, candidate.contentItemId), eq(savResolutionEvidence.sourceRef, candidate.sourceRef), eq(savResolutionEvidence.outcome, "human_resolution"))).orderBy(desc(savResolutionEvidence.createdAt)).limit(1);
    if (!evidence) throw new Error("KNOWLEDGE_REVIEWED_VERSION_EVIDENCE_REQUIRED");
    const [item] = await db.select().from(contentItems).where(eq(contentItems.id, candidate.contentItemId)).limit(1);
    const [version] = await db.select().from(contentVersions).where(eq(contentVersions.id, evidence.versionId)).limit(1);
    if (!item || !version) throw new Error("SAV_RESOLUTION_CONTENT_INVALID");
    return { item, version };
  }
  if (candidate.status !== "pending") throw new Error("SAV_LEARNING_CANDIDATE_NOT_PENDING");
  const patch = candidatePatch(candidate);
  const sourceLabel = candidate.hubspotTicketId ? `ticket HubSpot ${candidate.hubspotTicketId}` : `dossier SAV ${candidate.threadId ?? candidate.sourceRef}`;
  const subject = plainText(patch.subject) || `Résolution du ${sourceLabel}`;
  const resolution = plainText(patch.finalHumanResolution);
  const conditions = (patch.conditions ?? []).map(plainText).filter(Boolean);
  const limitations = (patch.limitations ?? []).map(plainText).filter(Boolean);
  const expectedResult = plainText(patch.expectedResult ?? "");
  if (resolution.length < 20) throw new Error("SAV_LEARNING_RESOLUTION_TOO_SHORT");

  let result: Awaited<ReturnType<typeof saveDraft>>;
  if (candidate.contentItemId) {
    const [current] = await db.select({ item: contentItems, version: contentVersions, category: categories })
      .from(contentItems)
      .innerJoin(contentVersions, eq(contentVersions.id, contentItems.currentDraftVersionId))
      .leftJoin(categories, eq(categories.id, contentItems.categoryId))
      .where(eq(contentItems.id, candidate.contentItemId)).limit(1);
    if (!current || current.item.type !== "article") throw new Error("SAV_RESOLUTION_CONTENT_INVALID");
    const metadata = current.version.metadata as ArticleMetadata;
    result = await saveDraft({
      type: "article",
      slug: current.item.slug,
      locale: current.item.locale,
      title: current.item.title,
      summary: current.item.summary,
      categorySlug: current.category?.slug ?? "depannage",
      visibility: current.item.visibility,
      agentKey: "sav",
      ownerEmail: current.item.ownerEmail,
      bodyMarkdown: candidate.sourceRef.startsWith("sav-observation:")
        ? `## Problème observé\n\n${subject}\n\n## Conditions\n\n${conditions.length ? conditions.map((value) => "- " + value).join("\n") : "- À préciser lors de la revue humaine."}\n\n## Solution confirmée par l’équipe\n\n${resolution}\n\n## Résultat attendu\n\n${expectedResult || "À préciser lors de la revue humaine."}\n\n## Limites et escalade\n\n${[...limitations, metadata.resolution?.escalation ?? "Transférer à un humain si la situation diffère de ce cas."].join("\n\n")}`
        : `${current.version.bodyMarkdown.trim()}\n\n## Correction issue du ${sourceLabel}\n\n${resolution}\n\n## Conditions et limites vérifiées\n\n${[...conditions, ...limitations, expectedResult].filter(Boolean).join("\n\n")}`,
      changeNote: `Apprentissage après intervention humaine sur le ${sourceLabel}`,
      metadata: {
        ...metadata,
        semanticSteps: undefined,
        prerequisites: [...new Set([...(metadata.prerequisites ?? []), ...conditions])],
        expectedResult: expectedResult || metadata.expectedResult,
        troubleshooting: [...limitations, metadata.troubleshooting].filter(Boolean).join("\n\n").slice(0, 10_000),
        sourceMetadata: {
          ...(metadata.sourceMetadata ?? {}),
          supportResolution: true,
          evidenceTicketIds: [...new Set([...(Array.isArray(metadata.sourceMetadata?.evidenceTicketIds) ? metadata.sourceMetadata.evidenceTicketIds.map(String) : []), ...(candidate.hubspotTicketId ? [candidate.hubspotTicketId] : [])])],
          evidenceSourceRefs: [...new Set([...(Array.isArray(metadata.sourceMetadata?.evidenceSourceRefs) ? metadata.sourceMetadata.evidenceSourceRefs.map(String) : []), candidate.sourceRef])],
          resolutionProvenance: patch.provenance ?? "unknown",
          customerConfirmed: patch.customerConfirmed === true,
        },
        resolution: {
          ...(metadata.resolution ?? { symptoms: [subject.slice(0, 500)], exceptions: [], escalation: "Transférer à un humain si la situation diffère de ce cas ou si la procédure échoue.", productVersion: "" }),
          exceptions: limitations,
          steps: [resolution],
        },
      },
    }, actorEmail, current.item.id, tx);
  } else {
    const slugId = `${candidate.sourceRef.toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "resolution"}-${candidate.id.slice(0, 8)}`;
    result = await saveDraft({
      type: "article",
      slug: `resolution-sav-${slugId}`,
      locale: "fr-FR",
      title: subject.slice(0, 500),
      summary: `Solution confirmée par l’équipe SAV à partir du ${sourceLabel}.`,
      categorySlug: "depannage",
      visibility: "charly_only",
      agentKey: "sav",
      ownerEmail: actorEmail,
      bodyMarkdown: `## Problème observé\n\n${subject}\n\n## Conditions\n\n${conditions.length ? conditions.map((value) => "- " + value).join("\n") : "- À préciser lors de la revue humaine."}\n\n## Solution confirmée par l’équipe\n\n${resolution}\n\n## Résultat attendu\n\n${expectedResult || "À préciser lors de la revue humaine."}\n\n## Limites et escalade\n\n${[...limitations, "Transférer à un humain si la situation diffère de ce cas ou si la procédure ne produit pas le résultat attendu."].join("\n\n")}`,
      changeNote: `Fiche créée après intervention humaine sur le ${sourceLabel}`,
      metadata: {
        intents: [subject.slice(0, 500)],
        limovaPaths: [],
        prerequisites: conditions,
        expectedResult: expectedResult || "Vérifier que le problème décrit est résolu ; recueillir une confirmation du client si nécessaire.",
        troubleshooting: "Transférer à un humain si la procédure validée ne fonctionne pas.",
        sourceMetadata: { supportResolution: true, evidenceTicketIds: candidate.hubspotTicketId ? [candidate.hubspotTicketId] : [], evidenceSourceRefs: [candidate.sourceRef], sourceSnapshotId: patch.sourceSnapshotId, resolutionProvenance: patch.provenance ?? "unknown", customerConfirmed: patch.customerConfirmed === true },
        resolution: {
          symptoms: [subject.slice(0, 500)], steps: [resolution], exceptions: limitations,
          escalation: "Transférer à un humain si la situation diffère de ce cas ou si la procédure ne produit pas le résultat attendu.",
          productVersion: "",
        },
      },
    }, actorEmail, undefined, tx);
  }

    await tx.insert(savResolutionEvidence).values({
      itemId: result.item.id,
      versionId: result.version.id,
      hubspotTicketId: candidate.hubspotTicketId,
      sourceRef: candidate.sourceRef,
      weight: 900,
      outcome: "human_resolution",
      summary: subject.slice(0, 1_000),
    }).onConflictDoNothing();
    await tx.update(savLearningCandidates).set({
      status: "approved",
      contentItemId: result.item.id,
      reviewedBy: actorEmail,
      reviewedAt: new Date(),
    }).where(eq(savLearningCandidates.id, candidate.id));
  return result;
  });
  await proposeOnboardingFromSav(candidateId, actorEmail);
  return result;
}

export async function rejectLearningCandidate(candidateId: string, actorEmail: string) {
  assertKnowledgeUgoApproval(actorEmail);
  return requireDb().transaction(async (tx) => {
    const [updated] = await tx.update(savLearningCandidates).set({
      status: "rejected", rejectionKind: "human",
      reviewedBy: actorEmail,
      reviewedAt: new Date(),
    }).where(and(eq(savLearningCandidates.id, candidateId), eq(savLearningCandidates.status, "pending"))).returning();
    if (!updated) throw new Error("SAV_LEARNING_CANDIDATE_NOT_PENDING");
    await closeSavLearningReservationTx(tx, candidateId);
    return updated;
  });
}
