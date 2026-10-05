import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, categories, contentItems, contentVersions, knowledgeFamilies, knowledgeFamilyRevisions, knowledgeFamilySources, knowledgeProjectionCandidates, knowledgeProjections, savLearningCandidates, savResolutionEvidence } from "@/db/schema";
import { saveDraft, publish, rollback, submitForReview } from "@/lib/workflow";
import { registerCanonicalKnowledge, getCanonicalFamily } from "./families";
import { proposeSavFromOnboarding, proposeOnboardingFromSav } from "./candidates";
import { canonicalKnowledgeSchema } from "./contracts";
import { approveLearningCandidate } from "@/lib/sav/learning";
import { reviewKnowledgeCandidate } from "./review";

const state = vi.hoisted(() => ({ db: null as unknown, embed: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("@/lib/embeddings", () => ({ embedTexts: state.embed }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
beforeEach(async () => {
  await fixture.client.exec("TRUNCATE knowledge_families, content_items, categories, sav.learning_candidates CASCADE; TRUNCATE audit_logs");
  await fixture.db.insert(categories).values([{ slug: "bien-demarrer", label: "Démarrer" }, { slug: "depannage", label: "Dépannage" }]);
  state.embed.mockReset();
});
const metadata = { objective: "Retrouver ses factures", proposalSignals: ["factures"], qualificationQuestions: [], expectedPages: ["/settings/billing"], successCriteria: ["La liste des factures est visible"], branches: [], fallbacks: ["Contacter le support si le menu manque"], sourceMetadata: { trainingSessionId: "training-fixture" }, actionSteps: [{ order: 1, action: "click", path: "/", label: "Paramètres", confidence: "strong", target: { testId: "settings-open", zone: "bottom-left" }, preconditions: ["[main]"], expected: { path: "/settings", pageMarkers: ["h1: Paramètres"], network: ["GET /api/settings status:200"] } }, { order: 2, action: "click", path: "/settings", label: "Facturation", confidence: "strong", target: { testId: "billing-tab" }, preconditions: [], expected: { pageMarkers: ["h1: Factures"], network: [] } }] };
async function onboarding(selectedMetadata: unknown = metadata, itemId?: string) {
  return saveDraft({ type: "onboarding", slug: "factures-fixture", locale: "fr-FR", title: "Retrouver les factures", summary: "Parcours factures", categorySlug: "bien-demarrer", visibility: "charly_only", agentKey: "charly", ownerEmail: "ugo@limova.ai", bodyMarkdown: "## Tutoriel\n\nSélectionnez les contrôles observés.", changeNote: "Démonstration de test", metadata: selectedMetadata }, "ugo@limova.ai", itemId);
}
async function savCandidate(steps: string[]) {
  const draft = await saveDraft({ type: "article", slug: "resolution-fixture", locale: "fr-FR", title: "Accéder aux factures", summary: "Résolution relue", categorySlug: "depannage", visibility: "charly_only", agentKey: "sav", ownerEmail: "ugo@limova.ai", bodyMarkdown: "## Résolution\n\n" + steps.join("\n"), changeNote: "Résolution humaine", metadata: { intents: ["factures"], limovaPaths: [], prerequisites: [], expectedResult: "Liste des factures visible", troubleshooting: "Contacter un humain.", resolution: { symptoms: ["Factures introuvables"], steps, exceptions: [], escalation: "Contacter un humain.", productVersion: "" } } }, "ugo@limova.ai");
  const [candidate] = await fixture.db.insert(savLearningCandidates).values({ contentItemId: draft.item.id, status: "approved", reviewedBy: "reouven@limova.ai", reviewedAt: new Date(), sourceRef: "ticket:fixture", sourceContentHash: "fixture", proposedPatch: {}, explanation: "Relu par un humain" }).returning();
  await fixture.db.insert(savResolutionEvidence).values({ itemId: draft.item.id, versionId: draft.version.id, sourceRef: candidate.sourceRef, outcome: "human_resolution", summary: "Version relue" });
  return { ...draft, candidate };
}
describe("canonical families and supervised projections", () => {
  it("requires Ugo and prepares an auditable corrected SAV draft without touching its tutorial", async () => {
    const source = await onboarding();
    const [sourceSnapshot] = await fixture.db.select().from(contentItems).where(eq(contentItems.id, source.item.id));
    const result = await proposeSavFromOnboarding(source.item.id, source.version.id, "ugo@limova.ai");
    const candidate = result.candidate!;
    const family = await getCanonicalFamily(candidate.familyId);
    const document = { ...family.revisions[0].document, prerequisites: ["Être connecté"], steps: family.revisions[0].document.steps.map((step) => ({ ...step, expectedResult: "Contrôle visible et sélectionné" })) };
    const input = { expectedRevisionId: candidate.revisionId, decision: "approve" as const, reason: "Parcours factures relu et prérequis confirmés", document };
    await expect(reviewKnowledgeCandidate(candidate.id, input, "reouven@limova.ai")).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    const approved = await reviewKnowledgeCandidate(candidate.id, input, "ugo@limova.ai");
    const retry = await reviewKnowledgeCandidate(candidate.id, input, "ugo@limova.ai");
    expect(retry.materializedVersionId).toBe(approved.materializedVersionId);
    expect((await fixture.db.select().from(contentItems).where(eq(contentItems.id, source.item.id)))[0]).toEqual(sourceSnapshot);
    expect((await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, source.version.id)))[0]).toEqual(source.version);
    const [target] = await fixture.db.select().from(contentItems).where(eq(contentItems.id, approved.targetItemId!));
    expect(target).toMatchObject({ status: "in_review", publishedVersionId: null });
    expect(await fixture.db.select().from(contentVersions)).toHaveLength(2);
    expect(await fixture.db.select().from(knowledgeFamilyRevisions)).toHaveLength(2);
    const [audit] = (await fixture.db.select().from(auditLogs)).filter((row) => row.action === "knowledge_candidate_approved");
    expect(audit.technicalMetadata).toMatchObject({ sourceVersionId: source.version.id, versionId: approved.materializedVersionId });
  });
  it("rejects stale reviews, non-executable Chrome candidates and unqualified variants", async () => {
    const source = await onboarding(); const candidate = (await proposeSavFromOnboarding(source.item.id, source.version.id, "ugo@limova.ai")).candidate!;
    await expect(reviewKnowledgeCandidate(candidate.id, { expectedRevisionId: crypto.randomUUID(), decision: "approve", reason: "Proposition obsolète" }, "ugo@limova.ai")).rejects.toThrow("KNOWLEDGE_CANDIDATE_STALE");
    const family = await getCanonicalFamily(candidate.familyId);
    const document = { ...family.revisions[0].document, steps: family.revisions[0].document.steps.map((step) => ({ ...step, variants: [{ roles: ["admin"], productVersion: "v2", instruction: "Parcours réservé aux admins", expectedResult: "À vérifier" }] })) };
    await expect(reviewKnowledgeCandidate(candidate.id, { expectedRevisionId: candidate.revisionId, decision: "approve", reason: "Variante à qualifier", document }, "ugo@limova.ai")).rejects.toThrow("KNOWLEDGE_VARIANT_CONTEXT_REQUIRED");
    const sav = await savCandidate(["Ouvrez Paramètres puis Facturation."]);
    const chrome = (await proposeOnboardingFromSav(sav.candidate.id, "ugo@limova.ai")).candidate!;
    await expect(reviewKnowledgeCandidate(chrome.id, { expectedRevisionId: chrome.revisionId, decision: "approve", reason: "Pas de tutoriel fiable" }, "ugo@limova.ai")).rejects.toThrow("KNOWLEDGE_RECORDING_REQUIRED");
  });
  it("blocks publication of unreviewed canonical projections before embeddings", async () => {
    const source = await onboarding(); const candidate = (await proposeSavFromOnboarding(source.item.id, source.version.id, "ugo@limova.ai")).candidate!;
    const draft = await saveDraft(candidate.proposedInput, "ugo@limova.ai");
    await expect(publish(draft.item.id, "ugo@limova.ai", { emergency: true, reason: "Test de contournement de revue" })).rejects.toThrow("KNOWLEDGE_CANONICAL_APPROVAL_REQUIRED");
    expect(state.embed).not.toHaveBeenCalled();
  });
  it("proposes one SAV procedure without DOM, publication or content duplication", async () => {
    const draft = await onboarding();
    const first = await proposeSavFromOnboarding(draft.item.id, draft.version.id, "ugo@limova.ai");
    const retry = await proposeSavFromOnboarding(draft.item.id, draft.version.id, "ugo@limova.ai");
    expect(first.candidate!.id).toBe(retry.candidate!.id);
    expect(first.candidate!.status).toBe("pending");
    const proposed = first.candidate!.proposedInput;
    expect(JSON.stringify(proposed)).toContain("en bas à gauche");
    expect(JSON.stringify(proposed)).not.toMatch(/testId|settings-open|billing-tab|GET \/api|domId/);
    expect(await fixture.db.select().from(contentItems)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeFamilies)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeFamilyRevisions)).toHaveLength(1);
    expect((await fixture.db.select().from(knowledgeFamilies))[0].approvedRevisionId).toBeNull();
    expect((await fixture.db.select().from(contentItems))[0].publishedVersionId).toBeNull();
  });
  it("keeps a DOM-only update in the same canonical revision while preserving both sources", async () => {
    const first = await onboarding(); await proposeSavFromOnboarding(first.item.id, first.version.id, "ugo@limova.ai");
    const updatedMetadata = { ...metadata, actionSteps: metadata.actionSteps.map((action) => ({ ...action, target: { ...action.target, testId: "dom-v2" } })) };
    const second = await onboarding(updatedMetadata, first.item.id); await proposeSavFromOnboarding(second.item.id, second.version.id, "ugo@limova.ai");
    expect(await fixture.db.select().from(knowledgeFamilyRevisions)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeFamilySources)).toHaveLength(2);
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeProjections)).toHaveLength(2);
  });
  it("retains pure gestures as not applicable instead of manufacturing support knowledge", async () => {
    const draft = await onboarding({ ...metadata, actionSteps: [{ ...metadata.actionSteps[0], label: "Contrôle observé" }] });
    const result = await proposeSavFromOnboarding(draft.item.id, draft.version.id, "ugo@limova.ai");
    expect(result.candidate).toMatchObject({ status: "not_applicable", proposedInput: {}, diff: { before: "", after: "" } });
  });
  it("versions renamed labels without changing semantic step identities", async () => {
    const first = await onboarding(); const initial = await proposeSavFromOnboarding(first.item.id, first.version.id, "ugo@limova.ai");
    const renamed = await onboarding({ ...metadata, actionSteps: metadata.actionSteps.map((action, index) => index === 0 ? { ...action, label: "Réglages" } : action) }, first.item.id);
    const changed = await proposeSavFromOnboarding(renamed.item.id, renamed.version.id, "ugo@limova.ai");
    const family = await getCanonicalFamily(initial.candidate!.familyId);
    expect(changed.candidate!.revisionId).not.toBe(initial.candidate!.revisionId);
    expect(family.revisions[0].document.steps.map((step) => step.id)).toEqual(family.revisions[1].document.steps.map((step) => step.id));
  });
  it("shares one family across SAV and onboarding projections with explicit version ownership", async () => {
    const initial = await onboarding(); const candidate = await proposeSavFromOnboarding(initial.item.id, initial.version.id, "ugo@limova.ai");
    const sav = await saveDraft(candidate.candidate!.proposedInput, "ugo@limova.ai");
    const family = await getCanonicalFamily(candidate.candidate!.familyId);
    await registerCanonicalKnowledge({ canonicalKey: family.family.canonicalKey, title: family.family.title, document: family.revisions[0].document,
      source: { ref: "approved-projection:fixture", hash: "a".repeat(64), versionId: sav.version.id }, projection: { surface: "sav", itemId: sav.item.id, versionId: sav.version.id } }, "ugo@limova.ai");
    expect((await getCanonicalFamily(family.family.id)).projections.map((projection) => projection.surface).sort()).toEqual(["onboarding", "sav"]);
    await expect(registerCanonicalKnowledge({ canonicalKey: "invalid:family", title: "Invalid", document: family.revisions[0].document, source: { ref: "invalid", hash: "b".repeat(64) }, projection: { surface: "sav", itemId: sav.item.id, versionId: initial.version.id } }, "ugo@limova.ai")).rejects.toThrow("KNOWLEDGE_PROJECTION_VERSION_MISMATCH");
  });
  it("creates a non-executable Chrome candidate from the exact human-reviewed SAV version", async () => {
    const source = await savCandidate(["Ouvrez Paramètres puis Facturation pour consulter vos factures."]);
    const result = await proposeOnboardingFromSav(source.candidate.id, "ugo@limova.ai");
    expect(result.candidate!.status).toBe("needs_recording");
    expect(result.candidate!.proposedInput).toHaveProperty("metadata.actionSteps", []);
    expect(result.candidate!.proposedInput).toHaveProperty("metadata.sourceMetadata.needsRecording", true);
    expect(await fixture.db.select().from(contentItems)).toHaveLength(1);
    const candidateDraft = await saveDraft(result.candidate!.proposedInput, "ugo@limova.ai");
    await expect(publish(candidateDraft.item.id, "ugo@limova.ai", { emergency: true, reason: "Impossible sans démonstration" })).rejects.toThrow("KNOWLEDGE_RECORDING_REQUIRED");
    expect(state.embed).not.toHaveBeenCalled();
  });
  it("does not turn contractual or backend resolutions into Chrome actions", async () => {
    const source = await savCandidate(["Le remboursement est pris en charge par la finance."]);
    const result = await proposeOnboardingFromSav(source.candidate.id, "ugo@limova.ai");
    expect(result.candidate!.status).toBe("not_applicable");
    expect((await getCanonicalFamily(result.candidate!.familyId)).revisions[0].document.applicability).toBe("sav_only");
  });
  it("can resume candidate generation after human review without rewriting the reviewed draft", async () => {
    const source = await savCandidate(["Ouvrez Paramètres puis Profil pour modifier votre nom."]);
    const result = await approveLearningCandidate(source.candidate.id, "ugo@limova.ai");
    const retry = await approveLearningCandidate(source.candidate.id, "ugo@limova.ai");
    expect(result.version.id).toBe(source.version.id);
    expect(retry.version.id).toBe(source.version.id);
    expect(await fixture.db.select().from(contentVersions)).toHaveLength(1);
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(1);
    expect((await fixture.db.select().from(savLearningCandidates))[0].reviewedBy).toBe("reouven@limova.ai");
  });
  it("refuses unreviewed resolutions and ignores later, unreviewed draft edits", async () => {
    const source = await savCandidate(["Ouvrez Paramètres pour consulter les factures."]);
    await fixture.db.update(savLearningCandidates).set({ status: "pending" }).where(eq(savLearningCandidates.id, source.candidate.id));
    await expect(proposeOnboardingFromSav(source.candidate.id, "ugo@limova.ai")).rejects.toThrow("KNOWLEDGE_HUMAN_VALIDATED_RESOLUTION_REQUIRED");
    await fixture.db.update(savLearningCandidates).set({ status: "approved" }).where(eq(savLearningCandidates.id, source.candidate.id));
    await fixture.db.insert(contentVersions).values({ itemId: source.item.id, version: 2, bodyMarkdown: "Modification non relue", metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "", troubleshooting: "" }, changeNote: "Non relu", authorEmail: "other@example.com" }).returning().then(async ([version]) => { await fixture.db.update(contentItems).set({ currentDraftVersionId: version.id }).where(eq(contentItems.id, source.item.id)); });
    const result = await proposeOnboardingFromSav(source.candidate.id, "ugo@limova.ai");
    expect(result.candidate!.proposedInput).toHaveProperty("metadata.sourceMetadata.sourceVersionId", source.version.id);
  });
  it("prevents SAV publication/rollback by any other admin before model or mutation effects", async () => {
    const source = await savCandidate(["Ouvrez Paramètres pour consulter les factures."]);
    await expect(publish(source.item.id, "reouven@limova.ai", { emergency: true, reason: "Tentative de contournement" })).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    await expect(rollback(source.item.id, source.version.id, "contact@limova.ai", "Tentative de rollback")).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    expect(state.embed).not.toHaveBeenCalled();
  });
  it("preserves publication and rollback by existing Studio admins for legacy tutorials", async () => {
    const source = await onboarding();
    state.embed.mockImplementation(async (texts: string[]) => texts.map(() => Array(768).fill(0.01)));
    await submitForReview(source.item.id, "reouven@limova.ai", "Revue du tutoriel historique");
    await publish(source.item.id, "reouven@limova.ai", { expectedVersionId: source.version.id });
    expect((await fixture.db.select().from(contentItems).where(eq(contentItems.id, source.item.id)))[0].publishedVersionId).toBe(source.version.id);
    await rollback(source.item.id, source.version.id, "reouven@limova.ai", "Restauration historique autorisée");
  });
  it("requires Ugo for new Chrome projections without restricting legacy tutorials", async () => {
    const source = await savCandidate(["Ouvrez Paramètres puis Profil pour modifier votre nom."]);
    const candidate = (await proposeOnboardingFromSav(source.candidate.id, "ugo@limova.ai")).candidate!;
    const draft = await saveDraft(candidate.proposedInput, "ugo@limova.ai");
    await expect(publish(draft.item.id, "reouven@limova.ai", { emergency: true, reason: "Tentative de contournement" })).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    expect(state.embed).not.toHaveBeenCalled();
  });
  it("does not merge identical titles with unrelated provenance", async () => {
    const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Même titre", applicability: "sav_only", locale: "fr-FR", expectedResult: "", escalation: "Revue requise", steps: [] });
    for (const key of ["source:one", "source:two"]) await registerCanonicalKnowledge({ canonicalKey: key, title: "Même titre", document, source: { ref: key, hash: "c".repeat(64) } }, "ugo@limova.ai");
    expect(await fixture.db.select().from(knowledgeFamilies)).toHaveLength(2);
  });
});
