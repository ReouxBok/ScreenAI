import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ staff: vi.fn(), detail: vi.fn(), drafts: vi.fn(), inbox: vi.fn(), cutover: vi.fn() }));
vi.mock("@/lib/sav/auth", () => ({ requireSavStaff: mocks.staff }));
vi.mock("@/lib/sav/service", () => ({ getSavThreadDetail: mocks.detail, listSavInbox: mocks.inbox }));
vi.mock("@/lib/sav/drafts", () => ({ getSavReplyDrafts: mocks.drafts }));
vi.mock("@/lib/sav/cutover", () => ({ getSavV0Cutover: mocks.cutover }));
vi.mock("@/db", () => ({ isDatabaseConfigured: () => true }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); }, usePathname: () => "/studio/sav/archives/x", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ back: vi.fn() }) }));
import ArchivesPage from "./page";
import ArchiveDossierPage from "./[id]/page";
import ArchivesLoading from "./loading";
import ArchivesError from "./error";

// Synthetic fixtures only: no real customer, mail or CRM data.
const id = "10000000-0000-4000-8000-0000000000a1", at = new Date("2026-10-14T16:16:00.000Z");
const detail = {
  thread: { id, subject: "Exemple : facture introuvable", customerEmail: "client@example.test", status: "human_requested", lastMessageAt: at, hubspotTicketId: "T-1" },
  messages: [{ id: "m1", direction: "inbound", fromEmail: "client@example.test", subject: "Exemple", receivedAt: at, body: { text: "Bonjour, je ne trouve pas ma facture." } }],
  decisions: [{ id: "d1", kind: "ticket_pending", explanation: "Demande de facture.", confidence: 72, isCurrent: true, actorType: "ai", actorEmail: null, createdAt: at }],
  actions: [
    { id: "a1", kind: "send_reply", status: "pending", errorCode: null, actorEmail: null, createdAt: at, executedAt: null, draftText: null, noteText: null },
    { id: "a2", kind: "draft_reply", status: "succeeded", errorCode: null, actorEmail: null, createdAt: at, executedAt: at, draftText: "Brouillon IA synthétique", noteText: null },
  ],
};
const drafts = { knowledgeRevision: null, versions: [{ id: "v2", revision: 2, status: "draft", createdAt: at, createdBy: "operateur@example.test", text: "Réponse humaine synthétique", origin: "human", isCurrent: true }] };
const render = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await ArchiveDossierPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) }));
beforeEach(() => { vi.clearAllMocks(); mocks.staff.mockResolvedValue({ email: "contact@example.test", role: "member" }); mocks.detail.mockResolvedValue(detail); mocks.drafts.mockResolvedValue(drafts);
  // The archive list is established only within the active V0 cutover (synthetic boundary).
  mocks.cutover.mockResolvedValue({ receivedAfter: "2026-01-01T00:00:00.000Z", mailboxEmail: "sav@example.com", intakeRecipient: "contact@limova.ai", deploymentSha: "0".repeat(40), activatedBy: "operateur@example.test" }); });

it("dossier: everything stored is readable, and nothing can be posted", async () => {
  const html = await render();
  for (const text of ["Exemple : facture introuvable", "Lecture seule", "Bonjour, je ne trouve pas ma facture.", "Ticket à proposer", "Dernière décision", "Envoyer la réponse", "En attente",
    "n’est pas confirmé", "Brouillon IA synthétique", "Réponse humaine synthétique", "Écrit par un humain", "ne marque aucun email comme lu", `href="/studio/sav/archives#archive-${id}"`]) expect(html).toContain(text);
  expect(html).not.toMatch(/<form|<button|<textarea|<input/);
  expect(mocks.detail).toHaveBeenCalledWith(id); expect(mocks.drafts).toHaveBeenCalledWith(id);
});

it("dossier: the refusal notice appears only for the server's exact code", async () => {
  expect(await render({ notice: "SAV_LEGACY_COMMAND_RETIRED", kind: "reply" })).toContain("Aucune réponse n’a été envoyée.");
  expect(await render({ notice: "SAV_LEGACY_COMMAND_RETIRED", kind: "ticket" })).toContain("Aucun ticket n’a été créé ni modifié.");
  for (const notice of ["SAV_V0_COMMAND_RETIRED", "<script>"]) expect(await render({ notice })).not.toContain("n’existe plus");
});

it("dossier: same guard as the old pages runs first; unknown or malformed id is a 404 without any read", async () => {
  mocks.staff.mockRejectedValueOnce(Error("NEXT_REDIRECT"));
  await expect(render()).rejects.toThrow("NEXT_REDIRECT");
  expect(mocks.detail).not.toHaveBeenCalled();
  await expect(ArchiveDossierPage({ params: Promise.resolve({ id: "../x" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
  expect(mocks.detail).not.toHaveBeenCalled();
  mocks.detail.mockResolvedValueOnce(null);
  await expect(render()).rejects.toThrow("NOT_FOUND");
});

it("dossier: empty sections say so instead of inventing content", async () => {
  mocks.detail.mockResolvedValueOnce({ ...detail, messages: [], decisions: [], actions: [] }); mocks.drafts.mockResolvedValueOnce({ knowledgeRevision: null, versions: [] });
  const html = await render();
  for (const text of ["Aucun message enregistré", "Aucune décision enregistrée.", "Aucune action enregistrée.", "Aucun brouillon enregistré."]) expect(html).toContain(text);
});

it("list: read-only rows, search kept in the pages, next page only when a row exists beyond it", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({ threadId: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, subject: `Exemple ${i}`, fromEmail: "client@example.test", receivedAt: at, threadStatus: "resolved", decisionKind: "no_ticket_needed" }));
  mocks.inbox.mockResolvedValueOnce(rows);
  const html = renderToStaticMarkup(await ArchivesPage({ searchParams: Promise.resolve({ q: "facture", page: "2" }) }));
  expect(mocks.inbox).toHaveBeenCalledWith(51, { offset: 50, query: "facture" });
  expect(html.match(/href="\/studio\/sav\/archives\/10000000/g)).toHaveLength(50);
  for (const text of ["Résolu · Aucun ticket nécessaire", 'href="/studio/sav/archives?q=facture"', 'href="/studio/sav/archives?q=facture&amp;page=3"', "Page 2", 'role="search"']) expect(html).toContain(text);
  expect(html).not.toMatch(/method="post"|formAction|<button[^>]*name=/i);
  mocks.inbox.mockResolvedValueOnce([]);
  expect(renderToStaticMarkup(await ArchivesPage({ searchParams: Promise.resolve({ q: "zzz" }) }))).toContain("Aucun dossier archivé ne correspond");
  mocks.inbox.mockResolvedValueOnce([]);
  expect(renderToStaticMarkup(await ArchivesPage({ searchParams: Promise.resolve({ notice: "SAV_LEGACY_COMMAND_RETIRED" }) }))).toContain("Cette commande de l’ancien circuit n’existe plus.");
});

it("list: without an active cutover the list is unavailable, never empty; a refused role reads nothing; a failed read is the error state", async () => {
  mocks.cutover.mockResolvedValueOnce(null);
  const inactive = renderToStaticMarkup(await ArchivesPage({ searchParams: Promise.resolve({ q: "facture" }) }));
  for (const text of ["Archives non lisibles", "La frontière de l’ancien circuit n’est pas active", "Ce n’est pas une liste vide"]) expect(inactive).toContain(text);
  expect(inactive).not.toMatch(/Aucun dossier/); expect(mocks.inbox).not.toHaveBeenCalled();
  mocks.staff.mockRejectedValueOnce(Error("NEXT_REDIRECT"));
  await expect(ArchivesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT");
  expect(mocks.cutover).toHaveBeenCalledTimes(1); expect(mocks.inbox).not.toHaveBeenCalled();
  mocks.cutover.mockRejectedValueOnce(Error("connection refused"));
  await expect(ArchivesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("connection refused");
  mocks.inbox.mockRejectedValueOnce(Error("connection refused"));
  await expect(ArchivesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("connection refused");
});

it("archive code never imports a loader or component with an effect", () => {
  const files = ["page.tsx", "[id]/page.tsx", "archive-view.tsx"].map(file => readFileSync(path.join(__dirname, file), "utf8")).join("\n");
  for (const banned of ["dossier-opened", "open-email-actions", "../actions", "./actions", "listSavDossierDashboard", "dashboard-projection", "enqueue", "context-progress", "filing-progress", "use client", "translations"]) expect(files).not.toContain(banned);
});

it("states: loading shows no row, count or name; error says nothing was confirmed, offers retry and Retour", () => {
  const loading = renderToStaticMarkup(createElement(ArchivesLoading));
  expect(loading).toContain("Chargement des archives"); expect(loading).not.toMatch(/Exemple|<a |\d+ dossiers?/);
  const error = renderToStaticMarkup(createElement(ArchivesError, { reset: vi.fn() }));
  for (const text of ['role="alert"', "Réessayer", "Rien n’a été modifié", 'href="/studio/sav/archives"']) expect(error).toContain(text);
});

it("states: a stored agent pause is shown; direct arrival goes back to the list at the dossier's row", async () => {
  mocks.detail.mockResolvedValueOnce({ ...detail, thread: { ...detail.thread, aiPaused: true } });
  const html = await render();
  expect(html).toContain("agent mis en pause sur ce dossier");
  expect(html).toContain(`href="/studio/sav/archives#archive-${id}"`);
  expect(await render()).not.toContain("agent mis en pause");
});

it("keyboard: labelled search with a real submit, rows are links carrying their anchor, nothing taken out of the tab order", async () => {
  mocks.inbox.mockResolvedValueOnce([{ threadId: id, subject: "Exemple", fromEmail: "client@example.test", receivedAt: at, threadStatus: "resolved", decisionKind: null }]);
  const html = renderToStaticMarkup(await ArchivesPage({ searchParams: Promise.resolve({}) }));
  for (const text of ['aria-label="Rechercher dans les archives"', 'type="submit"', `href="/studio/sav/archives/${id}?returnTo=%2Fstudio%2Fsav%2Farchives%23archive-${id}" id="archive-${id}"`]) expect(html).toContain(text);
  expect(html).not.toMatch(/tabindex="-1"|<div[^>]*onclick/i);
});

it("return: the row link carries the list's search, page and row; the dossier only accepts the archive list as its way back", async () => {
  mocks.inbox.mockResolvedValueOnce([{ threadId: id, subject: "Exemple", fromEmail: "client@example.test", receivedAt: at, threadStatus: "resolved", decisionKind: null }]);
  const list = renderToStaticMarkup(await ArchivesPage({ searchParams: Promise.resolve({ q: "facture", page: "2" }) }));
  expect(list).toContain(`href="/studio/sav/archives/${id}?returnTo=%2Fstudio%2Fsav%2Farchives%3Fq%3Dfacture%26page%3D2%23archive-${id}"`);
  expect(await render({ returnTo: `/studio/sav/archives?q=facture&page=2#archive-${id}` })).toContain(`href="/studio/sav/archives?q=facture&amp;page=2#archive-${id}"`);
  for (const returnTo of ["/studio/sav", "/studio/admin", "//evil.example/studio/sav/archives", "https://evil.example/studio/sav/archives", "/studio/sav/archives/../../admin"]) {
    const html = await render({ returnTo });
    expect(html).toContain(`href="/studio/sav/archives#archive-${id}"`); expect(html).not.toContain("evil"); expect(html).not.toContain("admin");
  }
});
