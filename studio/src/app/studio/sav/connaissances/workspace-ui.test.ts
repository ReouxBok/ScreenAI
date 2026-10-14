import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SavKnowledgeDetail, SavKnowledgeRow } from "@/lib/knowledge/workspace-contract";
const state = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/sav/auth", () => ({ requireSavStaff: state.auth }));
vi.mock("@/lib/knowledge/workspace", () => ({ paginateSavKnowledge: state.list, getSavKnowledgeDetail: state.detail }));
vi.mock("./workspace-actions", () => ({ startKnowledgeRevisionAction: vi.fn(), saveKnowledgeProposalAction: vi.fn(), previewKnowledgeProposalAction: vi.fn(), submitKnowledgeProposalAction: vi.fn(), findKnowledgeAction: vi.fn(), loadKnowledgeTargetAction: vi.fn(), previewKnowledgeReviewAction: vi.fn(), reviewKnowledgeWorkspaceAction: vi.fn(), publishKnowledgeWorkspaceAction: vi.fn(), activateKnowledgeWorkspaceAction: vi.fn() }));
vi.mock("./onboarding-review-form", () => ({ OnboardingReviewForm: () => createElement("div", null, "Formulaire source tutoriel") }));
vi.mock("./hubspot-review-form", () => ({ HubspotReviewForm: () => createElement("div", null, "Formulaire source HubSpot") }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
import Library from "./page";
import Detail from "./[id]/page";
import { KnowledgeProposalForm, KnowledgeProposalPreviewDocument } from "./proposal-form";
import { KnowledgePublication } from "./workspace-review";
import { safeKnowledgeReturn, knowledgeErrorMessage } from "./workspace-labels";
const id = "00550000-0000-4000-8000-000000000001";
const row: SavKnowledgeRow = { id, kind: "item", itemId: id, candidateId: null, draftId: null, learningCandidateId: null, familyId: id, title: "Renommer une maquette fictive", summary: "Retrouver une maquette facilement.", origin: "human", state: "production", version: 1, updatedAt: new Date("2026-10-14T10:00:00Z"), sourceLabel: "Source fictive", activeVersionId: id, publishedVersionId: id, hasPendingUpdate: true, nextAction: "Consulter la version active" };
const document = { schemaVersion: 1 as const, objective: row.summary, applicability: "sav_only" as const, locale: "fr-FR", productVersion: "", prerequisites: ["Maquette de démonstration"], expectedResult: "Nom affiché", exceptions: ["Vérifier les droits"], escalation: "Contacter un humain", steps: [{ id: "step.rename", userLabel: "Renommer", objective: "Identifier la maquette", instruction: "Choisir un nom explicite.", location: "", expectedResult: "Nom visible", prerequisites: [], exceptions: [], escalation: "", variants: [] }] };
const detail: SavKnowledgeDetail = { row, document, sources: [{ ref: "https://example.invalid/reference", label: "Source fictive" }], activeVersion: { id, version: 1, title: row.title, body: "Version active fictive", authorEmail: "staff@example.invalid", createdAt: row.updatedAt }, publishedVersion: null, proposedVersion: null, proposedBody: "Version proposée fictive", revisionId: id, draft: null, comparison: [], snapshot: "snapshot", missing: [], alerts: [], history: [], canReview: false, canPublish: false, canActivate: false, reviewKind: null };
beforeEach(() => { vi.clearAllMocks(); state.auth.mockResolvedValue({ email: "ugo@limova.ai", role: "owner" }); state.list.mockResolvedValue({ rows: [row], total: 1, page: 1, pageSize: 20, counts: { production: 1, automatic: 2, human: 3 } }); state.detail.mockResolvedValue(detail); });
describe("SAV-55 knowledge screens", () => {
  it("renders exactly three business tabs and a compact linked list", async () => {
    const html = renderToStaticMarkup(await Library({ searchParams: Promise.resolve({}) }));
    for (const title of ["En production", "À valider apprentissage automatique", "À valider proposition Humaine"]) expect(html).toContain(title);
    expect(html).toContain("Mise à jour à valider"); expect(html).toContain(`/studio/sav/connaissances/${id}?kind=item`);
    expect(html).not.toContain("Connaissance complète"); expect(html).not.toContain("<textarea");
  });
  it("keeps query and pagination in the detail return link", async () => {
    const html = renderToStaticMarkup(await Library({ searchParams: Promise.resolve({ tab: "human", q: "maquette", page: "2", status: "pending" }) }));
    expect(state.list).toHaveBeenCalledWith(expect.objectContaining({ tab: "human", q: "maquette", page: 2, status: "pending" }));
    expect(html).toContain("from=%2Fstudio%2Fsav%2Fconnaissances");
  });
  it("clears proposal status when navigating to production", async () => {
    await Library({ searchParams: Promise.resolve({ tab: "production", status: "pending" }) });
    expect(state.list).toHaveBeenCalledWith(expect.objectContaining({ status: "all" }));
  });
  it("shows an honest failure and never false zero counts", async () => {
    state.list.mockRejectedValue(new Error("private details"));
    const html = renderToStaticMarkup(await Library({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("n’a pas pu être chargée"); expect(html).not.toContain("private details"); expect(html).not.toContain("Aucune connaissance active");
  });
  it("shows the empty active state without claiming approved content is live", async () => {
    state.list.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 20, counts: { production: 0, automatic: 0, human: 0 } });
    const html = renderToStaticMarkup(await Library({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Aucune connaissance active"); expect(html).toContain("validation, publication et activation");
  });
  it("keeps old candidate links usable via dedicated detail", async () => {
    await expect(Library({ searchParams: Promise.resolve({ candidate: id }) })).rejects.toThrow(`REDIRECT:/studio/sav/connaissances/${id}?kind=candidate`);
  });
  it("renders sources and active/proposed comparison, without permitting Contact publication", async () => {
    state.auth.mockResolvedValue({ email: "contact@limova.ai", role: "member" });
    state.detail.mockResolvedValue({ ...detail, canPublish: true, canActivate: true });
    const html = renderToStaticMarkup(await Detail({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ kind: "item" }) }));
    expect(html).toContain("Version active fictive"); expect(html).toContain("Version proposée fictive"); expect(html).toContain("Source fictive");
    expect(html).not.toContain("Publier la version validée"); expect(html).not.toContain("Activer cette version pour le SAV");
  });
  it("publication and activation have separate confirmation entry points", () => {
    const html = renderToStaticMarkup(createElement(KnowledgePublication, { itemId: id, proposedVersionId: id, publishedVersionId: id, activeVersionId: null, canPublish: true, canActivate: true, title: row.title }));
    expect(html).toContain("Publier la version validée"); expect(html).toContain("Activer cette version pour le SAV"); expect(html).not.toContain("Confirmer la publication");
  });
  it("a proposal starts as an editable draft without an implicit submit", () => {
    const html = renderToStaticMarkup(createElement(KnowledgeProposalForm, { initial: null }));
    expect(html).toContain("Nouvelle connaissance"); expect(html).toContain("Améliorer une connaissance existante"); expect(html).toContain("Enregistrer le brouillon"); expect(html).toContain("Sources et preuves");
    expect(html).not.toContain("Confirmer et soumettre à validation"); expect(html).not.toContain("JSON");
  });
  it("previews the persisted draft title, procedure and sources returned by the server", () => {
    const html = renderToStaticMarkup(createElement(KnowledgeProposalPreviewDocument, { draft: { title: "Titre du tutoriel conservé", document: { ...document, objective: "Procédure A enregistrée dans un autre onglet" }, sources: [{ ref: "studio:preuve-A", label: "Preuve enregistrée A" }] } }));
    expect(html).toContain("Titre du tutoriel conservé"); expect(html).toContain("Procédure A enregistrée dans un autre onglet"); expect(html).toContain("Preuve enregistrée A"); expect(html).toContain("studio:preuve-A");
  });
  it("blocks external return targets and translates stale errors", () => {
    expect(safeKnowledgeReturn("https://example.invalid/steal")).toBe("/studio/sav/connaissances");
    expect(safeKnowledgeReturn("/studio/sav/connaissances?tab=human&page=2")).toContain("page=2");
    expect(knowledgeErrorMessage("KNOWLEDGE_TARGET_STALE")).toContain("version active a changé");
  });
});
