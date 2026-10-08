import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ detail: vi.fn(), review: vi.fn(), action: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/sav/auth", () => ({ requireSavStaff: dependencies.auth }));
vi.mock("@/lib/sav/service", () => ({ getSavThreadDetail: dependencies.detail }));
vi.mock("@/lib/sav/review", () => ({ getSavProposalReview: dependencies.review }));
vi.mock("@/lib/sav/cutover", () => ({ isSavMessageEligible: async () => true }));
vi.mock("@/lib/sav/thread-context", () => ({ getSavRelatedThreads: async () => [] }));
vi.mock("@/lib/sav/drafts", () => ({ getSavReplyDrafts: async () => ({ versions: [], knowledgeRevision: null }) }));
vi.mock("./mail-conversation", () => ({ MailConversation: () => null }));
vi.mock("./proposal-review", () => ({ ProposalReview: () => null }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("../actions", () => Object.fromEntries([
  "approveDraftAction", "correctDecisionAction", "createTicketAction", "linkTicketAction", "reconcileTicketAction", "requestHumanAction", "retryAction", "retryAnalysisAction", "reviewPilotItemAction", "refreshSavContextAction", "repairSavProposalAction",
].map((name) => [name, dependencies.action])));
import SavThreadPage from "./page";

const threadId = "10000000-0000-4000-8000-000000000001";
const reviewId = "10000000-0000-4000-8000-000000000002";
const action = { id: "10000000-0000-4000-8000-000000000003", kind: "create_ticket", actorType: "human", actorEmail: "fixture@example.invalid", status: "pending", errorCode: null, scheduledAt: null, payload: {}, createdAt: new Date("2026-10-08T13:00:00Z") };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false"); vi.stubEnv("HUBSPOT_PORTAL_ID", "143641967");
  dependencies.detail.mockResolvedValue({ thread: { id: threadId, subject: "Fixture", customerEmail: "fixture@example.invalid", status: "human_requested", aiPaused: true, hubspotTicketId: null },
    messages: [{ id: "fixture-message", direction: "inbound", body: {}, subject: "Fixture", fromEmail: "fixture@example.invalid" }], decisions: [], actions: [], agentRuns: [], pilotItem: null });
  dependencies.review.mockResolvedValue({ review: { id: reviewId, status: "approved" }, proposal: { routing: { kind: "new", contactId: "21" }, decision: { kind: "ticket_pending", explanation: "Fixture", confidence: 800 } } });
});
afterEach(() => vi.unstubAllEnvs());
async function render(overrides = {}, review = "") {
  const detail = await dependencies.detail(); dependencies.detail.mockResolvedValue({ ...detail, ...overrides });
  const page = await SavThreadPage({ params: Promise.resolve({ id: threadId }), searchParams: Promise.resolve({ review }) });
  const html = renderToStaticMarkup(page);
  expect(dependencies.auth).toHaveBeenCalledWith("admin");
  expect(dependencies.action).not.toHaveBeenCalled();
  return html;
}
describe("manual ticket controls in the dossier", () => {
  it("binds the human creation to the exact current review", async () => {
    expect(await render()).toContain(`name="reviewId" value="${reviewId}"`);
  });
  it("shows pending progress and disables a second creation", async () => {
    const html = await render({ actions: [action] });
    expect(html).toContain('disabled="">Demande HubSpot en attente');
    expect(html).toContain("en attente de confirmation"); expect(html).not.toContain('name="reviewId"');
  });
  it("does not treat an AI suggestion as a queued human creation", async () => {
    const html = await render({ actions: [{ ...action, actorType: "ai" }] });
    expect(html).toContain(`name="reviewId" value="${reviewId}"`);
    expect(html).not.toContain("Suivi de la demande HubSpot");
  });
  it("shows a confirmed ticket ID and usable link after persistence", async () => {
    const detail = await dependencies.detail();
    const html = await render({ thread: { ...detail.thread, hubspotTicketId: "301" }, actions: [{ ...action, status: "succeeded", payload: { hubspotTicketId: "301" } }] });
    expect(html).toContain('href="https://app.hubspot.com/contacts/143641967/ticket/301"');
    expect(html).toContain("Ticket #301"); expect(html).not.toContain("en attente de confirmation");
  });
  it("explains failed contact verification and keeps its creation unconfirmed", async () => {
    const html = await render({ actions: [{ ...action, status: "failed", errorCode: "SAV_HUBSPOT_CONTACT_REQUIRED" }] });
    expect(html).toContain("Aucun contact HubSpot confirmé"); expect(html).toContain("Aucun ticket lié");
  });
  it("offers reconciliation for a failed dispatch even before its error classification", async () => {
    const html = await render({ actions: [{ ...action, status: "failed", payload: { ticketCreateDispatchedAt: "fixture" } }] });
    expect(html).toContain("Vérifier et rapprocher ce ticket existant");
    expect(html).not.toContain('name="reviewId"'); expect(html).not.toContain(">Réessayer<");
  });
  it("does not offer reconciliation during an active dispatch", async () => {
    const html = await render({ actions: [{ ...action, status: "running", payload: { ticketCreateDispatchedAt: "fixture" } }] });
    expect(html).toContain("Ne relancez pas la création"); expect(html).not.toContain("Vérifier et rapprocher ce ticket existant");
  });
  it("explains an enqueue rejection in French", async () => {
    expect(await render({}, "SAV_VALIDATED_CURRENT_PROPOSAL_REQUIRED")).toContain("Validez la proposition courante");
  });
  it("requires a current approval before showing the creation form", async () => {
    dependencies.review.mockResolvedValue(null);
    const html = await render(); expect(html).toContain("Validez d’abord la proposition courante"); expect(html).not.toContain('name="reviewId"');
  });
});
