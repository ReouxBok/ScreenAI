import "server-only";
import { and, asc, eq, gt } from "drizzle-orm";
import { requireDb } from "@/db";
import { contentItems, contentVersions, knowledgeFamilyRevisions, savKnowledgeActivations, savKnowledgeProposalDrafts } from "@/db/schema";
import { assertSavPlaybookActor } from "@/lib/sav/playbook-contract";
import { articleMetadataSchema } from "@/lib/content";
import { canonicalKnowledgeSchema, type CanonicalKnowledge } from "./contracts";
import { canonicalFromSav } from "./conversion";
import { saveSavKnowledgeProposal } from "./proposals";

/** Structure only existing evidence. No model call, invented result or verifiedAt refresh. */
export function enrichSavDiagnosticDocument(document: CanonicalKnowledge): CanonicalKnowledge {
  // Copy evidence only. Classification is an explicit, separately reviewed envelope.
  // Words in a source question and paragraph order prove neither a required fact nor a branch.
  return canonicalKnowledgeSchema.parse(document);
}
export async function listSavDiagnosticEnrichment(afterId?: string) {
  const db = requireDb();
  const rows = await db.select({ item: contentItems, version: contentVersions }).from(contentItems)
    .innerJoin(savKnowledgeActivations, eq(savKnowledgeActivations.itemId, contentItems.id))
    .innerJoin(contentVersions, and(eq(contentVersions.id, savKnowledgeActivations.versionId), eq(contentVersions.itemId, contentItems.id)))
    .where(and(eq(contentItems.agentKey, "sav"), eq(contentItems.type, "article"), eq(contentItems.aiEnabled, true), afterId ? gt(contentItems.id, afterId) : undefined))
    .orderBy(asc(contentItems.id)).limit(21);
  return { rows: rows.slice(0, 20), next: rows.length > 20 ? rows[19].item.id : null };
}
export async function prepareSavDiagnosticEnrichment(input: { afterId?: string }, actorEmail: string) {
  assertSavPlaybookActor(actorEmail);
  const db = requireDb();
  const page = await listSavDiagnosticEnrichment(input.afterId);
  const results: Array<{ itemId: string; title: string; status: "prepared" | "preserved" | "review_required"; draftId?: string }> = [];
  for (const { item, version } of page.rows) {
    const [existing] = await db.select().from(savKnowledgeProposalDrafts).where(and(eq(savKnowledgeProposalDrafts.targetItemId, item.id), eq(savKnowledgeProposalDrafts.status, "draft"))).limit(1);
    if (existing) { results.push({ itemId: item.id, title: item.title, status: "preserved", draftId: existing.id }); continue; }
    // An unpublished update must not be silently used as the proof of the active procedure.
    if (item.status === "archived" || item.publishedVersionId !== version.id || item.currentDraftVersionId && item.currentDraftVersionId !== version.id) {
      results.push({ itemId: item.id, title: item.title, status: "review_required" }); continue;
    }
    const metadata = articleMetadataSchema.parse(version.metadata);
    const revisionId = metadata.sourceMetadata?.canonicalRevisionId;
    const [revision] = typeof revisionId === "string" ? await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, revisionId)) : [];
    const document = enrichSavDiagnosticDocument(revision ? canonicalKnowledgeSchema.parse(revision.document)
      : canonicalFromSav(`content:${item.id}`, metadata, item.locale, item.title).document);
    const draft = await saveSavKnowledgeProposal({ preparationKind: "diagnostic_enrichment", mode: "improve", targetItemId: item.id, title: item.title, document,
      sources: [{ ref: `content:${item.id}:${version.id}`, label: "Version active source conservée" }],
      reason: "Structurer les contrôles existants pour le diagnostic SAV. Questions manquantes, conditions et branches à qualifier lors de la revue ; aucune cause ou procédure nouvelle inventée." }, actorEmail);
    results.push({ itemId: item.id, title: item.title, status: "prepared", draftId: draft.id });
  }
  return { results, next: page.next };
}
