import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ detail: vi.fn(), review: vi.fn(), action: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/sav/auth", () => ({ requireSavStaff: dependencies.auth }));
vi.mock("@/lib/sav/service", () => ({ getSavThreadDetail: dependencies.detail }));
vi.mock("@/lib/sav/external-completion", () => ({ getSavExternalCompletion: async () => null }));
vi.mock("@/lib/sav/observations", () => ({ getSavObservations: async () => [] }));
vi.mock("./draft-review", () => ({ DraftReview: () => null }));
vi.mock("@/lib/sav/review", () => ({ getSavProposalReview: dependencies.review }));
vi.mock("@/lib/sav/partnership-forward", () => ({ getSavPartnershipTransferState: async () => ({ available: false, status: "unavailable" }), isSavPartnershipForward: (action: { payload: { purpose?: string } }) => action.payload.purpose === "partnership_forward" }));
vi.mock("../partnership-transfer", () => ({ PartnershipTransfer: () => null }));
vi.mock("@/lib/sav/cutover", () => ({ isSavMessageEligible: async () => true }));
vi.mock("@/lib/sav/thread-context", () => ({ getSavRelatedThreads: async () => [] }));
vi.mock("@/lib/sav/drafts", () => ({ getSavReplyDrafts: async () => ({ versions: [], knowledgeRevision: null }) }));
vi.mock("./mail-conversation", () => ({ MailConversation: () => null }));
vi.mock("./proposal-review", () => ({ ProposalReview: () => null, IdentityCheck: () => null, IdentityCandidates: () => null }));
vi.mock("./findings-summary", () => ({ FindingsSummary: () => null, UsedKnowledge: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("../ticket-preview-actions", () => ({ prepareTicketPreviewAction: vi.fn(), confirmTicketPreviewAction: vi.fn() }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("../actions", () => Object.fromEntries([
  "approveDraftAction", "correctDecisionAction", "createTicketAction", "linkTicketAction", "reconcileTicketAction", "reconcileTicketReturnAction", "requestHumanAction", "retryAction", "retryAnalysisAction", "reviewPilotItemAction", "refreshSavContextAction", "repairSavProposalAction",
].map((name) => [name, dependencies.action])));
import SavThreadPage from "./page";

const threadId = "10000000-0000-4000-8000-000000000001";
const reviewId = "10000000-0000-4000-8000-000000000002";
const action = { id: "10000000-0000-4000-8000-000000000003", kind: "create_ticket", actorType: "human", actorEmail: "fixture@example.invalid", status: "pending", errorCode: null, scheduledAt: null, payload: {}, createdAt: new Date("2026-10-08T13:00:00Z") };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false"); vi.stubEnv("HUBSPOT_PORTAL_ID", "143641967");
  dependencies.auth.mockResolvedValue({ email: "ugo@limova.ai" });
  dependencies.detail.mockResolvedValue({ thread: { id: threadId, subject: "Fixture", customerEmail: "fixture@example.invalid", status: "human_requested", aiPaused: true, hubspotTicketId: null },
    messages: [{ id: "fixture-message", direction: "inbound", body: { text: "Fixture", supportContext: { version: 1, messageId: "fixture-message", collectedAt: "2026-10-14T12:00:00Z", customerIdentity: { kind: "sender", email: "fixture@example.invalid" }, crm: { status: "ready", data: { contactId: "21", tickets: [], routing: { kind: "new" } } }, otherConversations: [] } }, subject: "Fixture", fromEmail: "fixture@example.invalid" }], decisions: [], actions: [], agentRuns: [], pilotItem: null });
  dependencies.review.mockResolvedValue({ review: { id: reviewId, status: "approved" }, proposal: { ticket: { title: "Demande fictive" }, routing: { kind: "new", contactId: "21" }, decision: { kind: "ticket_pending", explanation: "Fixture", confidence: 800 } } });
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
  it.each([
    { status: "pending", payload: {}, errorCode: null, expected: "En cours" },
    { status: "running", payload: {}, errorCode: null, expected: "En cours" },
    { status: "failed", payload: { ticketReturnDispatchedAt: "fixture" }, errorCode: null, expected: "Résultat à vérifier" },
    { status: "pending", payload: { ticketReturnDispatchedAt: "fixture" }, errorCode: null, expected: "Résultat à vérifier" },
    { status: "failed", payload: {}, errorCode: "SAV_MANUAL_RECONCILIATION_REQUIRED", expected: "Résultat à vérifier" },
    { status: "succeeded", payload: { hubspotTicketId: "301", ticketReturnDispatchedAt: "fixture", ticketReturnCompletedAt: "fixture" }, errorCode: null, expected: "Ticket lié" },
  ])("shows $expected for a linked ticket with a $status action", async ({ expected, ...operation }) => {
    const detail = await dependencies.detail();
    const html = await render({ thread: { ...detail.thread, hubspotTicketId: "301" }, actions: [{ ...action, kind: "link_ticket", ...operation }] });
    const progress = html.match(/<li\b[^>]*>[\s\S]*?<strong>Action HubSpot<\/strong><small>([^<]+)<\/small>/)?.[1];
    expect(progress).toBe(expected);
  });
  it("binds the human creation to the exact current review", async () => {
    const html = await render(); expect(html).toContain("Préparer l’aperçu de l’action"); expect(html).not.toContain("Confirmation explicite");
  });
  it("shows pending progress and disables a second creation", async () => {
    const html = await render({ actions: [action] });
    expect(html).toContain("Demande HubSpot en attente de confirmation"); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Préparer l’aperçu de l’action/);
    expect(html).toContain("en attente de confirmation"); expect(html).not.toContain('name="reviewId"');
  });
  it("does not treat an AI suggestion as a queued human creation", async () => {
    const html = await render({ actions: [{ ...action, actorType: "ai" }] });
    expect(html).toMatch(/<button[^>]*>Préparer l’aperçu de l’action/);
    expect(html).not.toContain("Suivi de la demande HubSpot");
  });
  it("shows a confirmed ticket ID and usable link after persistence", async () => {
    const detail = await dependencies.detail();
    const html = await render({ thread: { ...detail.thread, hubspotTicketId: "301" }, actions: [{ ...action, status: "succeeded", payload: { hubspotTicketId: "301" } }] });
    expect(html).toContain('href="https://app.hubspot.com/contacts/143641967/ticket/301"');
    expect(html).toContain("Ouvrir le ticket HubSpot"); expect(html).not.toContain("#301"); expect(html).not.toContain("en attente de confirmation");
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
  it("keeps a validated no-ticket dossier from enabling human creation", async () => {
    dependencies.review.mockResolvedValue({ review: { id: reviewId, status: "approved" }, proposal: { ticket: { title: "Demande fictive" }, routing: { kind: "new", contactId: "21" }, decision: { kind: "no_ticket_needed", explanation: "Fixture", confidence: 800 } } });
    const html = await render(); expect(html).not.toContain('name="reviewId"'); expect(html).not.toContain("Créer le ticket HubSpot");
  });
  it("requires a current approval before showing the creation form", async () => {
    dependencies.review.mockResolvedValue(null);
    const html = await render(); expect(html).toContain("Validez d’abord le dossier / process"); expect(html).not.toContain('name="reviewId"');
  });
});

it("SAV49 displays a failed reopening even when its predecessor ticket is already linked", async () => {
  const detail = await dependencies.detail();
  const html = await render({ thread: { ...detail.thread, hubspotTicketId: "401" }, actions: [{ ...action, kind: "link_ticket", status: "failed", errorCode: "HUBSPOT_HTTP_403:MISSING_SCOPES" }] });
  expect(html).toContain("Suivi de la demande HubSpot");
  expect(html).toContain("HubSpot refuse l’accès");
  const progress = html.match(/<li\b[^>]*>[\s\S]*?<strong>Action HubSpot<\/strong><small>([^<]+)<\/small>/)?.[1];
  expect(progress).toBe("Action non aboutie");
});
it.each(["ticket_done", "ticket_queued", "ticket_processing_deferred"])("SAV49 %s cannot override the persisted failure after reload", async review => {
  const html = await render({ actions: [{ ...action, status: "failed", errorCode: "SAV_PROPOSAL_STALE" }] }, review);
  expect(html).not.toContain("Action ticket exécutée et confirmée par HubSpot");
  expect(html).not.toContain("le worker planifié la reprendra");
  expect(html).toContain("proposition validée a changé");
});

it("SAV49 acknowledges the known ID but requires reconciliation after remote context changes", async () => {
  const html = await render({ actions: [{ ...action, status: "failed", errorCode: "SAV_TICKET_ACK_CONTEXT_CHANGED", payload: { hubspotTicketId: "301", ticketCreateDispatchedAt: "fixture" } }] });
  expect(html).toContain("ticket déjà acquitté");
  expect(html).toContain("Vérifier et rapprocher ce ticket existant");
  expect(html).toContain('name="ticketId"'); expect(html).toContain('value="301"');
  expect(html).not.toContain(">Réessayer<");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Préparer l’aperçu de l’action/);
});
