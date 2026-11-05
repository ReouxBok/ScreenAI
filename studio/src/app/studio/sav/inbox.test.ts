// SSR without JSX; .test.ts is the repository's discovered test convention.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, Fragment, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const dependencies = vi.hoisted(() => ({ cutover: vi.fn(), dashboard: vi.fn(), pending: false, incidents: vi.fn(), actions: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/sav/cutover", () => ({ getSavV0Cutover: dependencies.cutover }));
// Only the read-only reader exists here: importing the repairing one would fail the render (UX-Q6, option A).
vi.mock("@/lib/sav/dashboard", () => ({ listSavDossierDashboardReadOnly: async (options: unknown) => {
  const data = await dependencies.dashboard(options); return dependencies.pending ? { pending: true } : { pending: false, data };
} }));
vi.mock("./projection-progress", () => ({ SavProjectionProgress: () => createElement("section", { "data-testid": "projection-progress" }, "La liste se met à jour.") }));
vi.mock("@/lib/sav/service", () => ({ listSavWebhookIncidents: dependencies.incidents, listSavActionIncidents: dependencies.actions }));
vi.mock("./actions", () => ({ retryWebhookAction: vi.fn() }));
vi.mock("./open-email-actions", () => ({ openSavEmailAction: dependencies.open }));
vi.mock("next/link", () => ({ useLinkStatus: () => ({ pending: false }), default: (props: ComponentProps<"a">) => createElement("a", props) }));
import { SavV0Inbox } from "./inbox";
const threadId = "10000000-0000-4000-8000-000000000001";
const messageId = "10000000-0000-4000-8000-000000000002";
const row = { threadId, messageId, fromEmail: "fiction@example.invalid", receivedAt: new Date("2026-10-02T12:01:00Z"), summary: { title: "Retrouver mes factures", problem: "Le client cherche où trouver sa facture.", nextAction: "Ouvrir et qualifier", sourceLabel: "Objet de l’email", additionalRequests: 0 }, opening: "unopened", state: "to_process", reviewStatus: null, draftStatus: "À relire", replyStatus: "Aucun envoi", partnershipStatus: null, ticketProgress: "required", learning: "none", ticket: null, crmStatus: "unknown", nextAction: "Ouvrir et qualifier la demande", incident: false, technical: false };
const result = { rows: [row], counts: { to_process: 1, to_validate: 0, learning: 0, completed: 0, other: 0, technical: 0, incidents: 0 }, otherConfigurationStatus: "not_configured", page: 1, pageSize: 25, total: 1, totalPages: 1, view: "to_process" };
beforeEach(() => { vi.clearAllMocks(); dependencies.pending = false; dependencies.cutover.mockResolvedValue(null); dependencies.incidents.mockResolvedValue([]); dependencies.actions.mockResolvedValue([]); dependencies.dashboard.mockResolvedValue(result); });
const render = async (search: { view?: string; q?: string; page?: string; sort?: string } = {}) => renderToStaticMarkup(createElement(Fragment, null, await SavV0Inbox({ searchParams: Promise.resolve(search) })));
describe("SAV-55 compact dashboard", () => {
  it("labels external completion without claiming dossier or draft approval", async () => {
    dependencies.dashboard.mockResolvedValue({ ...result, view: "completed", rows: [{ ...row, state: "completed", handledExternally: true, nextAction: "Traité hors Studio" }] });
    const html = await render({ view: "completed" });
    expect(html).toContain("Traité hors Studio"); expect(html).toContain("Classement administratif");
    expect(html).not.toContain("Dossier validé"); expect(html).not.toContain("Dossier à valider");
    expect(html).toContain("Brouillon : À relire"); expect(dependencies.open).not.toHaveBeenCalled();
  });
  // SAV-60: opening a V0 dossier is a plain read (no POST, no Gmail filing, no opening record).
  it("opens the dossier with a plain link, without action on render or prefetch", async () => {
    const html = await render();
    expect(html).toContain('aria-label="Ouvrir le dossier : Retrouver mes factures"');
    expect(html).toContain(`href="/studio/sav/${threadId}?returnTo=`); expect(html).toContain(`%23dossier-${threadId}`);
    expect(html).not.toMatch(/<form[^>]*>\s*<input type="hidden" name="threadId"/); expect(html).not.toContain(`name="messageId" value="${messageId}"`);
    expect(dependencies.open).not.toHaveBeenCalled();
  });
  it("uses the four views and a compact problem/action without diagnostics in the list", async () => {
    const html = await render();
    for (const label of ["À traiter", "À valider", "Suivi HubSpot", "Terminés", "Le client cherche où trouver sa facture.", "Ouvrir et qualifier la demande"]) expect(html).toContain(label);
    expect(html).not.toContain("SAV_AI_");
  });
  it("keeps search, sorting and pagination server-side and preserves the selected context", async () => {
    dependencies.dashboard.mockResolvedValue({ ...result, page: 2, totalPages: 3, view: "to_validate" });
    const html = await render({ view: "to_validate", q: "facture", page: "2", sort: "oldest" });
    expect(dependencies.dashboard).toHaveBeenCalledWith({ view: "to_validate", query: "facture", page: 2, sort: "oldest" });
    expect(html).toContain('action="/studio/sav"'); expect(html).toContain("view%3Dto_validate%26q%3Dfacture%26page%3D2%26sort%3Doldest");
    expect(html).toContain("Page 2 sur 3"); expect(dependencies.open).not.toHaveBeenCalled();
  });
  it("shows a search empty state without claiming a successful zero on load errors", async () => {
    dependencies.dashboard.mockResolvedValue({ ...result, rows: [], total: 0 });
    expect(await render({ q: "absent" })).toContain("Aucun dossier ne correspond à cette recherche");
    dependencies.dashboard.mockRejectedValue(new Error("fixture"));
    const failed = await render(); expect(failed).toContain("Les dossiers ne sont pas disponibles"); expect(failed).not.toContain("Aucune nouvelle demande");
  });
  it.each(["approved", "rejected", null])("keeps the %s human verdict visible while an incident remains separate", async reviewStatus => {
    dependencies.dashboard.mockResolvedValue({ ...result, rows: [{ ...row, reviewStatus, incident: true, draftStatus: "Refusé" }] });
    const html = await render();
    expect(html).toContain(reviewStatus === "approved" ? "Dossier validé" : reviewStatus === "rejected" ? "Dossier à corriger" : "Dossier à valider");
    expect(html).toContain("Vérification nécessaire"); expect(html).toContain("Brouillon : Refusé"); expect(dependencies.open).not.toHaveBeenCalled();
  });
  it.each(["partial", "error", "unknown"])("does not describe %s CRM data as no ticket", async crmStatus => {
    dependencies.dashboard.mockResolvedValue({ ...result, rows: [{ ...row, crmStatus }] });
    const html = await render(); expect(html).not.toContain("Aucun ticket lié"); expect(html).not.toContain("Aucun ticket nécessaire");
  });
  it.each(["pending", "uncertain", "failed", "succeeded"])("preserves the SAV-53 %s partnership transfer independently", async partnershipStatus => {
    dependencies.dashboard.mockResolvedValue({ ...result, rows: [{ ...row, partnershipStatus }] });
    const html = await render(); expect(html).toContain(partnershipStatus === "succeeded" ? "Transféré à Nathan" : "Transfert à Nathan");
    expect(html).toContain("Brouillon : À relire");
  });
  it("keeps incidents and exclusions accessible without adding them to primary counts", async () => {
    const html = await render(); expect(html).toContain("Incidents"); expect(html).toContain("Exclusions (0)");
    expect(dependencies.incidents).not.toHaveBeenCalled();
    dependencies.dashboard.mockResolvedValue({ ...result, view: "incidents" });
    await render({ view: "incidents" }); expect(dependencies.incidents).toHaveBeenCalledWith(20);
  });
});


describe("Autre observation inbox", () => {
  it("shows an additive candidate with a direct dossier link and preserved return context", async () => {
    dependencies.dashboard.mockResolvedValue({ ...result, view: "other", otherConfigurationStatus: "configured", counts: { ...result.counts, other: 1 }, rows: [{ ...row, otherObservation: { family: "vistaprint_promotions", label: "Promotions Vistaprint", ruleVersion: "sav-other-observation-v1" } }] });
    const html = await render({ view: "other", q: "fixture", sort: "oldest" });
    expect(html).toContain("Autre — observation"); expect(html).toContain("Ces candidats restent visibles dans leur vue habituelle");
    expect(html).toContain("Promotions Vistaprint"); expect(html).toContain("Également dans À traiter");
    expect(html).toContain(`/studio/sav/${threadId}?returnTo=`); expect(html).toContain("view%3Dother"); expect(html).toContain("sort%3Doldest");
    expect(html).not.toContain('name="messageId"'); expect(html).not.toContain('name="threadId"');
    expect(html).toContain("Examiner le candidat"); expect(dependencies.open).not.toHaveBeenCalled();
  });
  it.each(["invalid", "not_configured"])("explains the %s configuration instead of claiming verified zero noise", async otherConfigurationStatus => {
    dependencies.dashboard.mockResolvedValue({ ...result, view: "other", otherConfigurationStatus, rows: [], total: 0 });
    const html = await render({ view: "other" });
    expect(html).toContain("Aucun candidat dans Autre"); expect(html).toContain("Aucun candidat n’est présenté comme confirmé");
    expect(html).toContain("Continuez à consulter les vues habituelles"); expect(dependencies.open).not.toHaveBeenCalled();
  });
});

describe("SAV-60 / UX-Q6 option A: opening the old list writes nothing", () => {
  it("shows the existing progress card when the projection is stale, without rows, counts or other reads", async () => {
    dependencies.pending = true;
    const html = await render({ view: "to_validate", q: "facture", page: "2", sort: "oldest" });
    expect(dependencies.dashboard).toHaveBeenCalledWith({ view: "to_validate", query: "facture", page: 2, sort: "oldest" });
    expect(html).toContain('data-testid="projection-progress"'); expect(html).toContain("Piloter les demandes");
    expect(html).not.toContain("Retrouver mes factures"); expect(html).not.toContain("Les dossiers ne sont pas disponibles");
    expect(dependencies.cutover).not.toHaveBeenCalled(); expect(dependencies.incidents).not.toHaveBeenCalled(); expect(dependencies.actions).not.toHaveBeenCalled();
  });
  it("uses only the read-only reader in the page source", () => {
    const source = readFileSync(path.join(__dirname, "inbox.tsx"), "utf8");
    expect(source).toContain("listSavDossierDashboardReadOnly(");
    expect(source).not.toMatch(/listSavDossierDashboard(Sql)?\(/); expect(source).not.toContain("dashboard-projection");
  });
});
