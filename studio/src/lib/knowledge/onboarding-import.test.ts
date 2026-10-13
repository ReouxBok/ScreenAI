import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { activeOnboardingTemplate, auditLogs, categories, contentChunks, contentItems, contentVersions, knowledgeFamilies, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjectionCandidates, knowledgeProjections, onboardingTemplateVersions } from "@/db/schema";
import type { OnboardingMetadata } from "@/db/schema";
import type { CurriculumJourney } from "@/lib/limova-curriculum";
import { searchKnowledge } from "@/lib/search";
import { parseContentInput } from "@/lib/content";
import { publish, rollback, saveDraft, setContentAiEnabled } from "@/lib/workflow";
import { canonicalKnowledgeSchema } from "./contracts";
import { savContentHash } from "@/lib/sav/crypto";
import { ONBOARDING_KNOWLEDGE_CONVERTER } from "./onboarding-sections";
import { registerCanonicalKnowledge } from "./families";
import { prepareOnboardingKnowledge } from "./onboarding-extraction";
import { paginateKnowledgeCandidates } from "./candidates";
import { continueOnboardingImport, getOnboardingImport, inventoryOnboardingSources, listOnboardingImports, onboardingSourceStatus, prepareOnboardingReview, startOnboardingImport } from "./onboarding-import";
import { reviewKnowledgeCandidate } from "./review";

const state = vi.hoisted(() => ({ db: null as unknown, curriculum: [] as CurriculumJourney[], embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(1))) }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("@/lib/embeddings", () => ({ embedTexts: state.embed }));
vi.mock("@/lib/limova-curriculum", () => ({
  LIMOVA_CURRICULUM: state.curriculum,
  curriculumSlug: (title: string) => title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
}));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let sequence = 0;
const actor = "ugo@limova.ai";
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
beforeEach(async () => {
  await fixture.client.exec("TRUNCATE knowledge_families, content_items, categories, onboarding_template_versions CASCADE; TRUNCATE audit_logs");
  await fixture.db.insert(categories).values([{ slug: "bien-demarrer", label: "Démarrer" }, { slug: "depannage", label: "Dépannage" }]);
  state.curriculum.splice(0); state.embed.mockClear(); sequence = 0;
});

// All content in this file is synthetic. No provider, model or production corpus is used.
const body = `# Renommer un espace de démonstration
## Quand utiliser ce parcours
Quand le nom d’un espace de test existant doit changer.
## Point d’entrée
Ouvrir « Paramètres » en bas à gauche.
## Prérequis
- Disposer du rôle administrateur de cet espace de test.
## Questions à poser si l’information manque
- Quel espace de test voulez-vous renommer ?
## Étapes opérationnelles
1. Ouvrir « Paramètres » en bas à gauche, puis « Général ».
2. Saisir le nouveau nom dans « Nom de l’espace ».
3. Cliquer sur « Enregistrer » et attendre la confirmation.
## Vérification de réussite
- Le nouveau nom apparaît dans l’en-tête de l’espace de test.
## Variantes et blocages
- Si le nom est déjà utilisé : choisir un nom différent.
## Reprise sûre
- Si la confirmation ne s’affiche pas, vérifier le nom affiché avant de recommencer.`;
const metadata: OnboardingMetadata = { objective: "Renommer un espace de démonstration", proposalSignals: [], qualificationQuestions: [], expectedPages: [], successCriteria: [], branches: [], fallbacks: [], actionSteps: [] };
type Candidate = typeof knowledgeProjectionCandidates.$inferSelect;
async function tutorial(input: {
  title?: string; body?: string; metadata?: OnboardingMetadata;
  item?: Partial<typeof contentItems.$inferInsert>; published?: boolean; indexed?: boolean;
} = {}) {
  const n = ++sequence;
  const [item] = await fixture.db.insert(contentItems).values({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, slug: `onboarding-fixture-${n}`, type: "onboarding", title: input.title ?? `Renommer un espace de démonstration ${n}`, ownerEmail: actor, agentKey: "charly", status: "published", aiEnabled: true, ...input.item }).returning();
  const [version] = await fixture.db.insert(contentVersions).values({ itemId: item.id, version: 1, bodyMarkdown: input.body ?? body, metadata: input.metadata ?? metadata, changeNote: "Source synthétique", authorEmail: actor }).returning();
  const [saved] = await fixture.db.update(contentItems).set({ publishedVersionId: input.published === false ? null : version.id, currentDraftVersionId: version.id }).where(eq(contentItems.id, item.id)).returning();
  if (input.indexed) await fixture.db.insert(contentChunks).values({ itemId: item.id, versionId: version.id, ordinal: 0, content: body, embedding: Array(768).fill(1) });
  return { item: saved, version };
}
async function republish(source: Awaited<ReturnType<typeof tutorial>>, overrides: Partial<typeof contentVersions.$inferInsert> = {}) {
  const [version] = await fixture.db.insert(contentVersions).values({ itemId: source.item.id, version: source.version.version + 1, bodyMarkdown: source.version.bodyMarkdown, metadata: source.version.metadata, changeNote: "Nouvelle preuve synthétique", authorEmail: actor, ...overrides }).returning();
  const [item] = await fixture.db.update(contentItems).set({ currentDraftVersionId: version.id, publishedVersionId: version.id }).where(eq(contentItems.id, source.item.id)).returning();
  return { item, version };
}
async function processAll() {
  const batch = await startOnboardingImport(actor);
  for (let done = 0; done < batch.total; done += 25) await continueOnboardingImport(batch.id, actor, 25);
  return getOnboardingImport(batch.id);
}
async function candidateFor(source: Awaited<ReturnType<typeof tutorial>>) {
  const batch = await processAll();
  const outcome = batch.outcomes[`content:${source.item.id}`];
  expect(outcome, JSON.stringify(batch.outcomes)).toMatchObject({ state: "candidate" });
  const [candidate] = await fixture.db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, outcome.candidateId!));
  return candidate;
}
async function documentFor(candidate: Candidate) {
  const [revision] = await fixture.db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, candidate.revisionId));
  return canonicalKnowledgeSchema.parse(revision.document);
}
async function approval(candidate: Candidate, document?: unknown) {
  const comparison = await prepareOnboardingReview(candidate, document);
  return { expectedRevisionId: candidate.revisionId, decision: "approve" as const, reason: "Procédure synthétique relue avec ses sources et différences.", ...(document ? { document } : {}), comparison: { snapshot: comparison.snapshot, acknowledged: true } };
}
async function reread(candidate: Candidate) {
  return (await fixture.db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, candidate.id)))[0];
}

describe("SAV-51 onboarding inventory and resumable import", () => {
  it.each(["needs_completion", "pending"])("blocks cosmetic approval with unresolved source sections even with status %s", async (status) => {
    const source = await tutorial({ body: body + "\n## Précaution particulière\nNe jamais désactiver l’authentification avant le transfert de propriété." });
    const candidate = await candidateFor(source);
    await fixture.db.update(knowledgeProjectionCandidates).set({ status: status as Candidate["status"] }).where(eq(knowledgeProjectionCandidates.id, candidate.id));
    const document = await documentFor(candidate);
    document.objective += " Objectif relu.";
    await expect(reviewKnowledgeCandidate(candidate.id, { ...await approval(candidate, document), missingAcknowledged: true,
      completionNote: "Relecture de la source avec une correction du titre uniquement." }, actor)).rejects.toThrow("ONBOARDING_SOURCE_SECTIONS_REVIEW_REQUIRED");
    expect((await fixture.db.select().from(knowledgeProjections).where(eq(knowledgeProjections.surface, "sav")))).toHaveLength(0);
  });
  it.each(["remove", "edit", "duplicate", "reorder"])("blocks source section tampering in the server comparison and approval: %s", async (change) => {
    const candidate = await candidateFor(await tutorial({ body: body + "\n## Précaution particulière\nVérifier le propriétaire.\n## Seconde précaution\nConserver le nom exact." }));
    const document = await documentFor(candidate);
    const originalComparison = await prepareOnboardingReview(candidate, document);
    const sections = document.onboardingContext!.sourceSections!;
    if (change === "remove") delete document.onboardingContext!.sourceSections;
    if (change === "edit") sections[0].content = "Autre condition";
    if (change === "duplicate") sections.push({ ...sections[0] });
    if (change === "reorder") sections.reverse();
    await expect(prepareOnboardingReview(candidate, document)).rejects.toThrow("ONBOARDING_SOURCE_SECTIONS_CHANGED");
    await expect(reviewKnowledgeCandidate(candidate.id, { expectedRevisionId: candidate.revisionId, decision: "approve", reason: "Tentative synthétique de contournement du formulaire.", document,
      comparison: { snapshot: originalComparison.snapshot, acknowledged: true }, completionNote: "Toutes les sections ont été relues dans le scénario fictif.", missingAcknowledged: true }, actor)).rejects.toThrow("ONBOARDING_SOURCE_SECTIONS_CHANGED");
  });
  it("keeps classified restrictions in the draft and excluded sections only in immutable review evidence", async () => {
    const candidate = await candidateFor(await tutorial({ body: body + "\n## Précaution particulière\nVérifier le propriétaire avant le transfert.\n## Organisation du tournage\nLa capture a été réalisée un mardi." }));
    const original = await documentFor(candidate);
    const document = structuredClone(original);
    const sections = document.onboardingContext!.sourceSections!;
    sections[0].classification = "exception"; sections[0].rationale = "La condition de propriété limite la procédure de transfert.";
    sections[1].classification = "not_applicable"; sections[1].rationale = "La date du tournage ne change pas la procédure ou ses conditions.";
    const input = { ...await approval(candidate, document), missingAcknowledged: true, completionNote: "Les deux sections de la source ont été explicitement qualifiées." };
    // A classification change also invalidates the comparison fingerprint.
    const changed = structuredClone(document); changed.onboardingContext!.sourceSections![0].classification = "prerequisite";
    await expect(reviewKnowledgeCandidate(candidate.id, { ...input, document: changed }, actor)).rejects.toThrow("ONBOARDING_COMPARISON_STALE");
    const approved = await reviewKnowledgeCandidate(candidate.id, input, actor);
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    expect(version.bodyMarkdown).toContain("Vérifier le propriétaire avant le transfert.");
    expect(version.bodyMarkdown).not.toContain("réalisée un mardi");
    expect(await documentFor(candidate)).toEqual(original);
    const [projection] = await fixture.db.select().from(knowledgeProjections).where(eq(knowledgeProjections.versionId, version.id));
    const [reviewed] = await fixture.db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, projection.revisionId));
    expect(reviewed.document).toEqual(document);
    const [item] = await fixture.db.select().from(contentItems).where(eq(contentItems.id, approved.targetItemId!));
    expect(item).toMatchObject({ aiEnabled: false, publishedVersionId: null, status: "in_review" });
  });
  it("requires regeneration of legacy pending candidates and keeps the old evidence on an idempotent v2 import", async () => {
    const source = await tutorial(); const old = await candidateFor(source);
    const [proof] = await fixture.db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, old.sourceId));
    const legacyHash = savContentHash({ converter: "onboarding-sav-51-v1", key: proof.sourceRef, sourceHash: proof.evidence.sourceHash, versionId: proof.sourceVersionId });
    await fixture.db.update(knowledgeFamilySources).set({ evidence: { ...proof.evidence, converter: "onboarding-sav-51-v1" }, sourceHash: legacyHash }).where(eq(knowledgeFamilySources.id, proof.id));
    await fixture.db.update(knowledgeFamilyRevisions).set({ canonicalHash: savContentHash({ document: await documentFor(old), hash: legacyHash }) }).where(eq(knowledgeFamilyRevisions.id, old.revisionId));
    // Model the previous converter's distinct manifest ID instead of overwriting its completed outcome.
    const [oldBatch] = await fixture.db.select().from(auditLogs).where(eq(auditLogs.action, "knowledge_onboarding_batch"));
    const manifest = JSON.parse(String(oldBatch.technicalMetadata.manifest)); manifest.converter = "onboarding-sav-51-v1";
    await fixture.db.update(auditLogs).set({ id: "00000000-0000-4000-9000-000000000051", technicalMetadata: { ...oldBatch.technicalMetadata, converter: manifest.converter, manifest: JSON.stringify(manifest) } }).where(eq(auditLogs.id, oldBatch.id));
    await expect(prepareOnboardingReview(old)).rejects.toThrow("ONBOARDING_CONVERTER_STALE");
    await expect(reviewKnowledgeCandidate(old.id, { expectedRevisionId: old.revisionId, decision: "approve", reason: "Ancienne préparation relue sans conversion.", comparison: { snapshot: "old", acknowledged: true } }, actor)).rejects.toThrow("ONBOARDING_CONVERTER_STALE");
    const fresh = await candidateFor(source); const again = await candidateFor(source);
    expect(fresh.id).not.toBe(old.id); expect(again.id).toBe(fresh.id);
    expect(await reread(old)).toEqual(old);
    const [freshProof] = await fixture.db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, fresh.sourceId));
    expect(freshProof.evidence.converter).toBe(ONBOARDING_KNOWLEDGE_CONVERTER);
  });
  it.each([false, true])("blocks publication of an old approved draft while preserving already published knowledge=%s", async (alreadyPublished) => {
    const candidate = await candidateFor(await tutorial());
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor);
    if (alreadyPublished) { await publish(approved.targetItemId!, actor); await setContentAiEnabled(approved.targetItemId!, true, actor); }
    const [proof] = await fixture.db.select().from(knowledgeFamilySources).where(eq(knowledgeFamilySources.id, candidate.sourceId));
    await fixture.db.update(knowledgeFamilySources).set({ evidence: { ...proof.evidence, converter: "onboarding-sav-51-v1" } }).where(eq(knowledgeFamilySources.id, proof.id));
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    await expect(publish(approved.targetItemId!, actor)).rejects.toThrow("ONBOARDING_CONVERTER_STALE");
    expect(await onboardingSourceStatus(version.metadata)).toBe("preparation_stale");
    expect((await reread(approved)).status).toBe("approved");
    const found = await searchKnowledge({ query: "Renommer un espace", scope: "sav", contentTypes: ["article"], limit: 10 });
    expect(found.results.length).toBe(alreadyPublished ? 1 : 0);
  });
  it.each([true, false])("keeps a candidate with no documented recovery, including exceptions=%s", async (hasExceptions) => {
    const incomplete = body.split("## Reprise sûre")[0];
    const source = await tutorial({ body: hasExceptions ? incomplete : incomplete.split("## Variantes et blocages")[0] });
    const candidate = await candidateFor(source);
    expect(candidate.status).toBe("needs_completion");
    expect(candidate.explanation).toContain("reprise sûre");
    const document = await documentFor(candidate);
    expect(document.escalation).toBe("");
    expect(candidate.proposedInput).toMatchObject({ metadata: { resolution: { escalation: "À compléter : reprise sûre non documentée dans la source." } } });
    const edited = { ...document, objective: "Renommer cet espace fictif afin de le retrouver dans la liste." };
    await expect(reviewKnowledgeCandidate(candidate.id, { ...await approval(candidate, edited), completionNote: "Relecture de la source fictive sans inventer la consigne absente.", missingAcknowledged: true }, actor)).rejects.toThrow("ONBOARDING_KNOWLEDGE_RECOVERY_REQUIRED");
    expect((await reread(candidate)).status).toBe("needs_completion");
  });

  it("inventories every active published source, records exclusions and snapshots the active template", async () => {
    const active = await tutorial({ indexed: true });
    const notIndexed = await tutorial();
    const archived = await tutorial({ item: { status: "archived" } });
    const disabled = await tutorial({ item: { aiEnabled: false } });
    const unpublished = await tutorial({ published: false });
    const sav = await tutorial({ item: { agentKey: "sav" } });
    await tutorial({ item: { type: "article" } });
    const [template] = await fixture.db.insert(onboardingTemplateVersions).values({ version: 1, definition: { name: "Test", openingPrompt: "Test", fallbackPrompt: "Test", nodes: [{ id: "test", contentItemId: active.item.id, depth: 0, trigger: "Test", optional: false }] }, changeNote: "Fixture", authorEmail: actor }).returning();
    await fixture.db.insert(activeOnboardingTemplate).values({ publishedVersionId: template.id });
    const manifest = await inventoryOnboardingSources();
    expect(manifest.sources.map((source) => source.itemId)).toEqual([active.item.id, notIndexed.item.id]);
    expect(manifest.inventory).toMatchObject({ studioActive: 2, studioIndexed: 1, templateVersionId: template.id, templateReferences: [active.item.id] });
    expect(manifest.inventory.excluded).toEqual(expect.arrayContaining([
      { id: archived.item.id, reason: "archived" }, { id: disabled.item.id, reason: "disabled" },
      { id: unpublished.item.id, reason: "unpublished" }, { id: sav.item.id, reason: "sav_scope" },
    ]));
    expect(manifest.sources[0]).toMatchObject({ title: active.item.title, versionId: active.version.id, version: 1, indexed: true });
    expect(manifest.sources[0].hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("includes embedded sources, records exact-title aliases, and requires comparison when the two differ", async () => {
    const source = await tutorial({ title: "Parcours fictif partagé" });
    state.curriculum.push({ group: "Compte, organisation et équipe", title: source.item.title, agentKey: "charly", categorySlug: "bien-demarrer", paths: ["/demo"] },
      { group: "Compte, organisation et équipe", title: "Parcours fictif embarqué", agentKey: "charly", categorySlug: "bien-demarrer", paths: ["/demo"] });
    const inventory = await inventoryOnboardingSources();
    expect(inventory.inventory).toMatchObject({ curriculum: 2, mappedCurriculum: 1, studioActive: 1 });
    expect(inventory.sources).toHaveLength(2);
    expect(inventory.sources.find((entry) => entry.itemId === source.item.id)?.aliases).toEqual([expect.objectContaining({ key: "curriculum:parcours-fictif-partage", differs: true })]);
    const candidate = await candidateFor(source);
    expect(candidate.status).toBe("needs_completion");
    expect(candidate.explanation).toContain("catalogue embarqué");
  });

  it("freezes source identities and does not fold new tutorials into an old batch", async () => {
    const first = await tutorial();
    const old = await startOnboardingImport(actor);
    const second = await tutorial();
    const newer = await startOnboardingImport(actor);
    expect(newer.id).not.toBe(old.id);
    expect((await getOnboardingImport(old.id)).manifest.sources.map((entry) => entry.itemId)).toEqual([first.item.id]);
    expect((await getOnboardingImport(newer.id)).manifest.sources.map((entry) => entry.itemId)).toEqual([first.item.id, second.item.id]);
    expect(await listOnboardingImports()).toHaveLength(2);
  });

  it("returns one durable batch and one candidate per source under concurrent calls", async () => {
    await tutorial();
    const started = await Promise.all([startOnboardingImport(actor), startOnboardingImport(actor)]);
    expect(started[0].id).toBe(started[1].id);
    await Promise.all([continueOnboardingImport(started[0].id, actor), continueOnboardingImport(started[0].id, actor)]);
    await continueOnboardingImport(started[0].id, actor);
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeFamilyRevisions)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeFamilySources)).toHaveLength(1);
    expect((await getOnboardingImport(started[0].id)).processed).toBe(1);
    expect((await fixture.db.select().from(auditLogs)).filter((row) => row.action === "knowledge_onboarding_batch")).toHaveLength(1);
  });

  it("does not let one failed source starve unattempted sources with limit one", async () => {
    const failed = await tutorial(); const good = await tutorial();
    const batch = await startOnboardingImport(actor);
    await fixture.db.update(contentItems).set({ aiEnabled: false }).where(eq(contentItems.id, failed.item.id));
    expect(await continueOnboardingImport(batch.id, actor, 1)).toMatchObject({ failed: 1, processed: 0, remaining: 1 });
    expect(await continueOnboardingImport(batch.id, actor, 1)).toMatchObject({ failed: 1, processed: 1, remaining: 0 });
    const outcomes = (await getOnboardingImport(batch.id)).outcomes;
    expect(outcomes[`content:${failed.item.id}`]).toMatchObject({ state: "failed", attempts: 1, error: "ONBOARDING_SOURCE_STALE" });
    expect(outcomes[`content:${good.item.id}`]).toMatchObject({ state: "candidate", attempts: 1 });
    await fixture.db.update(contentItems).set({ aiEnabled: true }).where(eq(contentItems.id, failed.item.id));
    expect(await continueOnboardingImport(batch.id, actor, 1)).toMatchObject({ failed: 0, processed: 2 });
  });

  it("isolates malformed sources with savepoints while preserving successful candidates and resumability", async () => {
    const invalid = await tutorial({ metadata: { ...metadata, objective: "" } });
    const good = await tutorial();
    const batch = await processAll();
    expect(batch).toMatchObject({ total: 2, processed: 1, failed: 1, remaining: 0 });
    expect(batch.outcomes[`content:${invalid.item.id}`]).toMatchObject({ state: "failed", error: "ONBOARDING_CONVERSION_FAILED" });
    expect(batch.outcomes[`content:${good.item.id}`].state).toBe("candidate");
    expect(await fixture.db.select().from(knowledgeFamilies)).toHaveLength(1);
  });

  it.each(["disabled", "archived", "unpublished", "republished"])("rejects the frozen source if it becomes %s before conversion", async (change) => {
    const source = await tutorial(); const batch = await startOnboardingImport(actor);
    if (change === "disabled") await fixture.db.update(contentItems).set({ aiEnabled: false }).where(eq(contentItems.id, source.item.id));
    if (change === "archived") await fixture.db.update(contentItems).set({ status: "archived" }).where(eq(contentItems.id, source.item.id));
    if (change === "unpublished") await fixture.db.update(contentItems).set({ publishedVersionId: null }).where(eq(contentItems.id, source.item.id));
    if (change === "republished") await republish(source);
    expect(await continueOnboardingImport(batch.id, actor)).toMatchObject({ failed: 1, processed: 0 });
    expect((await getOnboardingImport(batch.id)).outcomes[`content:${source.item.id}`].error).toBe("ONBOARDING_SOURCE_STALE");
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(0);
  });

  it("keeps equal titles as different source identities, and versions new evidence with identical text", async () => {
    const title = "Démo — Renommer l’espace (édition test)";
    const first = await tutorial({ title }); await tutorial({ title });
    await processAll();
    const old = await fixture.db.select().from(knowledgeProjectionCandidates);
    expect(old).toHaveLength(2);
    expect(new Set(old.map((candidate) => candidate.familyId)).size).toBe(2);
    expect(old.map((candidate) => candidate.proposedInput.title)).toEqual([title, title]);
    const [family] = await fixture.db.select().from(knowledgeFamilies).where(eq(knowledgeFamilies.canonicalKey, `content:${first.item.id}`));
    const oldCandidate = old.find((candidate) => candidate.familyId === family.id)!;
    const updated = await republish(first);
    const replacement = await candidateFor(updated);
    expect(replacement.id).not.toBe(oldCandidate.id);
    expect(replacement.familyId).toBe(oldCandidate.familyId);
    expect(replacement.proposedInput.title).toBe(title);
    expect((await reread(oldCandidate))).toEqual(oldCandidate);
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(3);
  });

  it("reuses an existing canonical family without replacing its Chrome projection", async () => {
    const recorded: OnboardingMetadata = { ...metadata, actionSteps: [{ order: 1, action: "click", path: "/demo", label: "Paramètres", confidence: "strong", target: { testId: "synthetic-settings" }, preconditions: [], expected: { pageMarkers: ["Général"], network: [] } }] };
    const source = await tutorial({ metadata: recorded });
    const document = prepareOnboardingKnowledge({ title: source.item.title, bodyMarkdown: body, metadata: recorded, locale: "fr-FR", sourceKey: "synthetic:legacy" }).document;
    const legacy = await registerCanonicalKnowledge({ canonicalKey: "legacy:synthetic-family", title: source.item.title, document,
      source: { ref: "synthetic:legacy-evidence", hash: "a".repeat(64), versionId: source.version.id },
      projection: { surface: "onboarding", itemId: source.item.id, versionId: source.version.id, technicalBindings: [{ semanticStepId: document.steps[0].id, actionOrder: 1 }] },
    }, actor);
    const [projection] = await fixture.db.select().from(knowledgeProjections);
    const candidate = await candidateFor(source);
    expect(candidate.familyId).toBe(legacy.family.id);
    expect(await fixture.db.select().from(knowledgeFamilies)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeProjections)).toEqual([projection]);
    expect(candidate.revisionId).not.toBe(legacy.revision.id);
  });

  it("keeps candidate identity when indexing changes without changing source evidence", async () => {
    const source = await tutorial(); const candidate = await candidateFor(source);
    await fixture.db.insert(contentChunks).values({ itemId: source.item.id, versionId: source.version.id, ordinal: 0, content: body, embedding: Array(768).fill(1) });
    const retry = await candidateFor(source);
    expect(retry.id).toBe(candidate.id);
    expect(retry.revisionId).toBe(candidate.revisionId);
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeFamilySources)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeFamilyRevisions)).toHaveLength(1);
  });

  it.each(["approved", "rejected"])("preserves a %s decision on retry and on a new source version", async (status) => {
    const source = await tutorial(); const candidate = await candidateFor(source);
    if (status === "approved") await reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor);
    else await reviewKnowledgeCandidate(candidate.id, { expectedRevisionId: candidate.revisionId, decision: "reject", reason: "Refus humain de la source synthétique." }, actor);
    const reviewed = await reread(candidate);
    await processAll(); expect(await reread(candidate)).toEqual(reviewed);
    const newer = await candidateFor(await republish(source));
    expect(newer.id).not.toBe(candidate.id); expect(newer.status).toBe("pending");
    expect(await reread(candidate)).toEqual(reviewed);
    if (status === "approved") expect(newer.targetItemId).toBe(reviewed.targetItemId);
  });

  it("paginates more than one hundred candidates without gaps and filters across the full catalogue", async () => {
    for (let index = 0; index < 103; index++) await tutorial();
    const batch = await processAll(); expect(batch).toMatchObject({ total: 103, processed: 103, failed: 0 });
    const pages = await Promise.all([1, 2, 3].map((page) => paginateKnowledgeCandidates({ page, pageSize: 50, source: "onboarding" })));
    expect(pages.map((page) => page.rows.length)).toEqual([50, 50, 3]);
    expect(pages.every((page) => page.total === 103)).toBe(true);
    expect(new Set(pages.flatMap((page) => page.rows.map((row) => row.candidate.id))).size).toBe(103);
    const last = pages[2].rows[0].candidate;
    await reviewKnowledgeCandidate(last.id, { expectedRevisionId: last.revisionId, decision: "reject", reason: "Refus synthétique du dernier groupe." }, actor);
    const filtered = await paginateKnowledgeCandidates({ status: "rejected", page: 20, pageSize: 50, source: "onboarding" });
    expect(filtered).toMatchObject({ total: 1, page: 1 }); expect(filtered.rows[0].candidate.id).toBe(last.id);
    expect((await paginateKnowledgeCandidates({ source: "hubspot" })).total).toBe(0);
    expect((await paginateKnowledgeCandidates({ source: "sav" })).total).toBe(0);
  }, 30_000);

  it("denies import and continuation for actors outside SAV", async () => {
    await tutorial();
    await expect(startOnboardingImport("other@example.invalid")).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    const batch = await startOnboardingImport(actor);
    await expect(continueOnboardingImport(batch.id, "other@example.invalid")).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(0);
  });
});

describe("SAV-51 supervised review and publication separation", () => {
  it("does not pre-arm an unpublished SAV candidate for automatic activation on publication", async () => {
    const candidate = await candidateFor(await tutorial());
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor);
    await expect(setContentAiEnabled(approved.targetItemId!, true, "reouven@limova.ai")).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    await expect(setContentAiEnabled(approved.targetItemId!, true, actor)).rejects.toThrow("ONBOARDING_PUBLICATION_REQUIRED");
    const [item] = await fixture.db.select().from(contentItems).where(eq(contentItems.id, approved.targetItemId!));
    expect(item.aiEnabled).toBe(false);
    expect(item.publishedVersionId).toBeNull();
  });
  it("requires Ugo, current revision and acknowledged comparison", async () => {
    const candidate = await candidateFor(await tutorial()); const input = await approval(candidate);
    await expect(reviewKnowledgeCandidate(candidate.id, input, "reouven@limova.ai")).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    await expect(reviewKnowledgeCandidate(candidate.id, { ...input, expectedRevisionId: crypto.randomUUID() }, actor)).rejects.toThrow("KNOWLEDGE_CANDIDATE_STALE");
    await expect(reviewKnowledgeCandidate(candidate.id, { ...input, comparison: undefined }, actor)).rejects.toThrow("ONBOARDING_COMPARISON_REVIEW_REQUIRED");
    await expect(reviewKnowledgeCandidate(candidate.id, { ...input, comparison: { acknowledged: true, snapshot: "stale" } }, actor)).rejects.toThrow("ONBOARDING_COMPARISON_STALE");
    expect((await fixture.db.select().from(contentItems)).filter((item) => item.agentKey === "sav")).toHaveLength(0);
  });

  it("blocks incomplete knowledge until an actual correction, completion note and missing-data acknowledgement", async () => {
    const candidate = await candidateFor(await tutorial({ body: body.replace("Ouvrir « Paramètres » en bas à gauche, puis « Général ».", "Ouvrir la liste concernée et sélectionner l’élément exact à modifier.") }));
    expect(candidate.status).toBe("needs_completion");
    const original = await documentFor(candidate);
    const document = { ...original, steps: original.steps.map((step, index) => index === 0 ? { ...step, instruction: "Ouvrir « Paramètres » en bas à gauche, puis « Général »." } : step) };
    await expect(reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor)).rejects.toThrow("ONBOARDING_COMPLETION_REQUIRED");
    await expect(reviewKnowledgeCandidate(candidate.id, { ...await approval(candidate, original), completionNote: "Source synthétique complétée par le test.", missingAcknowledged: true }, actor)).rejects.toThrow("ONBOARDING_COMPLETION_REQUIRED");
    const corrected = await approval(candidate, document);
    await expect(reviewKnowledgeCandidate(candidate.id, { ...corrected, completionNote: "Source synthétique complétée par le test." }, actor)).rejects.toThrow("ONBOARDING_COMPLETION_REQUIRED");
    await expect(reviewKnowledgeCandidate(candidate.id, { ...corrected, completionNote: "Court", missingAcknowledged: true }, actor)).rejects.toThrow("ONBOARDING_COMPLETION_REQUIRED");
    const approved = await reviewKnowledgeCandidate(candidate.id, { ...corrected, completionNote: "Instruction synthétique précisée et relue avec ses limites.", missingAcknowledged: true }, actor);
    expect(approved.status).toBe("approved");
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    expect(version.metadata.sourceMetadata).toHaveProperty("comparisonReview.missingAcknowledged", true);
    expect(await documentFor(candidate)).toEqual(original);
  });

  it("invalidates comparison after corrected content or another candidate changes the comparison inventory", async () => {
    const candidate = await candidateFor(await tutorial()); const input = await approval(candidate);
    const original = await documentFor(candidate); const document = { ...original, expectedResult: "Nouveau résultat synthétique documenté." };
    await expect(reviewKnowledgeCandidate(candidate.id, { ...input, document }, actor)).rejects.toThrow("ONBOARDING_COMPARISON_STALE");
    await tutorial(); await processAll();
    await expect(reviewKnowledgeCandidate(candidate.id, input, actor)).rejects.toThrow("ONBOARDING_COMPARISON_STALE");
  });

  it.each(["disabled", "archived", "republished", "renamed"])("refuses approval if the tutorial becomes %s after preparation", async (change) => {
    const source = await tutorial(); const candidate = await candidateFor(source); const input = await approval(candidate);
    if (change === "disabled") await fixture.db.update(contentItems).set({ aiEnabled: false }).where(eq(contentItems.id, source.item.id));
    if (change === "archived") await fixture.db.update(contentItems).set({ status: "archived" }).where(eq(contentItems.id, source.item.id));
    if (change === "republished") await republish(source);
    if (change === "renamed") await fixture.db.update(contentItems).set({ title: "Nouveau titre synthétique" }).where(eq(contentItems.id, source.item.id));
    await expect(reviewKnowledgeCandidate(candidate.id, input, actor)).rejects.toThrow("ONBOARDING_SOURCE_STALE");
    expect((await reread(candidate)).status).toBe("pending");
  });

  it("checks an editor's current target draft instead of silently replacing it", async () => {
    const source = await tutorial(); const first = await candidateFor(source);
    const approved = await reviewKnowledgeCandidate(first.id, await approval(first), actor);
    const candidate = await candidateFor(await republish(source)); const input = await approval(candidate);
    const [newDraft] = await fixture.db.insert(contentVersions).values({ itemId: approved.targetItemId!, version: 2, bodyMarkdown: "Correction humaine synthétique à préserver.", metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "", troubleshooting: "" }, changeNote: "Fixture", authorEmail: actor }).returning();
    await fixture.db.update(contentItems).set({ currentDraftVersionId: newDraft.id }).where(eq(contentItems.id, approved.targetItemId!));
    await expect(reviewKnowledgeCandidate(candidate.id, input, actor)).rejects.toThrow("ONBOARDING_COMPARISON_STALE");
    expect((await prepareOnboardingReview(candidate)).before).toBe(newDraft.bodyMarkdown);
    expect((await fixture.db.select().from(contentItems).where(eq(contentItems.id, approved.targetItemId!)))[0].currentDraftVersionId).toBe(newDraft.id);
  });

  it("keeps an exact source title after a human rewrites the objective and creates only a disabled unindexed draft", async () => {
    const title = "Démo : Renommer l’espace — exemple";
    const source = await tutorial({ title, indexed: true }); const candidate = await candidateFor(source);
    const original = await documentFor(candidate);
    const document = { ...original, objective: "Comprendre et modifier le nom de l’espace de démonstration" };
    expect(state.embed).not.toHaveBeenCalled();
    expect((await searchKnowledge({ query: "Renommer un espace", locale: "fr-FR", scope: "sav", contentTypes: ["article"], limit: 5 })).results).toEqual([]);
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate, document), actor);
    const retry = await reviewKnowledgeCandidate(candidate.id, await approval(candidate, document), actor);
    expect(retry.materializedVersionId).toBe(approved.materializedVersionId);
    const [item] = await fixture.db.select().from(contentItems).where(eq(contentItems.id, approved.targetItemId!));
    expect(item).toMatchObject({ title, status: "in_review", agentKey: "sav", aiEnabled: false, publishedVersionId: null });
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    expect(version.bodyMarkdown).toContain(document.objective);
    expect(version.metadata.sourceMetadata).toHaveProperty("sourceVersionId", source.version.id);
    expect((await fixture.db.select().from(contentItems).where(eq(contentItems.id, source.item.id)))[0]).toEqual(source.item);
    expect((await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, source.version.id)))[0]).toEqual(source.version);
    expect(await fixture.db.select().from(contentChunks)).toHaveLength(1);
    expect((await fixture.db.select().from(knowledgeProjections)).map((projection) => projection.surface).sort()).toEqual(["onboarding", "sav"]);
    expect((await searchKnowledge({ query: "Renommer un espace", locale: "fr-FR", scope: "sav", contentTypes: ["article"], limit: 5 })).results).toEqual([]);
    expect(state.embed).not.toHaveBeenCalled();
  });

  it("retrieves the complete procedure only after separate explicit publication and activation in the isolated database", async () => {
    const source = await tutorial(); const candidate = await candidateFor(source);
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor);
    await publish(approved.targetItemId!, actor, { expectedVersionId: approved.materializedVersionId! });
    expect((await searchKnowledge({ query: "Renommer un espace", scope: "sav" })).results).toEqual([]);
    await setContentAiEnabled(approved.targetItemId!, true, actor);
    const found = await searchKnowledge({ query: "Renommer un espace", scope: "sav" });
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    expect(found.results).toHaveLength(1);
    expect(found.results[0]).toMatchObject({ title: source.item.title, contentVersionId: version.id, content: version.bodyMarkdown });
    expect(found.results[0].content).toContain("Quand le nom");
    expect(found.results[0].content).toContain("Prérequis");
    expect(found.results[0].content).toContain("Si la confirmation");
    expect(await searchKnowledge({ query: "Renommer un espace", scope: "extension", contentTypes: ["article"] })).toMatchObject({ results: [] });
  });

  it.each(["title", "scope", "provenance"])("protects a published tutorial knowledge against generic draft changes to %s", async (field) => {
    const source = await tutorial(); const candidate = await candidateFor(source);
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor);
    await publish(approved.targetItemId!, actor);
    await setContentAiEnabled(approved.targetItemId!, true, actor);
    const input = parseContentInput(approved.proposedInput);
    if (field === "title") input.title = "Un autre titre fictif";
    if (field === "scope") input.agentKey = "charly";
    if (field === "provenance") input.metadata.sourceMetadata = {};
    await expect(saveDraft(input, actor, approved.targetItemId!)).rejects.toThrow(field === "title" ? "ONBOARDING_EXACT_TITLE_REQUIRED" : field === "scope" ? "SAV_KNOWLEDGE_SCOPE_REQUIRED" : "KNOWLEDGE_PROVENANCE_REQUIRED");
    const found = await searchKnowledge({ query: "Renommer un espace", scope: "sav" });
    expect(found.results[0]).toMatchObject({ title: source.item.title, contentVersionId: approved.materializedVersionId });
    expect(await searchKnowledge({ query: "Renommer un espace", scope: "extension", contentTypes: ["article"] })).toMatchObject({ results: [] });
  });

  it("keeps the active SAV title unchanged while a renamed source is approved but not yet published", async () => {
    const source = await tutorial({ title: "Renommer un espace — titre initial" });
    const first = await candidateFor(source);
    const approvedFirst = await reviewKnowledgeCandidate(first.id, await approval(first), actor);
    await publish(approvedFirst.targetItemId!, actor, { expectedVersionId: approvedFirst.materializedVersionId! });
    await setContentAiEnabled(approvedFirst.targetItemId!, true, actor);
    const renamedTitle = "Renommer un espace — titre corrigé";
    await fixture.db.update(contentItems).set({ title: renamedTitle }).where(eq(contentItems.id, source.item.id));
    const republished = await republish(source);
    const second = await candidateFor(republished);
    const approvedSecond = await reviewKnowledgeCandidate(second.id, await approval(second), actor);
    expect(approvedSecond.proposedInput.title).toBe(renamedTitle);
    const [target] = await fixture.db.select().from(contentItems).where(eq(contentItems.id, approvedFirst.targetItemId!));
    expect(target).toMatchObject({ title: source.item.title, publishedVersionId: approvedFirst.materializedVersionId, currentDraftVersionId: approvedSecond.materializedVersionId });
    const before = await searchKnowledge({ query: "Renommer un espace", scope: "sav" });
    expect(before.results[0]).toMatchObject({ title: source.item.title, contentVersionId: approvedFirst.materializedVersionId });
    await publish(approvedSecond.targetItemId!, actor, { expectedVersionId: approvedSecond.materializedVersionId! });
    const after = await searchKnowledge({ query: "Renommer un espace", scope: "sav" });
    expect(after.results[0]).toMatchObject({ title: renamedTitle, contentVersionId: approvedSecond.materializedVersionId });
  });

  it.each(["disabled", "republished"])("keeps validated knowledge available with an alert when its source is %s, as chosen by Ugo", async (change) => {
    const source = await tutorial(); const candidate = await candidateFor(source);
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor);
    await publish(approved.targetItemId!, actor);
    await setContentAiEnabled(approved.targetItemId!, true, actor);
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    expect(await onboardingSourceStatus(version.metadata)).toBe("current");
    if (change === "disabled") await fixture.db.update(contentItems).set({ aiEnabled: false }).where(eq(contentItems.id, source.item.id));
    else await republish(source);
    expect(await onboardingSourceStatus(version.metadata)).toBe("changed");
    const found = await searchKnowledge({ query: "Renommer un espace", scope: "sav" });
    expect(found.results[0]).toMatchObject({ contentVersionId: version.id, content: version.bodyMarkdown });
    expect(await onboardingSourceStatus({})).toBeNull();
  });

  it.each(["disabled", "archived", "republished"])("blocks publication if an approved source becomes %s", async (change) => {
    const source = await tutorial(); const candidate = await candidateFor(source);
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor);
    if (change === "disabled") await fixture.db.update(contentItems).set({ aiEnabled: false }).where(eq(contentItems.id, source.item.id));
    if (change === "archived") await fixture.db.update(contentItems).set({ status: "archived" }).where(eq(contentItems.id, source.item.id));
    if (change === "republished") await republish(source);
    await expect(publish(approved.targetItemId!, actor, { expectedVersionId: approved.materializedVersionId! })).rejects.toThrow("ONBOARDING_SOURCE_STALE");
    expect(state.embed).not.toHaveBeenCalled();
    expect((await fixture.db.select().from(contentItems).where(eq(contentItems.id, approved.targetItemId!)))[0].publishedVersionId).toBeNull();
    expect(await fixture.db.select().from(contentChunks)).toHaveLength(0);
  });

  it("rechecks the source after embedding and before publication commits", async () => {
    const source = await tutorial(); const candidate = await candidateFor(source);
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor);
    state.embed.mockImplementationOnce(async (texts: string[]) => {
      await fixture.db.update(contentItems).set({ aiEnabled: false }).where(eq(contentItems.id, source.item.id));
      return texts.map(() => Array(768).fill(1));
    });
    await expect(publish(approved.targetItemId!, actor, { expectedVersionId: approved.materializedVersionId! })).rejects.toThrow("ONBOARDING_SOURCE_STALE");
    expect(state.embed).toHaveBeenCalledTimes(1);
    expect((await fixture.db.select().from(contentItems).where(eq(contentItems.id, approved.targetItemId!)))[0].publishedVersionId).toBeNull();
    expect(await fixture.db.select().from(contentChunks)).toHaveLength(0);
  });

  it("blocks later activation after the approved tutorial becomes inactive", async () => {
    const source = await tutorial(); const candidate = await candidateFor(source);
    const approved = await reviewKnowledgeCandidate(candidate.id, await approval(candidate), actor);
    await publish(approved.targetItemId!, actor, { expectedVersionId: approved.materializedVersionId! });
    await fixture.db.update(contentItems).set({ aiEnabled: false }).where(eq(contentItems.id, source.item.id));
    await expect(setContentAiEnabled(approved.targetItemId!, true, actor)).rejects.toThrow("ONBOARDING_SOURCE_STALE");
    expect((await fixture.db.select().from(contentItems).where(eq(contentItems.id, approved.targetItemId!)))[0].aiEnabled).toBe(false);
    expect((await searchKnowledge({ query: "Renommer un espace", scope: "sav" })).results).toEqual([]);
  });

  it("blocks rollback to knowledge based on a superseded tutorial version", async () => {
    const source = await tutorial(); const first = await candidateFor(source);
    const approvedFirst = await reviewKnowledgeCandidate(first.id, await approval(first), actor);
    await publish(approvedFirst.targetItemId!, actor, { expectedVersionId: approvedFirst.materializedVersionId! });
    const nextSource = await republish(source);
    const second = await candidateFor(nextSource);
    const approvedSecond = await reviewKnowledgeCandidate(second.id, await approval(second), actor);
    await publish(approvedSecond.targetItemId!, actor, { expectedVersionId: approvedSecond.materializedVersionId! });
    await expect(rollback(approvedFirst.targetItemId!, approvedFirst.materializedVersionId!, actor, "Repli synthétique vers une preuve obsolète.")).rejects.toThrow("ONBOARDING_SOURCE_STALE");
    expect((await fixture.db.select().from(contentItems).where(eq(contentItems.id, approvedFirst.targetItemId!)))[0].publishedVersionId).toBe(approvedSecond.materializedVersionId);
  });

  it("rejects a corrected procedure too long for complete retrieval instead of publishing a truncated version", async () => {
    const candidate = await candidateFor(await tutorial());
    const original = await documentFor(candidate);
    const document = { ...original, onboardingContext: { ...original.onboardingContext!, sourceNotes: Array.from({ length: 4 }, (_, index) => `Note synthétique ${index}. ` + "Condition de démonstration à conserver. ".repeat(100)) } };
    await expect(reviewKnowledgeCandidate(candidate.id, await approval(candidate, document), actor)).rejects.toThrow("ONBOARDING_PROCEDURE_TOO_LONG");
    expect((await reread(candidate)).status).toBe("pending");
    expect((await fixture.db.select().from(contentItems)).filter((item) => item.agentKey === "sav")).toHaveLength(0);
  });
});
