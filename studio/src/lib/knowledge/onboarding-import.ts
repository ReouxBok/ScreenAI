import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { activeOnboardingTemplate, auditLogs, contentItems, contentVersions, knowledgeFamilies, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjectionCandidates, knowledgeProjections, onboardingTemplateVersions } from "@/db/schema";
import { onboardingMetadataSchema, parseContentInput } from "@/lib/content";
import { assertSavActor } from "@/lib/sav/access";
import { savContentHash } from "@/lib/sav/crypto";
import { LIMOVA_CURRICULUM, curriculumSlug } from "@/lib/limova-curriculum";
import { buildOperationalJourney } from "@/lib/operational-journey";
import { canonicalKnowledgeSchema } from "./contracts";
import { savProjectionBody } from "./conversion";
import { prepareOnboardingKnowledge } from "./onboarding-extraction";
import { hubspotComparison, knowledgeComparisonInventory } from "./hubspot-import";
import { assertOnboardingSectionEvidence, ONBOARDING_KNOWLEDGE_CONVERTER } from "./onboarding-sections";

const CONVERTER = ONBOARDING_KNOWLEDGE_CONVERTER;
const BATCH_ACTION = "knowledge_onboarding_batch";
type Reader = Pick<ReturnType<typeof requireDb>, "select">;
type Transaction = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
type Source = { key: string; kind: "studio" | "curriculum"; title: string; version: number; versionId: string | null; itemId: string | null; hash: string; indexed: boolean; aliases: Array<{ key: string; hash: string; differs: boolean }> };
type Outcome = { state: "candidate" | "failed"; candidateId?: string; status?: string; error?: string; attempts: number };
type Manifest = { converter: string; sources: Source[]; inventory: { studioActive: number; studioIndexed: number; curriculum: number; mappedCurriculum: number; templateVersionId: string | null; templateReferences: string[]; excluded: Array<{ id: string; reason: string }> } };
type Batch = { manifest: Manifest; outcomes: Record<string, Outcome> };
function curriculum() {
  return LIMOVA_CURRICULUM.map((entry) => ({ key: `curriculum:${curriculumSlug(entry.title)}`, title: entry.title, locale: "fr-FR", ...buildOperationalJourney(entry) }));
}
function sourceHash(input: { title: string; locale: string; bodyMarkdown: string; metadata: unknown; versionId: string | null; aliases?: Source["aliases"] }) {
  return savContentHash(input);
}
function batchData(row: typeof auditLogs.$inferSelect): Batch {
  if (row.action !== BATCH_ACTION) throw new Error("ONBOARDING_BATCH_NOT_FOUND");
  return { manifest: JSON.parse(String(row.technicalMetadata.manifest)), outcomes: JSON.parse(String(row.technicalMetadata.outcomes ?? "{}")) };
}
function summary(row: typeof auditLogs.$inferSelect) {
  const { manifest, outcomes } = batchData(row);
  const states = Object.values(outcomes);
  return { id: row.id, total: manifest.sources.length, processed: states.filter((value) => value.state === "candidate").length,
    failed: states.filter((value) => value.state === "failed").length, remaining: manifest.sources.length - states.length,
    needsCompletion: states.filter((value) => value.status === "needs_completion").length,
    ready: states.filter((value) => value.status === "pending").length, createdAt: row.createdAt };
}

/** One SQL snapshot of all published sources; the source itself is never modified. */
export async function inventoryOnboardingSources(db = requireDb()): Promise<Manifest> {
  const items = await db.select({ item: contentItems, version: contentVersions, indexed: sql<boolean>`exists (select 1 from content_chunks c where c.item_id=${contentItems.id} and c.version_id=${contentItems.publishedVersionId})` })
    .from(contentItems).leftJoin(contentVersions, eq(contentVersions.id, contentItems.publishedVersionId)).where(eq(contentItems.type, "onboarding")).orderBy(asc(contentItems.id));
  const active = items.filter(({ item, version }) => version && item.publishedVersionId && item.status !== "archived" && item.aiEnabled && item.agentKey !== "sav");
  const runtime = curriculum();
  const mapped = new Set<string>();
  const sources: Source[] = active.map(({ item, version, indexed }) => {
    const aliases = runtime.filter((entry) => entry.title === item.title).map((entry) => {
      mapped.add(entry.key);
      return { key: entry.key, hash: sourceHash({ ...entry, versionId: null }), differs: entry.bodyMarkdown !== version!.bodyMarkdown };
    });
    return { key: `content:${item.id}`, kind: "studio", title: item.title, itemId: item.id, versionId: version!.id, version: version!.version, indexed, aliases,
      hash: sourceHash({ title: item.title, locale: item.locale, bodyMarkdown: version!.bodyMarkdown, metadata: version!.metadata, versionId: version!.id, aliases }) };
  });
  for (const entry of runtime.filter((value) => !mapped.has(value.key))) sources.push({ key: entry.key, kind: "curriculum", title: entry.title, itemId: null, versionId: null, version: 1, indexed: false, aliases: [], hash: sourceHash({ ...entry, versionId: null }) });
  const [template] = await db.select({ version: onboardingTemplateVersions }).from(activeOnboardingTemplate).innerJoin(onboardingTemplateVersions, eq(onboardingTemplateVersions.id, activeOnboardingTemplate.publishedVersionId)).limit(1);
  return { converter: CONVERTER, sources: sources.sort((a, b) => a.key.localeCompare(b.key)), inventory: {
    studioActive: active.length, studioIndexed: active.filter((row) => row.indexed).length, curriculum: runtime.length, mappedCurriculum: mapped.size,
    templateVersionId: template?.version.id ?? null, templateReferences: template?.version.definition.nodes.map((node) => node.contentItemId) ?? [],
    excluded: items.filter((row) => !active.includes(row)).map(({ item }) => ({ id: item.id, reason: item.status === "archived" ? "archived" : !item.publishedVersionId ? "unpublished" : !item.aiEnabled ? "disabled" : "sav_scope" })),
  } };
}

export async function startOnboardingImport(actorEmail: string) {
  assertSavActor(actorEmail);
  const manifest = await inventoryOnboardingSources();
  const hex = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  await requireDb().insert(auditLogs).values({ id, actorEmail, action: BATCH_ACTION, entityType: "knowledge_import", entityId: id,
    technicalMetadata: { manifest: JSON.stringify(manifest), outcomes: "{}", converter: CONVERTER } }).onConflictDoNothing();
  const [row] = await requireDb().select().from(auditLogs).where(eq(auditLogs.id, id));
  return summary(row);
}

async function readSource(source: Source, db: Reader) {
  if (source.kind === "curriculum") {
    const entry = curriculum().find((value) => value.key === source.key);
    if (!entry || sourceHash({ ...entry, versionId: null }) !== source.hash || entry.title !== source.title) throw new Error("ONBOARDING_SOURCE_STALE");
    return entry;
  }
  const [row] = await db.select({ item: contentItems, version: contentVersions }).from(contentItems).innerJoin(contentVersions, eq(contentVersions.id, contentItems.publishedVersionId)).where(eq(contentItems.id, source.itemId!));
  if (!row || row.item.type !== "onboarding" || row.item.agentKey === "sav" || row.item.status === "archived" || !row.item.aiEnabled || row.version.id !== source.versionId) throw new Error("ONBOARDING_SOURCE_STALE");
  const runtime = curriculum();
  const aliases = source.aliases.map((alias) => {
    const entry = runtime.find((value) => value.key === alias.key);
    if (!entry) throw new Error("ONBOARDING_SOURCE_STALE");
    return { key: entry.key, hash: sourceHash({ ...entry, versionId: null }), differs: entry.bodyMarkdown !== row.version.bodyMarkdown };
  });
  const value = { title: row.item.title, locale: row.item.locale, bodyMarkdown: row.version.bodyMarkdown, metadata: onboardingMetadataSchema.parse(row.version.metadata) };
  // Hash raw persisted metadata: schema defaults must not alter source identity.
  if (sourceHash({ ...value, metadata: row.version.metadata, versionId: row.version.id, aliases }) !== source.hash || row.item.title !== source.title) throw new Error("ONBOARDING_SOURCE_STALE");
  return value;
}

async function prepareSource(tx: Transaction, source: Source, actorEmail: string) {
  const value = await readSource(source, tx);
  const prepared = prepareOnboardingKnowledge({ ...value, metadata: onboardingMetadataSchema.parse(value.metadata), sourceKey: source.key });
  const document = canonicalKnowledgeSchema.parse(prepared.document);
  const missing = [...prepared.quality.missing];
  if (savProjectionBody(document).length > 12_000) missing.push("La procédure dépasse la taille transmise intégralement à l’agent : la structurer avant validation.");
  if (source.aliases.some((alias) => alias.differs)) missing.push("Le catalogue embarqué et le tutoriel publié diffèrent : arbitrer les différences avant validation.");
  const quality = { ...prepared.quality, missing, state: missing.length ? "needs_completion" as const : prepared.quality.state };
  const familyRows = source.itemId ? await tx.select({ family: knowledgeFamilies }).from(knowledgeProjections).innerJoin(knowledgeFamilies, eq(knowledgeFamilies.id, knowledgeProjections.familyId)).where(eq(knowledgeProjections.itemId, source.itemId)) : [];
  const familyIds = new Set(familyRows.map((row) => row.family.id));
  if (familyIds.size > 1) throw new Error("KNOWLEDGE_ITEM_FAMILY_AMBIGUOUS");
  const key = familyRows[0]?.family.canonicalKey ?? source.key;
  await tx.insert(knowledgeFamilies).values({ canonicalKey: key, title: source.title, createdBy: actorEmail }).onConflictDoNothing();
  const [family] = await tx.select().from(knowledgeFamilies).where(eq(knowledgeFamilies.canonicalKey, key)).for("update");
  // Source and converter identities version evidence, including equal text republished.
  const hash = savContentHash({ converter: CONVERTER, key: source.key, sourceHash: source.hash, versionId: source.versionId });
  const [existingSource] = await tx.select().from(knowledgeFamilySources).where(and(eq(knowledgeFamilySources.familyId, family.id), eq(knowledgeFamilySources.sourceRef, source.key), eq(knowledgeFamilySources.sourceHash, hash)));
  if (existingSource) {
    const [existing] = await tx.select().from(knowledgeProjectionCandidates).where(and(eq(knowledgeProjectionCandidates.revisionId, existingSource.revisionId), eq(knowledgeProjectionCandidates.targetSurface, "sav")));
    if (!existing) throw new Error("ONBOARDING_CANDIDATE_MISSING");
    return existing;
  }
  // Lock the item only after the family, matching the human review lock order.
  if (source.itemId) await tx.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.id, source.itemId)).for("update");
  await readSource(source, tx);
  const canonicalHash = savContentHash({ document, hash });
  const [{ latest }] = await tx.select({ latest: max(knowledgeFamilyRevisions.revision) }).from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.familyId, family.id));
  const [revision] = await tx.insert(knowledgeFamilyRevisions).values({ familyId: family.id, revision: (latest ?? 0) + 1, canonicalHash, document }).returning();
  const [evidence] = await tx.insert(knowledgeFamilySources).values({ familyId: family.id, revisionId: revision.id, sourceRef: source.key, sourceHash: hash, sourceVersionId: source.versionId,
    evidence: { importKind: "onboarding_catalog", converter: CONVERTER, sourceItemId: source.itemId, sourceVersionId: source.versionId, sourceTitle: source.title, sourceHash: source.hash, snapshot: source, quality, provenance: prepared.provenance } }).returning();
  // A prior Chrome mapping is evidence, never silently replaced by this SAV conversion.
  if (source.itemId && source.versionId) await tx.insert(knowledgeProjections).values({ familyId: family.id, revisionId: revision.id, surface: "onboarding", itemId: source.itemId, versionId: source.versionId }).onConflictDoNothing();
  const targets = await tx.select({ item: contentItems }).from(knowledgeProjections).innerJoin(contentItems, eq(contentItems.id, knowledgeProjections.itemId)).where(and(eq(knowledgeProjections.familyId, family.id), eq(knowledgeProjections.surface, "sav")));
  const unique = new Map(targets.map(({ item }) => [item.id, item]));
  if (unique.size > 1) throw new Error("KNOWLEDGE_TARGET_PROJECTION_AMBIGUOUS");
  const target = unique.values().next().value;
  const baseVersionId = target?.currentDraftVersionId ?? target?.publishedVersionId ?? null;
  const [base] = baseVersionId ? await tx.select().from(contentVersions).where(eq(contentVersions.id, baseVersionId)) : [];
  const proposedInput = parseContentInput({ type: "article", slug: target?.slug ?? `sav-${family.id}`, title: source.title, summary: document.objective, locale: value.locale,
    categorySlug: "depannage", visibility: "charly_only", agentKey: "sav", ownerEmail: target?.ownerEmail ?? actorEmail,
    bodyMarkdown: savProjectionBody(document), changeNote: "Connaissance candidate issue d’un tutoriel ; validation Ugo puis publication distincte", metadata: {
      intents: [...new Set([document.objective, ...(document.supportContext?.symptoms ?? [])])].slice(0, 50), limovaPaths: [], prerequisites: document.prerequisites, expectedResult: document.expectedResult, troubleshooting: document.escalation, semanticSteps: document.steps,
      sourceMetadata: { importKind: "onboarding_catalog", canonicalFamilyId: family.id, canonicalRevisionId: revision.id, sourceItemId: source.itemId, sourceVersionId: source.versionId, sourceTitle: source.title, sourceHash: source.hash, quality },
      // Candidates may be incomplete; keep the canonical evidence empty and label its gap explicitly.
      // Human review requires a completed canonical recovery before preparing a publishable draft.
      resolution: { symptoms: document.supportContext?.symptoms ?? [document.objective], steps: document.steps.map((step) => step.instruction), exceptions: document.exceptions, escalation: document.escalation.trim().length >= 3 ? document.escalation : "À compléter : reprise sûre non documentée dans la source.", productVersion: document.productVersion, supersedes: [], conflictsWith: [] },
    } });
  if (proposedInput.title !== source.title) throw new Error("ONBOARDING_EXACT_TITLE_REQUIRED");
  const [candidate] = await tx.insert(knowledgeProjectionCandidates).values({ familyId: family.id, revisionId: revision.id, sourceId: evidence.id, targetSurface: "sav", targetItemId: target?.id, baseVersionId,
    status: quality.state === "ready" ? "pending" : "needs_completion", explanation: quality.state === "ready" ? "Procédure sourcée à relire et comparer par Ugo. Publication et activation distinctes." : `À compléter avant validation : ${missing.join(" ")}`,
    proposedInput, diff: { before: base?.bodyMarkdown ?? "", after: proposedInput.bodyMarkdown }, createdBy: actorEmail }).returning();
  await tx.insert(auditLogs).values({ actorEmail, action: "knowledge_projection_proposed", entityType: "knowledge_candidate", entityId: candidate.id, technicalMetadata: { sourceHash: source.hash, sourceKey: source.key, converter: CONVERTER } });
  return candidate;
}

/** Bounded pages, durable outcomes and per-source savepoints. No providers or indexing. */
export async function continueOnboardingImport(id: string, actorEmail: string, limit = 10) {
  assertSavActor(actorEmail); z.uuid().parse(id);
  const size = Math.max(1, Math.min(25, Math.floor(limit) || 10));
  return requireDb().transaction(async (tx) => {
    const [row] = await tx.select().from(auditLogs).where(eq(auditLogs.id, id)).for("update");
    if (!row) throw new Error("ONBOARDING_BATCH_NOT_FOUND");
    const { manifest, outcomes } = batchData(row);
    if (manifest.converter !== CONVERTER) throw new Error("ONBOARDING_BATCH_VERSION_STALE");
    const selected = manifest.sources.filter((source) => outcomes[source.key]?.state !== "candidate")
      .sort((a, b) => (outcomes[a.key]?.attempts ?? 0) - (outcomes[b.key]?.attempts ?? 0) || a.key.localeCompare(b.key)).slice(0, size);
    for (const source of selected) {
      const attempts = (outcomes[source.key]?.attempts ?? 0) + 1;
      try {
        const candidate = await tx.transaction((savepoint) => prepareSource(savepoint, source, actorEmail));
        outcomes[source.key] = { state: "candidate", candidateId: candidate.id, status: candidate.status, attempts };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        outcomes[source.key] = { state: "failed", error: /^[A-Z][A-Z_]+$/.test(message) ? message : "ONBOARDING_CONVERSION_FAILED", attempts };
      }
    }
    const [updated] = await tx.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, outcomes: JSON.stringify(outcomes), updatedAt: new Date().toISOString() } }).where(eq(auditLogs.id, id)).returning();
    return summary(updated);
  });
}

export async function listOnboardingImports() {
  const rows = await requireDb().select().from(auditLogs).where(eq(auditLogs.action, BATCH_ACTION)).orderBy(desc(auditLogs.createdAt)).limit(10);
  return rows.map(summary);
}

export async function proposeActiveOnboardingKnowledge(itemId: string, versionId: string, actorEmail: string) {
  assertSavActor(actorEmail); z.uuid().parse(itemId); z.uuid().parse(versionId);
  const manifest = await inventoryOnboardingSources();
  const source = manifest.sources.find((entry) => entry.itemId === itemId && entry.versionId === versionId);
  if (!source) throw new Error("ONBOARDING_SOURCE_STALE");
  return requireDb().transaction((tx) => prepareSource(tx, source, actorEmail));
}
export async function getOnboardingImport(id: string) {
  const [row] = await requireDb().select().from(auditLogs).where(and(eq(auditLogs.id, z.uuid().parse(id)), eq(auditLogs.action, BATCH_ACTION)));
  if (!row) throw new Error("ONBOARDING_BATCH_NOT_FOUND");
  return { ...summary(row), ...batchData(row) };
}

export async function prepareOnboardingReview(candidate: typeof knowledgeProjectionCandidates.$inferSelect, rawDocument?: unknown, db: Reader = requireDb()) {
  const [source] = await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
  const [revision] = await db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, candidate.revisionId));
  if (!source || !revision || source.evidence.importKind !== "onboarding_catalog" || source.revisionId !== revision.id || source.familyId !== candidate.familyId) throw new Error("KNOWLEDGE_PROVENANCE_REQUIRED");
  if (source.evidence.converter !== CONVERTER) throw new Error("ONBOARDING_CONVERTER_STALE");
  const snapshot = source.evidence.snapshot as Source;
  await readSource(snapshot, db);
  const document = canonicalKnowledgeSchema.parse(rawDocument ?? revision.document);
  assertOnboardingSectionEvidence(document, canonicalKnowledgeSchema.parse(revision.document));
  const original = parseContentInput(candidate.proposedInput);
  const proposed = parseContentInput({ ...original, title: snapshot.title, summary: document.objective, bodyMarkdown: savProjectionBody(document) });
  const targets = await db.select({ item: contentItems }).from(knowledgeProjections).innerJoin(contentItems, eq(contentItems.id, knowledgeProjections.itemId)).where(and(eq(knowledgeProjections.familyId, candidate.familyId), eq(knowledgeProjections.surface, "sav")));
  const unique = new Map(targets.map(({ item }) => [item.id, item]));
  if (unique.size > 1) throw new Error("KNOWLEDGE_TARGET_PROJECTION_AMBIGUOUS");
  const target = unique.values().next().value;
  if (target && (target.status === "archived" || target.agentKey !== "sav")) throw new Error("KNOWLEDGE_TARGET_STALE");
  const baseVersionId = target?.currentDraftVersionId ?? target?.publishedVersionId ?? null;
  const [base] = baseVersionId ? await db.select().from(contentVersions).where(eq(contentVersions.id, baseVersionId)) : [];
  const comparison = hubspotComparison({ id: candidate.id, proposedInput: proposed }, await knowledgeComparisonInventory(db));
  const quality = source.evidence.quality as { missing: string[]; warnings: string[] };
  return { ...comparison, snapshot: savContentHash({ comparison: comparison.snapshot, source: snapshot, document, target: target?.id ?? null, baseVersionId }),
    sourceCurrent: true, title: snapshot.title, missing: quality.missing, warnings: quality.warnings,
    targetItemId: target?.id ?? null, baseVersionId, before: base?.bodyMarkdown ?? "", after: proposed.bodyMarkdown };
}

/** A previously approved draft still depends on the exact active tutorial evidence. */
export async function assertOnboardingPublicationSource(metadata: { sourceMetadata?: Record<string, unknown> }, db: Reader = requireDb(), lock = false) {
  if (metadata.sourceMetadata?.importKind !== "onboarding_catalog") return;
  const candidateId = z.uuid().parse(metadata.sourceMetadata.approvedCandidateId);
  const [candidate] = await db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, candidateId));
  if (!candidate || candidate.status !== "approved") throw new Error("KNOWLEDGE_CANONICAL_APPROVAL_REQUIRED");
  const [source] = await db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
  if (!source || source.evidence.importKind !== "onboarding_catalog") throw new Error("KNOWLEDGE_PROVENANCE_REQUIRED");
  if (source.evidence.converter !== CONVERTER) throw new Error("ONBOARDING_CONVERTER_STALE");
  const snapshot = source.evidence.snapshot as Source;
  if (lock && snapshot.itemId) await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.id, snapshot.itemId)).for("update");
  await readSource(snapshot, db);
}

/** Ugo keeps the published knowledge available; source drift is an editorial alert. */
export async function onboardingSourceStatus(metadata: { sourceMetadata?: Record<string, unknown> }) {
  if (metadata.sourceMetadata?.importKind !== "onboarding_catalog") return null;
  try {
    await assertOnboardingPublicationSource(metadata);
    return "current" as const;
  } catch (error) {
    if (error instanceof Error && error.message === "ONBOARDING_CONVERTER_STALE") return "preparation_stale" as const;
    return error instanceof Error && error.message === "ONBOARDING_SOURCE_STALE" ? "changed" as const : "unavailable" as const;
  }
}
