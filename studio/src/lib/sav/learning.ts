import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import {
  categories,
  contentItems,
  contentVersions,
  savLearningCandidates,
  savResolutionEvidence,
} from "@/db/schema";
import type { ArticleMetadata } from "@/db/schema";
import { saveDraft } from "@/lib/workflow";
import { decryptSavPayload } from "./crypto";

type LearningPatch = {
  subject: string;
  finalHumanResolution: string;
  sourceSnapshotId: string;
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

function candidatePatch(candidate: typeof savLearningCandidates.$inferSelect) {
  const ciphertext = candidate.proposedPatch.ciphertext;
  if (typeof ciphertext !== "string") throw new Error("SAV_LEARNING_PATCH_INVALID");
  return decryptSavPayload<LearningPatch>(ciphertext);
}

export async function listLearningCandidates(limit = 100) {
  const candidates = await requireDb().select({
    id: savLearningCandidates.id,
    hubspotTicketId: savLearningCandidates.hubspotTicketId,
    contentItemId: savLearningCandidates.contentItemId,
    status: savLearningCandidates.status,
    explanation: savLearningCandidates.explanation,
    evidenceTicketIds: savLearningCandidates.evidenceTicketIds,
    createdAt: savLearningCandidates.createdAt,
    reviewedBy: savLearningCandidates.reviewedBy,
    reviewedAt: savLearningCandidates.reviewedAt,
    proposedPatch: savLearningCandidates.proposedPatch,
  }).from(savLearningCandidates).orderBy(desc(savLearningCandidates.createdAt)).limit(Math.min(250, Math.max(1, limit)));
  return candidates.map((candidate) => {
    try {
      const patch = candidatePatch(candidate as typeof savLearningCandidates.$inferSelect);
      return {
        ...candidate,
        proposedPatch: undefined,
        proposedSubject: plainText(patch.subject).slice(0, 500),
        proposedResolution: plainText(patch.finalHumanResolution).slice(0, 4_000),
      };
    } catch {
      return {
        ...candidate,
        proposedPatch: undefined,
        proposedSubject: "Proposition illisible",
        proposedResolution: "Le contenu chiffré de cette proposition n’a pas pu être relu.",
      };
    }
  });
}

export async function approveLearningCandidate(candidateId: string, actorEmail: string) {
  const db = requireDb();
  const [candidate] = await db.select().from(savLearningCandidates)
    .where(and(eq(savLearningCandidates.id, candidateId), eq(savLearningCandidates.status, "pending"))).limit(1);
  if (!candidate) throw new Error("SAV_LEARNING_CANDIDATE_NOT_PENDING");
  const patch = candidatePatch(candidate);
  const subject = plainText(patch.subject) || `Résolution du ticket ${candidate.hubspotTicketId}`;
  const resolution = plainText(patch.finalHumanResolution);
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
      bodyMarkdown: `${current.version.bodyMarkdown.trim()}\n\n## Correction issue du ticket ${candidate.hubspotTicketId}\n\n${resolution}`,
      changeNote: `Apprentissage après intervention humaine sur le ticket ${candidate.hubspotTicketId}`,
      metadata: {
        ...metadata,
        sourceMetadata: {
          ...(metadata.sourceMetadata ?? {}),
          supportResolution: true,
          evidenceTicketIds: [...new Set([...(Array.isArray(metadata.sourceMetadata?.evidenceTicketIds) ? metadata.sourceMetadata.evidenceTicketIds.map(String) : []), candidate.hubspotTicketId])],
        },
      },
    }, actorEmail, current.item.id);
  } else {
    const slugId = candidate.hubspotTicketId.toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || candidate.id.slice(0, 8);
    result = await saveDraft({
      type: "article",
      slug: `resolution-sav-${slugId}`,
      locale: "fr-FR",
      title: subject.slice(0, 500),
      summary: `Solution confirmée par l’équipe SAV à partir du ticket HubSpot ${candidate.hubspotTicketId}.`,
      categorySlug: "depannage",
      visibility: "charly_only",
      agentKey: "sav",
      ownerEmail: actorEmail,
      bodyMarkdown: `## Problème observé\n\n${subject}\n\n## Solution confirmée par l’équipe\n\n${resolution}\n\n## Escalade\n\nTransférer à un humain si la situation diffère de ce cas ou si la procédure ne produit pas le résultat attendu.`,
      changeNote: `Fiche créée après intervention humaine sur le ticket ${candidate.hubspotTicketId}`,
      metadata: {
        intents: [subject.slice(0, 500)],
        limovaPaths: [],
        prerequisites: [],
        expectedResult: "Le problème décrit est résolu et le client confirme le résultat.",
        troubleshooting: "Transférer à un humain si la procédure validée ne fonctionne pas.",
        sourceMetadata: { supportResolution: true, evidenceTicketIds: [candidate.hubspotTicketId], sourceSnapshotId: patch.sourceSnapshotId },
      },
    }, actorEmail);
  }

  await db.transaction(async (tx) => {
    await tx.insert(savResolutionEvidence).values({
      itemId: result.item.id,
      versionId: result.version.id,
      hubspotTicketId: candidate.hubspotTicketId,
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
  });
  return result;
}

export async function rejectLearningCandidate(candidateId: string, actorEmail: string) {
  const [updated] = await requireDb().update(savLearningCandidates).set({
    status: "rejected",
    reviewedBy: actorEmail,
    reviewedAt: new Date(),
  }).where(and(eq(savLearningCandidates.id, candidateId), eq(savLearningCandidates.status, "pending"))).returning();
  if (!updated) throw new Error("SAV_LEARNING_CANDIDATE_NOT_PENDING");
  return updated;
}
