import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const actions = vi.hoisted(() => ({ prepare: vi.fn(), confirm: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../ticket-preview-actions", () => ({ prepareTicketPreviewAction: actions.prepare, confirmTicketPreviewAction: actions.confirm }));
import { TicketSelector } from "./ticket-selector";
const props = { threadId: "thread", reviewId: "review", linkedTicketId: "1", suggestedTicketId: "2", newTicketTitle: "Nouvelle question", crmReady: true, completed: false, pending: false,
  tickets: [{ id: "1", subject: "Demande ancienne", status: "closed" as const, createdAt: "2026-10-01T12:00:00Z", stageId: "4", ownerId: "11", ownerName: "Nora Dupont" }, { id: "2", subject: "Demande récente", status: "open" as const, createdAt: "2026-10-14T12:00:00Z", stageId: "2", ownerId: "12", ownerName: "Alex Support" }] };
it("shows titles/status/date/owner with recent tickets first and separates actual from suggested", () => {
  const html = renderToStaticMarkup(createElement(TicketSelector, props));
  expect(html).toContain("Ticket réellement lié : Demande ancienne"); expect(html).toContain("Correspondance proposée : Demande récente");
  const choices = html.slice(html.indexOf("<fieldset"));
  expect(choices.indexOf("Demande récente")).toBeLessThan(choices.indexOf("Demande ancienne"));
  expect(html).toContain("En attente du client"); expect(html).toContain("Propriétaire : Alex Support"); expect(html).toContain("14/10/2026");
  expect(html).not.toContain("#1"); expect(html).not.toContain("#2"); expect(html).not.toContain("#12");
  expect(html).not.toContain('name="ticketId"'); expect(html).not.toContain("Confirmation explicite");
  expect(actions.prepare).not.toHaveBeenCalled(); expect(actions.confirm).not.toHaveBeenCalled();
});
it.each([{ pending: true }, { blockedReason: "Résultat incertain" }, { reviewId: null }, { crmReady: false }])("blocks preparing an action for state %s", state => {
  const html = renderToStaticMarkup(createElement(TicketSelector, { ...props, ...state }));
  expect(html).toContain('<fieldset disabled="">');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Préparer l’aperçu de l’action/);
});
it("distinguishes empty CRM from unavailable context", () => {
  const ready = renderToStaticMarkup(createElement(TicketSelector, { ...props, linkedTicketId: null, tickets: [] }));
  const error = renderToStaticMarkup(createElement(TicketSelector, { ...props, linkedTicketId: null, tickets: [], crmReady: false }));
  expect(ready).toContain("Aucun ticket retrouvé"); expect(error).toContain("indisponible ou incomplet"); expect(error).not.toContain("Aucun ticket retrouvé");
});
