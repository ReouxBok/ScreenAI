import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({
  auth: vi.fn(), select: vi.fn(), start: vi.fn(), resume: vi.fn(), prepare: vi.fn(), review: vi.fn(), revalidate: vi.fn(),
  paginate: vi.fn(), imports: vi.fn(), batch: vi.fn(), inventory: vi.fn(), sourceInventory: vi.fn(), approvedRevisions: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireApiStaff: state.auth, hasRole: (role: string) => ["admin", "owner"].includes(role) }));
vi.mock("@/lib/sav/auth", () => ({ requireSavStaff: state.auth }));
vi.mock("@/db", () => ({ requireDb: () => ({ select: (selection: Record<string, unknown> = {}) => {
  if ("projectionVersionId" in selection) return { from: () => ({ innerJoin: () => ({ where: state.approvedRevisions }) }) };
  const query = { from: () => query, innerJoin: () => query, where: () => query, limit: state.select };
  return query;
} }) }));
vi.mock("@/lib/knowledge/onboarding-import", () => ({ startOnboardingImport: state.start, continueOnboardingImport: state.resume, prepareOnboardingReview: state.prepare, listOnboardingImports: state.imports, getOnboardingImport: state.batch, inventoryOnboardingSources: state.sourceInventory }));
vi.mock("@/lib/knowledge/candidates", () => ({ paginateKnowledgeCandidates: state.paginate }));
vi.mock("@/lib/knowledge/hubspot-import", () => ({ knowledgeComparisonInventory: state.inventory, hubspotComparison: vi.fn() }));
vi.mock("../actions", () => ({ importOnboardingKnowledgeAction: vi.fn(), importHubspotKnowledgeAction: vi.fn(), reviewKnowledgeAction: vi.fn(), previewHubspotReviewAction: vi.fn() }));
vi.mock("@/lib/knowledge/review", () => ({ reviewKnowledgeCandidate: state.review }));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));

import { continueOnboardingImportAction, previewOnboardingReviewAction, reviewOnboardingKnowledgeAction, startOnboardingImportAction } from "./onboarding-actions";
import SavKnowledgeCandidatesPage from "./page";

const candidateId = "10000000-0000-4000-8000-000000000001";
const revisionId = "10000000-0000-4000-8000-000000000002";
const importId = "10000000-0000-4000-8000-000000000003";
function form(values: Record<string, string> = {}) {
  const result = new FormData();
  for (const [key, value] of Object.entries({ candidateId, revisionId, reason: "Procédure et source relues", ...values })) result.set(key, value);
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.auth.mockResolvedValue({ email: "ugo@limova.ai", role: "owner" });
  state.select.mockResolvedValue([{ id: candidateId, revisionId, status: "pending" }]);
  state.start.mockResolvedValue({ id: importId, total: 119 });
  state.resume.mockResolvedValue({ id: importId, total: 119, processed: 10, remaining: 109 });
  state.prepare.mockResolvedValue({ snapshot: "snapshot", sourceCurrent: true });
  state.review.mockResolvedValue({ id: candidateId });
  state.paginate.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 20 });
  state.imports.mockResolvedValue([]);
  state.batch.mockResolvedValue(null);
  state.inventory.mockResolvedValue([]);
  state.sourceInventory.mockResolvedValue({ sources: [{ key: `content:${candidateId}`, hash: "source-hash" }] });
  state.approvedRevisions.mockResolvedValue([]);
});

describe("SAV onboarding knowledge actions", () => {
  it("requires an admin session and a SAV actor before starting a lot", async () => {
    state.auth.mockResolvedValue({ email: "another-admin@example.com", role: "admin" });
    await expect(startOnboardingImportAction(form())).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    expect(state.auth).toHaveBeenCalledWith("admin");
    expect(state.start).not.toHaveBeenCalled();
  });

  it("starts the inventory without processing or publishing candidates", async () => {
    await expect(startOnboardingImportAction(form())).rejects.toThrow("result=onboarding_import_started");
    expect(state.start).toHaveBeenCalledWith("ugo@limova.ai");
    expect(state.resume).not.toHaveBeenCalled();
    expect(state.review).not.toHaveBeenCalled();
  });

  it("resumes at most ten sources and preserves supported list filters", async () => {
    await expect(continueOnboardingImportAction(form({ importId, limit: "99999", returnPage: "2", returnStatus: "needs_completion", returnSource: "onboarding" }))).rejects.toThrow("result=onboarding_import_continued&page=2&status=needs_completion&source=onboarding");
    expect(state.resume).toHaveBeenCalledWith(importId, "ugo@limova.ai", 10);
  });

  it("does not call the backend for a malformed lot reference", async () => {
    await expect(continueOnboardingImportAction(form({ importId: "bad", returnPage: "-1", returnStatus: "unknown", returnSource: "https://example.com" }))).rejects.toThrow("/studio/sav/connaissances?result=ONBOARDING_ACTION_INVALID");
    expect(state.resume).not.toHaveBeenCalled();
  });

  it("reserves previews for Ugo before reading candidates", async () => {
    state.auth.mockResolvedValue({ email: "reouven@limova.ai", role: "admin" });
    await expect(previewOnboardingReviewAction(form({ document: "{}" }))).rejects.toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    expect(state.select).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it("rejects a stale candidate revision before preparing a comparison", async () => {
    state.select.mockResolvedValue([{ id: candidateId, revisionId: importId, status: "pending" }]);
    expect(await previewOnboardingReviewAction(form({ document: "{}" }))).toEqual({ comparison: null, error: "KNOWLEDGE_CANDIDATE_STALE" });
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it("previews the corrected document for a candidate needing completion", async () => {
    const candidate = { id: candidateId, revisionId, status: "needs_completion" };
    state.select.mockResolvedValue([candidate]);
    const result = await previewOnboardingReviewAction(form({ document: JSON.stringify({ objective: "Document corrigé" }) }));
    expect(result.error).toBeNull();
    expect(state.prepare).toHaveBeenCalledWith(candidate, { objective: "Document corrigé" });
    expect(state.review).not.toHaveBeenCalled();
  });

  it("returns only a safe error code when source checking fails", async () => {
    state.prepare.mockRejectedValue(new Error("private database details"));
    expect(await previewOnboardingReviewAction(form({ document: "{}" }))).toEqual({ comparison: null, error: "ONBOARDING_ACTION_INVALID" });
  });

  it("allows rejection without comparison or a parseable edited document", async () => {
    await expect(reviewOnboardingKnowledgeAction(form({ decision: "reject", document: "invalid JSON" }))).rejects.toThrow("result=draft_ready");
    expect(state.review).toHaveBeenCalledWith(candidateId, { expectedRevisionId: revisionId, decision: "reject", reason: "Procédure et source relues" }, "ugo@limova.ai");
  });

  it("passes explicit comparison and completion evidence to server review", async () => {
    await expect(reviewOnboardingKnowledgeAction(form({ decision: "approve", document: "{}", comparisonSnapshot: "checked-snapshot", comparisonAcknowledged: "on", completionNote: "Les conditions ont été vérifiées dans la version source.", missingAcknowledged: "on" }))).rejects.toThrow("result=draft_ready");
    expect(state.review).toHaveBeenCalledWith(candidateId, expect.objectContaining({ decision: "approve", document: {}, comparison: { snapshot: "checked-snapshot", acknowledged: true }, completionNote: "Les conditions ont été vérifiées dans la version source.", missingAcknowledged: true }), "ugo@limova.ai");
  });

  it("keeps the selected candidate, lot and filters after a review", async () => {
    await expect(reviewOnboardingKnowledgeAction(form({ decision: "reject", returnPage: "4", returnStatus: "needs_completion", returnSource: "onboarding", returnBatch: importId, returnCandidate: candidateId }))).rejects.toThrow(`page=4&status=needs_completion&source=onboarding&batch=${importId}&candidate=${candidateId}#candidate-${candidateId}`);
  });
});

function candidateRow(id = candidateId, title = "Connecter son compte et conserver le même titre") {
  return {
    candidate: { id, familyId: id, status: "needs_completion", targetSurface: "sav", explanation: "Résultat à confirmer dans la source", proposedInput: { title }, diff: { before: "", after: "## Objectif\n\nProcédure complète et vérifiable." }, targetItemId: null, materializedVersionId: null as string | null, reviewedAt: null },
    family: { canonicalKey: `content:${id}`, title: "Ancien titre de la famille" },
    revision: { id: revisionId, revision: 1, reviewState: "pending", document: { schemaVersion: 1, locale: "fr-FR", applicability: "shared", objective: "Permettre au membre de connecter son compte.", prerequisites: ["Avoir accès au compte"], expectedResult: "Le compte est connecté", exceptions: ["Faire vérifier un refus"], escalation: "Contacter un humain si le résultat diffère", productVersion: "", steps: [{ id: "step.connect", userLabel: "Ouvrir les intégrations", objective: "Accéder au bon écran", instruction: "Ouvrir le catalogue des intégrations.", location: "Menu principal", prerequisites: [], expectedResult: "Catalogue visible", exceptions: [], escalation: "", variants: [] }] } },
    source: { sourceRef: `content:${id}`, sourceVersionId: revisionId, evidence: { importKind: "onboarding_catalog", sourceTitle: title, sourceItemId: importId, snapshot: { key: `content:${id}`, hash: "source-hash" }, quality: { missing: ["Résultat source à vérifier"], warnings: ["Différence avec le catalogue"] } } },
  };
}
function batchFixture() {
  return {
    id: importId, total: 3, processed: 1, failed: 1, remaining: 1, ready: 0, needsCompletion: 1, createdAt: new Date("2026-10-12T14:00:00Z"),
    manifest: { sources: ["first", "failed", "waiting"].map((key) => ({ key, kind: "studio", title: `Tutoriel ${key}`, version: 2, versionId: revisionId, itemId: importId, hash: "source-hash", indexed: true, aliases: [] })), inventory: { studioActive: 3, studioIndexed: 3, curriculum: 2, mappedCurriculum: 2, excluded: [], templateVersionId: null, templateReferences: [] } },
    outcomes: { first: { state: "candidate", status: "needs_completion", candidateId, attempts: 1 }, failed: { state: "failed", error: "ONBOARDING_SOURCE_STALE", attempts: 2 } },
  };
}
async function pageHtml(searchParams: Record<string, string> = {}) {
  return renderToStaticMarkup(await SavKnowledgeCandidatesPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("SAV onboarding catalogue presentation", () => {
  it("keeps titles visible while knowledge and review details start collapsed", async () => {
    const row = candidateRow();
    state.paginate.mockResolvedValue({ rows: [row], total: 123, page: 1, pageSize: 20 });
    const html = await pageHtml();
    expect(html).toContain(`<h2>${row.candidate.proposedInput.title}</h2>`);
    expect(html).not.toContain("<h2>Ancien titre de la famille</h2>");
    expect(html).toContain('<details class="learning-preview"><summary>Lire la connaissance et ses limites</summary>');
    expect(html).toContain('<details class="learning-preview"><summary>Revoir, corriger ou écarter cette connaissance</summary>');
    expect(html).not.toContain('<details class="learning-preview" open="">');
    expect(html).toContain("123 candidats correspondants · Page 1 sur 7.");
    expect(html).toContain("<h3>Prérequis</h3><ul><li>Avoir accès au compte</li></ul>");
  });

  it("preserves status, source and selected lot when changing pages", async () => {
    state.paginate.mockResolvedValue({ rows: [], total: 123, page: 3, pageSize: 20 });
    const html = await pageHtml({ page: "3", status: "needs_completion", source: "onboarding", batch: importId });
    expect(state.paginate).toHaveBeenCalledWith({ page: 3, pageSize: 20, status: "needs_completion", source: "onboarding" });
    expect(html).toContain(`page=4&amp;status=needs_completion&amp;source=onboarding&amp;batch=${importId}`);
    expect(html).toContain(`page=2&amp;status=needs_completion&amp;source=onboarding&amp;batch=${importId}`);
  });

  it("checks current source hashes once for all visible onboarding candidates", async () => {
    const rows = [candidateRow(), candidateRow(importId)];
    state.paginate.mockResolvedValue({ rows, total: 2, page: 1, pageSize: 20 });
    state.sourceInventory.mockResolvedValue({ sources: rows.map(({ source }) => source.evidence.snapshot) });
    const html = await pageHtml();
    expect(state.sourceInventory).toHaveBeenCalledTimes(1);
    expect(html).not.toContain("Le tutoriel source a changé.");
  });

  it.each(["pending", "needs_completion", "approved"])("shows a changed source alert for %s without changing the decision", async (status) => {
    const row = candidateRow();
    row.candidate.status = status;
    state.paginate.mockResolvedValue({ rows: [row], total: 1, page: 1, pageSize: 20 });
    state.sourceInventory.mockResolvedValue({ sources: [{ key: row.source.evidence.snapshot.key, hash: "new-source-hash" }] });
    const html = await pageHtml();
    expect(html).toContain("Le tutoriel source a changé. Les connaissances déjà publiées restent utilisables ; préparez puis validez une mise à jour.");
    expect(row.candidate.status).toBe(status);
    expect(state.review).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });

  it("alerts when the source is no longer in the active inventory", async () => {
    state.paginate.mockResolvedValue({ rows: [candidateRow()], total: 1, page: 1, pageSize: 20 });
    state.sourceInventory.mockResolvedValue({ sources: [] });
    expect(await pageHtml()).toContain("Le tutoriel source a changé.");
  });

  it("does not inventory sources for rejected or non-onboarding candidates", async () => {
    const rejected = candidateRow();
    rejected.candidate.status = "rejected";
    const other = candidateRow(importId);
    other.source.evidence.importKind = "hubspot";
    state.paginate.mockResolvedValue({ rows: [rejected, other], total: 2, page: 1, pageSize: 20 });
    expect(await pageHtml()).not.toContain("Le tutoriel source a changé.");
    expect(state.sourceInventory).not.toHaveBeenCalled();
  });

  it.each([false, true])("shows the approved corrected document and its revision in catalogue or direct view (direct=%s)", async (direct) => {
    const row = candidateRow();
    row.candidate.status = "approved";
    row.candidate.materializedVersionId = importId;
    const correctedDocument = { ...row.revision.document, objective: "Objectif corrigé et validé par Ugo", steps: [{ ...row.revision.document.steps[0], instruction: "Instruction corrigée avec la preuve métier." }] };
    state.paginate.mockResolvedValue({ rows: [row], total: 1, page: 1, pageSize: 20 });
    state.select.mockResolvedValue([row]);
    state.approvedRevisions.mockResolvedValue([{ familyId: row.candidate.familyId, projectionVersionId: importId, revision: { ...row.revision, revision: 2, document: correctedDocument } }]);
    const html = await pageHtml(direct ? { candidate: candidateId } : {});
    expect(state.approvedRevisions).toHaveBeenCalledTimes(1);
    expect(html).toContain("Révision métier 2");
    expect(html).toContain("Objectif corrigé et validé par Ugo");
    expect(html).toContain("Instruction corrigée avec la preuve métier.");
    expect(html).not.toContain(row.revision.document.objective);
    expect(html).not.toContain(row.revision.document.steps[0].instruction);
    expect(html).toContain(`Version : ${revisionId}`);
    expect(html).toContain("Informations absentes de la source initiale");
  });

  it("loads all approved materialized documents in one query without mixing families or versions", async () => {
    const first = candidateRow();
    const second = candidateRow(importId, "Second tutoriel");
    first.candidate.status = "approved"; second.candidate.status = "approved";
    first.candidate.materializedVersionId = importId; second.candidate.materializedVersionId = candidateId;
    state.paginate.mockResolvedValue({ rows: [first, second], total: 2, page: 1, pageSize: 20 });
    state.approvedRevisions.mockResolvedValue([
      { familyId: first.candidate.familyId, projectionVersionId: importId, revision: { ...first.revision, revision: 2, document: { ...first.revision.document, objective: "Première connaissance corrigée" } } },
      { familyId: second.candidate.familyId, projectionVersionId: candidateId, revision: { ...second.revision, revision: 3, document: { ...second.revision.document, objective: "Deuxième connaissance corrigée" } } },
      { familyId: importId, projectionVersionId: importId, revision: { ...first.revision, document: { ...first.revision.document, objective: "Mauvaise famille" } } },
      { familyId: candidateId, projectionVersionId: candidateId, revision: { ...first.revision, document: { ...first.revision.document, objective: "Mauvaise version" } } },
    ]);
    const html = await pageHtml();
    expect(state.approvedRevisions).toHaveBeenCalledTimes(1);
    expect(html).toContain("Première connaissance corrigée"); expect(html).toContain("Deuxième connaissance corrigée");
    expect(html).not.toContain("Mauvaise famille"); expect(html).not.toContain("Mauvaise version");
  });

  it("never presents the original document as approved when its materialized revision is missing", async () => {
    const row = candidateRow(); row.candidate.status = "approved"; row.candidate.materializedVersionId = importId;
    state.paginate.mockResolvedValue({ rows: [row], total: 1, page: 1, pageSize: 20 });
    const html = await pageHtml();
    expect(html).toContain("La révision validée n’est plus accessible ici.");
    expect(html).not.toContain(row.revision.document.objective);
  });

  it("keeps the source document before approval and does not fetch materialized revisions", async () => {
    const row = candidateRow(); row.candidate.materializedVersionId = importId;
    state.paginate.mockResolvedValue({ rows: [row], total: 1, page: 1, pageSize: 20 });
    expect(await pageHtml()).toContain(row.revision.document.objective);
    expect(state.approvedRevisions).not.toHaveBeenCalled();
  });

  it("shows all source outcomes and links directly to a candidate beyond the current page", async () => {
    const batch = batchFixture();
    state.imports.mockResolvedValue([batch]);
    state.batch.mockResolvedValue(batch);
    const html = await pageHtml({ batch: importId, status: "pending", source: "onboarding" });
    expect(html).toContain("1 / 3 sources préparées · 1 en attente · 1 en erreur.");
    expect(html).toContain("Tutoriel first"); expect(html).toContain("Tutoriel failed"); expect(html).toContain("Tutoriel waiting");
    expect(html).toContain("En erreur — reprise nécessaire"); expect(html).toContain("En attente de traitement");
    expect(html).toContain(`batch=${importId}&amp;candidate=${candidateId}#candidate-${candidateId}`);
  });

  it("reads and opens the selected candidate despite the current page and status filter", async () => {
    const selected = candidateRow();
    state.paginate.mockResolvedValue({ rows: [candidateRow(importId, "Autre candidat")], total: 123, page: 3, pageSize: 20 });
    state.select.mockResolvedValue([selected]);
    const html = await pageHtml({ page: "3", status: "approved", source: "hubspot", candidate: candidateId });
    expect(state.select).toHaveBeenCalledWith(1);
    expect(html).toContain(`<article id="candidate-${candidateId}"`);
    expect(html).toContain('<details class="learning-preview" open=""><summary>Lire la connaissance et ses limites</summary>');
    expect(html).not.toContain("<h2>Autre candidat</h2>");
    expect(html).toContain("indépendamment des filtres");
    expect(html).toContain("page=3&amp;status=approved&amp;source=hubspot");
    expect(html).not.toContain('aria-label="Pagination des connaissances"');
  });

  it("does not query a malformed candidate id or pretend to show another candidate", async () => {
    state.paginate.mockResolvedValue({ rows: [candidateRow()], total: 1, page: 1, pageSize: 20 });
    const html = await pageHtml({ candidate: "invalid" });
    expect(state.select).not.toHaveBeenCalled();
    expect(html).toContain("Cette connaissance n’est plus accessible.");
    expect(html).not.toContain(`<article id="candidate-${candidateId}"`);
  });

  it("checks staff access before reading a selected candidate or the catalogue", async () => {
    state.auth.mockRejectedValue(new Error("SAV_ACCESS_FORBIDDEN"));
    await expect(pageHtml({ candidate: candidateId })).rejects.toThrow("SAV_ACCESS_FORBIDDEN");
    expect(state.select).not.toHaveBeenCalled(); expect(state.paginate).not.toHaveBeenCalled();
  });
});
