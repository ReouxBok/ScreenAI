// SSR without JSX; .test.ts is the repository's discovered test convention.
import { createElement, Fragment, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const dependencies = vi.hoisted(() => ({ cutover: vi.fn(), inbox: vi.fn(), incidents: vi.fn(), actions: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/sav/cutover", () => ({ getSavV0Cutover: dependencies.cutover }));
vi.mock("@/lib/sav/service", () => ({ listSavInbox: dependencies.inbox, listSavWebhookIncidents: dependencies.incidents, listSavActionIncidents: dependencies.actions }));
vi.mock("./actions", () => ({ retryWebhookAction: vi.fn() }));
vi.mock("./open-email-actions", () => ({ openSavEmailAction: dependencies.open }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
import { SavV0Inbox } from "./inbox";
const threadId = "10000000-0000-4000-8000-000000000001";
const messageId = "10000000-0000-4000-8000-000000000002";
beforeEach(() => {
  vi.clearAllMocks(); dependencies.cutover.mockResolvedValue(null); dependencies.incidents.mockResolvedValue([]); dependencies.actions.mockResolvedValue([]);
  dependencies.inbox.mockResolvedValue([{ threadId, messageId, subject: "Retrouver mes factures", fromEmail: "fiction@example.invalid", receivedAt: new Date("2026-10-02T12:01:00Z"), preview: "Fixture", decisionKind: null, explanation: null, confidence: null, reviewId: null, reviewStatus: null, analysisStatus: "pending", analysisErrorCode: null, aiPaused: false, hubspotTicketId: null }]);
});
describe("SAV inbox explicit open forms", () => {
  it("renders an accessible POST form bound to the exact row, without running the action during render/prefetch", async () => {
    const element = await SavV0Inbox({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(createElement(Fragment, null, element));
    expect(html).toContain('aria-label="Ouvrir l’email : Retrouver mes factures"');
    expect(html).toContain(`name="threadId" value="${threadId}"`);
    expect(html).toContain(`name="messageId" value="${messageId}"`);
    expect(html).not.toContain(`href="/studio/sav/${threadId}"`);
    expect(dependencies.open).not.toHaveBeenCalled();
  });
  it("keeps search and tab navigation read-only and does not file anything on an empty inbox", async () => {
    dependencies.inbox.mockResolvedValue([]);
    const element = await SavV0Inbox({ searchParams: Promise.resolve({ view: "pending", q: "facture" }) });
    const html = renderToStaticMarkup(createElement(Fragment, null, element));
    expect(html).toContain('method="get"'); expect(html).toContain('href="/studio/sav?view=pending"');
    expect(html).toContain("Aucun email dans cette vue"); expect(dependencies.open).not.toHaveBeenCalled();
  });
});
