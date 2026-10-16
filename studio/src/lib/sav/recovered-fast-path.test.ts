import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { activeKnowledge, savActions, savAgentRuns, savDecisions, savLearningCandidates, savMailboxes, savMessages, savProposalReviews, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import { getSavProposalReview, reviewSavProposal } from "./review";
import { queueSavManualTicket } from "./manual-tickets";
import { getSavThreadDetail, listSavInbox, retrySavAction } from "./service";
import { savModeAllowsWrite } from "./action-policy";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ManualTicketStatus } from "@/app/studio/sav/[id]/manual-ticket-status";
import { findSavContactCandidates, processManualSavTicketActionImmediately, processPendingHubspotActions, reconcileSavManualTicket } from "./hubspot";
import { extractSavIdentityHints, phoneMatchesHint } from "./identity";
import { geminiFixture } from "../../../test/sav-understanding-fixtures";

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
    if (url.includes("generativelanguage.googleapis.com")) {
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      return geminiFixture({ assessments: data.tickets.map((ticket: { id: string; text: string }) => ({ ticketId: ticket.id,
        relation: mode === "different" ? "different_issue" : "same_issue", messageExcerpt: data.currentMessage, historyExcerpt: "",
        ticketExcerpt: ticket.text.split("\n")[0], explanation: "Verdict provider simulé pour la demande synthétique." })) });
    }
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    if (url.includes("gmail.googleapis.com") && url.includes("threads/gmail-thread")) return Response.json({ messages: [{ id: "gmail-message", internalDate: String(Date.parse("2026-10-02T12:01:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "client@example.com" }] } }] });
    const stages = ["1", "2", "3", "4"].map((id) => ({ id, metadata: { isClosed: id === "4", ticketState: id === "4" ? "CLOSED" : "OPEN" } }));
    if (url.endsWith("/pipelines/tickets/0")) return Response.json({ id: "0", stages });
    if (url.endsWith("/pipelines/tickets")) return Response.json({ results: [{ id: "0", stages }] });
    if (url.endsWith("/contacts/search")) return Response.json({ results: mode === "unknown" ? [] : [{ id: "21", properties: { email: "client@example.com" } }] });
    if (url.endsWith("/tickets/search")) return Response.json({ results: ["existing", "different"].includes(mode) ? [{ id: "401", properties: { subject: mode === "different" ? "Intégration Slack impossible" : "Retrouver les factures", hs_pipeline: "0", hs_pipeline_stage: "1", hs_lastmodifieddate: new Date().toISOString() } }] : [] });
    if (url.endsWith("/objects/emails") && init?.method === "POST") return Response.json({ id: "501", properties: {} });
    if (url.includes("/associations/default/") && init?.method === "PUT") return new Response(null, { status: 204 });
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
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false"); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters"); vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "test-only");
  vi.stubEnv("SAV_GEMINI_API_KEY", "fixture-key"); vi.stubEnv("SAV_AI_ANALYSIS", "true");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "gmail-thread", subject: "Retrouver les factures", customerEmail: "client@example.com" }).returning(); threadId = thread.id;
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, gmailMessageId: "gmail-message", direction: "inbound", fromEmail: thread.customerEmail, subject: thread.subject, bodyCiphertext: encryptSavPayload({ text: proposal.ticket.description }), receivedAt: new Date("2026-10-02T12:01:00Z"), analysisStatus: "done" }).returning(); messageId = message.id;
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId, runtime: "rules", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture-v1", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal), completedAt: new Date() }).returning(); runId = run.id;
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId, agentRunId: runId, kind: "ticket_pending", reasonCode: "fixture", explanation: "Demande fictive", confidence: 800 }).returning(); decisionId = decision.id;
});

const posts = (network: ReturnType<typeof mockIntegrations>) => network.mock.calls.filter(([url, init]) => url.endsWith("/objects/tickets") && init?.method === "POST");
it("fast path and cron share one claim and one remote creation", async () => {
  const r = await reviewSavProposal(reviewInput(), "ugo@limova.ai");
  const a = await queueSavManualTicket({threadId,reviewId:r.id,kind:"create_ticket"},"ugo@limova.ai");
  const network = mockIntegrations();
  await Promise.all([processManualSavTicketActionImmediately(a.id),processPendingHubspotActions(),processManualSavTicketActionImmediately(a.id)]);
  expect(posts(network)).toHaveLength(1);
  expect(await processManualSavTicketActionImmediately(a.id)).toEqual({status:"completed"});
  expect(posts(network)).toHaveLength(1);
});
it("fast path timeout remains uncertain across click and cron replay",async()=>{
 const r=await reviewSavProposal(reviewInput(),"ugo@limova.ai");
 const a=await queueSavManualTicket({threadId,reviewId:r.id,kind:"create_ticket"},"ugo@limova.ai");
 const network=mockIntegrations("timeout");
 expect(await processManualSavTicketActionImmediately(a.id)).toEqual({status:"failed",errorCode:"SAV_MANUAL_RECONCILIATION_REQUIRED"});
 await processManualSavTicketActionImmediately(a.id); await processPendingHubspotActions();
 expect(posts(network)).toHaveLength(1);
});
it.each(["shadow","disabled"])("fast path respects %s without any provider call",async(blocker)=>{
 const r=await reviewSavProposal(reviewInput(),"ugo@limova.ai");
 const a=await queueSavManualTicket({threadId,reviewId:r.id,kind:"create_ticket"},"ugo@limova.ai");
 const network=mockIntegrations();
 vi.stubEnv(blocker==="shadow"?"SAV_AUTOMATION_MODE":"SAV_WRITES_DISABLED",blocker==="shadow"?"shadow":"true");
 expect(await processManualSavTicketActionImmediately(a.id)).toEqual({status:"pending"});
 expect(network).not.toHaveBeenCalled();
});
it("new inbound before immediate execution fails terminally without provider calls",async()=>{
 const r=await reviewSavProposal(reviewInput(),"ugo@limova.ai");
 const a=await queueSavManualTicket({threadId,reviewId:r.id,kind:"create_ticket"},"ugo@limova.ai");
 const [m]=await fixture.db.select().from(savMessages).where(eq(savMessages.id,messageId));
 await fixture.db.insert(savMessages).values({...m,id:crypto.randomUUID(),gmailMessageId:"newer",receivedAt:new Date("2026-10-02T12:02:00Z")});
 const network=mockIntegrations();
 expect(await processManualSavTicketActionImmediately(a.id)).toEqual({status:"failed",errorCode:"SAV_PROPOSAL_STALE"});
 expect(network).not.toHaveBeenCalled();
});
