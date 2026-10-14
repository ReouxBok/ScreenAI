import "server-only";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { savResolutionIsCurrent } from "@/lib/search";
import { requireDb } from "@/db";
import { auditLogs, contentItems, contentVersions, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjectionCandidates, knowledgeProjections, savKnowledgeActivations, savKnowledgeProposalDrafts, savLearningCandidates } from "@/db/schema";
import { assertSavActor } from "@/lib/sav/access";
import { decryptSavPayload } from "@/lib/sav/crypto";
import { z } from "zod";
import { articleMetadataSchema } from "@/lib/content";
import { canReviewKnowledgeCandidate, canonicalKnowledgeSchema, type CanonicalKnowledge } from "./contracts";
import { canonicalFromSav, publicKnowledgeText, savProjectionBody } from "./conversion";
import { onboardingSourceStatus } from "./onboarding-import";
import { previewSavKnowledgeProposal, previewSavKnowledgeReview, toSavKnowledgeDraft, workspaceSourceStatus } from "./proposals";
import type { SavKnowledgeDetail, SavKnowledgeOrigin, SavKnowledgeRow, SavKnowledgeTab, SavKnowledgeVersion } from "./workspace-contract";
export * from "./workspace-contract";
export { saveSavKnowledgeProposal, previewSavKnowledgeProposal, submitSavKnowledgeProposal, previewSavKnowledgeReview, reviewSavKnowledgeProposal, requestSavKnowledgeCompletion, startSavKnowledgeRevision } from "./proposals";
export { activateSavKnowledgeVersion, publishSavKnowledgeVersion } from "./activation";

const originExpression = sql`CASE
 WHEN source.evidence->>'origin' IN ('human','automatic') THEN source.evidence->>'origin'
 WHEN source.evidence->>'importKind' IN ('hubspot','onboarding_catalog') OR source.source_ref LIKE 'sav-learning:%' OR source.source_ref LIKE 'training:%' OR source.source_ref LIKE 'content:%' THEN 'automatic'
 ELSE 'unknown' END`;
const workspaceRows = sql`
 WITH catalogue AS (
 SELECT item.id, 'item'::text AS kind, item.id AS item_id, NULL::uuid AS candidate_id, NULL::uuid AS draft_id, NULL::uuid AS learning_candidate_id,
   (SELECT p.family_id FROM knowledge_projections p WHERE p.item_id=item.id AND p.surface='sav' LIMIT 1) AS family_id,
   active.title, item.summary,
   coalesce((SELECT CASE WHEN source.evidence->>'origin' IN ('human','automatic') THEN source.evidence->>'origin' WHEN source.evidence->>'importKind' IN ('hubspot','onboarding_catalog') OR source.source_ref LIKE 'sav-learning:%' OR source.source_ref LIKE 'content:%' OR source.source_ref LIKE 'training:%' THEN 'automatic' ELSE 'unknown' END
     FROM knowledge_family_sources source WHERE source.id IN (SELECT c.source_id FROM knowledge_projection_candidates c WHERE c.materialized_version_id=active.version_id) OR source.revision_id IN (SELECT p.revision_id FROM knowledge_projections p WHERE p.version_id=active.version_id AND p.surface='sav') ORDER BY source.created_at DESC LIMIT 1),'unknown') AS origin, 'production'::text AS state, version.version, active.activated_at AS updated_at,
   'Version activée dans le SAV'::text AS source_label, active.version_id AS active_version_id, item.published_version_id,
   (EXISTS(SELECT 1 FROM sav_knowledge_proposal_drafts d WHERE d.target_item_id=item.id AND d.status='draft') OR EXISTS(SELECT 1 FROM knowledge_projection_candidates c WHERE c.target_item_id=item.id AND c.target_surface='sav' AND NOT EXISTS(SELECT 1 FROM sav_knowledge_proposal_drafts replacement WHERE replacement.source_candidate_id=c.id) AND (c.status IN ('pending','needs_completion') OR c.status='approved' AND c.materialized_version_id IS DISTINCT FROM active.version_id AND c.materialized_version_id IN (item.current_draft_version_id,item.published_version_id)))) AS has_pending_update
 FROM content_items item JOIN sav_knowledge_activations active ON active.item_id=item.id JOIN content_versions version ON version.id=active.version_id
 WHERE item.agent_key='sav' AND item.type='article' AND item.status <> 'archived' AND item.ai_enabled=true
   AND EXISTS(SELECT 1 FROM content_chunks chunk WHERE chunk.item_id=item.id AND chunk.version_id=active.version_id)
   AND ${savResolutionIsCurrent}
 UNION ALL
 SELECT candidate.id, 'candidate', candidate.target_item_id, candidate.id, NULL::uuid, NULL::uuid, candidate.family_id,
   coalesce(candidate.proposed_input->>'title',family.title), candidate.explanation, ${originExpression},
   CASE WHEN EXISTS(SELECT 1 FROM sav_knowledge_proposal_drafts replacement WHERE replacement.source_candidate_id=candidate.id) THEN 'superseded' WHEN candidate.status='approved' AND candidate.materialized_version_id IS NOT NULL AND candidate.materialized_version_id IS DISTINCT FROM active.version_id AND candidate.materialized_version_id IS DISTINCT FROM item.current_draft_version_id AND candidate.materialized_version_id IS DISTINCT FROM item.published_version_id THEN 'superseded' WHEN candidate.status='approved' THEN
     CASE WHEN active.version_id=candidate.materialized_version_id AND item.ai_enabled AND item.status<>'archived' AND EXISTS(SELECT 1 FROM content_chunks chunk WHERE chunk.version_id=active.version_id AND chunk.item_id=item.id) THEN 'production'
       WHEN item.published_version_id=candidate.materialized_version_id THEN 'published_inactive'
       WHEN (SELECT attempt.status FROM sav_knowledge_publication_attempts attempt WHERE attempt.version_id=candidate.materialized_version_id ORDER BY attempt.created_at DESC LIMIT 1)='failed' THEN 'index_error'
       WHEN (SELECT attempt.status FROM sav_knowledge_publication_attempts attempt WHERE attempt.version_id=candidate.materialized_version_id ORDER BY attempt.created_at DESC LIMIT 1)='indexing' THEN 'indexing'
       ELSE 'approved' END
     ELSE candidate.status END,
   version.version, coalesce(candidate.reviewed_at,candidate.created_at),
   CASE WHEN source.evidence->>'importKind'='onboarding_catalog' THEN 'Tutoriel source' WHEN source.evidence->>'importKind'='hubspot' THEN 'Import de preuves HubSpot' WHEN source.evidence->>'origin'='human' THEN 'Proposition humaine' WHEN source.evidence->>'origin'='automatic' THEN 'Résolution observée' ELSE 'Source conservée dans le Studio' END,
   active.version_id, item.published_version_id, false
 FROM knowledge_projection_candidates candidate JOIN knowledge_families family ON family.id=candidate.family_id
 JOIN knowledge_family_sources source ON source.id=candidate.source_id
 LEFT JOIN content_items item ON item.id=candidate.target_item_id LEFT JOIN sav_knowledge_activations active ON active.item_id=item.id
 LEFT JOIN content_versions version ON version.id=candidate.materialized_version_id
 WHERE candidate.target_surface='sav'
 UNION ALL
 SELECT draft.id,'draft',draft.target_item_id,NULL::uuid,draft.id,draft.learning_candidate_id,NULL::uuid,draft.title,draft.reason,draft.origin,'draft',NULL::integer,draft.updated_at,
  CASE WHEN draft.origin='automatic' THEN 'Résolution observée' ELSE 'Proposition humaine' END,active.version_id,item.published_version_id,false
 FROM sav_knowledge_proposal_drafts draft LEFT JOIN content_items item ON item.id=draft.target_item_id LEFT JOIN sav_knowledge_activations active ON active.item_id=item.id
 WHERE draft.status='draft'
 UNION ALL
 SELECT learning.id,'learning',learning.content_item_id,NULL::uuid,NULL::uuid,learning.id,NULL::uuid,coalesce(snapshot.subject,'Résolution humaine à préparer'),learning.explanation,'automatic',learning.status::text,NULL::integer,learning.created_at,'Résolution HubSpot qualifiée',active.version_id,item.published_version_id,false
 FROM sav.learning_candidates learning LEFT JOIN content_items item ON item.id=learning.content_item_id LEFT JOIN sav_knowledge_activations active ON active.item_id=item.id LEFT JOIN sav.ticket_snapshots snapshot ON snapshot.hubspot_ticket_id=learning.hubspot_ticket_id
 WHERE learning.status='pending' AND NOT EXISTS(SELECT 1 FROM sav_knowledge_proposal_drafts draft WHERE draft.learning_candidate_id=learning.id)
 )`;
function resultRows<T>(result: unknown): T[] { return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[]; }
const actions: Record<string, string> = { production: "Consulter la version active", pending: "Examiner la proposition", draft: "Terminer puis soumettre", needs_completion: "Compléter les sources ou la procédure", approved: "Publier la version validée", published_inactive: "Activer la version publiée", index_error: "Vérifier l’erreur de publication", indexing: "Publication en attente", rejected: "Consulter le motif du refus", superseded: "Consulter la proposition suivante", needs_recording: "Compléter la démonstration", not_applicable: "Qualifier la proposition" };
function rowDto(raw: Record<string, unknown>): SavKnowledgeRow {
  return { id: String(raw.id), kind: raw.kind as SavKnowledgeRow["kind"], itemId: raw.item_id as string | null, candidateId: raw.candidate_id as string | null, draftId: raw.draft_id as string | null, learningCandidateId: raw.learning_candidate_id as string | null, familyId: raw.family_id as string | null, title: String(raw.title), summary: String(raw.summary), origin: raw.origin as SavKnowledgeOrigin, state: String(raw.state), version: raw.version == null ? null : Number(raw.version), updatedAt: new Date(String(raw.updated_at)), sourceLabel: String(raw.source_label), activeVersionId: raw.active_version_id as string | null, publishedVersionId: raw.published_version_id as string | null, hasPendingUpdate: raw.has_pending_update === true, nextAction: actions[String(raw.state)] ?? "Consulter le détail" };
}
export async function paginateSavKnowledge(input: { tab?: SavKnowledgeTab; q?: string; status?: string; page?: number; pageSize?: number } = {}) {
  const db = requireDb();
  const tab = ["production", "automatic", "human"].includes(input.tab ?? "") ? input.tab! : "production";
  const pageSize = Math.min(50, Math.max(1, Math.floor(input.pageSize ?? 20) || 20));
  const q = (input.q ?? "").trim().slice(0, 200).replace(/[\\%_]/g, "\\$&");
  const search = q ? sql`(title ILIKE ${`%${q}%`} OR summary ILIKE ${`%${q}%`} OR source_label ILIKE ${`%${q}%`})` : sql`TRUE`;
  const tabFilter = tab === "production" ? sql`kind='item'` : sql`kind<>'item' AND state NOT IN ('production','superseded') AND ${tab === "human" ? sql`origin='human'` : sql`origin IN ('automatic','unknown')`}`;
  const status = input.status && Object.hasOwn(actions, input.status) ? input.status : "all";
  const filter = sql`${search} AND ${tabFilter} AND ${status === "all" ? sql`TRUE` : sql`state=${status}`}`;
  const countsRows = resultRows<{ production: number; automatic: number; human: number }>(await db.execute(sql`${workspaceRows} SELECT
   count(*) FILTER(WHERE kind='item')::int AS production,
   count(*) FILTER(WHERE kind<>'item' AND state NOT IN ('production','superseded') AND origin IN ('automatic','unknown'))::int AS automatic,
   count(*) FILTER(WHERE kind<>'item' AND state NOT IN ('production','superseded') AND origin='human')::int AS human FROM catalogue WHERE ${search}`));
  const [{ total }] = resultRows<{ total: number }>(await db.execute(sql`${workspaceRows} SELECT count(*)::int AS total FROM catalogue WHERE ${filter}`));
  const page = Math.max(1, Math.min(Math.ceil(total / pageSize) || 1, Math.floor(input.page ?? 1) || 1));
  const rows = resultRows<Record<string, unknown>>(await db.execute(sql`${workspaceRows} SELECT * FROM catalogue WHERE ${filter} ORDER BY updated_at DESC,id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`));
  return { rows: rows.map(rowDto), total, page, pageSize, counts: countsRows[0] };
}
export async function searchSavKnowledgeTargets(q = "", page = 1) {
  return paginateSavKnowledge({ tab: "production", q, page, pageSize: 20 });
}
function displaySources(evidence: Record<string, unknown> | undefined, ref: string, label: string) {
  if (!Array.isArray(evidence?.sources)) return [{ ref, label }];
  return evidence.sources.flatMap((source: unknown) => {
    if (!source || typeof source !== "object") return [];
    const value = source as Record<string, unknown>;
    const link = typeof value.ref === "string" ? value.ref : typeof value.url === "string" ? value.url : null;
    return link ? [{ ref: link, label: typeof value.label === "string" ? value.label : `Preuve conservée${typeof value.date === "string" ? ` · ${value.date.slice(0, 10)}` : ""}` }] : [];
  });
}
function versionDto(version: typeof contentVersions.$inferSelect | undefined, title: string): SavKnowledgeVersion | null {
  return version ? { id: version.id, version: version.version, title, body: version.bodyMarkdown, authorEmail: version.authorEmail, createdAt: version.createdAt } : null;
}
export async function getSavKnowledgeDetail(input: { candidateId?: string; itemId?: string; draftId?: string; learningCandidateId?: string }, actorEmail: string): Promise<SavKnowledgeDetail | null> {
  assertSavActor(actorEmail);
  const id = input.candidateId ?? input.itemId ?? input.draftId ?? input.learningCandidateId;
  if (!id || !z.uuid().safeParse(id).success) return null;
  const db = requireDb();
  const kind = input.candidateId ? "candidate" : input.itemId ? "item" : input.draftId ? "draft" : "learning";
  const rows = resultRows<Record<string, unknown>>(await db.execute(sql`${workspaceRows} SELECT * FROM catalogue WHERE id=${id}::uuid AND kind=${kind} LIMIT 1`));
  let row = rows[0] ? rowDto(rows[0]) : null;
  // A direct item link remains usable when disabled, archived or not yet indexed.
  if (!row && kind === "item") {
    const [item] = await db.select().from(contentItems).where(eq(contentItems.id, id));
    if (!item || item.agentKey !== "sav" || item.type !== "article") return null;
    const [active] = await db.select().from(savKnowledgeActivations).where(eq(savKnowledgeActivations.itemId, id));
    row = { id, kind: "item", itemId: id, candidateId: null, draftId: null, learningCandidateId: null, familyId: null, title: active?.title ?? item.title, summary: item.summary, origin: "unknown", state: item.status === "archived" ? "archived" : item.publishedVersionId ? "published_inactive" : "draft", version: null, updatedAt: item.updatedAt, sourceLabel: "Fiche SAV du Studio", activeVersionId: active?.versionId ?? null, publishedVersionId: item.publishedVersionId, hasPendingUpdate: false, nextAction: "Consulter les versions" };
  }
  if (!row) return null;
  const [item] = row.itemId ? await db.select().from(contentItems).where(eq(contentItems.id, row.itemId)) : [];
  const versions = item ? await db.select().from(contentVersions).where(eq(contentVersions.itemId, item.id)).orderBy(desc(contentVersions.version)) : [];
  const [active] = item ? await db.select().from(savKnowledgeActivations).where(eq(savKnowledgeActivations.itemId, item.id)) : [];
  const activeVersion = versionDto(versions.find((version) => version.id === active?.versionId), active?.title ?? row.title);
  const publishedVersion = versionDto(versions.find((version) => version.id === item?.publishedVersionId), item?.title ?? row.title);
  let proposedVersion = versionDto(versions.find((version) => version.id === item?.currentDraftVersionId), item?.title ?? row.title);
  let reviewKind: SavKnowledgeDetail["reviewKind"] = null;
  let document: CanonicalKnowledge | null = null;
  let sources: SavKnowledgeDetail["sources"] = [];
  let draft: SavKnowledgeDetail["draft"] = null;
  let revisionId: string | null = null;
  let snapshot: string | null = null;
  let comparison: SavKnowledgeDetail["comparison"] = [];
  let missing: string[] = [];
  const alerts: string[] = [];
  let proposedBody = proposedVersion?.body ?? "";
  if (row.candidateId) {
    const [candidate] = await db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, row.candidateId));
    const [revision] = await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, candidate.revisionId));
    document = revision ? canonicalKnowledgeSchema.parse(revision.document) : null; revisionId = candidate.revisionId;
    proposedBody = candidate.diff.after;
    if (candidate.materializedVersionId) {
      proposedVersion = versionDto(versions.find((version) => version.id === candidate.materializedVersionId), row.title);
      const [projection] = await db.select().from(knowledgeProjections).where(and(eq(knowledgeProjections.versionId, candidate.materializedVersionId), eq(knowledgeProjections.surface, "sav")));
      const [approvedRevision] = projection ? await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, projection.revisionId)) : [];
      document = approvedRevision ? canonicalKnowledgeSchema.parse(approvedRevision.document) : null;
      if (!document) alerts.push("KNOWLEDGE_APPROVED_DOCUMENT_UNAVAILABLE");
    }
    const [source] = await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
    reviewKind = source?.evidence.importKind === "sav_workspace" ? "workspace" : source?.evidence.importKind === "onboarding_catalog" ? "onboarding" : source?.evidence.importKind === "hubspot" ? "hubspot" : "legacy";
    sources = source ? displaySources(source.evidence, source.sourceRef, row.sourceLabel) : [];
    try { if (["pending", "needs_completion"].includes(candidate.status)) { const preview = await previewSavKnowledgeReview(candidate.id, actorEmail); snapshot = preview.snapshot; comparison = preview.comparison; missing = preview.missing; } }
    catch (error) { alerts.push(error instanceof Error ? error.message : "KNOWLEDGE_REVIEW_UNAVAILABLE"); }
  } else if (row.draftId) {
    const [stored] = await db.select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.id, row.draftId));
    draft = toSavKnowledgeDraft(stored); document = draft.document; sources = draft.sources; proposedBody = savProjectionBody(document);
    try { const preview = await previewSavKnowledgeProposal(draft.id, actorEmail); snapshot = preview.snapshot; comparison = preview.comparison; missing = preview.missing; sources = preview.sources; }
    catch (error) { alerts.push(error instanceof Error ? error.message : "KNOWLEDGE_REVIEW_UNAVAILABLE"); }
  } else if (row.learningCandidateId) {
    const [learning] = await db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id, row.learningCandidateId));
    try {
      const patch = decryptSavPayload<{ subject: string; finalHumanResolution: string }>(String(learning.proposedPatch.ciphertext));
      const title = publicKnowledgeText(patch.subject).slice(0, 500);
      row.title = title || row.title;
      document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: title || row.title, applicability: "sav_only", locale: "fr-FR", prerequisites: [], expectedResult: "", escalation: "", exceptions: [], steps: [{ id: "resolution.observed", userLabel: "Résolution observée", objective: title || row.title, instruction: publicKnowledgeText(patch.finalHumanResolution).slice(0, 2000), expectedResult: "", prerequisites: [], exceptions: [], escalation: "", variants: [] }] });
      sources = [{ ref: `sav-learning:${learning.id}`, label: "Preuve de résolution qualifiée par Ugo" }];
      proposedBody = savProjectionBody(document);
      missing = ["Préparer une procédure générique avec ses conditions, son résultat et ses limites avant soumission."];
    } catch { alerts.push("SAV_LEARNING_PATCH_INVALID"); }
  } else {
    const version = versions.find((entry) => entry.id === (activeVersion?.id ?? proposedVersion?.id));
    if (version) {
      const [projection] = await db.select().from(knowledgeProjections).where(and(eq(knowledgeProjections.versionId, version.id), eq(knowledgeProjections.surface, "sav")));
      const [revision] = projection ? await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, projection.revisionId)) : [];
      try { document = revision ? canonicalKnowledgeSchema.parse(revision.document) : canonicalFromSav(`content:${row.itemId}`, articleMetadataSchema.parse(version.metadata), item!.locale, row.title).document; }
      catch { alerts.push("KNOWLEDGE_CANONICAL_DOCUMENT_UNAVAILABLE"); }
      const [materialized] = await db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.materializedVersionId, version.id)).limit(1);
      const sourceRows = materialized ? await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, materialized.sourceId)) : projection ? await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.revisionId, projection.revisionId)) : [];
      sources = sourceRows.flatMap((source) => displaySources(source.evidence, source.sourceRef, "Preuve conservée dans le Studio"));
      const drift = await onboardingSourceStatus(version.metadata) ?? await workspaceSourceStatus(version.metadata);
      if (drift && drift !== "current") alerts.push("La source a changé : la version active est conservée jusqu’à revalidation.");
    }
  }
  const ids = [id, row.itemId, row.candidateId, row.draftId].filter((value): value is string => Boolean(value));
  const logs = await db.select().from(auditLogs).where(or(...ids.map((entityId) => eq(auditLogs.entityId, entityId)))).orderBy(desc(auditLogs.createdAt)).limit(50);
  return { reviewKind, row, document, sources, activeVersion, publishedVersion, proposedVersion, proposedBody, revisionId, draft, comparison, snapshot, missing, alerts,
    history: logs.map((log) => ({ action: log.action, actor: log.actorEmail, at: log.createdAt, reason: typeof log.technicalMetadata.reason === "string" ? log.technicalMetadata.reason : "" })),
    canReview: Boolean(row.candidateId && canReviewKnowledgeCandidate(actorEmail, "sav") && ["pending", "needs_completion"].includes(row.state)),
    canPublish: Boolean((!row.candidateId || proposedVersion?.id === item?.currentDraftVersionId) && actorEmail === "ugo@limova.ai" && item?.status === "in_review" && item.currentDraftVersionId && item.currentDraftVersionId !== item.publishedVersionId),
    canActivate: Boolean((!row.candidateId || proposedVersion?.id === item?.publishedVersionId) && actorEmail === "ugo@limova.ai" && item && item.status !== "archived" && item.publishedVersionId && (item.publishedVersionId !== active?.versionId || !item.aiEnabled)),
  };
}
