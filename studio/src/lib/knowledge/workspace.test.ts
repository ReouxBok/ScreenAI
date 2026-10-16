import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { auditLogs, categories, contentItems, contentVersions, knowledgeFamilies, knowledgeProjectionCandidates, savKnowledgeActivations, savKnowledgePublicationAttempts, savLearningCandidates } from "@/db/schema";
import type { SaveSavKnowledgeProposalInput } from "./proposals";
import { canonicalKnowledgeSchema } from "./contracts";
import { articleMetadataSchema } from "@/lib/content";
import { saveSavKnowledgeProposal, previewSavKnowledgeProposal, submitSavKnowledgeProposal, previewSavKnowledgeReview, reviewSavKnowledgeProposal, publishSavKnowledgeVersion, activateSavKnowledgeVersion, startSavKnowledgeRevision, paginateSavKnowledge, getSavKnowledgeDetail } from "./workspace";
import { searchKnowledge } from "@/lib/search";
import { rollback, saveDraft, setContentAiEnabled } from "@/lib/workflow";
import { encryptSavPayload, savContentHash } from "@/lib/sav/crypto";

const state = vi.hoisted(() => ({ db: null as unknown, embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(1))) }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("@/lib/embeddings", () => ({ embedTexts: state.embed }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
const actor = "ugo@limova.ai";
const contact = "contact@limova.ai";
const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Renommer un espace de démonstration", applicability: "sav_only", locale: "fr-FR", prerequisites: ["Disposer des droits de gestion de l’espace."], expectedResult: "Le nom apparaît dans la liste des espaces.", exceptions: ["Un nom déjà employé doit être remplacé."], escalation: "Transmettre à un humain si le nom reste inchangé.", steps: [{ id: "workspace.rename", userLabel: "Modifier le nom", objective: "Choisir le nouveau nom", instruction: "Ouvrir les paramètres de l’espace, modifier le nom puis enregistrer.", expectedResult: "Le nom choisi apparaît dans la liste.", prerequisites: [], exceptions: [], escalation: "", variants: [] }] });
const proposal = { mode: "new" as const, title: document.objective, document, sources: [{ ref: "https://docs.example.test/workspaces", label: "Procédure de démonstration vérifiée par l’équipe" }], reason: "Formaliser une procédure sourcée et réutilisable." };
beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-workspace-test-key-not-production"); fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); vi.unstubAllEnvs(); });
beforeEach(async () => { await fixture.client.exec("TRUNCATE sav_knowledge_proposal_drafts, sav.learning_candidates, knowledge_families, content_items, categories CASCADE; TRUNCATE audit_logs"); await fixture.db.insert(categories).values({ slug: "depannage", label: "Dépannage" }); state.embed.mockReset().mockImplementation(async (texts: string[]) => texts.map(() => Array(768).fill(1))); });
async function submit(input: SaveSavKnowledgeProposalInput = proposal, who = actor) { const draft = await saveSavKnowledgeProposal(input, who); const preview = await previewSavKnowledgeProposal(draft.id, who); return submitSavKnowledgeProposal({ draftId: draft.id, snapshot: preview.snapshot }, who); }
async function approve(candidate: Awaited<ReturnType<typeof submit>>, who = actor, corrected = document) { const preview = await previewSavKnowledgeReview(candidate.id, who, corrected); return reviewSavKnowledgeProposal({ candidateId: candidate.id, expectedRevisionId: candidate.revisionId, snapshot: preview.snapshot, decision: "approve", reason: "Sources et procédure comparées puis vérifiées.", document: corrected }, who); }
async function active() { const approved = await approve(await submit()); await publishSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedVersionId: approved.materializedVersionId! }, actor); await activateSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedPublishedVersionId: approved.materializedVersionId!, expectedActiveVersionId: null }, actor); return approved; }

describe("SAV-55 canonical knowledge workspace", () => {
  it("saves internal drafts, requires a preview, deduplicates submission and classifies explicit human provenance", async () => {
    const draft = await saveSavKnowledgeProposal(proposal, contact);
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(0);
    const preview = await previewSavKnowledgeProposal(draft.id, contact);
    await expect(submitSavKnowledgeProposal({ draftId: draft.id, snapshot: "obsolete" }, contact)).rejects.toThrow("KNOWLEDGE_PREVIEW_STALE");
    const candidate = await submitSavKnowledgeProposal({ draftId: draft.id, snapshot: preview.snapshot }, contact);
    expect((await submitSavKnowledgeProposal({ draftId: draft.id, snapshot: preview.snapshot }, contact)).id).toBe(candidate.id);
    const list = await paginateSavKnowledge({ tab: "human" });
    expect(list.total).toBe(1); expect(list.rows[0]).toMatchObject({ origin: "human", kind: "candidate", state: "pending" });
    expect((await paginateSavKnowledge({ tab: "automatic" })).total).toBe(0);
  });
  it("refuses incomplete sources, private text, stale draft edits and non-owner edits", async () => {
    const draft = await saveSavKnowledgeProposal({ ...proposal, sources: [] }, contact);
    const preview = await previewSavKnowledgeProposal(draft.id, contact);
    expect(preview.missing).toContain("Ajouter au moins une source de preuve.");
    await expect(submitSavKnowledgeProposal({ draftId: draft.id, snapshot: preview.snapshot }, contact)).rejects.toThrow("KNOWLEDGE_PROPOSAL_INCOMPLETE");
    await expect(saveSavKnowledgeProposal({ ...proposal, draftId: draft.id, expectedRevision: 2 }, contact)).rejects.toThrow("KNOWLEDGE_DRAFT_STALE");
    await expect(saveSavKnowledgeProposal({ ...proposal, draftId: draft.id, expectedRevision: 1 }, "reouven@limova.ai")).rejects.toThrow("KNOWLEDGE_DRAFT_OWNER_REQUIRED");
    await expect(saveSavKnowledgeProposal({ ...proposal, title: "Accès client.private@example.test" }, actor)).rejects.toThrow("ONBOARDING_KNOWLEDGE_UNSAFE_CONTENT");
  });
  it("keeps the active version through correction, review and publication until explicit version activation", async () => {
    const first = await active();
    const changed = { ...document, objective: "Renommer un espace existant", steps: [{ ...document.steps[0], instruction: "Ouvrir les préférences, saisir le nom validé puis enregistrer." }] };
    const candidate = await submit({ ...proposal, mode: "improve", targetItemId: first.targetItemId!, document: changed });
    const corrected = { ...changed, steps: [{ ...changed.steps[0], instruction: "Ouvrir les préférences de l’espace, saisir le nom corrigé puis enregistrer." }] };
    const approved = await approve(candidate, contact, corrected);
    expect((await getSavKnowledgeDetail({ candidateId: candidate.id }, contact))?.document?.steps[0].instruction).toBe(corrected.steps[0].instruction);
    expect((await fixture.db.select().from(savKnowledgeActivations))[0].versionId).toBe(first.materializedVersionId);
    expect((await paginateSavKnowledge({ tab: "production" })).rows[0].hasPendingUpdate).toBe(true);
    await publishSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedVersionId: approved.materializedVersionId! }, actor);
    const search = await searchKnowledge({ query: "Renommer un espace", scope: "sav", contentTypes: ["article"] });
    expect(search.results[0]?.contentVersionId).toBe(first.materializedVersionId);
    expect((await paginateSavKnowledge({ tab: "human" })).rows.some((row) => row.state === "published_inactive")).toBe(true);
    await activateSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedPublishedVersionId: approved.materializedVersionId!, expectedActiveVersionId: first.materializedVersionId! }, actor);
    expect((await searchKnowledge({ query: "Renommer un espace", scope: "sav", contentTypes: ["article"] })).results[0]?.contentVersionId).toBe(approved.materializedVersionId);
    expect(await fixture.db.select().from(knowledgeFamilies)).toHaveLength(1);
    expect(await fixture.db.select().from(contentItems)).toHaveLength(1);
    expect((await paginateSavKnowledge({ tab: "production" })).rows[0]).toMatchObject({ origin: "human", hasPendingUpdate: false });
    expect((await getSavKnowledgeDetail({ itemId: approved.targetItemId! }, actor))?.sources[0].ref).toBe(proposal.sources[0].ref);
  });
  it("requires Ugo for publication and activation, rejects a stale activation preview", async () => {
    const approved = await approve(await submit(), contact);
    await expect(publishSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedVersionId: approved.materializedVersionId! }, contact)).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    await publishSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedVersionId: approved.materializedVersionId! }, actor);
    await expect(setContentAiEnabled(approved.targetItemId!, true, actor)).rejects.toThrow("KNOWLEDGE_EXPLICIT_VERSION_ACTIVATION_REQUIRED");
    await expect(activateSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedPublishedVersionId: approved.materializedVersionId!, expectedActiveVersionId: crypto.randomUUID() }, actor)).rejects.toThrow("KNOWLEDGE_ACTIVATION_STALE");
    await expect(activateSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedPublishedVersionId: approved.materializedVersionId!, expectedActiveVersionId: null }, contact)).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
  });
  it("persists an indexing failure while keeping the old active content", async () => {
    const first = await active(); const candidate = await submit({ ...proposal, mode: "improve", targetItemId: first.targetItemId! }); const approved = await approve(candidate);
    state.embed.mockRejectedValueOnce(new Error("EMBEDDING_UNAVAILABLE"));
    await expect(publishSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedVersionId: approved.materializedVersionId! }, actor)).rejects.toThrow("EMBEDDING_UNAVAILABLE");
    expect((await fixture.db.select().from(savKnowledgeActivations))[0].versionId).toBe(first.materializedVersionId);
    expect((await paginateSavKnowledge({ tab: "human", status: "index_error" })).total).toBe(1);
    expect((await fixture.db.select().from(savKnowledgePublicationAttempts)).at(-1)?.status).toBe("failed");
  });
  it("invalidates review when source or active base changes, preserves history and permits a motivated rejection", async () => {
    const first = await active(); const candidate = await submit({ ...proposal, mode: "improve", targetItemId: first.targetItemId! });
    const preview = await previewSavKnowledgeReview(candidate.id, actor);
    await fixture.db.update(contentItems).set({ publishedVersionId: null }).where(eq(contentItems.id, first.targetItemId!));
    await expect(reviewSavKnowledgeProposal({ candidateId: candidate.id, expectedRevisionId: candidate.revisionId, snapshot: preview.snapshot, decision: "approve", reason: "Revue de la proposition vérifiée." }, actor)).rejects.toThrow("KNOWLEDGE_REVIEW_STALE");
    const rejected = await reviewSavKnowledgeProposal({ candidateId: candidate.id, expectedRevisionId: candidate.revisionId, snapshot: "", decision: "reject", reason: "La proposition doit être préparée à nouveau." }, actor);
    expect(rejected.status).toBe("rejected");
    expect((await fixture.db.select().from(auditLogs)).some((row) => row.action === "knowledge_candidate_rejected")).toBe(true);
  });
  it("keeps learning origin automatic after human qualification and improves the selected family", async () => {
    const first = await active();
    const [learning] = await fixture.db.insert(savLearningCandidates).values({ sourceRef: "ticket:test-observation", sourceContentHash: savContentHash({ proof: "fictitious" }), explanation: "Résolution observée sur données fictives.", proposedPatch: { ciphertext: encryptSavPayload({ subject: document.objective, finalHumanResolution: document.steps[0].instruction }) }, createdBy: "human" }).returning();
    const draft = await saveSavKnowledgeProposal({ ...proposal, mode: "improve", targetItemId: first.targetItemId!, learningCandidateId: learning.id }, actor);
    expect(draft.origin).toBe("automatic");
    expect((await saveSavKnowledgeProposal({ ...proposal, mode: "improve", targetItemId: first.targetItemId!, learningCandidateId: learning.id }, actor)).id).toBe(draft.id);
    const preview = await previewSavKnowledgeProposal(draft.id, actor); const candidate = await submitSavKnowledgeProposal({ draftId: draft.id, snapshot: preview.snapshot }, actor);
    expect((await paginateSavKnowledge({ tab: "automatic" })).rows[0].candidateId).toBe(candidate.id);
    expect((await getSavKnowledgeDetail({ candidateId: candidate.id }, contact))?.canReview).toBe(true);
    const approved = await approve(candidate, contact);
    expect(approved.targetItemId).toBe(first.targetItemId);
    expect((await fixture.db.select().from(savLearningCandidates))[0]).toMatchObject({ status: "approved", contentItemId: first.targetItemId });
    expect(await fixture.db.select().from(knowledgeFamilies)).toHaveLength(1);
  });
  it("requires completion with an audit reason and keeps compact pagination and counts aligned", async () => {
    const candidate = await submit();
    await reviewSavKnowledgeProposal({ candidateId: candidate.id, expectedRevisionId: candidate.revisionId, snapshot: "", decision: "needs_completion", reason: "Préciser la condition de réussite observée." }, contact);
    await saveSavKnowledgeProposal({ ...proposal, title: "Supprimer un espace fictif" }, actor);
    const list = await paginateSavKnowledge({ tab: "human", q: "Renommer", pageSize: 1 });
    expect(list.total).toBe(1); expect(list.counts.human).toBe(1); expect(list.rows[0].state).toBe("needs_completion");
    expect((await getSavKnowledgeDetail({ candidateId: candidate.id }, contact))?.history.some((event) => event.action === "sav_knowledge_completion_requested")).toBe(true);
    expect((await paginateSavKnowledge({ tab: "human", q: "not-found" })).rows).toEqual([]);
  });
  it("completes a proposal with a new source revision in its original family without erasing the old decision", async () => {
    const candidate = await submit();
    await reviewSavKnowledgeProposal({ candidateId: candidate.id, expectedRevisionId: candidate.revisionId, snapshot: "", decision: "needs_completion", reason: "Ajouter une source de preuve complémentaire." }, actor);
    const next = await startSavKnowledgeRevision(candidate.id, actor);
    const saved = await saveSavKnowledgeProposal({ ...proposal, draftId: next.id, expectedRevision: next.revision, sources: [{ ref: "https://docs.example.test/current", label: "Source complémentaire vérifiée" }], reason: "Source complétée pour lever la demande de précision." }, actor);
    const preview = await previewSavKnowledgeProposal(saved.id, actor);
    const replacement = await submitSavKnowledgeProposal({ draftId: saved.id, snapshot: preview.snapshot }, actor);
    expect(replacement.id).not.toBe(candidate.id); expect(replacement.familyId).toBe(candidate.familyId);
    expect((await startSavKnowledgeRevision(candidate.id, actor)).candidateId).toBe(replacement.id);
    expect((await fixture.db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, candidate.id)))[0].status).toBe("needs_completion");
    expect((await paginateSavKnowledge({ tab: "human" })).total).toBe(1);
    await approve(replacement);
    expect(await fixture.db.select().from(knowledgeFamilies)).toHaveLength(1);
  });
  it.each(["2099-12-31", "2098-06-30"])("preserves unedited lead metadata and uses the explicit canonical expiry %s", async (validUntil) => {
    const first = await active();
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, first.materializedVersionId!));
    const resolution = "resolution" in version.metadata ? version.metadata.resolution! : undefined;
    await fixture.db.update(contentVersions).set({ metadata: { ...version.metadata, resolution: { ...resolution!, audience: "lead", responseTemplate: "Bonjour, voici les informations produit validées.", validUntil: "2099-12-31" } } }).where(eq(contentVersions.id, version.id));
    const dated = { ...document, validUntil };
    const candidate = await submit({ ...proposal, mode: "improve", targetItemId: first.targetItemId!, document: dated });
    expect(candidate.proposedInput).toMatchObject({ metadata: { resolution: { audience: "lead", responseTemplate: "Bonjour, voici les informations produit validées.", validUntil } } });
    const approved = await approve(candidate, actor, dated);
    const [updated] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    expect(updated.metadata).toMatchObject({ resolution: { audience: "lead", responseTemplate: "Bonjour, voici les informations produit validées.", validUntil } });
  });
  it("clears canonical expiry and product version at submission while preserving unedited lead metadata", async () => {
    const first = await active();
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, first.materializedVersionId!));
    const metadata = articleMetadataSchema.parse(version.metadata);
    await fixture.db.update(contentVersions).set({ metadata: { ...metadata, resolution: { ...metadata.resolution!, audience: "lead", responseTemplate: "Bonjour, voici les informations produit validées.", validUntil: "2099-12-31", productVersion: "version précédente" } } }).where(eq(contentVersions.id, version.id));
    const candidate = await submit({ ...proposal, mode: "improve", targetItemId: first.targetItemId!, document });
    const proposedResolution = articleMetadataSchema.parse(candidate.proposedInput.metadata).resolution;
    expect(proposedResolution).not.toHaveProperty("validUntil");
    expect(proposedResolution).toMatchObject({ productVersion: "", audience: "lead", responseTemplate: "Bonjour, voici les informations produit validées." });
    const approved = await approve(candidate);
    const [updated] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    expect(articleMetadataSchema.parse(updated.metadata).resolution).not.toHaveProperty("validUntil");
    expect(updated.metadata).toMatchObject({ resolution: { productVersion: "", audience: "lead", responseTemplate: "Bonjour, voici les informations produit validées." } });
    expect((await getSavKnowledgeDetail({ candidateId: candidate.id }, actor))?.document?.validUntil).toBeUndefined();
  });
  it("clears an expiry removed only during review from both the approved candidate and its materialized version", async () => {
    const dated = { ...document, validUntil: "2099-12-31", productVersion: "version précédente" };
    const candidate = await submit({ ...proposal, document: dated });
    expect(candidate.proposedInput).toMatchObject({ metadata: { resolution: { validUntil: dated.validUntil, productVersion: dated.productVersion } } });
    const approved = await approve(candidate, actor, document);
    expect(articleMetadataSchema.parse(approved.proposedInput.metadata).resolution).not.toHaveProperty("validUntil");
    const [updated] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    expect(articleMetadataSchema.parse(updated.metadata).resolution).not.toHaveProperty("validUntil");
    expect(updated.metadata).toMatchObject({ resolution: { productVersion: "" } });
    expect((await getSavKnowledgeDetail({ candidateId: candidate.id }, actor))?.document?.validUntil).toBeUndefined();
  });
  it.each(["support", "lead"] as const)("retrieves formerly expired %s knowledge only after explicit revalidation, publication and activation", async (audience) => {
    const first = await active();
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, first.materializedVersionId!));
    const metadata = articleMetadataSchema.parse(version.metadata);
    await fixture.db.update(contentVersions).set({ metadata: { ...metadata, resolution: { ...metadata.resolution!, audience, responseTemplate: "Bonjour, voici les informations produit validées.", validUntil: "2020-01-01" } } }).where(eq(contentVersions.id, version.id));
    const search = () => searchKnowledge({ query: "Renommer un espace", scope: "sav", contentTypes: ["article"], savAudience: audience });
    expect((await search()).results).toHaveLength(0);
    const approved = await approve(await submit({ ...proposal, mode: "improve", targetItemId: first.targetItemId!, document }));
    expect((await search()).results).toHaveLength(0);
    await publishSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedVersionId: approved.materializedVersionId! }, actor);
    expect((await fixture.db.select().from(savKnowledgeActivations))[0].versionId).toBe(first.materializedVersionId);
    expect((await search()).results).toHaveLength(0);
    await activateSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedPublishedVersionId: approved.materializedVersionId!, expectedActiveVersionId: first.materializedVersionId! }, actor);
    const results = (await search()).results;
    expect(results.some((row) => row.contentVersionId === approved.materializedVersionId)).toBe(true);
    expect(results[0].resolution).toMatchObject({ audience, responseTemplate: "Bonjour, voici les informations produit validées." });
    expect(results[0].resolution).not.toHaveProperty("validUntil");
    expect((await searchKnowledge({ query: "Renommer un espace", scope: "sav", contentTypes: ["article"], savAudience: audience === "lead" ? "support" : "lead" })).results).toHaveLength(0);
  });
  it("blocks publication if a declared Studio source changed after approval", async () => {
    const first = await active();
    const candidate = await submit({ ...proposal, sources: [{ ref: `content:${first.targetItemId}:${first.materializedVersionId}`, label: "Version source explicite" }] });
    const approved = await approve(candidate);
    await fixture.db.update(contentItems).set({ publishedVersionId: null }).where(eq(contentItems.id, first.targetItemId!));
    await expect(publishSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedVersionId: approved.materializedVersionId! }, actor)).rejects.toThrow("KNOWLEDGE_SOURCE_STALE");
    expect((await fixture.db.select().from(savKnowledgeActivations))).toHaveLength(1);
  });
  it("does not start a second indexing attempt while the first is pending", async () => {
    const approved = await approve(await submit());
    await fixture.db.insert(savKnowledgePublicationAttempts).values({ itemId: approved.targetItemId!, versionId: approved.materializedVersionId!, status: "indexing", actorEmail: actor });
    await expect(publishSavKnowledgeVersion({ itemId: approved.targetItemId!, expectedVersionId: approved.materializedVersionId! }, actor)).rejects.toThrow("KNOWLEDGE_PUBLICATION_PENDING");
    expect(state.embed).not.toHaveBeenCalled();
    expect((await paginateSavKnowledge({ tab: "human" })).rows[0].state).toBe("indexing");
  });

  it("keeps a rejected learning proposal final and requires a new separately qualified proof", async () => {
    const [learning] = await fixture.db.insert(savLearningCandidates).values({ sourceRef: "ticket:rejected-observation", sourceContentHash: savContentHash({ proof: "fresh" }), explanation: "Résolution fictive qualifiée.", proposedPatch: { ciphertext: encryptSavPayload({ subject: document.objective, finalHumanResolution: document.steps[0].instruction }) }, createdBy: "human" }).returning();
    const draft = await saveSavKnowledgeProposal({ ...proposal, learningCandidateId: learning.id }, actor);
    const preview = await previewSavKnowledgeProposal(draft.id, actor);
    const candidate = await submitSavKnowledgeProposal({ draftId: draft.id, snapshot: preview.snapshot }, actor);
    await reviewSavKnowledgeProposal({ candidateId: candidate.id, expectedRevisionId: candidate.revisionId, snapshot: "", decision: "reject", reason: "La rédaction nécessite une correction explicite." }, actor);
    expect((await fixture.db.select().from(savLearningCandidates))[0].status).toBe("rejected");
    await expect(startSavKnowledgeRevision(candidate.id, contact)).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    await fixture.db.update(savLearningCandidates).set({ sourceContentHash: savContentHash({ proof: "changed" }) }).where(eq(savLearningCandidates.id, learning.id));
    await expect(startSavKnowledgeRevision(candidate.id, actor)).rejects.toThrow("SAV_OBSERVATION_STALE");
    await fixture.db.update(savLearningCandidates).set({ sourceContentHash: learning.sourceContentHash }).where(eq(savLearningCandidates.id, learning.id));
    await expect(startSavKnowledgeRevision(candidate.id, actor)).rejects.toThrow("SAV_LEARNING_REJECTION_FINAL");
    expect((await fixture.db.select().from(savLearningCandidates))[0].status).toBe("rejected");
    expect((await fixture.db.select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, candidate.id)))[0].status).toBe("rejected");
    expect((await fixture.db.select().from(auditLogs)).some((row) => row.action === "sav_learning_revision_started")).toBe(false);
  });

  it("restores a published version without activation and lets Ugo activate the audited rollback separately", async () => {
    const first = await active();
    const second = await approve(await submit({ ...proposal, mode: "improve", targetItemId: first.targetItemId!, document: { ...document, objective: "Renommer un espace : procédure améliorée" } }));
    await publishSavKnowledgeVersion({ itemId: second.targetItemId!, expectedVersionId: second.materializedVersionId! }, actor);
    await activateSavKnowledgeVersion({ itemId: second.targetItemId!, expectedPublishedVersionId: second.materializedVersionId!, expectedActiveVersionId: first.materializedVersionId! }, actor);
    await expect(rollback(first.targetItemId!, first.materializedVersionId!, contact, "Retour à la procédure précédente validée.")).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    await rollback(first.targetItemId!, first.materializedVersionId!, actor, "Retour à la procédure précédente validée.");
    expect((await fixture.db.select().from(savKnowledgeActivations))[0].versionId).toBe(second.materializedVersionId);
    await activateSavKnowledgeVersion({ itemId: first.targetItemId!, expectedPublishedVersionId: first.materializedVersionId!, expectedActiveVersionId: second.materializedVersionId! }, actor);
    expect((await fixture.db.select().from(savKnowledgeActivations))[0].versionId).toBe(first.materializedVersionId);
    expect((await fixture.db.select().from(auditLogs)).some((row) => row.action === "rolled_back" && row.technicalMetadata.versionId === first.materializedVersionId)).toBe(true);
  });

  it("saves incomplete internal drafts but requires completion before submission", async () => {
    const draft = await saveSavKnowledgeProposal({ ...proposal, title: "", document: { ...document, objective: "", steps: [{ ...document.steps[0], userLabel: "", objective: "", instruction: "" }] } }, contact);
    expect(draft.document.steps[0].instruction).toBe("");
    expect((await paginateSavKnowledge({ tab: "human" })).rows.find(row => row.id === draft.id)?.title).toBe("Brouillon sans titre");
    const preview = await previewSavKnowledgeProposal(draft.id, contact);
    expect(preview.missing).toContain("Donner un titre clair à la connaissance.");
    await expect(submitSavKnowledgeProposal({ draftId: draft.id, snapshot: preview.snapshot }, contact)).rejects.toThrow("KNOWLEDGE_PROPOSAL_INCOMPLETE");
    await expect(saveSavKnowledgeProposal({ ...proposal, document: { ...draft.document, steps: [{ ...draft.document.steps[0], instruction: "client.private@example.test" }] } }, contact)).rejects.toThrow("ONBOARDING_KNOWLEDGE_UNSAFE_CONTENT");
    expect(await fixture.db.select().from(knowledgeProjectionCandidates)).toHaveLength(0);
  });

  it("keeps an expired active version visible for revalidation without listing it as production", async () => {
    const approved = await active();
    const [version] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, approved.materializedVersionId!));
    await fixture.db.update(contentVersions).set({ metadata: { ...version.metadata, resolution: { ...articleMetadataSchema.parse(version.metadata).resolution!, validUntil: "2000-01-01" } } }).where(eq(contentVersions.id, version.id));
    expect((await paginateSavKnowledge({ tab: "production" })).total).toBe(0);
    const human = await paginateSavKnowledge({ tab: "human", status: "needs_revalidation" });
    expect(human.total).toBe(1);
    expect(human.rows[0]).toMatchObject({ candidateId: approved.id, state: "needs_revalidation", origin: "human" });
    expect(human.counts).toMatchObject({ production: 0, human: 1 });
    expect((await searchKnowledge({ query: "Renommer un espace", scope: "sav", contentTypes: ["article"] })).results).toHaveLength(0);
  });
  it("lists historical SAV drafts and inactive publications with unknown provenance, without duplicating candidates", async () => {
    const current = await active();
    const [base] = await fixture.db.select().from(contentVersions).where(eq(contentVersions.id, current.materializedVersionId!));
    const legacy = await saveDraft({ type: "article", slug: "legacy-internal", locale: "fr-FR", title: "Ancienne procédure sans candidat", summary: "Fiche historique à qualifier", categorySlug: "depannage", visibility: "charly_only", agentKey: "sav", ownerEmail: actor, bodyMarkdown: base.bodyMarkdown, changeNote: "Fiche historique de démonstration", metadata: { ...base.metadata, sourceMetadata: {} } }, actor);
    let automatic = await paginateSavKnowledge({ tab: "automatic" });
    expect(automatic.rows).toHaveLength(1);
    expect(automatic.rows[0]).toMatchObject({ itemId: legacy.item.id, state: "draft", origin: "unknown" });
    await fixture.db.update(contentItems).set({ status: "in_review" }).where(eq(contentItems.id, legacy.item.id));
    expect((await paginateSavKnowledge({ tab: "automatic", status: "pending" })).total).toBe(1);
    await publishSavKnowledgeVersion({ itemId: legacy.item.id, expectedVersionId: legacy.version.id }, actor);
    automatic = await paginateSavKnowledge({ tab: "automatic" });
    expect(automatic.rows[0]).toMatchObject({ itemId: legacy.item.id, state: "published_inactive", origin: "unknown" });
    expect(automatic.counts).toMatchObject({ production: 1, automatic: 1, human: 0 });
    await activateSavKnowledgeVersion({ itemId: legacy.item.id, expectedPublishedVersionId: legacy.version.id, expectedActiveVersionId: null }, actor);
    await setContentAiEnabled(legacy.item.id, false, actor);
    expect((await paginateSavKnowledge({ tab: "automatic" })).rows[0]).toMatchObject({ itemId: legacy.item.id, state: "published_inactive" });
    await fixture.db.update(contentVersions).set({ metadata: { ...legacy.version.metadata, resolution: { ...articleMetadataSchema.parse(legacy.version.metadata).resolution!, validUntil: "2000-01-01" } } }).where(eq(contentVersions.id, legacy.version.id));
    expect((await paginateSavKnowledge({ tab: "automatic", status: "needs_revalidation" })).total).toBe(1);
  });

});
