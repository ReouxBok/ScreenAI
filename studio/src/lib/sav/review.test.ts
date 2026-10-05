import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { activeKnowledge, savActions, savAgentRuns, savDecisions, savLearningCandidates, savMailboxes, savMessages, savProposalReviews, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import { getSavProposalReview, reviewSavProposal } from "./review";
import { queueSavManualTicket } from "./manual-tickets";
import { listSavInbox, retrySavAction } from "./service";
import { findSavContactCandidates, processPendingHubspotActions, reconcileSavManualTicket } from "./hubspot";
import { extractSavIdentityHints, phoneMatchesHint } from "./identity";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let threadId: string;
let messageId: string;
let decisionId: string;
let runId: string;
const proposal = savStructuredProposalSchema.parse({ schemaVersion: 1, category: "how_to", urgency: "normal", decision: { kind: "ticket_pending", reasonCode: "fixture_support", explanation: "Demande support fictive à vérifier", confidence: 800 }, routing: { kind: "new", reason: "fixture", contactId: "21" }, ticket: { title: "Retrouver les factures", description: "Comment retrouver mes factures ?" }, process: [{ kind: "human_review", label: "Relire la procédure proposée", sourceIds: [] }], internalNote: null, replyDraft: "Brouillon fictif", sources: [], knowledgeRevision: "not_consulted", model: "fixture" });
function reviewInput(reusability = "none") {
  return { messageId, decisionId, agentRunId: runId, expectedReviewId: null, status: "approved", verdict: "partial", dimensions: { classification: "correct", routing: "correct", grounding: "partial", tone: "correct", escalation: "correct" }, comment: "Revue fictive, corriger la procédure", reusability, reusableResolution: "Ouvrez Paramètres puis Facturation. Cas client@example.com, tél 0612345678.", justification: "Parcours générique vérifié, réutilisable pour retrouver les factures", correction: { category: proposal.category, urgency: proposal.urgency, decisionKind: proposal.decision.kind, reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, title: proposal.ticket.title, description: proposal.ticket.description, process: proposal.process, internalNote: "Note corrigée", replyDraft: "Brouillon corrigé, à relire" } };
}
function mockIntegrations(mode: "create" | "timeout" | "existing" | "unknown" | "different" = "create") {
  vi.stubEnv("GMAIL_CLIENT_ID", "test"); vi.stubEnv("GMAIL_CLIENT_SECRET", "test"); vi.stubEnv("GMAIL_REFRESH_TOKEN", "test");
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    if (url.includes("gmail.googleapis.com") && url.includes("threads/gmail-thread")) return Response.json({ messages: [{ id: "gmail-message", internalDate: String(Date.parse("2026-10-02T12:01:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "client@example.com" }] } }] });
    const stages = ["1", "2", "3", "4"].map((id) => ({ id, metadata: { isClosed: id === "4", ticketState: id === "4" ? "CLOSED" : "OPEN" } }));
    if (url.endsWith("/pipelines/tickets/0")) return Response.json({ id: "0", stages });
    if (url.endsWith("/pipelines/tickets")) return Response.json({ results: [{ id: "0", stages }] });
    if (url.endsWith("/contacts/search")) return Response.json({ results: mode === "unknown" ? [] : [{ id: "21", properties: { email: "client@example.com" } }] });
    if (url.endsWith("/tickets/search")) return Response.json({ results: ["existing", "different"].includes(mode) ? [{ id: "401", properties: { subject: mode === "different" ? "Intégration Slack impossible" : "Retrouver les factures", hs_pipeline: "0", hs_pipeline_stage: "1", hs_lastmodifieddate: new Date().toISOString() } }] : [] });
    if (url.endsWith("/objects/tickets") && init?.method === "POST") {
      if (mode === "timeout") throw new TypeError("Simulated ambiguous transport failure");
      return Response.json({ id: "301", properties: { subject: "Retrouver les factures", hs_pipeline: "0", hs_pipeline_stage: "1" } });
    }
    throw new Error("Unexpected network operation in isolated test");
  });
  vi.stubGlobal("fetch", network);
  return network;
}
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false"); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters"); vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "test-only");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "gmail-thread", subject: "Retrouver les factures", customerEmail: "client@example.com" }).returning(); threadId = thread.id;
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, gmailMessageId: "gmail-message", direction: "inbound", fromEmail: thread.customerEmail, subject: thread.subject, bodyCiphertext: encryptSavPayload({ text: proposal.ticket.description }), receivedAt: new Date("2026-10-02T12:01:00Z"), analysisStatus: "done" }).returning(); messageId = message.id;
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId, runtime: "rules", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture-v1", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal), completedAt: new Date() }).returning(); runId = run.id;
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId, agentRunId: runId, kind: "ticket_pending", reasonCode: "fixture", explanation: "Demande fictive", confidence: 800 }).returning(); decisionId = decision.id;
});
describe("SAV supervised reviews and manual tickets", () => {
  it("allows correcting a critical proposal without upgrading the original verdict", async () => {
    const review = await reviewSavProposal({ ...reviewInput(), verdict: "critical" }, "ugo@limova.ai");
    expect((await getSavProposalReview(messageId))?.review).toMatchObject({ id: review.id, status: "approved", verdict: "critical" });
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("rejects approval of an unchanged critical process, including a critical dimension", async () => {
    const unchanged = { ...reviewInput(), verdict: "correct", dimensions: { ...reviewInput().dimensions, grounding: "critical" }, correction: { ...reviewInput().correction, replyDraft: proposal.replyDraft } };
    await expect(reviewSavProposal(unchanged, "ugo@limova.ai")).rejects.toThrow("SAV_CRITICAL_PROPOSAL_CORRECTION_REQUIRED");
  });
  it("allows a different issue only with an explicit human justification and never overrides a matching ticket", async () => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    const input = { threadId, reviewId: review.id, kind: "create_ticket" };
    await queueSavManualTicket(input, "ugo@limova.ai");
    const network = mockIntegrations("different");
    expect((await processPendingHubspotActions()).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_DISTINCT_ISSUE_CONFIRMATION_REQUIRED" });
    const reason = "Le ticket existant concerne Slack, cette nouvelle demande concerne la facturation";
    const action = await queueSavManualTicket({ ...input, distinctIssueReason: reason }, "ugo@limova.ai");
    expect(JSON.stringify(action.payload)).not.toContain(reason);
    expect((await processPendingHubspotActions()).processed[0]).toMatchObject({ status: "succeeded", ticketId: "301" });
    expect(network.mock.calls.filter(([url, init]) => url.endsWith("/objects/tickets") && init?.method === "POST")).toHaveLength(1);
  });
  it.each(["none", "tone_only", "customer_specific"])("keeps %s as evaluation of the exact run, with encrypted before/after", async (reusability) => {
    await reviewSavProposal(reviewInput(reusability), "ugo@limova.ai");
    const [review] = await fixture.db.select().from(savProposalReviews);
    expect(review).toMatchObject({ agentRunId: runId, decisionId, verdict: "partial" });
    expect(review.afterCiphertext).not.toContain("corrigé");
    expect(decryptSavPayload(review.beforeCiphertext)).toEqual(proposal);
    expect((await getSavProposalReview(messageId))?.proposal.replyDraft).toBe("Brouillon corrigé, à relire");
    expect(await fixture.db.select().from(savLearningCandidates)).toHaveLength(0);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
    expect(await fixture.db.select().from(activeKnowledge)).toHaveLength(0);
  });
  it("requires explicit reusable qualification and redacts the pending knowledge candidate", async () => {
    await reviewSavProposal(reviewInput("reusable"), "ugo@limova.ai");
    const [candidate] = await fixture.db.select().from(savLearningCandidates);
    expect(candidate.status).toBe("pending");
    const patch = decryptSavPayload<{ agentRunId: string; finalHumanResolution: string }>(String(candidate.proposedPatch.ciphertext));
    expect(patch.agentRunId).toBe(runId);
    expect(patch.finalHumanResolution).not.toContain("client@example.com");
    expect(patch.finalHumanResolution).not.toContain("0612345678");
  });
  it("refuses a stale page and a proposal superseded by a newer inbound", async () => {
    await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    await expect(reviewSavProposal(reviewInput(), "ugo@limova.ai")).rejects.toThrow("SAV_REVIEW_STALE");
    const [message] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
    await fixture.db.insert(savMessages).values({ ...message, id: crypto.randomUUID(), gmailMessageId: "newer", receivedAt: new Date("2026-10-02T12:02:00Z") });
    await expect(reviewSavProposal({ ...reviewInput(), expectedReviewId: (await getSavProposalReview(messageId))!.review!.id }, "ugo@limova.ai")).rejects.toThrow("SAV_PROPOSAL_STALE");
  });
  it("serializes double clicks and keeps ticket creation separate from review", async () => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    const input = { threadId, reviewId: review.id, kind: "create_ticket" };
    const actions = await Promise.all([queueSavManualTicket(input, "ugo@limova.ai"), queueSavManualTicket(input, "ugo@limova.ai")]);
    expect(actions[0].id).toBe(actions[1].id);
    expect(await fixture.db.select().from(savActions)).toHaveLength(1);
  });
  it("creates exactly one remote ticket on double click and never creates a contact or sends mail", async () => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    const input = { threadId, reviewId: review.id, kind: "create_ticket" };
    await Promise.all([queueSavManualTicket(input, "ugo@limova.ai"), queueSavManualTicket(input, "ugo@limova.ai")]);
    const network = mockIntegrations();
    const result = await processPendingHubspotActions();
    expect(result.processed[0]).toMatchObject({ status: "succeeded", ticketId: "301" });
    await processPendingHubspotActions();
    const creations = network.mock.calls.filter(([url, init]) => url.endsWith("/objects/tickets") && init?.method === "POST");
    expect(creations).toHaveLength(1);
    expect(network.mock.calls.some(([url]) => /\/objects\/contacts$|\/send|\/objects\/emails/.test(url))).toBe(false);
    expect(JSON.parse(String(creations[0][1]?.body)).properties).toMatchObject({ content: proposal.ticket.description, hs_pipeline: "0", hs_pipeline_stage: "1" });
  });
  it("prevents a late duplicate and requires a separate explicit link", async () => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    await queueSavManualTicket({ threadId, reviewId: review.id, kind: "create_ticket" }, "ugo@limova.ai");
    const network = mockIntegrations("existing");
    const result = await processPendingHubspotActions();
    expect(result.processed[0]).toMatchObject({ errorCode: "SAV_EXISTING_TICKET_REQUIRES_LINK", status: "failed" });
    await queueSavManualTicket({ threadId, reviewId: review.id, kind: "link_ticket", ticketId: "401" }, "ugo@limova.ai");
    await processPendingHubspotActions();
    expect((await fixture.db.select().from(savThreads))[0].hubspotTicketId).toBe("401");
    expect(network.mock.calls.some(([url]) => url.endsWith("/objects/tickets"))).toBe(false);
  });
  it("preserves the dispatch marker and stops all retries after an ambiguous timeout", async () => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    const action = await queueSavManualTicket({ threadId, reviewId: review.id, kind: "create_ticket" }, "ugo@limova.ai");
    const network = mockIntegrations("timeout");
    const result = await processPendingHubspotActions();
    expect(result.processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_MANUAL_RECONCILIATION_REQUIRED" });
    await processPendingHubspotActions();
    await expect(retrySavAction(action.id, "ugo@limova.ai")).rejects.toThrow("SAV_MANUAL_RECONCILIATION_REQUIRED");
    expect(network.mock.calls.filter(([url]) => url.endsWith("/objects/tickets"))).toHaveLength(1);
  });
  it("blocks unknown-contact ticket creation instead of creating a CRM contact", async () => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    await queueSavManualTicket({ threadId, reviewId: review.id, kind: "create_ticket" }, "ugo@limova.ai");
    const network = mockIntegrations("unknown");
    const result = await processPendingHubspotActions();
    expect(result.processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_HUBSPOT_CONTACT_REQUIRED" });
    expect(network.mock.calls.some(([url]) => /\/objects\/(contacts|tickets)$/.test(url))).toBe(false);
  });
  it("never retries an ambiguous ticket dispatch", async () => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    const action = await queueSavManualTicket({ threadId, reviewId: review.id, kind: "create_ticket" }, "ugo@limova.ai");
    await fixture.db.update(savActions).set({ status: "failed", errorCode: "SAV_MANUAL_RECONCILIATION_REQUIRED", payload: { ...action.payload, ticketCreateDispatchedAt: new Date().toISOString() } }).where(eq(savActions.id, action.id));
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    await expect(retrySavAction(action.id, "ugo@limova.ai")).rejects.toThrow("SAV_MANUAL_RECONCILIATION_REQUIRED");
    await expect(queueSavManualTicket({ threadId, reviewId: review.id, kind: "create_ticket" }, "ugo@limova.ai")).rejects.toThrow("SAV_MANUAL_RECONCILIATION_REQUIRED");
    expect(network).not.toHaveBeenCalled();
  });
  it.each([true, false])("reconciles an uncertain ticket only after verifying its content and contact: %s", async (matching) => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    const action = await queueSavManualTicket({ threadId, reviewId: review.id, kind: "create_ticket" }, "ugo@limova.ai");
    await fixture.db.update(savActions).set({ status: "failed", errorCode: "SAV_MANUAL_RECONCILIATION_REQUIRED", payload: { ...action.payload, ticketCreateDispatchedAt: new Date().toISOString() } }).where(eq(savActions.id, action.id));
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/contacts/search")) return Response.json({ results: [{ id: "21", properties: { email: "client@example.com" } }] });
      if (url.includes("/tickets/301") && !init?.method) return Response.json({ id: "301", properties: { subject: proposal.ticket.title, content: proposal.ticket.description, hs_pipeline: "0" }, associations: { contacts: { results: [{ id: matching ? "21" : "99" }] } } });
      throw new Error("No mutation allowed during reconciliation");
    });
    vi.stubGlobal("fetch", network);
    if (matching) {
      await reconcileSavManualTicket(action.id, "301", "ugo@limova.ai", "Ticket retrouvé et contrôlé manuellement");
      expect((await fixture.db.select().from(savActions))[0].status).toBe("succeeded");
      expect((await fixture.db.select().from(savThreads))[0].hubspotTicketId).toBe("301");
    } else {
      await expect(reconcileSavManualTicket(action.id, "301", "ugo@limova.ai", "Ticket retrouvé et contrôlé manuellement")).rejects.toThrow("SAV_RECONCILIATION_TARGET_INVALID");
      expect((await fixture.db.select().from(savActions))[0].status).toBe("failed");
      expect((await fixture.db.select().from(savThreads))[0].hubspotTicketId).toBeNull();
    }
    expect(network.mock.calls.every(([url, init]) => !init?.method || (url.endsWith("/contacts/search") && init.method === "POST"))).toBe(true);
  });
  it("requires explicit human verification before accepting a registration email", async () => {
    const input = reviewInput();
    const correction = { ...input.correction, registrationEmail: "inscription@example.com", identityVerified: false };
    await expect(reviewSavProposal({ ...input, correction }, "ugo@limova.ai")).rejects.toThrow("SAV_CUSTOMER_IDENTITY_VERIFICATION_REQUIRED");
    await reviewSavProposal({ ...input, correction: { ...correction, identityVerified: true } }, "ugo@limova.ai");
    expect((await getSavProposalReview(messageId))?.proposal.customerIdentity).toEqual({ registrationEmail: "inscription@example.com", verifiedByHuman: true });
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("allows retention to remove a thread and its dependent review without breaking foreign keys", async () => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    await queueSavManualTicket({ threadId, reviewId: review.id, kind: "create_ticket" }, "ugo@limova.ai");
    await fixture.db.delete(savThreads).where(eq(savThreads.id, threadId));
    expect(await fixture.db.select().from(savProposalReviews)).toHaveLength(0);
    expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  });
  it("resumes an acknowledged ticket after a local failure without another POST or email", async () => {
    const review = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
    const action = await queueSavManualTicket({ threadId, reviewId: review.id, kind: "create_ticket" }, "ugo@limova.ai");
    await fixture.db.update(savActions).set({ status: "failed", errorCode: "LOCAL_FAILURE", payload: { ...action.payload, ticketCreateDispatchedAt: new Date().toISOString(), hubspotTicketId: "301" } }).where(eq(savActions.id, action.id));
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("No new creation allowed");
      if (url.includes("/pipelines/tickets/0")) return Response.json({ id: "0", stages: ["1", "2", "3", "4"].map((id) => ({ id, metadata: { isClosed: id === "4" } })) });
      if (url.includes("/tickets/301")) return Response.json({ id: "301", properties: { subject: "Retrouver les factures", hs_pipeline: "0", hs_pipeline_stage: "1" } });
      throw new Error("Unexpected external request");
    }); vi.stubGlobal("fetch", network);
    await retrySavAction(action.id, "ugo@limova.ai");
    await processPendingHubspotActions();
    expect((await fixture.db.select().from(savThreads))[0].hubspotTicketId).toBe("301");
    expect((await fixture.db.select().from(savActions))[0].status).toBe("succeeded");
    expect(await fixture.db.select().from(savActions)).toHaveLength(1);
  });
  it("separates technical exclusions and searches beyond the first page", async () => {
    await fixture.db.update(savDecisions).set({ kind: "bounce" }).where(eq(savDecisions.id, decisionId));
    expect(await listSavInbox()).toHaveLength(0);
    expect(await listSavInbox(50, { view: "technical" })).toHaveLength(1);
    expect(await listSavInbox(50, { view: "technical", query: "factures" })).toHaveLength(1);
    expect(await listSavInbox(50, { view: "technical", query: "absent" })).toHaveLength(0);
  });
});
describe("unverified identity hints", () => {
  it("finds name/phone candidates with read-only search and never confirms identity", async () => {
    const network = vi.fn(async () => Response.json({ results: [{ id: "31", properties: { firstname: "Jeanne", lastname: "Martin", email: "compte@example.com", phone: "06 12 34 56 78" } }] }));
    vi.stubGlobal("fetch", network);
    const matches = await findSavContactCandidates({ names: ["Jeanne Martin"], phones: ["33612345678"] });
    expect(matches).toEqual([{ contactId: "31", name: "Jeanne Martin", email: "compte@example.com", phoneHint: "…5678", matchedBy: "phone", confirmed: false }]);
    expect(network.mock.calls).toHaveLength(2);
  });
  it("extracts explicit name/phone without treating them as confirmed identity", () => {
    expect(extractSavIdentityHints("Bonjour\nNom : Jeanne Martin\nTéléphone : +33 6 12 34 56 78")).toEqual({ names: ["Jeanne Martin"], phones: ["33612345678"] });
    expect(phoneMatchesHint("06 12 34 56 78", "33612345678")).toBe(true);
    expect(extractSavIdentityHints("Facture 1234567890123" )).toEqual({ names: [], phones: [] });
  });
});
