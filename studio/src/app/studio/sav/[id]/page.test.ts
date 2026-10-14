import { createElement, Fragment, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { getSavThreadDetail } from "@/lib/sav/service";
import type { getSavProposalReview } from "@/lib/sav/review";
import type { SavStructuredProposal } from "@/lib/sav/proposal";

const dependencies = vi.hoisted(() => ({
  observations: vi.fn().mockResolvedValue([]), eligible: vi.fn().mockResolvedValue(true), auth: vi.fn(), detail: vi.fn(), review: vi.fn(), related: vi.fn(), stage: vi.fn(), notFound: vi.fn(), drafts: vi.fn(),
  actions: {
    refreshSavContextAction: vi.fn(), repairSavProposalAction: vi.fn(),
    approveDraftAction: vi.fn(), correctDecisionAction: vi.fn(), createTicketAction: vi.fn(),
    linkTicketAction: vi.fn(), reconcileTicketAction: vi.fn(), requestHumanAction: vi.fn(),
    retryAction: vi.fn(), retryAnalysisAction: vi.fn(), reviewPilotItemAction: vi.fn(), qualifyObservationAction: vi.fn(), reviewDraftAction: vi.fn(), reviewProposalAction: vi.fn(), saveReplyDraftAction: vi.fn(), sendStudioReplyAction: vi.fn(),
  },
}));
vi.mock("@/lib/sav/partnership-forward", () => ({ getSavPartnershipTransferState: async () => ({ available: false, status: "unavailable" }), isSavPartnershipForward: (action: { payload: { purpose?: string } }) => action.payload.purpose === "partnership_forward" }));
vi.mock("../dossier-opened", () => ({ SavDossierOpened: () => null, SavDossierBackLink: () => createElement("a", { href: "/studio/sav" }, "Retour aux dossiers") }));
vi.mock("../partnership-transfer", () => ({ PartnershipTransfer: () => null }));
vi.mock("@/lib/sav/cutover", () => ({ isSavMessageEligible: dependencies.eligible }));
vi.mock("@/lib/sav/auth", () => ({ requireSavStaff: dependencies.auth }));
vi.mock("@/lib/sav/service", () => ({ getSavThreadDetail: dependencies.detail }));
vi.mock("@/lib/sav/review", () => ({ getSavProposalReview: dependencies.review }));
vi.mock("@/lib/sav/observations", () => ({getSavObservations:dependencies.observations}));
vi.mock("@/lib/sav/drafts", () => ({ getSavReplyDrafts: dependencies.drafts }));
vi.mock("@/lib/sav/thread-context", () => ({ getSavRelatedThreads: dependencies.related }));
vi.mock("@/lib/sav/config", () => ({ savReleaseStage: dependencies.stage, savAutomationMode: () => "assist" }));
vi.mock("next/navigation", () => ({ notFound: dependencies.notFound, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("../ticket-preview-actions", () => ({ prepareTicketPreviewAction: vi.fn(), confirmTicketPreviewAction: vi.fn() }));
vi.mock("../actions", () => dependencies.actions);

import SavThreadPage from "./page";

type ThreadDetail = NonNullable<Awaited<ReturnType<typeof getSavThreadDetail>>>;
type ProposalReviewData = NonNullable<Awaited<ReturnType<typeof getSavProposalReview>>>;
type Action = ThreadDetail["actions"][number];
const now = new Date("2026-10-02T12:00:00Z");
const threadId = "10000000-0000-4000-8000-000000000001";
const messageId = "10000000-0000-4000-8000-000000000002";
const decisionId = "10000000-0000-4000-8000-000000000003";
const runId = "10000000-0000-4000-8000-000000000004";
const reviewId = "10000000-0000-4000-8000-000000000005";

function detailFixture(): ThreadDetail {
  return {
    thread: { id: threadId, mailboxId: "mailbox", gmailThreadId: "gmail-thread", hubspotTicketId: null,
      subject: "Retrouver mes factures", customerEmail: "client@example.invalid", status: "new", aiPaused: false,
      humanRequestedAt: null, humanDueAt: null, lastMessageAt: now, resolvedAt: null, createdAt: now, updatedAt: now },
    messages: [{ id: messageId, mailboxId: "mailbox", threadId, gmailMessageId: "gmail-message", hubspotEmailId: null,
      direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["contact@limova.ai"], subject: "Retrouver mes factures",
      preview: "EMAIL_CLIENT_TEST", bodyCiphertext: undefined, body: { text: "EMAIL_CLIENT_TEST" }, receivedAt: now,
      studioOpenedAt: null, studioOpeningTracked: true, processedAt: now, analysisStatus: "done", analysisAttempts: 1, analysisStartedAt: null, analysisErrorCode: null, createdAt: now }],
    decisions: [{ id: decisionId, agentRunId: runId, messageId, kind: "ticket_pending", reasonCode: "new_customer_support_request",
      explanation: "DECISION_IA_ORIGINALE", confidence: 900, evidence: [], model: "fixture", actorType: "ai", actorEmail: null,
      supersedesDecisionId: null, isCurrent: true, createdAt: now }],
    actions: [], agentRuns: [], pilotItem: null,
  };
}

function proposalFixture(): SavStructuredProposal {
  return { schemaVersion: 1, category: "how_to", urgency: "normal",
    decision: { kind: "ticket_pending", reasonCode: "new_customer_support_request", explanation: "DECISION_IA_ORIGINALE", confidence: 900 },
    routing: { kind: "new", reason: "no_open_ticket", contactId: "456" },
    ticket: { title: "Retrouver mes factures", description: "EMAIL_CLIENT_TEST" },
    process: [{ kind: "product_step", label: "Ouvrir les paramètres puis la facturation.", sourceIds: [] }],
    internalNote: "Note interne fictive", replyDraft: "BROUILLON_STUDIO_TEST", sources: [],
    knowledgeRevision: "not_consulted", model: "fixture", identityCandidates: [],
    customerIdentity: { registrationEmail: null, verifiedByHuman: false },
  };
}

function reviewFixture(approved = false): ProposalReviewData {
  const proposal = proposalFixture();
  return { decisionId, agentRunId: runId, model: "fixture", promptRevision: "fixture-prompt", before: structuredClone(proposal), proposal,
    expectedReviewId: approved?reviewId:null, draftHash:"x".repeat(43), draftVerdict:null,historicalReview:null,
    review: approved ? { scope:"dossier", id: reviewId, status: "approved", verdict: "correct",
      dimensions: { classification: "correct", routing: "correct", grounding: "correct", tone: "correct", escalation: "correct" },
      reviewedBy: "ugo@limova.ai", reviewedAt: now, reasons: [], comment: "Process vérifié par un humain.", reusability: "none" } : null,
  };
}

/** Test-only partial action DTO: the page reads only these fields, not worker payloads. */
function actionFixture(overrides: Partial<Action> = {}): Action {
  return { id: "action-fixture", threadId, kind: "create_ticket", status: "failed", payload: {}, errorCode: null,
    actorType: "human", actorEmail: "ugo@limova.ai", createdAt: now, draftText: null, noteText: null, ...overrides } as Action;
}

async function renderPage() {
  // Await this isolated server function explicitly; this is an SSR unit test, not an RSC/E2E runtime.
  const element = await SavThreadPage({ params: Promise.resolve({ id: threadId }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(createElement(Fragment, null, element));
}

function aside(html: string) {
  const content = html.match(/<aside\b[^>]*>([\s\S]*?)<\/aside>/)?.[1];
  expect(content).toBeDefined();
  return content!;
}

function sectionWithHeading(html: string, heading: string) {
  const headingAt = html.indexOf(`<h2>${heading}</h2>`);
  expect(headingAt).toBeGreaterThanOrEqual(0);
  return html.slice(html.lastIndexOf("<section", headingAt), html.indexOf("</section>", headingAt) + "</section>".length);
}

function selectOptions(html: string, name: string) {
  const select = html.match(new RegExp(`<select\\b[^>]*name="${name}"[^>]*>([\\s\\S]*?)<\\/select>`))?.[1];
  expect(select).toBeDefined();
  return [...select!.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map((match) => [match[1], match[2]]);
}

function buttonAttributes(html: string, label: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter((match) => match[2] === label || match[2].startsWith(`<span>${label}</span>`)).map((match) => match[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SAV_WRITES_DISABLED", "true");
  vi.stubEnv("HUBSPOT_PORTAL_ID", "143641967");
  dependencies.auth.mockResolvedValue({ email: "ugo@limova.ai", role: "admin" });
  dependencies.detail.mockResolvedValue(detailFixture());
  dependencies.review.mockResolvedValue(reviewFixture());
  dependencies.related.mockResolvedValue([]);
  dependencies.drafts.mockResolvedValue({ knowledgeRevision: null, versions: [] });
  dependencies.stage.mockReturnValue("v0");
  dependencies.notFound.mockImplementation(() => { throw new Error("NOT_FOUND"); });
});
afterEach(() => vi.unstubAllEnvs());

describe("SAV dossier SSR and human-review guardrails", () => {
  it("shows the contact and associated tickets without any proposal", async () => {
    const detail = detailFixture();
    detail.messages[0].body.supportContext = { version: 1, messageId, collectedAt: now.toISOString(),
      customerIdentity: { kind: "sender", email: "client@example.invalid" },
      crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId: "42", identityCandidates: [],
        tickets: [{ id: "99", subject: "Une autre question", description: "", status: "open", pipelineId: "0", stageId: "1", createdAt: null, updatedAt: null }], routing: { kind: "new", reason: "distinct_issue", candidateIds: [] } } },
      conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
    dependencies.detail.mockResolvedValue(detail); dependencies.review.mockResolvedValue(null);
    const html = await renderPage();
    expect(html).toContain("Ouvrir la fiche #42"); expect(html).toContain("Une autre question · #99");
    expect(html).toContain("Reconstituer la proposition manquante");
    expect(html).not.toContain("Les anciens emails ne sont pas retraités");
  });
  it("does not turn a CRM outage into a missing contact", async () => {
    const detail = detailFixture();
    detail.messages[0].body.supportContext = { version: 1, messageId, collectedAt: now.toISOString(),
      customerIdentity: { kind: "sender", email: "client@example.invalid" },
      crm: { status: "error", errorCode: "SAV_HUBSPOT_CONTACT_UNAVAILABLE", data: null },
      conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
    dependencies.detail.mockResolvedValue(detail); dependencies.review.mockResolvedValue(null);
    expect(await renderPage()).toContain("Recherche HubSpot indisponible");
  });
  it("authorizes the SAV user before reading the dossier or related customer context", async () => {
    await renderPage();
    expect(dependencies.auth).toHaveBeenCalledWith("admin");
    const authorizedAt = dependencies.auth.mock.invocationCallOrder[0];
    for (const reader of [dependencies.detail, dependencies.review, dependencies.related]) {
      expect(reader.mock.invocationCallOrder[0]).toBeGreaterThan(authorizedAt);
    }
    expect(dependencies.related).toHaveBeenCalledWith(threadId);
    expect(dependencies.review).toHaveBeenCalledWith(messageId);
  });

  it("does not read any customer data if SAV authorization rejects", async () => {
    dependencies.auth.mockRejectedValueOnce(new Error("SAV_ACCESS_DENIED"));
    await expect(renderPage()).rejects.toThrow("SAV_ACCESS_DENIED");
    expect(dependencies.detail).not.toHaveBeenCalled();
    expect(dependencies.review).not.toHaveBeenCalled();
    expect(dependencies.related).not.toHaveBeenCalled();
  });

  it("shows the client mail before the proposal, puts external-action CTAs in the aside and offers a context jump", async () => {
    dependencies.review.mockResolvedValue(reviewFixture(true));
    const html = await renderPage();
    expect(html.indexOf("EMAIL_CLIENT_TEST")).toBeLessThan(html.indexOf('id="proposal-review-title"'));
    expect(html.indexOf("Dernier email reçu")).toBeLessThan(html.indexOf("Proposition de l’IA"));
    expect(aside(html)).toContain("Ouvrir un nouveau ticket");
    expect(html.slice(0, html.indexOf("<aside"))).not.toContain("Ouvrir un nouveau ticket");
    expect(html).toContain('href="#sav-client-context"');
    expect(html).toContain('<aside id="sav-client-context" tabindex="-1"');
    expect(html).toContain("Aucun email envoyé, aucun ticket créé, aucune connaissance publiée par ce bouton.");
    expect(html).not.toContain("Approuver et mettre en file d’envoi");
    for (const action of Object.values(dependencies.actions)) expect(action).not.toHaveBeenCalled();
  });

  it("uses French select labels while preserving every backend option value and proof identifier", async () => {
    const html = await renderPage();
    expect(selectOptions(html, "category")).toEqual([
      ["technical", "Problème technique"], ["account", "Compte et accès"], ["billing", "Facturation"],
      ["integration", "Intégration"], ["how_to", "Utilisation du produit"], ["acknowledgement", "Remerciement ou confirmation"], ["other", "Autre"],
    ]);
    expect(selectOptions(html, "urgency")).toEqual([["low", "Faible"], ["normal", "Normale"], ["high", "Élevée"], ["critical", "Critique"]]);
    expect(selectOptions(html, "decisionKind")).toEqual([
      ["ticket_pending", "Ticket à proposer"], ["no_ticket_needed", "Aucun ticket nécessaire"], ["human_review_required", "Revue humaine requise"],
      ["spam", "Courrier indésirable"], ["internal_notification", "Notification interne"], ["automatic_reply", "Réponse automatique"],
      ["bounce", "Échec de distribution"], ["duplicate", "Doublon"],
    ]);
    const verdicts = [["correct", "Correct"], ["partial", "Partiel"], ["incorrect", "Incorrect"], ["critical", "Critique"]];
    for (const name of ["verdict", "dimension_classification", "dimension_routing", "dimension_grounding", "dimension_tone", "dimension_escalation"]) {
      expect(selectOptions(html, name)).toEqual(verdicts);
    }
    expect(selectOptions(html, "reusability").map(([value]) => value)).toEqual(["none", "tone_only", "customer_specific", "reusable"]);
    expect(html).toContain(`name="decisionId" value="${decisionId}"`);
    expect(html).toContain(`name="agentRunId" value="${runId}"`);
    expect(html).toContain('name="processKind_0" value="product_step"');
    expect(buttonAttributes(html, "Valider le dossier / process")).toHaveLength(1);
    expect(buttonAttributes(html, "Refuser le process")).toHaveLength(0);
  });

  it("shows the clean sections, a read-only draft and a separate disabled preview-send CTA", async () => {
    const html = await renderPage();
    const titles = ["Résumé du sujet", "Action proposée", "Connaissances utilisées", "Valider le dossier / process", "Verdict du brouillon"];
    for (let index = 1; index < titles.length; index++) expect(html.indexOf(titles[index])).toBeGreaterThan(html.indexOf(titles[index - 1]));
    expect(html).not.toMatch(/<textarea[^>]*name="replyDraft"/);
    expect(html).not.toMatch(/<textarea[^>]*name="text"/);
    expect(buttonAttributes(html, "Envoyer la réponse acceptée")).toEqual([expect.stringContaining('disabled=""')]);
    expect(html).toContain("validée séparément par Ugo");
    expect(html).toContain("Non assigné");
    expect(html).not.toContain("Sources et preuves");
  });

  it("allows sending independently of process approval when the server enables manual writes", async () => {
    vi.stubEnv("SAV_WRITES_DISABLED", "false");
    dependencies.review.mockResolvedValue({...reviewFixture(),draftVerdict:{id:"verdict",status:"accepted",draftId:"accepted-draft",stale:false,reason:"",reviewedBy:"ugo@limova.ai"}});
    const html = await renderPage();
    expect(buttonAttributes(html, "Envoyer la réponse acceptée")[0]).not.toContain("disabled");
    expect(html).toContain("Confirme l’envoi dans le fil Gmail d’origine.");
  });
  it("allows manual V0 send on a human-owned dossier, not an automatic resumption", async () => {
    vi.stubEnv("SAV_WRITES_DISABLED", "false");
    const detail = detailFixture();
    detail.thread.aiPaused = true; detail.thread.status = "human_requested";
    dependencies.detail.mockResolvedValue(detail);
    dependencies.review.mockResolvedValue({...reviewFixture(),draftVerdict:{id:"verdict",status:"accepted",draftId:"accepted-draft",stale:false,reason:"",reviewedBy:"ugo@limova.ai"}});
    const html = await renderPage();
    expect(buttonAttributes(html, "Envoyer la réponse acceptée")[0]).not.toContain("disabled");
    expect(html).not.toContain("Envoi désactivé dans cette prévisualisation");
    expect(buttonAttributes(html, "Transférer à un humain")).toHaveLength(0);
  });
  it("explains the real environment lock rather than claiming this is a preview", async () => {
    const html = await renderPage();
    expect(html).toContain("Les envois sont désactivés dans cet environnement");
    expect(buttonAttributes(html, "Envoyer la réponse acceptée")[0]).toContain("disabled");
  });

  it("lists only knowledge actually supporting the response/process, not every retrieved search result", async () => {
    const review = reviewFixture();
    review.proposal.sources = [{ sourceType: "knowledge", sourceId: "used", title: "Parcours Factures", claim: "Les factures sont dans la facturation" }, { sourceType: "knowledge", sourceId: "retrieved", title: "Résultat non utilisé" }];
    dependencies.review.mockResolvedValue(review);
    const html = await renderPage();
    expect(html).toContain("Parcours Factures");
    expect(html).not.toContain("Résultat non utilisé");
  });

  it.each(["succeeded", "pending", "running", "failed"] as const)("blocks a duplicate manual send in state %s", async (status) => {
    vi.stubEnv("SAV_WRITES_DISABLED", "false");
    const detail = detailFixture();
    detail.actions = [actionFixture({ kind: "send_reply", messageId, status, payload: { manualReplyConfirmed: true, ...(status === "failed" ? { replySendDispatchedAt: now.toISOString() } : {}) } })];
    dependencies.detail.mockResolvedValue(detail);
    expect(buttonAttributes(await renderPage(), "Envoyer la réponse acceptée")[0]).toContain("disabled");
  });

  it.each(["succeeded", "pending", "failed"] as const)("keeps internal partnership transfer %s separate from customer replies", async status => {
    vi.stubEnv("SAV_WRITES_DISABLED", "false");
    const detail = detailFixture();
    dependencies.review.mockResolvedValue({...reviewFixture(),draftVerdict:{id:"verdict",status:"accepted",draftId:"accepted-draft",stale:false,reason:"",reviewedBy:"ugo@limova.ai"}});
    detail.actions = [actionFixture({ kind: "send_reply", messageId, status, payload: { purpose: "partnership_forward", manualReplyConfirmed: true, forwardDispatchedAt: now.toISOString() } })];
    dependencies.detail.mockResolvedValue(detail);
    const html = await renderPage();
    expect(buttonAttributes(html, "Envoyer la réponse acceptée")[0]).not.toContain("disabled");
    expect(html).toContain("Transfert partenariat à Nathan");
    expect(buttonAttributes(html, "Réessayer")).toHaveLength(0);
  });

  it("shows the reviewed correction in the decision rail instead of the original AI decision", async () => {
    const reviewed = reviewFixture(true);
    reviewed.proposal.decision = { ...reviewed.proposal.decision, kind: "no_ticket_needed", explanation: "DECISION_CORRIGEE_PAR_HUMAIN" };
    dependencies.review.mockResolvedValue(reviewed);
    const rail = aside(await renderPage());
    expect(rail).toContain("Décision du process revu");
    expect(rail).toContain("Aucun ticket nécessaire");
    expect(rail).toContain("DECISION_CORRIGEE_PAR_HUMAIN");
    expect(rail).not.toContain("DECISION_IA_ORIGINALE");
  });

  it("keeps a proposed matching ticket distinct from a ticket actually linked to the dossier", async () => {
    const review = reviewFixture();
    review.proposal.routing = { kind: "matched", reason: "exact_subject", contactId: "456", ticketId: "789" };
    dependencies.review.mockResolvedValue(review);
    const ticketCard = sectionWithHeading(aside(await renderPage()), "Ticket réellement lié");
    expect(ticketCard).toContain("Aucun ticket lié à ce dossier.");
    expect(ticketCard).toContain("Correspondance proposée");
    expect(ticketCard).toContain("Rattachement manuel à confirmer");
    expect(ticketCard).toContain("/ticket/789");
    expect(ticketCard).not.toContain("Ticket #789");
  });

  it("shows the actual linked ticket and no extra create-ticket CTA", async () => {
    const detail = detailFixture();
    detail.thread.hubspotTicketId = "987";
    dependencies.detail.mockResolvedValue(detail);
    dependencies.review.mockResolvedValue(reviewFixture(true));
    const html = await renderPage();
    const ticketCard = sectionWithHeading(aside(html), "Ticket réellement lié");
    expect(ticketCard).toContain("Ticket #987");
    expect(ticketCard).not.toContain("Correspondance proposée");
    expect(buttonAttributes(html, "Ouvrir un nouveau ticket")).toEqual([]);
  });

  it("does not present unconfirmed name/phone candidates as a linked HubSpot contact", async () => {
    const review = reviewFixture();
    review.proposal.routing = { kind: "review", reason: "customer_identity_unverified", candidateIds: [] };
    review.proposal.identityCandidates = [{ contactId: "654", name: "Camille Test", email: "compte@example.invalid", phoneHint: "•••1234", matchedBy: "phone", confirmed: false }];
    dependencies.review.mockResolvedValue(review);
    const html = await renderPage();
    const contactCard = sectionWithHeading(aside(html), "Fiche HubSpot liée");
    expect(html).toContain("Camille Test");
    expect(html).toContain("correspondance par téléphone, à vérifier humainement");
    expect(contactCard).toContain("ne sont pas encore une fiche liée");
    expect(contactCard).not.toContain("/contact/654");
    expect(html).not.toContain("Ouvrir la fiche #654");
    expect(html).toContain("Aucun contact ne sera créé.");
  });

  it.each([
    ["unknown dispatched result", { payload: { ticketCreateDispatchedAt: now.toISOString() } }],
    ["explicit reconciliation error", { errorCode: "SAV_MANUAL_RECONCILIATION_REQUIRED" }],
  ] as const)("disables ticket creation for an uncertain create action (%s)", async (_name, overrides) => {
    const detail = detailFixture();
    detail.actions = [actionFixture(overrides)];
    dependencies.detail.mockResolvedValue(detail);
    dependencies.review.mockResolvedValue(reviewFixture(true));
    const html = await renderPage();
    expect(buttonAttributes(aside(html), "Préparer l’aperçu de l’action")).toEqual([expect.stringContaining('disabled=""')]);
    expect(html).toContain("Résultat HubSpot incertain");
    expect(html).not.toContain("Confirmer le rattachement");
  });

  it.each(["pending", "running"] as const)("does not offer duplicate creation or linking while the request is %s", async (status) => {
    const detail = detailFixture();
    detail.actions = [actionFixture({ status })];
    dependencies.detail.mockResolvedValue(detail);
    dependencies.review.mockResolvedValue(reviewFixture(true));
    const html = await renderPage();
    expect(buttonAttributes(aside(html), "Préparer l’aperçu de l’action")).toEqual([expect.stringContaining('disabled=""')]);
    expect(html).toContain("Demande HubSpot en attente de confirmation");
    expect(buttonAttributes(html, "Ouvrir un nouveau ticket")).toEqual([]);
    expect(html).not.toContain("Confirmer le rattachement");
  });
  it.each(["create_ticket", "link_ticket"] as const)("does not mistake an AI %s suggestion for a pending human request in V0", async (kind) => {
    const detail = detailFixture();
    detail.actions = [actionFixture({ kind, actorType: "ai", actorEmail: null, status: "pending" })];
    dependencies.detail.mockResolvedValue(detail);
    dependencies.review.mockResolvedValue(reviewFixture(true));
    const html = await renderPage();
    expect(buttonAttributes(html, "Demande HubSpot en attente")).toHaveLength(0);
    expect(html).not.toContain("Demande HubSpot en attente de confirmation");
    expect(buttonAttributes(html, "Préparer l’aperçu de l’action")).toHaveLength(1);
    expect(html).toContain("Le contexte HubSpot est indisponible ou incomplet");
    dependencies.review.mockResolvedValue(reviewFixture(false));
    const unreviewed = await renderPage();
    expect(buttonAttributes(unreviewed, "Préparer l’aperçu de l’action")[0]).toContain("disabled");
    expect(unreviewed).toContain("Validez d’abord le dossier / process");
  });

  it("keeps historical mail readable without a new proposal-review or send CTA", async () => {
    dependencies.eligible.mockResolvedValueOnce(false);
    const detail = detailFixture();
    detail.messages[0].receivedAt = new Date("2026-10-01T12:00:00Z");
    detail.decisions = [];
    dependencies.detail.mockResolvedValue(detail);
    dependencies.review.mockResolvedValue(null);
    const html = await renderPage();
    expect(html).toContain("EMAIL_CLIENT_TEST");
    expect(html).toContain("Les anciens emails ne sont pas retraités");
    expect(html).not.toContain("Valider le dossier / process");
    expect(html).not.toContain("Refuser le process");
    expect(html).not.toContain("Approuver et mettre en file d’envoi");
    expect(buttonAttributes(html, "Préparer l’aperçu de l’action")).toEqual([expect.stringContaining('disabled=""')]);
  });
});

it.each(["2026-01-02T12:00:00Z", null, "invalid"])("shows the real ticket creation date or an explicit missing date (%s)", async (createdAt) => {
  const detail = detailFixture(); detail.thread.hubspotTicketId = "99";
  detail.messages[0].body.supportContext = { version: 1, messageId, collectedAt: now.toISOString(),
    customerIdentity: { kind: "sender", email: "client@example.invalid" },
    crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId: "42", identityCandidates: [],
      tickets: [{ id: "99", subject: "Question", description: "", status: "open", pipelineId: "0", stageId: "1", createdAt, updatedAt: now.toISOString() }],
      routing: { kind: "new", reason: "distinct_issue", candidateIds: [] } } },
    conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
  dependencies.detail.mockResolvedValue(detail);
  const html = sectionWithHeading(await renderPage(), "Ticket réellement lié");
  expect(html).toContain(createdAt && createdAt !== "invalid" ? "02/01/2026 13:00" : "Date indisponible");
  expect(html).not.toContain("02/10/2026");
});

it.each(["1", "2", "3"])("uses the saved semantic match for the generic-subject return CTA at stage %s", async stageId => {
  const detail = detailFixture();
  detail.messages[0].subject = "Re: Suite à votre demande - Urgent";
  detail.messages[0].body.supportContext = { version: 1, messageId, collectedAt: now.toISOString(), customerIdentity: { kind: "sender", email: "client@example.invalid" },
    crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId: "42", identityCandidates: [],
      tickets: [{ id: "401", subject: "Incident du téléphone IA", description: "L'agent ne fonctionne plus", status: "open", pipelineId: "0", stageId, ownerId: "71", createdAt: null, updatedAt: null }],
      routing: { kind: "matched", ticketId: "401", reason: "semantic_same_issue", returnOperation: stageId === "1" ? "keep" : "reactivate" } } },
    conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
  dependencies.detail.mockResolvedValue(detail); dependencies.review.mockResolvedValue(reviewFixture(true));
  const html = await renderPage();
  expect(html).toContain('type="radio"');
  expect(html).toMatch(/checked="" value="401"/);
  expect(buttonAttributes(html, "Préparer l’aperçu de l’action")[0]).not.toContain("disabled");
  expect(html).not.toContain("Confirmation explicite");
  expect(aside(html)).not.toContain("Créer un ticket HubSpot");
});

it("shows the original customer and the same forwarded return CTA as the backend", async () => {
  const detail = detailFixture();
  detail.thread.customerEmail = "colleague@limova.ai";
  detail.thread.subject = "À traiter pour Alice";
  Object.assign(detail.messages[0], { fromEmail: "colleague@limova.ai", subject: detail.thread.subject });
  detail.messages[0].body.text = "---------- Forwarded message ---------\nFrom: Alice <alice@example.com>\nSubject: Connexion impossible\n\nConnexion impossible.";
  detail.messages[0].body.supportContext = { version: 1, messageId, collectedAt: now.toISOString(), customerIdentity: { kind: "forwarded", email: "alice@example.com" },
    crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId: "42", identityCandidates: [],
      tickets: [{ id: "401", subject: "Connexion impossible", description: "", status: "open", pipelineId: "0", stageId: "2", ownerId: "71", createdAt: null, updatedAt: null }],
      routing: { kind: "matched", ticketId: "401", reason: "exact_subject", returnOperation: "reactivate" } } },
    conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
  dependencies.detail.mockResolvedValue(detail); dependencies.review.mockResolvedValue(reviewFixture(true));
  const html = await renderPage();
  expect(html).toContain("<h1>Connexion impossible</h1>");
  expect(html).toContain("<strong>alice@example.com</strong>");
  expect(html).toContain("Transféré par colleague@limova.ai");
  expect(html).toContain("Une réponse Gmail restera adressée à ce collègue");
  expect(html).toContain("Fiche reconnue pour le client transféré alice@example.com");
  expect(html).not.toContain("Fiche reconnue pour l’expéditeur colleague@limova.ai");
  expect(html).toMatch(/checked="" value="401"/);
  expect(html).toContain("Préparer l’aperçu de l’action");
  expect(dependencies.related).not.toHaveBeenCalled();
  expect(detail.messages[0].fromEmail).toBe("colleague@limova.ai");
});

it("does not offer to reopen a matching ticket after a reviewed no-ticket correction", async () => {
  const detail = detailFixture();
  detail.messages[0].body.supportContext = { version: 1, messageId, collectedAt: now.toISOString(), customerIdentity: { kind: "sender", email: detail.messages[0].fromEmail },
    crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId: "42", identityCandidates: [],
      tickets: [{ id: "401", subject: detail.messages[0].subject, description: "", status: "open", pipelineId: "0", stageId: "2", ownerId: "71", createdAt: null, updatedAt: null }],
      routing: { kind: "matched", ticketId: "401", reason: "exact_subject", returnOperation: "reactivate" } } },
    conversation: null, conversationError: null, otherConversations: [], otherConversationsError: null };
  const review = reviewFixture(true); review.proposal.decision.kind = "no_ticket_needed";
  dependencies.detail.mockResolvedValue(detail); dependencies.review.mockResolvedValue(review);
  const html = await renderPage();
  expect(buttonAttributes(html, "Repasser en Nouveau")).toHaveLength(0);
  expect(html).not.toContain('name="returnOperation"');
  expect(html).toContain("La décision validée ne demande aucune action sur un ticket.");
});

it.each([false, true])("does not expose the colleague's old CRM/history for a forward (ambiguous=%s)", async ambiguous => {
  const detail = detailFixture();
  detail.thread.customerEmail = "colleague@limova.ai";
  detail.messages[0].fromEmail = "colleague@limova.ai";
  detail.messages[0].body.text = `---------- Forwarded message ---------\nFrom: alice@example.com\n${ambiguous ? "From: bob@example.com\n" : ""}Subject: Connexion impossible\n\nDemande`;
  detail.messages[0].body.supportContext = { version: 1, messageId, collectedAt: now.toISOString(), customerIdentity: { kind: "sender", email: "colleague@limova.ai" },
    crm: { status: "ready", errorCode: null, data: { errorCode: null, contactFound: true, contactId: "999", identityCandidates: [], tickets: [], routing: { kind: "new", reason: "no_candidates", candidateIds: [] } } },
    conversation: null, conversationError: null, otherConversations: [{ id: "private-history", subject: "HISTORIQUE_COLLEGUE", relation: "Même expéditeur", messages: [] }], otherConversationsError: null };
  dependencies.detail.mockResolvedValue(detail); dependencies.review.mockResolvedValue(reviewFixture(true));
  const html = await renderPage();
  expect(html).toContain("Identité du client transféré à vérifier");
  expect(html).toContain("Actualiser le contexte client");
  expect(html).not.toContain("Ouvrir la fiche #999");
  expect(html).not.toContain("HISTORIQUE_COLLEGUE");
  expect(buttonAttributes(html, "Préparer l’aperçu de l’action")).toEqual([expect.stringContaining('disabled=""')]);
  expect(dependencies.related).not.toHaveBeenCalled();
});
