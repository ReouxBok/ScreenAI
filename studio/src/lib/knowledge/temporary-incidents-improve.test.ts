import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { categories, knowledgeFamilies, knowledgeFamilyRevisions } from "@/db/schema";
import type { SavSupportDelivery } from "./support-delivery";
import type { SaveSavKnowledgeProposalInput } from "./proposals";
import { canonicalKnowledgeSchema } from "./contracts";
import { saveSavKnowledgeProposal, previewSavKnowledgeProposal, submitSavKnowledgeProposal, previewSavKnowledgeReview, reviewSavKnowledgeProposal, publishSavKnowledgeVersion, activateSavKnowledgeVersion } from "./workspace";

const state = vi.hoisted(() => ({ db: null as unknown, embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(1))) }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("@/lib/embeddings", () => ({ embedTexts: state.embed }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
const actor = "ugo@limova.ai";
const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Renommer un espace de démonstration", applicability: "sav_only", locale: "fr-FR", prerequisites: ["Disposer des droits de gestion de l’espace."], expectedResult: "Le nom apparaît dans la liste des espaces.", exceptions: ["Un nom déjà employé doit être remplacé."], escalation: "Transmettre à un humain si le nom reste inchangé.", steps: [{ id: "workspace.rename", userLabel: "Modifier le nom", objective: "Choisir le nouveau nom", instruction: "Ouvrir les paramètres de l’espace, modifier le nom puis enregistrer.", expectedResult: "Le nom choisi apparaît dans la liste.", prerequisites: [], exceptions: [], escalation: "", variants: [] }] });
const delivery: SavSupportDelivery = { version: 1, mode: "procedure", internalStepIds: [], groups: [{ id: "workspace.rename", label: "Renommer un espace de démonstration", stepIds: ["workspace.rename"], requiresHuman: false, prerequisiteIndexes: [0], exceptionIndexes: [0], includeExpectedResult: true, includeEscalation: true }] };
const proposal = { delivery, mode: "new" as const, title: document.objective, document, sources: [{ ref: "https://docs.example.test/workspaces", label: "Procédure de démonstration vérifiée par l’équipe" }], reason: "Formaliser une procédure sourcée et réutilisable." };
beforeAll(async () => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "synthetic-workspace-test-key-not-production"); fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); vi.unstubAllEnvs(); });
beforeEach(async () => { await fixture.client.exec("TRUNCATE sav_knowledge_proposal_drafts, sav.learning_candidates, knowledge_families, content_items, categories CASCADE; TRUNCATE audit_logs"); await fixture.db.insert(categories).values({ slug: "depannage", label: "Dépannage" }); state.embed.mockReset().mockImplementation(async (texts: string[]) => texts.map(() => Array(768).fill(1))); });
async function submit(input: SaveSavKnowledgeProposalInput = proposal, who = actor) { const draft = await saveSavKnowledgeProposal(input, who); const preview = await previewSavKnowledgeProposal(draft.id, who); return submitSavKnowledgeProposal({ draftId: draft.id, snapshot: preview.snapshot }, who); }
async function approve(candidate: Awaited<ReturnType<typeof submit>>, who = actor, corrected = document) { const preview = await previewSavKnowledgeReview(candidate.id, who, corrected); return reviewSavKnowledgeProposal({ candidateId: candidate.id, expectedRevisionId: candidate.revisionId, snapshot: preview.snapshot, decision: "approve", reason: "Sources et procédure comparées puis vérifiées.", document: corrected }, who); }

// SAV-79 R-T1: an improvement must not silently drop the stored temporary incident. Synthetic SYN data only.
const incident = {
  schemaVersion: 1, id: "syn-workspace-delay", revision: 1, title: "SYN renommage lent",
  scope: { families: ["usage"], productArea: "Espaces" },
  status: "active", knownSince: "2026-11-10T08:00:00Z", validUntil: "2026-11-12T08:00:00Z",
  infoToCollect: [], approvedReply: "Le renommage peut prendre quelques minutes ; l’équipe suit le sujet.", fix: { level: "none", evidence: "" },
  provenance: { source: "Déclaration interne SYN", recordedAt: "2026-11-10T08:05:00Z" },
};
const withIncident = canonicalKnowledgeSchema.parse({ ...document, temporaryIncident: incident });
async function latestDocument(familyId: string) {
  const [revision] = await fixture.db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.familyId, familyId)).orderBy(desc(knowledgeFamilyRevisions.revision)).limit(1);
  return canonicalKnowledgeSchema.parse(revision.document);
}

describe("SAV-79 temporary incident through improve", () => {
  it("keeps the approved revision incident when an improvement document omits it", async () => {
    const first = await approve(await submit({ ...proposal, document: withIncident }), actor, withIncident);
    await publishSavKnowledgeVersion({ itemId: first.targetItemId!, expectedVersionId: first.materializedVersionId! }, actor);
    await activateSavKnowledgeVersion({ itemId: first.targetItemId!, expectedPublishedVersionId: first.materializedVersionId!, expectedActiveVersionId: null }, actor);
    expect((await latestDocument(first.familyId)).temporaryIncident?.id).toBe("syn-workspace-delay");
    const changed = { ...document, objective: "Renommer un espace existant" };
    expect(changed).not.toHaveProperty("temporaryIncident");
    const candidate = await submit({ ...proposal, mode: "improve", targetItemId: first.targetItemId!, document: changed });
    const stored = await latestDocument(candidate.familyId);
    expect(stored.objective).toBe("Renommer un espace existant");
    expect(stored.temporaryIncident).toMatchObject({ id: "syn-workspace-delay", revision: 1 });
    // The incident never reaches the projected SAV body.
    expect(JSON.stringify(candidate.proposedInput)).not.toContain("syn-workspace-delay");
  });

  it("keeps the incident when the reviewer approves a corrected document that omits it", async () => {
    const candidate = await submit({ ...proposal, document: withIncident });
    const corrected = { ...document, objective: "Renommer un espace de démonstration (corrigé)" };
    const approved = await approve(candidate, actor, corrected);
    const [family] = await fixture.db.select().from(knowledgeFamilies).where(eq(knowledgeFamilies.id, approved.familyId));
    const [revision] = await fixture.db.select().from(knowledgeFamilyRevisions).where(eq(knowledgeFamilyRevisions.id, family.approvedRevisionId!));
    const stored = canonicalKnowledgeSchema.parse(revision.document);
    expect(stored.objective).toBe("Renommer un espace de démonstration (corrigé)");
    expect(stored.temporaryIncident).toMatchObject({ id: "syn-workspace-delay", revision: 1 });
  });

  it("a new knowledge item does not inherit any incident", async () => {
    const candidate = await submit({ ...proposal, document });
    expect((await latestDocument(candidate.familyId)).temporaryIncident).toBeUndefined();
  });

  it("an explicit incident in the improvement (e.g. a revocation revision) wins over the inherited one", async () => {
    const first = await approve(await submit({ ...proposal, document: withIncident }), actor, withIncident);
    await publishSavKnowledgeVersion({ itemId: first.targetItemId!, expectedVersionId: first.materializedVersionId! }, actor);
    const revoked = { ...incident, revision: 2, status: "revoked", revocation: { at: "2026-11-11T09:00:00Z", reason: "Incident SYN clos" } };
    const candidate = await submit({ ...proposal, mode: "improve", targetItemId: first.targetItemId!, document: { ...document, temporaryIncident: revoked } as never });
    expect((await latestDocument(candidate.familyId)).temporaryIncident).toMatchObject({ revision: 2, status: "revoked" });
  });
});

