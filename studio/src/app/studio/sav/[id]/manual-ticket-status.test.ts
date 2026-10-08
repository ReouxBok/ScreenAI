import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManualTicketStatus } from "./manual-ticket-status";

const action = { kind: "create_ticket", status: "pending", errorCode: null, scheduledAt: null, payload: {} };
function render(overrides = {}, writesDisabled = false) {
  return renderToStaticMarkup(createElement(ManualTicketStatus, { action: { ...action, ...overrides }, writesDisabled }));
}
describe("manual ticket progress", () => {
  it.each(["pending", "running"])("never displays %s as confirmed creation", (status) => {
    const html = render({ status });
    expect(html).toContain("en attente de confirmation");
    expect(html).toContain("Aucun ticket créé ou rattaché n’est encore confirmé");
    expect(html).toContain('role="status"');
  });
  it("explains a blocked environment without suggesting an immediate retry", () => {
    const html = render({}, true);
    expect(html).toContain("écritures HubSpot sont désactivées");
    expect(html).not.toContain("Prochaine tentative");
  });
  it("displays a scheduled transient retry", () => {
    const html = render({ errorCode: "HUBSPOT_HTTP_429", scheduledAt: new Date("2026-10-08T13:00:00Z") });
    expect(html).toContain("limite temporairement"); expect(html).toContain("Prochaine tentative prévue");
  });
  it.each([
    ["SAV_PROPOSAL_STALE", "proposition validée a changé"],
    ["SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED", "Validez la proposition courante"],
    ["SAV_HUBSPOT_CONTACT_REQUIRED", "Aucun contact HubSpot confirmé"],
    ["SAV_EXISTING_TICKET_REQUIRES_LINK", "rattachement à un ticket existant"],
    ["SAV_DISTINCT_ISSUE_CONFIRMATION_REQUIRED", "problème distinct"],
    ["SAV_LINK_TARGET_INVALID", "corrigez l’ID du ticket"],
    ["SAV_GMAIL_THREAD_CHANGED", "Actualisez le contexte du dossier"],
    ["SAV_GMAIL_PREFLIGHT_INCOMPLETE", "Vérifiez la synchronisation"],
    ["HUBSPOT_HTTP_403:MISSING_SCOPES", "droits de l’intégration"],
  ])("offers a French recovery for %s", (errorCode, expected) => {
    const html = render({ status: "failed", errorCode });
    expect(html).toContain(expected); expect(html).not.toContain(errorCode);
  });
  it.each(["pending", "running", "failed"])("preserves uncertain creation over the %s label", (status) => {
    const html = render({ status, payload: { ticketCreateDispatchedAt: "fixture" } }, true);
    expect(html).toContain("Création à vérifier"); expect(html).toContain("Ne relancez pas la création");
    expect(html).not.toContain("Prochaine tentative");
  });
  it("does not display arbitrary provider text or private payloads", () => {
    const html = render({ status: "failed", errorCode: "private@example.invalid provider text", payload: { text: "secret fixture" } });
    expect(html).toContain("journal d’actions"); expect(html).not.toContain("private@example.invalid"); expect(html).not.toContain("secret fixture");
  });
  it("does not leave an error notice once the ticket has succeeded", () => {
    expect(render({ status: "succeeded", errorCode: "old-error", payload: { hubspotTicketId: "301" } })).toBe("");
    expect(renderToStaticMarkup(createElement(ManualTicketStatus, { action: null, writesDisabled: false }))).toBe("");
  });
});
