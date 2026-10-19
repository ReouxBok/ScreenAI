import "server-only";
import { isSavCaseLearningFrozen } from "@/lib/sav/config";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, contentItems, contentVersions, knowledgeFamilies, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjectionCandidates, knowledgeProjections, savKnowledgeActivations, savKnowledgeProposalDrafts, savLearningCandidates, savObservationCycles, savResolutionObservations, savResolutionEvidence } from "@/db/schema";
import { parseContentInput } from "@/lib/content";
import { savContentHash } from "@/lib/sav/crypto";
import { assertSavActor } from "@/lib/sav/access";
import { closeSavLearningReservationTx } from "@/lib/sav/learning-admission";
import { assertSavLearningAdmitted } from "@/lib/sav/learning-origin";
import { assertSavCrmLearningSource } from "@/lib/sav/learning-source";
import { assertKnowledgeCandidateReview, assertKnowledgeUgoApproval, canonicalKnowledgeSchema, semanticStepSchema, type CanonicalKnowledge } from "./contracts";
import { assertSafeKnowledgeDraft, assertSafeOnboardingKnowledge } from "./onboarding-extraction";
import { savQualifiedProjectionBody as savProjectionBody } from "./conversion";
import { knowledgeComparisonInventory, prepareHubspotReview } from "./hubspot-import";
import { prepareOnboardingReview } from "./onboarding-import";
import { compareKnowledge } from "./hubspot-input";
import { reviewKnowledgeCandidate } from "./review";
import type { SavKnowledgeDraft, SavKnowledgeSource, SavKnowledgeVersion } from "./workspace-contract";
import { assertSavSupportDelivery, savSupportDeliverySchema, unclassifiedSavDelivery } from "./support-delivery";
import { createSavDeliveryEnvelope, readSavDeliveryEnvelope, savDeliveryHash, savDeliveryMetadata } from "./delivery-envelope";

type Db = Pick<ReturnType<typeof requireDb>, "select">;
type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
const draftDocumentSchema = canonicalKnowledgeSchema.safeExtend({
  objective: z.string().trim().max(500),
  steps: z.array(semanticStepSchema.extend({ userLabel: z.string().trim().max(500), objective: z.string().trim().max(500), instruction: z.string().trim().max(2000) })).max(50),
});
const proposalSchema = z.object({
  delivery: savSupportDeliverySchema.optional(),
  preparationKind: z.literal("diagnostic_enrichment").optional(),
  draftId: z.uuid().optional(), expectedRevision: z.number().int().positive().optional(),
  mode: z.enum(["new", "improve"]), targetItemId: z.uuid().nullable().optional(),
  title: z.string().trim().max(500), document: draftDocumentSchema,
  sources: z.array(z.object({ ref: z.string().trim().min(3).max(1000).refine((value) => /^(?:https:\/\/[^\s]+|(?:content|sav-learning|sav-observation|knowledge-source):[a-z0-9:._-]+)$/i.test(value), "KNOWLEDGE_SOURCE_REFERENCE_INVALID"), label: z.string().trim().min(3).max(500) }).strict()).max(50),
  reason: z.string().trim().max(2000), learningCandidateId: z.uuid().nullable().optional(),
}).strict().refine((input) => input.mode === "new" ? !input.targetItemId : Boolean(input.targetItemId), "KNOWLEDGE_TARGET_REQUIRED");
export type SaveSavKnowledgeProposalInput = z.input<typeof proposalSchema>;
export function toSavKnowledgeDraft(row: typeof savKnowledgeProposalDrafts.$inferSelect): SavKnowledgeDraft {
  return { ...row, mode: row.mode as "new" | "improve", origin: row.origin as "human" | "automatic" | "unknown", document: draftDocumentSchema.parse(row.document) };
}
async function draftWithDelivery(row: typeof savKnowledgeProposalDrafts.$inferSelect, db: Db) {
  const draft = toSavKnowledgeDraft(row);
  const [saved] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, row.id), eq(auditLogs.action, "sav_knowledge_proposal_saved"), sql`${auditLogs.technicalMetadata}->>'revision' = ${String(row.revision)}`)).orderBy(desc(auditLogs.createdAt)).limit(1);
  let delivery = unclassifiedSavDelivery;
  if (saved?.technicalMetadata.revision === row.revision && saved.technicalMetadata.delivery) {
    try { delivery = readSavDeliveryEnvelope(draft.document, typeof saved.technicalMetadata.delivery === "string" ? JSON.parse(saved.technicalMetadata.delivery) : saved.technicalMetadata.delivery).qualification; } catch { /* A changed/legacy draft must be qualified again. */ }
  }
  return { ...draft, delivery };
}
export async function lockWorkspaceLearningSource(id: string, db: Db) {
  const [learning] = await db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id, id));
  if (learning?.status === "pending") await assertSavLearningAdmitted(learning, db);
  if (learning) await assertSavCrmLearningSource(learning, db, true);
  if (learning?.sourceRef.startsWith("sav-observation:")) {
    const [cycle] = await db.select().from(savObservationCycles).where(eq(savObservationCycles.id, learning.sourceRef.slice("sav-observation:".length)));
    if (cycle) await db.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, cycle.observationId)).for("update");
  }
}
export async function readSavLearningEvidence(id: string, db: Db = requireDb(), lock = false, allowRejected = false) {
  if(isSavCaseLearningFrozen())throw new Error("SAV_CASE_LEARNING_FROZEN");
  if (lock) await lockWorkspaceLearningSource(id, db);
  const query = db.select().from(savLearningCandidates).where(eq(savLearningCandidates.id, id));
  const [candidate] = await (lock ? query.for("update") : query);
  if (!candidate || !(allowRejected ? ["pending", "approved", "rejected"] : ["pending", "approved"]).includes(candidate.status)) throw new Error("SAV_OBSERVATION_STALE");
  if (candidate.status === "pending") await assertSavLearningAdmitted(candidate, db);
  await assertSavCrmLearningSource(candidate, db);
  if (candidate.sourceRef.startsWith("sav-observation:")) {
    const [cycle] = await db.select().from(savObservationCycles).where(eq(savObservationCycles.id, candidate.sourceRef.slice("sav-observation:".length)));
    const query = cycle ? db.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, cycle.observationId)) : null;
    const [observation] = query ? await (lock ? query.for("update") : query) : [];
    if (observation?.leaseUntil && observation.leaseUntil > new Date()) throw new Error("SAV_OBSERVATION_SYNC_IN_PROGRESS");
    if (!cycle || !observation?.closed || cycle.cycle !== observation.cycle || cycle.candidateId !== candidate.id || !["resolved","evidence_observed"].includes(cycle.qualification??"") || observation.sourceErrors.length) throw new Error("SAV_OBSERVATION_STALE");
    return { candidate, fingerprint: savContentHash({ id: candidate.id, sourceHash: candidate.sourceContentHash, cycleId: cycle.id, cycleSourceHash: cycle.sourceHash, qualification: cycle.qualification }) };
  }
  return { candidate, fingerprint: savContentHash({ id: candidate.id, sourceHash: candidate.sourceContentHash }) };
}
async function targetState(itemId: string | null | undefined, db: Db = requireDb(), lock = false) {
  if (!itemId) return { item: null, base: null, active: null, activeVersion: null };
  const query = db.select().from(contentItems).where(eq(contentItems.id, itemId));
  const [item] = await (lock ? query.for("update") : query);
  if (!item || item.slug === "sav-master-playbook" || item.agentKey !== "sav" || item.type !== "article" || item.status === "archived") throw new Error("SAV_KNOWLEDGE_SCOPE_REQUIRED");
  const [active] = await db.select().from(savKnowledgeActivations).where(eq(savKnowledgeActivations.itemId, item.id));
  const [base] = item.currentDraftVersionId || item.publishedVersionId ? await db.select().from(contentVersions).where(eq(contentVersions.id, (item.currentDraftVersionId ?? item.publishedVersionId)!)) : [];
  const [version] = active ? await db.select().from(contentVersions).where(eq(contentVersions.id, active.versionId)) : [];
  const activeVersion: SavKnowledgeVersion | null = active && version ? { id: version.id, version: version.version, title: active.title, body: version.bodyMarkdown, createdAt: version.createdAt, authorEmail: version.authorEmail } : null;
  return { item, base: base ?? null, active: active ?? null, activeVersion };
}
async function sourceFingerprint(sources: SavKnowledgeSource[], db: Db = requireDb(), lock = false) {
  const proofs = [];
  for (const source of sources) {
    if (source.ref.startsWith("content:")) {
      const [, itemId, expectedVersion] = source.ref.split(":");
      if (!z.uuid().safeParse(itemId).success) throw new Error("KNOWLEDGE_SOURCE_REFERENCE_INVALID");
      const query = db.select().from(contentItems).where(eq(contentItems.id, itemId));
      const [item] = await (lock ? query.for("update") : query);
      if (!item || item.status === "archived" || !item.publishedVersionId || expectedVersion && expectedVersion !== item.publishedVersionId) throw new Error("KNOWLEDGE_SOURCE_STALE");
      proofs.push({ ref: source.ref, versionId: item.publishedVersionId, title: item.title });
    } else if (source.ref.startsWith("sav-learning:")) {
      proofs.push({ ref: source.ref, hash: (await readSavLearningEvidence(source.ref.slice(13), db, lock)).fingerprint });
    } else if (source.ref.startsWith("sav-observation:")) {
      const cycleId = source.ref.slice("sav-observation:".length);
      if (!z.uuid().safeParse(cycleId).success) throw new Error("KNOWLEDGE_SOURCE_REFERENCE_INVALID");
      const [cycle] = await db.select().from(savObservationCycles).where(eq(savObservationCycles.id, cycleId));
      const query = cycle ? db.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, cycle.observationId)) : null;
      const [observation] = query ? await (lock ? query.for("update") : query) : [];
      if (!cycle || !observation?.closed || observation.cycle !== cycle.cycle || !["resolved","evidence_observed"].includes(cycle.qualification??"") || observation.sourceErrors.length) throw new Error("SAV_OBSERVATION_STALE");
      if (observation.leaseUntil && observation.leaseUntil > new Date()) throw new Error("SAV_OBSERVATION_SYNC_IN_PROGRESS");
      proofs.push({ ref: source.ref, sourceHash: cycle.sourceHash, qualification: cycle.qualification, candidateId: cycle.candidateId });
    } else if (source.ref.startsWith("knowledge-source:")) {
      const [proof] = await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, source.ref.slice(17)));
      if (!proof) throw new Error("KNOWLEDGE_SOURCE_STALE");
      proofs.push({ ref: source.ref, hash: proof.sourceHash });
    } else proofs.push(source); // User-declared external reference; never fetched or treated as verified automatically.
  }
  return savContentHash(proofs);
}
export async function saveSavKnowledgeProposal(raw: SaveSavKnowledgeProposalInput, actorEmail: string, transaction?: Tx) {
  assertSavActor(actorEmail);
  const input = proposalSchema.parse(raw);
  const delivery = assertSavSupportDelivery(input.document, input.delivery ?? unclassifiedSavDelivery);
  assertSafeKnowledgeDraft({ ...input.document, objective: input.title });
  assertSafeKnowledgeDraft(input.document);
  if (input.sources.some((source) => source.ref.startsWith("sav-learning:") && source.ref !== `sav-learning:${input.learningCandidateId}`)) throw new Error("KNOWLEDGE_LEARNING_ORIGIN_REQUIRED");
  if (input.learningCandidateId) assertKnowledgeUgoApproval(actorEmail);
  const persist = async (tx: Tx) => {
    if (!input.draftId && input.learningCandidateId) {
      await lockWorkspaceLearningSource(input.learningCandidateId, tx);
      await tx.select().from(savLearningCandidates).where(eq(savLearningCandidates.id, input.learningCandidateId)).for("update");
      const [prior] = await tx.select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.learningCandidateId, input.learningCandidateId));
      if (prior) return draftWithDelivery(prior, tx);
    }
    const [existing] = input.draftId ? await tx.select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.id, input.draftId)).for("update") : [];
    if (input.draftId && (!existing || existing.revision !== input.expectedRevision || existing.status !== "draft")) throw new Error("KNOWLEDGE_DRAFT_STALE");
    if (existing && existing.createdBy !== actorEmail && actorEmail !== "ugo@limova.ai") throw new Error("KNOWLEDGE_DRAFT_OWNER_REQUIRED");
    if (existing && (existing.learningCandidateId ?? null) !== (input.learningCandidateId ?? null)) throw new Error("KNOWLEDGE_ORIGIN_IMMUTABLE");
    const target = await targetState(input.targetItemId, tx, true);
    if (input.preparationKind === "diagnostic_enrichment") {
      if (input.mode !== "improve" || !target.active || target.item!.publishedVersionId !== target.active.versionId
        || target.item!.currentDraftVersionId && target.item!.currentDraftVersionId !== target.active.versionId
        || !input.sources.some(source => source.ref === `content:${target.item!.id}:${target.active!.versionId}`)) throw new Error("KNOWLEDGE_SOURCE_STALE");
      const [retained] = await tx.select().from(savKnowledgeProposalDrafts).where(and(eq(savKnowledgeProposalDrafts.targetItemId, target.item!.id), eq(savKnowledgeProposalDrafts.status, "draft"))).limit(1);
      if (retained) return draftWithDelivery(retained, tx);
    }
    const learning = input.learningCandidateId ? await readSavLearningEvidence(input.learningCandidateId, tx, true) : null;
    const values = { mode: input.mode, targetItemId: input.targetItemId ?? null, baseVersionId: target.base?.id ?? null, activeVersionId: target.active?.versionId ?? null,
      title: target.base?.metadata.sourceMetadata?.importKind === "onboarding_catalog" ? target.item!.title : input.title,
      document: input.document, sources: input.sources, reason: input.reason, origin: existing?.origin ?? (learning ? "automatic" : "human"), learningCandidateId: input.learningCandidateId ?? null, learningSourceHash: learning?.fingerprint ?? null,
      revision: (existing?.revision ?? 0) + 1, updatedAt: new Date() };
    const [draft] = existing ? await tx.update(savKnowledgeProposalDrafts).set(values).where(eq(savKnowledgeProposalDrafts.id, existing.id)).returning() : await tx.insert(savKnowledgeProposalDrafts).values({ ...values, createdBy: actorEmail }).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_knowledge_proposal_saved", entityType: "knowledge_draft", entityId: draft.id, technicalMetadata: { revision: draft.revision, targetItemId: draft.targetItemId, origin: draft.origin, delivery: JSON.stringify(createSavDeliveryEnvelope(input.document, delivery)) } });
    return { ...toSavKnowledgeDraft(draft), delivery };
  };
  return transaction ? persist(transaction) : requireDb().transaction(persist);
}
function completeness(document: CanonicalKnowledge, sources: SavKnowledgeSource[], reason: string) {
  return [!canonicalKnowledgeSchema.safeParse(document).success && "Compléter l’objectif, les intitulés et les instructions des étapes.", !sources.length && "Ajouter au moins une source de preuve.", reason.trim().length < 10 && "Expliquer le motif de la proposition.", !document.steps.length && "Décrire la procédure.", !document.expectedResult && "Préciser le résultat attendu.", !document.prerequisites.length && "Préciser les conditions d’utilisation.", !document.escalation && "Préciser les limites et le passage à un humain.", document.steps.some((step) => !step.expectedResult) && "Préciser le résultat observable de chaque étape."].filter((value): value is string => Boolean(value));
}
async function draftPreview(draft: typeof savKnowledgeProposalDrafts.$inferSelect, db: Db = requireDb(), lock = false) {
  const target = await targetState(draft.targetItemId, db);
  const inheritedSource = target.base?.metadata.sourceMetadata?.importKind === "onboarding_catalog" ? target.base.metadata.sourceMetadata : null;
  const inheritedRef = inheritedSource && typeof inheritedSource.sourceItemId === "string" && typeof inheritedSource.sourceVersionId === "string" ? `content:${inheritedSource.sourceItemId}:${inheritedSource.sourceVersionId}` : null;
  const sources = [...draft.sources, ...(inheritedRef && !draft.sources.some((source) => source.ref === inheritedRef) ? [{ ref: inheritedRef, label: "Tutoriel source de la connaissance améliorée" }] : []), ...(draft.learningCandidateId && !draft.sources.some((source) => source.ref === `sav-learning:${draft.learningCandidateId}`) ? [{ ref: `sav-learning:${draft.learningCandidateId}`, label: "Résolution observée et qualifiée" }] : [])];
  const learning = draft.learningCandidateId ? await readSavLearningEvidence(draft.learningCandidateId, db) : null;
  if (learning && learning.fingerprint !== draft.learningSourceHash) throw new Error("SAV_OBSERVATION_STALE");
  const sourceHash = await sourceFingerprint(sources, db, lock);
  const inventory = await knowledgeComparisonInventory(db);
  const comparison = compareKnowledge({ title: draft.title, body: savProjectionBody(draft.document) }, inventory);
  const targetStale = (target.base?.id ?? null) !== draft.baseVersionId || (target.active?.versionId ?? null) !== draft.activeVersionId;
  const missing = completeness(draft.document, sources, draft.reason);
  const qualifiedDraft = await draftWithDelivery(draft, db);
  if (qualifiedDraft.delivery.mode === "unclassified") missing.push("Qualifier la restitution : procédure complète, diagnostic conditionnel ou consignes internes.");
  if (draft.title.trim().length < 3) missing.push("Donner un titre clair à la connaissance.");
  if (targetStale) missing.push("La version de référence a changé. Enregistrer à nouveau après comparaison.");
  return { draft: qualifiedDraft, sources, sourceHash, target, inventory, comparison, missing, activeVersion: target.activeVersion,
    snapshot: savContentHash({ draftId: draft.id, revision: draft.revision, document: draft.document, delivery: qualifiedDraft.delivery, sources, sourceHash, baseVersionId: target.base?.id ?? null, activeVersionId: target.active?.versionId ?? null, publishedVersionId: target.item?.publishedVersionId ?? null, inventory }) };
}
export async function previewSavKnowledgeProposal(draftId: string, actorEmail: string) {
  assertSavActor(actorEmail);
  const [draft] = await requireDb().select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.id, draftId));
  if (!draft) throw new Error("KNOWLEDGE_DRAFT_NOT_FOUND");
  return draftPreview(draft);
}
export async function submitSavKnowledgeProposal(input: { draftId: string; snapshot: string }, actorEmail: string) {
  assertSavActor(actorEmail);
  return requireDb().transaction(async (tx) => {
    const [draft] = await tx.select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.id, input.draftId)).for("update");
    if (!draft) throw new Error("KNOWLEDGE_DRAFT_NOT_FOUND");
    if (draft.createdBy !== actorEmail && actorEmail !== "ugo@limova.ai") throw new Error("KNOWLEDGE_DRAFT_OWNER_REQUIRED");
    if (draft.status === "submitted" && draft.candidateId) {
      const [candidate] = await tx.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, draft.candidateId));
      return candidate;
    }
    if (draft.status !== "draft") throw new Error("KNOWLEDGE_DRAFT_STALE");
    if (draft.learningCandidateId) { assertKnowledgeUgoApproval(actorEmail); await readSavLearningEvidence(draft.learningCandidateId, tx, true); }
    await targetState(draft.targetItemId, tx, true);
    const preview = await draftPreview(draft, tx, true);
    if (preview.snapshot !== input.snapshot) throw new Error("KNOWLEDGE_PREVIEW_STALE");
    if (preview.missing.length) throw new Error("KNOWLEDGE_PROPOSAL_INCOMPLETE");
    assertSafeOnboardingKnowledge(draft.document);
    const mappings = draft.targetItemId ? await tx.select({ family: knowledgeFamilies }).from(knowledgeProjections).innerJoin(knowledgeFamilies, eq(knowledgeFamilies.id, knowledgeProjections.familyId)).where(and(eq(knowledgeProjections.itemId, draft.targetItemId), eq(knowledgeProjections.surface, "sav"))) : [];
    const unique = new Map(mappings.map(({ family }) => [family.id, family]));
    if (unique.size > 1) throw new Error("KNOWLEDGE_ITEM_FAMILY_AMBIGUOUS");
    const [retainedFamily] = draft.familyId ? await tx.select().from(knowledgeFamilies).where(eq(knowledgeFamilies.id, draft.familyId)) : [];
    let family = retainedFamily ?? unique.values().next().value;
    if (retainedFamily && unique.size && !unique.has(retainedFamily.id)) throw new Error("KNOWLEDGE_TARGET_PROJECTION_AMBIGUOUS");
    const canonicalKey = family?.canonicalKey ?? (draft.targetItemId ? `content:${draft.targetItemId}` : `human-proposal:${draft.id}`);
    if (!family) { await tx.insert(knowledgeFamilies).values({ canonicalKey, title: draft.title, createdBy: actorEmail }).onConflictDoNothing(); [family] = await tx.select().from(knowledgeFamilies).where(eq(knowledgeFamilies.canonicalKey, canonicalKey)); }
    await tx.select().from(knowledgeFamilies).where(eq(knowledgeFamilies.id, family!.id)).for("update");
    const deliveryMetadata = savDeliveryMetadata(draft.document, createSavDeliveryEnvelope(draft.document, preview.draft.delivery));
    const canonicalHash = savContentHash({ document: draft.document, delivery: deliveryMetadata.envelope, draftId: draft.id, revision: draft.revision, sourceHash: preview.sourceHash });
    const [{ latest }] = await tx.select({ latest: max(knowledgeFamilyRevisions.revision) }).from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.familyId, family!.id));
    const [revision] = await tx.insert(knowledgeFamilyRevisions).values({ familyId: family!.id, revision: (latest ?? 0) + 1, canonicalHash, document: draft.document }).returning();
    const [source] = await tx.insert(knowledgeFamilySources).values({ familyId: family!.id, revisionId: revision.id, sourceRef: `sav-proposal:${draft.id}:${draft.revision}`, sourceHash: preview.sourceHash,
      evidence: { importKind: "sav_workspace", delivery: deliveryMetadata.envelope, origin: draft.origin, submittedBy: actorEmail, draftId: draft.id, draftRevision: draft.revision, sourceCandidateId: draft.sourceCandidateId, sources: preview.sources, sourceHash: preview.sourceHash, learningCandidateId: draft.learningCandidateId, learningSourceHash: draft.learningSourceHash, baseVersionId: draft.baseVersionId, activeVersionId: draft.activeVersionId, publishedVersionId: preview.target.item?.publishedVersionId ?? null } }).returning();
    const document = canonicalKnowledgeSchema.parse(draft.document);
    const baseResolution = preview.target.base && "resolution" in preview.target.base.metadata ? preview.target.base.metadata.resolution : undefined;
    // Canonical fields can be explicitly cleared; retain only unedited metadata.
    const inheritedResolution = { ...baseResolution };
    delete inheritedResolution.validUntil;
    const proposed = parseContentInput({ type: "article", slug: preview.target.item?.slug ?? `sav-${family!.id}`, locale: document.locale, title: draft.title, summary: document.objective, categorySlug: "depannage", visibility: "charly_only", agentKey: "sav", ownerEmail: preview.target.item?.ownerEmail ?? actorEmail, bodyMarkdown: savProjectionBody(document), changeNote: draft.reason,
      metadata: { intents: [document.objective, ...(document.supportContext?.symptoms ?? [])], limovaPaths: [], prerequisites: document.prerequisites, expectedResult: document.expectedResult, troubleshooting: document.escalation, semanticSteps: document.steps,
        sourceMetadata: { importKind: "sav_workspace", savDelivery: deliveryMetadata.envelope, knowledgeTitle: draft.title, canonicalFamilyId: family!.id, canonicalRevisionId: revision.id, canonicalObjective: document.objective, proposalDraftId: draft.id, sourceId: source.id, origin: draft.origin },
        resolution: { ...inheritedResolution, delivery: deliveryMetadata.projection, diagnostic: document.diagnostic, ...(document.supportContext?.responseTemplate ? { responseTemplate: document.supportContext.responseTemplate } : {}), ...(document.validUntil ? { validUntil: document.validUntil } : {}), symptoms: document.supportContext?.symptoms ?? [document.objective], steps: document.steps.map((step) => step.instruction), exceptions: document.exceptions, escalation: document.escalation, productVersion: document.productVersion, supersedes: [], conflictsWith: [] } } });
    const [candidate] = await tx.insert(knowledgeProjectionCandidates).values({ familyId: family!.id, revisionId: revision.id, sourceId: source.id, targetSurface: "sav", targetItemId: draft.targetItemId, baseVersionId: draft.baseVersionId, status: "pending", explanation: draft.reason, proposedInput: proposed, diff: { before: preview.activeVersion?.body ?? preview.target.base?.bodyMarkdown ?? "", after: proposed.bodyMarkdown }, createdBy: actorEmail }).returning();
    await tx.update(savKnowledgeProposalDrafts).set({ status: "submitted", candidateId: candidate.id, updatedAt: new Date() }).where(eq(savKnowledgeProposalDrafts.id, draft.id));
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_knowledge_proposal_submitted", entityType: "knowledge_candidate", entityId: candidate.id, technicalMetadata: { draftId: draft.id, revision: draft.revision, familyId: family!.id, origin: draft.origin, sourceId: source.id } });
    return candidate;
  });
}

export async function previewSavKnowledgeReview(candidateId: string, actorEmail: string, rawDocument?: unknown, db: Db = requireDb()) {
  assertSavActor(actorEmail);
  const [candidate] = await db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, candidateId));
  if (!candidate || candidate.targetSurface !== "sav") throw new Error("KNOWLEDGE_CANDIDATE_NOT_FOUND");
  const [source] = await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
  const [revision] = await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, candidate.revisionId));
  if (!source || !revision) throw new Error("KNOWLEDGE_PROVENANCE_REQUIRED");
  const document = canonicalKnowledgeSchema.parse(rawDocument ?? revision.document);
  let delivery = unclassifiedSavDelivery;
  if (source.evidence.importKind === "sav_workspace" && source.evidence.delivery) {
    // Bind the submitted qualification to its immutable source first. A review
    // correction requires a new preview and acknowledgement of the full rendering.
    delivery = readSavDeliveryEnvelope(canonicalKnowledgeSchema.parse(revision.document), source.evidence.delivery).qualification;
    assertSavSupportDelivery(document, delivery);
  }
  const target = await targetState(candidate.targetItemId, db);
  const inventory = await knowledgeComparisonInventory(db);
  const proposed = parseContentInput(candidate.proposedInput);
  const sources = Array.isArray(source.evidence.sources) ? source.evidence.sources as SavKnowledgeSource[] : [{ ref: source.sourceRef, label: "Source conservée dans le Studio" }];
  let sourceHash = source.sourceHash;
  let legacySnapshot: string | undefined;
  if (source.evidence.importKind === "sav_workspace") {
    sourceHash = await sourceFingerprint(sources, db);
    if (sourceHash !== source.evidence.sourceHash || target.base?.id !== (candidate.baseVersionId ?? undefined) || (target.active?.versionId ?? null) !== source.evidence.activeVersionId || (target.item?.publishedVersionId ?? null) !== source.evidence.publishedVersionId) throw new Error("KNOWLEDGE_REVIEW_STALE");
    if (typeof source.evidence.learningCandidateId === "string" && (await readSavLearningEvidence(source.evidence.learningCandidateId, db)).fingerprint !== source.evidence.learningSourceHash) throw new Error("SAV_OBSERVATION_STALE");
  } else if (source.evidence.importKind === "onboarding_catalog") legacySnapshot = (await prepareOnboardingReview(candidate, document, db)).snapshot;
  else if (source.evidence.importKind === "hubspot") legacySnapshot = (await prepareHubspotReview(candidate, document, db)).snapshot;
  const comparison = compareKnowledge({ title: proposed.title, body: savProjectionBody(document) }, inventory.filter((entry) => entry.ref !== `candidate:${candidate.id}`));
  return { candidate, source, revision, document, delivery, sources, comparison, activeVersion: target.activeVersion, legacySnapshot,
    missing: source.evidence.importKind === "sav_workspace" ? [...completeness(document, sources, candidate.explanation), ...(delivery.mode === "unclassified" ? ["Qualifier la restitution avant validation."] : [])] : [],
    snapshot: savContentHash({ candidateId, revisionId: revision.id, sourceHash, document, delivery, activeVersionId: target.active?.versionId ?? null, baseVersionId: target.base?.id ?? null, publishedVersionId: target.item?.publishedVersionId ?? null, inventory, legacySnapshot }) };
}

/** Called inside review's transaction so source/active-version checks cannot race materialization. */
export async function assertWorkspaceReview(candidate: typeof knowledgeProjectionCandidates.$inferSelect, document: CanonicalKnowledge, db: Tx) {
  const [source] = await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
  if (source?.evidence.importKind !== "sav_workspace") return;
  if (typeof source.evidence.learningCandidateId === "string") await readSavLearningEvidence(source.evidence.learningCandidateId, db, true);
  await targetState(candidate.targetItemId, db, true);
  const preview = await previewSavKnowledgeReview(candidate.id, "ugo@limova.ai", document, db);
  if (preview.missing.length) throw new Error("KNOWLEDGE_PROPOSAL_INCOMPLETE");
  assertSafeOnboardingKnowledge(document);
}
export async function reviewSavKnowledgeProposal(input: { candidateId: string; expectedRevisionId: string; snapshot: string; decision: "approve" | "reject" | "needs_completion"; reason: string; document?: unknown }, actorEmail: string) {
  assertKnowledgeCandidateReview(actorEmail, "sav");
  if (input.reason.trim().length < 10) throw new Error("KNOWLEDGE_REVIEW_REASON_REQUIRED");
  if (input.decision === "needs_completion") return requestSavKnowledgeCompletion(input, actorEmail);
  if (input.decision === "reject") return reviewKnowledgeCandidate(input.candidateId, { expectedRevisionId: input.expectedRevisionId, decision: "reject", reason: input.reason }, actorEmail);
  const preview = await previewSavKnowledgeReview(input.candidateId, actorEmail, input.document);
  if (preview.snapshot !== input.snapshot || preview.candidate.revisionId !== input.expectedRevisionId) throw new Error("KNOWLEDGE_REVIEW_STALE");
  return reviewKnowledgeCandidate(input.candidateId, { expectedRevisionId: input.expectedRevisionId, decision: input.decision, reason: input.reason, document: input.document, comparison: { snapshot: preview.legacySnapshot ?? input.snapshot, acknowledged: true }, workspaceSnapshot: input.snapshot }, actorEmail);
}
export async function requestSavKnowledgeCompletion(input: { candidateId: string; expectedRevisionId: string; reason: string }, actorEmail: string) {
  assertKnowledgeCandidateReview(actorEmail, "sav");
  if (input.reason.trim().length < 10) throw new Error("KNOWLEDGE_REVIEW_REASON_REQUIRED");
  return requireDb().transaction(async (tx) => {
    const [candidate] = await tx.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, input.candidateId)).for("update");
    if (!candidate || candidate.targetSurface !== "sav" || candidate.revisionId !== input.expectedRevisionId || !["pending", "needs_completion"].includes(candidate.status)) throw new Error("KNOWLEDGE_CANDIDATE_STALE");
    const [updated] = await tx.update(knowledgeProjectionCandidates).set({ status: "needs_completion" }).where(eq(knowledgeProjectionCandidates.id, candidate.id)).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_knowledge_completion_requested", entityType: "knowledge_candidate", entityId: candidate.id, technicalMetadata: { revisionId: candidate.revisionId, reason: input.reason } });
    return updated;
  });
}
/** Preserve resolution proof identity when an observed resolution improves an existing family. */
export async function finishWorkspaceLearningReview(candidate: typeof knowledgeProjectionCandidates.$inferSelect, itemId: string, versionId: string, actorEmail: string, tx: Tx) {
  const [source] = await tx.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
  const learningId = source?.evidence.importKind === "sav_workspace" ? source.evidence.learningCandidateId : null;
  if (typeof learningId !== "string") return;
  assertKnowledgeCandidateReview(actorEmail, "sav");
  const { candidate: learning } = await readSavLearningEvidence(learningId, tx, true);
  await tx.update(savLearningCandidates).set({ status: "approved", contentItemId: itemId, reviewedBy: actorEmail, reviewedAt: new Date() }).where(eq(savLearningCandidates.id, learning.id));
  await tx.insert(savResolutionEvidence).values({ itemId, versionId, hubspotTicketId: learning.hubspotTicketId, sourceRef: learning.sourceRef, weight: 900, outcome: "human_resolution", summary: "Procédure générique validée depuis la résolution observée." }).onConflictDoNothing();
}

/** New publications/activations require the exact reviewed proof; old active content stays available. */
export async function assertWorkspacePublicationSource(metadata: { sourceMetadata?: Record<string, unknown>; resolution?: { delivery?: unknown } }, db: Db = requireDb(), lock = false, restoring = false) {
  if (metadata.sourceMetadata?.importKind !== "sav_workspace") return;
  const id = z.uuid().parse(metadata.sourceMetadata.approvedCandidateId);
  const [candidate] = await db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, id));
  const [source] = candidate ? await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId)) : [];
  if (!candidate || candidate.status !== "approved" || !source || source.evidence.importKind !== "sav_workspace") throw new Error("KNOWLEDGE_CANONICAL_APPROVAL_REQUIRED");
  if (source.evidence.delivery) {
    const [approved] = await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, String(metadata.sourceMetadata?.canonicalRevisionId)));
    if (!approved) throw new Error("SAV_DELIVERY_DOCUMENT_CHANGED");
    const document = canonicalKnowledgeSchema.parse(approved.document);
    const [original] = await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, candidate.revisionId));
    if (!original) throw new Error("SAV_DELIVERY_DOCUMENT_CHANGED");
    const qualification = readSavDeliveryEnvelope(canonicalKnowledgeSchema.parse(original.document), source.evidence.delivery).qualification;
    const expected = savDeliveryMetadata(document, createSavDeliveryEnvelope(document, qualification));
    if (savDeliveryHash(metadata.sourceMetadata?.savDelivery) !== savDeliveryHash(expected.envelope)
      || savDeliveryHash(metadata.resolution?.delivery) !== savDeliveryHash(expected.projection)) throw new Error("SAV_DELIVERY_DOCUMENT_CHANGED");
  }
  if (typeof source.evidence.learningCandidateId === "string" && lock) await lockWorkspaceLearningSource(source.evidence.learningCandidateId, db);
  const target = await targetState(candidate.targetItemId, db, lock);
  const [restoration] = target.item ? await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "content"), eq(auditLogs.entityId, target.item.id), eq(auditLogs.action, "rolled_back"))).orderBy(desc(auditLogs.createdAt)).limit(1) : [];
  // An explicit, audited Ugo restoration may change the former review base, never the proof.
  const restored = restoring || Boolean(restoration?.actorEmail === "ugo@limova.ai" && restoration.technicalMetadata.versionId === candidate.materializedVersionId && restoration.technicalMetadata.previousActiveVersionId === (target.active?.versionId ?? null) && target.item?.publishedVersionId === candidate.materializedVersionId && target.item.currentDraftVersionId === candidate.materializedVersionId);
  if (!restored && (target.active?.versionId ?? null) !== source.evidence.activeVersionId && target.active?.versionId !== candidate.materializedVersionId) throw new Error("KNOWLEDGE_REVIEW_STALE");
  if (!restored && (target.item?.publishedVersionId ?? null) !== source.evidence.publishedVersionId && target.item?.publishedVersionId !== candidate.materializedVersionId) throw new Error("KNOWLEDGE_REVIEW_STALE");
  const sources = source.evidence.sources as SavKnowledgeSource[];
  if (!Array.isArray(sources) || !sources.length || await sourceFingerprint(sources, db, lock) !== source.evidence.sourceHash) throw new Error("KNOWLEDGE_SOURCE_STALE");
  if (typeof source.evidence.learningCandidateId === "string" && (await readSavLearningEvidence(source.evidence.learningCandidateId, db, lock)).fingerprint !== source.evidence.learningSourceHash) throw new Error("SAV_OBSERVATION_STALE");
}

export async function finishWorkspaceLearningRejection(candidate: typeof knowledgeProjectionCandidates.$inferSelect, actorEmail: string, tx: Tx) {
  const [source] = await tx.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
  const learningId = source?.evidence.importKind === "sav_workspace" ? source.evidence.learningCandidateId : null;
  if (typeof learningId !== "string") return;
  assertKnowledgeCandidateReview(actorEmail, "sav");
  await tx.update(savLearningCandidates).set({ status: "rejected", rejectionKind: "human", reviewedBy: actorEmail, reviewedAt: new Date() }).where(and(eq(savLearningCandidates.id, learningId), eq(savLearningCandidates.status, "pending")));
  await closeSavLearningReservationTx(tx, learningId);
}


/** A correction is a new editorial revision in the same family; previous decisions remain immutable. */
export async function startSavKnowledgeRevision(candidateId: string, actorEmail: string) {
  assertSavActor(actorEmail);
  return requireDb().transaction(async (tx) => {
    const [candidate] = await tx.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, candidateId)).for("update");
    if (!candidate || candidate.targetSurface !== "sav" || !["pending", "needs_completion", "rejected"].includes(candidate.status)) throw new Error("KNOWLEDGE_CANDIDATE_NOT_REVIEWABLE");
    const [existing] = await tx.select().from(savKnowledgeProposalDrafts).where(eq(savKnowledgeProposalDrafts.sourceCandidateId, candidate.id));
    if (existing) return toSavKnowledgeDraft(existing);
    const [source] = await tx.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
    const [revision] = await tx.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, candidate.revisionId));
    if (!source || !revision) throw new Error("KNOWLEDGE_PROVENANCE_REQUIRED");
    if (source.evidence.importKind !== "sav_workspace") throw new Error("KNOWLEDGE_SPECIALIZED_REVIEW_REQUIRED");
    const learningId = typeof source.evidence.learningCandidateId === "string" ? source.evidence.learningCandidateId : null;
    if (learningId) assertKnowledgeUgoApproval(actorEmail);
    const learning = learningId ? await readSavLearningEvidence(learningId, tx, true, true) : null;
    if (learning && learning.fingerprint !== source.evidence.learningSourceHash) throw new Error("SAV_OBSERVATION_STALE");
    if (learning?.candidate.status === "rejected") {
      throw new Error("SAV_LEARNING_REJECTION_FINAL");
    }
    const target = await targetState(candidate.targetItemId, tx, true);
    const proposed = parseContentInput(candidate.proposedInput);
    const sourceItemId = typeof source.evidence.sourceItemId === "string" ? source.evidence.sourceItemId : null;
    const sourceVersionId = typeof source.evidence.sourceVersionId === "string" ? source.evidence.sourceVersionId : source.sourceVersionId;
    let sources: SavKnowledgeSource[] = source.evidence.importKind === "sav_workspace" && Array.isArray(source.evidence.sources) ? source.evidence.sources as SavKnowledgeSource[] : [];
    if (!sources.length && sourceItemId && sourceVersionId) sources = [{ ref: `content:${sourceItemId}:${sourceVersionId}`, label: "Tutoriel source : vérifier la version actuelle" }];
    if (!sources.length) sources = [{ ref: `knowledge-source:${source.id}`, label: "Preuve conservée du candidat précédent" }];
    const origin = source.evidence.origin === "human" ? "human" : source.evidence.origin === "automatic" || ["hubspot", "onboarding_catalog"].includes(String(source.evidence.importKind)) || /^(?:training|content|sav-learning):/.test(source.sourceRef) ? "automatic" : "unknown";
    const [draft] = await tx.insert(savKnowledgeProposalDrafts).values({ familyId: candidate.familyId, sourceCandidateId: candidate.id, mode: target.item ? "improve" : "new", targetItemId: target.item?.id ?? null, baseVersionId: target.base?.id ?? null, activeVersionId: target.active?.versionId ?? null, title: proposed.title, document: revision.document, sources, reason: "", origin, learningCandidateId: learningId, learningSourceHash: learning?.fingerprint ?? null, createdBy: actorEmail }).returning();
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_knowledge_revision_started", entityType: "knowledge_draft", entityId: draft.id, technicalMetadata: { sourceCandidateId: candidate.id, familyId: candidate.familyId, origin } });
    return toSavKnowledgeDraft(draft);
  });
}


export async function workspaceSourceStatus(metadata: { sourceMetadata?: Record<string, unknown> }) {
  if (metadata.sourceMetadata?.importKind !== "sav_workspace") return null;
  try {
    const [candidate] = await requireDb().select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, String(metadata.sourceMetadata.approvedCandidateId)));
    const [source] = candidate ? await requireDb().select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId)) : [];
    if (!source || !candidate || candidate.status !== "approved" || !Array.isArray(source.evidence.sources)) return "changed" as const;
    if (await sourceFingerprint(source.evidence.sources as SavKnowledgeSource[]) !== source.evidence.sourceHash) return "changed" as const;
    if (typeof source.evidence.learningCandidateId === "string" && (await readSavLearningEvidence(source.evidence.learningCandidateId)).fingerprint !== source.evidence.learningSourceHash) return "changed" as const;
    return "current" as const;
  } catch { return "changed" as const; }
}
