import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { encryptSavPayload } from "./crypto";
import { savStructuredProposalSchema } from "./proposal";
import { reviewSavProposal } from "./review";
import { queueSavManualTicket } from "./manual-tickets";
import { retrySavAction } from "./service";
import { processPendingHubspotActions, reconcileSavTicketReturn, readSavHubspotContext } from "./hubspot";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let threadId: string;
let messageId: string;
let decisionId: string;
let runId: string;
const proposal = savStructuredProposalSchema.parse({ schemaVersion: 1, category: "how_to", urgency: "normal", decision: { kind: "ticket_pending", reasonCode: "fixture_support", explanation: "Demande support fictive à vérifier", confidence: 800 }, routing: { kind: "new", reason: "fixture", contactId: "21" }, ticket: { title: "Connexion impossible", description: "Connexion impossible <script>test</script>." }, process: [{ kind: "human_review", label: "Relire la procédure proposée", sourceIds: [] }], internalNote: null, replyDraft: "Brouillon fictif", sources: [], knowledgeRevision: "not_consulted", model: "fixture" });
function reviewInput(reusability = "none") {
  return { messageId, decisionId, agentRunId: runId, expectedReviewId: null, status: "approved", verdict: "partial", dimensions: { classification: "correct", routing: "correct", grounding: "partial", tone: "correct", escalation: "correct" }, comment: "Revue fictive, corriger la procédure", reusability, reusableResolution: "Ouvrez Paramètres puis Facturation. Cas client@example.com, tél 0612345678.", justification: "Parcours générique vérifié, réutilisable pour retrouver les factures", correction: { category: proposal.category, urgency: proposal.urgency, decisionKind: proposal.decision.kind, reasonCode: proposal.decision.reasonCode, explanation: proposal.decision.explanation, title: proposal.ticket.title, description: proposal.ticket.description, process: proposal.process, internalNote: "Note corrigée", replyDraft: "Brouillon corrigé, à relire" } };
}
let stage = "2", closedAt: string | null = null;
let remoteNote: { id: string; properties: Record<string, string> } | null = null;
let failure: "none" | "note_timeout" | "patch_timeout" = "none";
function mockIntegrations() {
  vi.stubEnv("GMAIL_CLIENT_ID", "test"); vi.stubEnv("GMAIL_CLIENT_SECRET", "test"); vi.stubEnv("GMAIL_REFRESH_TOKEN", "test");
  const record = () => ({ id: "401", createdAt: "2026-09-01T00:00:00Z", properties: { subject: "Connexion impossible", content: "Même demande", hs_pipeline: "0", hs_pipeline_stage: stage, hs_last_closed_date: closedAt }, associations: { contacts: { results: [{ id: "21" }] } } });
  const network = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    if (url.includes("gmail.googleapis.com") && url.includes("threads/gmail-thread")) return Response.json({ messages: [{ id: "gmail-message", internalDate: String(Date.parse("2026-10-02T12:01:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "client@example.com" }] } }] });
    const stages = ["1", "2", "3", "4"].map(id => ({ id, metadata: { isClosed: id === "4", ticketState: id === "4" ? "CLOSED" : "OPEN" } }));
    if (url.endsWith("/pipelines/tickets/0")) return Response.json({ id: "0", stages });
    if (url.endsWith("/pipelines/tickets")) return Response.json({ results: [{ id: "0", stages }] });
    if (url.endsWith("/contacts/search")) return Response.json({ results: [{ id: "21", properties: { email: "client@example.com" } }] });
    if (url.endsWith("/tickets/search")) return Response.json({ results: [record()] });
    if (url.endsWith("/associations/notes/tickets/labels")) return Response.json({ results: [{ category: "HUBSPOT_DEFINED", label: null, typeId: 228 }] });
    if (url.endsWith("/objects/notes") && init?.method === "POST") {
      remoteNote = { id: "501", properties: JSON.parse(String(init.body)).properties };
      if (failure === "note_timeout") throw new TypeError("Simulated lost note acknowledgement");
      return Response.json(remoteNote);
    }
    if (url.includes("/objects/notes/501?")) return Response.json({ ...remoteNote, associations: { tickets: { results: [{ id: "401" }] } } });
    if (url.endsWith("/objects/tickets/401") && init?.method === "PATCH") {
      stage = JSON.parse(String(init.body)).properties.hs_pipeline_stage;
      if (failure === "patch_timeout") throw new TypeError("Simulated lost patch acknowledgement");
      return Response.json(record());
    }
    if (url.includes("/objects/tickets/401?")) return Response.json(record());
    if (url.endsWith("/objects/tickets") && init?.method === "POST") return Response.json({ id: "301", properties: JSON.parse(String(init.body)).properties });
    throw new Error(`Unexpected fixture call: ${url}`);
  });
  vi.stubGlobal("fetch", network);
  return network;
}

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture?.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(async () => {
  stage = "2"; closedAt = null; remoteNote = null; failure = "none";
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false"); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters"); vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "test-only");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE active_knowledge; TRUNCATE audit_logs");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  await activateSavV0Cutover({ receivedAfter: "2026-10-02T12:00:00Z", mailboxEmail: mailbox.email, intakeRecipient: "contact@limova.ai", deploymentSha: "a".repeat(40), activatedBy: "ugo@limova.ai" });
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "gmail-thread", subject: "Connexion impossible", customerEmail: "client@example.com" }).returning(); threadId = thread.id;
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId, gmailMessageId: "gmail-message", direction: "inbound", fromEmail: thread.customerEmail, subject: thread.subject, bodyCiphertext: encryptSavPayload({ text: proposal.ticket.description }), receivedAt: new Date("2026-10-02T12:01:00Z"), analysisStatus: "done" }).returning(); messageId = message.id;
  const [run] = await fixture.db.insert(savAgentRuns).values({ messageId, runtime: "rules", mode: "off", status: "succeeded", model: "fixture", promptRevision: "fixture-v1", inputHash: "fixture", proposalCiphertext: encryptSavPayload(proposal), completedAt: new Date() }).returning(); runId = run.id;
  const [decision] = await fixture.db.insert(savDecisions).values({ messageId, agentRunId: runId, kind: "ticket_pending", reasonCode: "fixture", explanation: "Demande fictive", confidence: 800 }).returning(); decisionId = decision.id;
});

async function prepare(operation: "keep" | "reactivate" | "create", linked = false) {
  const network = mockIntegrations();
  if (linked) await fixture.db.update(savThreads).set({ hubspotTicketId: "401" }).where(eq(savThreads.id, threadId));
  const crm = await readSavHubspotContext({ email: "client@example.com", subject: "Connexion impossible", returnedAt: "2026-10-02T12:01:00Z" });
  await fixture.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: proposal.ticket.description, supportContext: { version: 1, messageId, collectedAt: "2026-10-02T12:02:00Z", crm: { status: "ready", errorCode: null, data: crm } } }) }).where(eq(savMessages.id, messageId));
  const review = await reviewSavProposal({ ...reviewInput(), reviewScope: "dossier" }, "ugo@limova.ai");
  const request = { threadId, reviewId: review.id, kind: operation === "create" ? "create_ticket" : "link_ticket", ticketId: "401", returnOperation: operation };
  const action = await queueSavManualTicket(request, "ugo@limova.ai");
  return { network, action, request };
}
function mutations(network: ReturnType<typeof mockIntegrations>) { return network.mock.calls.filter(([url, init]) => /\/objects\/(notes|tickets)(?:\/\d+)?$/.test(url) && ["POST", "PATCH"].includes(init?.method ?? "")); }

it.each(["1", "2", "3", "4"])("handles stage %s without duplicate note or ticket", async initialStage => {
  stage = initialStage;
  if (stage === "4") closedAt = "2026-09-25T12:01:00Z";
  const { network, action, request } = await prepare(stage === "1" ? "keep" : "reactivate", true);
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "succeeded", ticketId: "401" }]);
  expect(stage).toBe("1");
  expect(mutations(network)).toHaveLength(initialStage === "1" ? 0 : 2);
  if (initialStage !== "1") {
    expect(remoteNote?.properties.hs_note_body).toContain("Le client est revenu");
    expect(remoteNote?.properties.hs_note_body).toContain("Connexion impossible &lt;script&gt;test&lt;/script&gt;.");
    expect(remoteNote?.properties.hs_note_body).toContain("gmail-message");
  }
  await queueSavManualTicket(request, "ugo@limova.ai");
  await processPendingHubspotActions(1);
  expect(mutations(network)).toHaveLength(initialStage === "1" ? 0 : 2);
});
it.each([15 * 86400000, 15 * 86400000 + 1])("uses the exact closed-age boundary %s on a linked ticket", async age => {
  stage = "4"; closedAt = new Date(Date.parse("2026-10-02T12:01:00Z") - age).toISOString();
  const create = age > 15 * 86400000;
  const { network, action } = await prepare(create ? "create" : "reactivate", true);
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "succeeded", ticketId: create ? "301" : "401" }]);
  expect((await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId)))[0].hubspotTicketId).toBe(create ? "301" : "401");
  expect(mutations(network)).toHaveLength(create ? 1 : 2);
});
it("refuses changed remote stage before any note or patch", async () => {
  const { network, action } = await prepare("reactivate"); stage = "4";
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "failed", errorCode: "SAV_TICKET_RETURN_CONTEXT_CHANGED" }]);
  expect(mutations(network)).toHaveLength(0);
});
it.each(["note_timeout", "patch_timeout"] as const)("blocks blind retries after %s and reconciles with reads only", async kind => {
  const { network, action, request } = await prepare("reactivate"); failure = kind;
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "failed", errorCode: "SAV_TICKET_RETURN_RECONCILIATION_REQUIRED" }]);
  await expect(retrySavAction(action.id, "ugo@limova.ai")).rejects.toThrow("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED");
  await expect(queueSavManualTicket(request, "ugo@limova.ai")).rejects.toThrow("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED");
  if (kind === "note_timeout") {
    await expect(reconcileSavTicketReturn(action.id, "501", "ugo@limova.ai")).rejects.toThrow("SAV_RECONCILIATION_TARGET_INVALID");
    stage = "1"; // Operator finishes the status update in HubSpot, outside this worker.
  }
  const count = mutations(network).length;
  await reconcileSavTicketReturn(action.id, "501", "ugo@limova.ai");
  expect(mutations(network)).toHaveLength(count);
  expect((await fixture.db.select().from(savActions).where(eq(savActions.id, action.id)))[0].status).toBe("succeeded");
});
it("refuses a newer inbound after confirmation", async () => {
  const { network, action } = await prepare("reactivate");
  const [original] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  await fixture.db.insert(savMessages).values({ mailboxId: original.mailboxId, threadId, gmailMessageId: "new-inbound", direction: "inbound", fromEmail: original.fromEmail, subject: original.subject, bodyCiphertext: encryptSavPayload({ text: "Nouvelle demande" }), receivedAt: new Date("2026-10-02T13:00:00Z") });
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "failed" }]);
  expect(mutations(network)).toHaveLength(0);
});
