import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savActions, savAgentRuns, savDecisions, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { resolveSavCustomerIdentity, resolveSavCustomerMessage } from "./forwarded-identity";
import { savStructuredProposalSchema } from "./proposal";
import { reviewSavProposal } from "./review";
import { prepareSavManualTicketPreview, readSavTicketPreviewToken, readSavManualTicketPreviewContext } from "./manual-ticket-preview";
import { queueSavManualTicket } from "./manual-tickets";
import { retrySavAction } from "./service";
import { processPendingHubspotActions, reconcileSavTicketReturn, readSavHubspotContext } from "./hubspot";
import { geminiFixture } from "../../../test/sav-understanding-fixtures";

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
let predecessorStage: string | null = null;
let stage = "2", closedAt: string | null = null;
let ownerId: string | null = "71";
let remoteNote: { id: string; properties: Record<string, string> } | null = null;
let failure: "none" | "note_timeout" | "patch_timeout" = "none";
let matchingUnavailable = false;
let ticketDescription = "Même demande";
function mockIntegrations() {
  vi.stubEnv("GMAIL_CLIENT_ID", "test"); vi.stubEnv("GMAIL_CLIENT_SECRET", "test"); vi.stubEnv("GMAIL_REFRESH_TOKEN", "test");
  const record = () => ({ id: "401", createdAt: "2026-09-01T00:00:00Z", properties: { subject: "Connexion impossible", content: ticketDescription, hs_pipeline: "0", hs_pipeline_stage: stage, hs_last_closed_date: closedAt, hubspot_owner_id: ownerId }, associations: { contacts: { results: [{ id: "21" }] } } });
  const network = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("generativelanguage.googleapis.com")) {
      if (matchingUnavailable) return new Response("Provider unavailable", { status: 500 });
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      return geminiFixture({ assessments: data.tickets.map((ticket: { id: string; text: string }) => ({ ticketId: ticket.id, relation: "same_issue",
        messageExcerpt: data.currentMessage, historyExcerpt: "", ticketExcerpt: ticket.text.split("\n")[0], explanation: "Même demande synthétique, verdict provider simulé." })) });
    }
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "fixture-token", expires_in: 3600 });
    if (url.includes("gmail.googleapis.com") && url.includes("threads/gmail-thread")) return Response.json({ messages: [{ id: "gmail-message", internalDate: String(Date.parse("2026-10-02T12:01:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "client@example.com" }] } }] });
    const stages = ["1", "2", "3", "4"].map(id => ({ id, metadata: { isClosed: id === "4", ticketState: id === "4" ? "CLOSED" : "OPEN" } }));
    if (url.endsWith("/pipelines/tickets/0")) return Response.json({ id: "0", stages });
    if (url.endsWith("/pipelines/tickets")) return Response.json({ results: [{ id: "0", stages }] });
    if (/\/tickets\/\d+\/associations\/(?:notes|emails)\?/.test(url)) return Response.json({ results: [] });
    if (url.endsWith("/contacts/search")) return Response.json({ results: [{ id: "21", properties: { email: "client@example.com" } }] });
    const predecessor = () => ({ ...record(), id: "400", properties: { ...record().properties, hs_pipeline_stage: predecessorStage, hs_last_closed_date: "2026-09-01T00:00:00Z" } });
    if (url.endsWith("/tickets/search")) return Response.json({ results: [...(predecessorStage ? [predecessor()] : []), record()] });
    if (url.includes("/objects/tickets/400?")) return Response.json(predecessor());
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
  predecessorStage = null; stage = "2"; closedAt = null; ownerId = "71"; remoteNote = null; failure = "none"; matchingUnavailable = false; ticketDescription = "Même demande";
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("SAV_RELEASE_STAGE", "v0"); vi.stubEnv("SAV_AUTOMATION_MODE", "assist"); vi.stubEnv("SAV_WRITES_DISABLED", "false"); vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-sav-encryption-key-32-characters"); vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "test-only");
  vi.stubEnv("SAV_GEMINI_API_KEY", "fixture-key"); vi.stubEnv("SAV_AI_ANALYSIS", "true");
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
  if (linked) await fixture.db.update(savThreads).set({ hubspotTicketId: predecessorStage ? "400" : "401" }).where(eq(savThreads.id, threadId));
  const [message] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  const body = decryptSavPayload<{ text: string }>(message.bodyCiphertext);
  const customer = resolveSavCustomerMessage({ fromEmail: message.fromEmail, subject: message.subject, body: body.text });
  const customerIdentity = resolveSavCustomerIdentity({ fromEmail: message.fromEmail, body: body.text });
  const crm = await readSavHubspotContext({ email: customer.email!, subject: customer.subject, body: customer.body, returnedAt: "2026-10-02T12:01:00Z" });
  await fixture.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ ...body, supportContext: { version: 1, messageId, collectedAt: "2026-10-02T12:02:00Z", customerIdentity, crm: { status: "ready", errorCode: null, data: crm } } }) }).where(eq(savMessages.id, messageId));
  const review = await reviewSavProposal({ ...reviewInput(), reviewScope: "dossier" }, "ugo@limova.ai");
  const request = { threadId, reviewId: review.id, kind: operation === "create" ? "create_ticket" : "link_ticket", ticketId: "401", returnOperation: operation };
  const action = await queueSavManualTicket(request, "ugo@limova.ai");
  return { network, action, request };
}
function mutations(network: ReturnType<typeof mockIntegrations>) { return network.mock.calls.filter(([url, init]) => /\/objects\/(notes|tickets)(?:\/\d+)?$/.test(url) && ["POST", "PATCH"].includes(init?.method ?? "")); }

it("reactivates a content-matched issue despite a generic inherited subject, across queue and worker", async () => {
  const generic = "Re: Suite à votre demande - Urgent", text = "Le test de connexion échoue toujours, je reviens sur ce problème.";
  await fixture.db.update(savThreads).set({ subject: generic }).where(eq(savThreads.id, threadId));
  await fixture.db.update(savMessages).set({ subject: generic, bodyCiphertext: encryptSavPayload({ text }) }).where(eq(savMessages.id, messageId));
  const { network, action } = await prepare("reactivate");
  expect((await processPendingHubspotActions(1)).processed[0]).toMatchObject({ actionId: action.id, status: "succeeded", ticketId: "401" });
  expect(mutations(network)).toHaveLength(2);
  const checks = network.mock.calls.filter(([url]) => url.includes("generativelanguage.googleapis.com"));
  expect(checks).toHaveLength(1); // Identical evidence is reused, remote lifecycle fields are still checked.
  for (const [, init] of checks) expect(JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text)).toMatchObject({ currentMessage: text });
  expect(action.payload.ticketReturn).toMatchObject({ ticketId: "401", ownerId: "71", operation: "reactivate" });
});

it("does not mutate CRM when changed ticket content requires an unavailable new semantic check", async () => {
  const { network } = await prepare("reactivate"); matchingUnavailable = true; ticketDescription = "Autre problème à qualifier";
  expect((await processPendingHubspotActions(1)).processed[0].status).toBe("failed");
  expect(mutations(network)).toHaveLength(0);
  expect(stage).toBe("2");
});

it.each(["1", "2", "3", "4"])("handles stage %s without duplicate note or ticket", async initialStage => {
  stage = initialStage;
  if (stage === "4") closedAt = "2026-09-25T12:01:00Z";
  const { network, action, request } = await prepare(stage === "1" ? "keep" : "reactivate", true);
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "succeeded", ticketId: "401" }]);
  expect(stage).toBe("1");
  expect(mutations(network)).toHaveLength(initialStage === "1" ? 0 : 2);
  if (initialStage !== "1") {
    expect(remoteNote?.properties.hs_note_body).toBe(initialStage === "4"
      ? "<p>Le client a renvoyé un email sur ce sujet. Le ticket est rouvert et repasse en Nouveau.</p>"
      : "<p>Le client a renvoyé un email sur ce sujet. Le ticket repasse en Nouveau.</p>");
    expect(remoteNote?.properties.hs_note_body).not.toContain("Connexion impossible");
    expect(remoteNote?.properties.hs_note_body).not.toContain("gmail-message");
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

it.each(["1", "2", "3"])("replaces the closed predecessor link with an existing successor at stage %s", async nextStage => {
  predecessorStage = "4"; stage = nextStage;
  const { network, action } = await prepare(stage === "1" ? "keep" : "reactivate", true);
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "succeeded", ticketId: "401" }]);
  expect((await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId)))[0].hubspotTicketId).toBe("401");
  expect(mutations(network)).toHaveLength(nextStage === "1" ? 0 : 2);
});
it("refuses a successor if the predecessor reopens after confirmation", async () => {
  predecessorStage = "4";
  const { network, action } = await prepare("reactivate", true); predecessorStage = "1";
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "failed", errorCode: "SAV_TICKET_RETURN_CONTEXT_CHANGED" }]);
  expect(mutations(network)).toHaveLength(0);
});
it("does not replace a concurrently changed local link", async () => {
  predecessorStage = "4";
  const { network, action } = await prepare("reactivate", true);
  await fixture.db.update(savThreads).set({ hubspotTicketId: "999" }).where(eq(savThreads.id, threadId));
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "failed" }]);
  expect(mutations(network)).toHaveLength(0);
});
it("reconciles a successor return without repeating the remote writes", async () => {
  predecessorStage = "4";
  const { network, action } = await prepare("reactivate", true); failure = "patch_timeout";
  expect((await processPendingHubspotActions(1)).processed).toMatchObject([{ actionId: action.id, status: "failed", errorCode: "SAV_TICKET_RETURN_RECONCILIATION_REQUIRED" }]);
  const count = mutations(network).length;
  await reconcileSavTicketReturn(action.id, "501", "ugo@limova.ai");
  expect(mutations(network)).toHaveLength(count);
  expect((await fixture.db.select().from(savThreads).where(eq(savThreads.id, threadId)))[0].hubspotTicketId).toBe("401");
});

it.each(["reactivate", "create"] as const)("preserves the prior owner on a supervised %s", async operation => {
  if (operation === "create") { stage = "4"; closedAt = "2026-09-01T12:01:00Z"; }
  const { network, action } = await prepare(operation, true);
  expect((await processPendingHubspotActions(1)).processed[0]).toMatchObject({ actionId: action.id, status: "succeeded" });
  const ticketWrite = mutations(network).find(([url]) => /\/objects\/tickets(?:\/\d+)?$/.test(url));
  expect(JSON.parse(String(ticketWrite?.[1]?.body)).properties.hubspot_owner_id).toBe("71");
});

it("blocks a changed owner before writing a return note or reopening", async () => {
  const { network, action } = await prepare("reactivate"); ownerId = "72";
  expect((await processPendingHubspotActions(1)).processed[0]).toMatchObject({ actionId: action.id, status: "failed", errorCode: "SAV_TICKET_RETURN_CONTEXT_CHANGED" });
  expect(mutations(network)).toHaveLength(0);
});

it("requires an explicit owner before queuing a reactivation", async () => {
  ownerId = null;
  await expect(prepare("reactivate")).rejects.toThrow("SAV_TICKET_OWNER_REQUIRED");
  expect(await fixture.db.select().from(savActions)).toHaveLength(0);
});

it("rejects a changed owner during read-only reconciliation", async () => {
  const { network, action } = await prepare("reactivate"); failure = "patch_timeout";
  await processPendingHubspotActions(1); ownerId = "72";
  const count = mutations(network).length;
  await expect(reconcileSavTicketReturn(action.id, "501", "ugo@limova.ai")).rejects.toThrow("SAV_RECONCILIATION_TARGET_INVALID");
  expect(mutations(network)).toHaveLength(count);
});

it("does not infer an owner for an uncertain legacy operation", async () => {
  const { network, action } = await prepare("reactivate"); failure = "patch_timeout";
  await processPendingHubspotActions(1);
  const [stored] = await fixture.db.select().from(savActions).where(eq(savActions.id, action.id));
  const request = decryptSavPayload<Record<string, unknown>>(String(stored.payload.ticketReturnRequestCiphertext));
  delete request.expectedOwnerId;
  await fixture.db.update(savActions).set({ payload: { ...stored.payload, ticketReturnRequestCiphertext: encryptSavPayload(request) } }).where(eq(savActions.id, action.id));
  const count = mutations(network).length;
  await expect(reconcileSavTicketReturn(action.id, "501", "ugo@limova.ai")).rejects.toThrow("SAV_TICKET_RETURN_LEGACY_OWNER_UNVERIFIABLE");
  await expect(retrySavAction(action.id, "ugo@limova.ai")).rejects.toThrow("SAV_TICKET_RETURN_RECONCILIATION_REQUIRED");
  expect(mutations(network)).toHaveLength(count);
});

it("routes a forwarded return with its original subject and customer, not the colleague", async () => {
  const text = "---------- Forwarded message ---------\nFrom: client@example.com\nSubject: Connexion impossible\n\nConnexion impossible.";
  await fixture.db.update(savMessages).set({ fromEmail: "colleague@limova.ai", subject: "À traiter pour ce client", bodyCiphertext: encryptSavPayload({ text }) }).where(eq(savMessages.id, messageId));
  await fixture.db.update(savThreads).set({ customerEmail: "colleague@limova.ai", subject: "À traiter pour ce client" }).where(eq(savThreads.id, threadId));
  const { network, action } = await prepare("reactivate");
  expect((await processPendingHubspotActions(1)).processed[0]).toMatchObject({ actionId: action.id, status: "succeeded", ticketId: "401" });
  const searches = network.mock.calls.filter(([url]) => url.endsWith("/contacts/search"));
  expect(searches.length).toBeGreaterThan(0);
  for (const [, init] of searches) { expect(String(init?.body)).toContain("client@example.com"); expect(String(init?.body)).not.toContain("colleague@limova.ai"); }
  const [source] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  expect(source.fromEmail).toBe("colleague@limova.ai");
});

it("requires an explicit context refresh for a legacy snapshot without customer identity", async () => {
  const network = mockIntegrations();
  const crm = await readSavHubspotContext({ email: "client@example.com", subject: "Connexion impossible", returnedAt: "2026-10-02T12:01:00Z" });
  const legacy = { version: 1, messageId, collectedAt: "2026-10-02T12:02:00Z", crm: { status: "ready", errorCode: null, data: crm } };
  await fixture.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload({ text: proposal.ticket.description, supportContext: legacy }) }).where(eq(savMessages.id, messageId));
  const review = await reviewSavProposal({ ...reviewInput(), reviewScope: "dossier" }, "ugo@limova.ai");
  await expect(queueSavManualTicket({ threadId, reviewId: review.id, kind: "link_ticket", ticketId: "401", returnOperation: "reactivate" }, "ugo@limova.ai")).rejects.toThrow("SAV_TICKET_RETURN_CONTEXT_CHANGED");
  expect(await fixture.db.select().from(savActions)).toHaveLength(0);
  expect(mutations(network)).toHaveLength(0);
});


it("preserves the original body for a queued legacy action and reconciles its snapshot", async () => {
  const { network, action } = await prepare("reactivate");
  const { ticketReturnNoteVersion: _version, ...legacy } = action.payload; void _version;
  await fixture.db.update(savActions).set({ payload: legacy }).where(eq(savActions.id, action.id));
  failure = "patch_timeout"; await processPendingHubspotActions(1);
  expect(remoteNote?.properties.hs_note_body).toContain("Connexion impossible &lt;script&gt;test&lt;/script&gt;.");
  expect(remoteNote?.properties.hs_note_body).toContain("gmail-message");
  const count = mutations(network).length;
  await reconcileSavTicketReturn(action.id, "501", "ugo@limova.ai");
  expect(mutations(network)).toHaveLength(count);
});
it("confirms the encrypted preview once and preserves idempotence without network writes during preview", async () => {
  const { network, action, request } = await prepare("reactivate");
  await fixture.db.delete(savActions).where(eq(savActions.id, action.id));
  const [before] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  const preview = await prepareSavManualTicketPreview(request, "ugo@limova.ai");
  const fresh = await readSavManualTicketPreviewContext(threadId);
  const [after] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  expect(after.bodyCiphertext).toBe(before.bodyCiphertext);
  expect(mutations(network)).toHaveLength(0);
  const signed = readSavTicketPreviewToken(preview.token, "ugo@limova.ai");
  const first = await queueSavManualTicket({ ...signed.command, previewToken: preview.token }, "ugo@limova.ai", fresh);
  const second = await queueSavManualTicket({ ...signed.command, previewToken: preview.token }, "ugo@limova.ai", fresh);
  expect(first.id).toBe(second.id);
  expect(first.payload.ticketPreviewConfirmed).toBe(true);
  expect((await processPendingHubspotActions(1)).processed[0].status).toBe("succeeded");
  expect(mutations(network)).toHaveLength(2);
});
it("rejects a stale preview before queuing a CRM command", async () => {
  const { action, request } = await prepare("reactivate");
  await fixture.db.delete(savActions).where(eq(savActions.id, action.id));
  const preview = await prepareSavManualTicketPreview(request, "ugo@limova.ai");
  const [source] = await fixture.db.select().from(savMessages).where(eq(savMessages.id, messageId));
  const body = decryptSavPayload<{ text: string; supportContext: { crm: { data: { tickets: Array<{ ownerId: string }> } } } }>(source.bodyCiphertext);
  body.supportContext.crm.data.tickets[0].ownerId = "72";
  await fixture.db.update(savMessages).set({ bodyCiphertext: encryptSavPayload(body) }).where(eq(savMessages.id, source.id));
  const signed = readSavTicketPreviewToken(preview.token, "ugo@limova.ai");
  await expect(queueSavManualTicket({ ...signed.command, previewToken: preview.token }, "ugo@limova.ai")).rejects.toThrow(/SAV_(TICKET_PREVIEW_CHANGED|VALIDATED_CURRENT_PROPOSAL_REQUIRED)/);
  expect(await fixture.db.select().from(savActions)).toHaveLength(0);
});


it("never falls back to a full email note for an unknown future note version", async () => {
  const { network, action } = await prepare("reactivate");
  await fixture.db.update(savActions).set({ payload: { ...action.payload, ticketReturnNoteVersion: 99 } }).where(eq(savActions.id, action.id));
  expect((await processPendingHubspotActions(1)).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_TICKET_RETURN_NOTE_VERSION_INVALID" });
  expect(mutations(network)).toHaveLength(0);
});
it("checks the preview contact again in the worker before any write", async () => {
  const { network, action } = await prepare("reactivate");
  await fixture.db.update(savActions).set({ payload: { ...action.payload, ticketPreviewSnapshotCiphertext: encryptSavPayload({ contactId: "other-contact", targetId: "401", targetTitle: "Connexion impossible" }) } }).where(eq(savActions.id, action.id));
  expect((await processPendingHubspotActions(1)).processed[0]).toMatchObject({ status: "failed", errorCode: "SAV_TICKET_PREVIEW_CHANGED" });
  await expect(retrySavAction(action.id, "ugo@limova.ai")).rejects.toThrow("SAV_TICKET_PREVIEW_CHANGED");
  expect(mutations(network)).toHaveLength(0);
});

it("reuses verified identical semantic evidence when the model becomes unavailable", async () => {
  const { network, action } = await prepare("reactivate"); matchingUnavailable=true;
  expect((await processPendingHubspotActions(1)).processed[0]).toMatchObject({actionId:action.id,status:"succeeded"});
  expect(network.mock.calls.filter(([url])=>url.includes("generativelanguage.googleapis.com"))).toHaveLength(1);
  expect(mutations(network)).toHaveLength(2); expect(stage).toBe("1");
});
