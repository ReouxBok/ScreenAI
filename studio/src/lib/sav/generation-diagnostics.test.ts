import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savAgentRuns, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { analyzeSavMessage } from "./intelligence";
import { decryptSavPayload } from "./crypto";

const state = vi.hoisted(() => ({ db: null as unknown, failTrace: false, search: vi.fn(), agent: vi.fn(), crm: vi.fn(), context: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.failTrace ? { insert: () => { throw new Error("fixture-db-failed"); } } : state.db }));
vi.mock("@/lib/search", () => ({ searchKnowledge: state.search }));
vi.mock("./agent/orchestrator", () => ({ runSavAdkAgent: state.agent }));
vi.mock("./hubspot", () => ({ readSavHubspotContext: state.crm }));
vi.mock("./conversation", () => ({ loadSavConversation: state.context }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
let messageId: string;
let warnings: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
const input = { from: "fiction@example.invalid", subject: "Utilisation", body: "Comment changer la couleur ?" };
const network = vi.fn();
const validOutput = { category: "how_to", urgency: "normal", ticketRequired: true,
  reasonCode: "needs_context", explanation: "Le dossier nécessite une vérification humaine.", confidence: 0.99,
  requiresHuman: true, replyDraft: "", internalNote: "Dossier interne fictif.", responseKind: "none", citations: [] };
function response(output: unknown) { return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] }); }
async function runs() { return fixture.db.select().from(savAgentRuns).where(eq(savAgentRuns.messageId, messageId)); }

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); warnings.mockRestore(); errors.mockRestore(); });
beforeEach(async () => {
  vi.resetAllMocks(); state.failTrace = false;
  vi.stubEnv("SAV_ADK_MODE", "pilot"); vi.stubEnv("SAV_AI_ANALYSIS", "true");
  vi.stubEnv("SAV_GEMINI_API_KEY", "fixture-not-a-real-key"); vi.stubEnv("SAV_AI_MODEL", "fixture-model");
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "test-only-generation-diagnostics-key-32-characters");
  vi.stubGlobal("fetch", network);
  warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  network.mockImplementation(() => { throw new Error("Unexpected fixture network call"); });
  state.search.mockResolvedValue({ revision: "offline", results: [] });
  state.context.mockResolvedValue({ senderMatchesCustomer: true, aiPaused: false });
  state.crm.mockResolvedValue({ contactFound: true, contactId: "31", tickets: [], routing: { kind: "new", reason: "fixture" } });
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE");
  const [mailbox] = await fixture.db.insert(savMailboxes).values({ email: "contact@limova.ai" }).returning();
  const [thread] = await fixture.db.insert(savThreads).values({ mailboxId: mailbox.id, gmailThreadId: "fixture", subject: input.subject, customerEmail: input.from }).returning();
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, direction: "inbound", fromEmail: input.from, bodyCiphertext: "fixture-unused", receivedAt: new Date() }).returning();
  messageId = message.id;
});

describe("SAV generation diagnostics on isolated PostgreSQL", () => {
  it("persists separated current declarations and provenance while the original remains untouched", async () => {
    const body = "Hello, how can I invite 3 users?\nI am available Tuesday at 14:00.\nOn Tuesday, Support wrote:\nPlease cancel my subscription.";
    network.mockResolvedValue(response(validOutput));
    const result = await analyzeSavMessage({ ...input, subject: "Re: Account", body }, { messageId });
    const [, init] = network.mock.calls[0];
    const request = JSON.parse(init.body);
    expect(request.contents[0].parts[0].text).toContain("DERNIER TEXTE ENTRANT:\nHello, how can I invite 3 users?");
    expect(state.search).toHaveBeenCalledWith(expect.objectContaining({ locale: "en-US", query: expect.not.stringContaining("cancel my subscription") }));
    const run = (await runs())[0];
    const snapshot = decryptSavPayload<{ messageContext: { currentText: string; quotedText: string; facts: Array<{ kind: string }> } }>(run.proposalCiphertext!);
    expect(snapshot.messageContext.currentText).not.toContain("cancel");
    expect(snapshot.messageContext.quotedText).toContain("cancel my subscription");
    expect(snapshot.messageContext.facts.map(fact => fact.kind)).toEqual(["access_count", "callback_availability"]);
    expect(result.structuredProposal?.ticket.description).toBe(body);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(body);
  });
  it.each([401, 404, 429, 503])("retains HTTP %s without recording a successful generation", async status => {
    network.mockResolvedValue(new Response("private provider body", { status }));
    const result = await analyzeSavMessage(input, { messageId });
    expect(result.proposal).toMatchObject({ requiresHumanApproval: true, reasonCode: "analysis_unverified" });
    expect((await runs())[0]).toMatchObject({ status: "fallback", runtime: "legacy_gemini", model: "fixture-model", fallbackRuntime: "rules", errorCode: `SAV_AI_HTTP_${status}` });
    expect(state.agent).not.toHaveBeenCalled();
    const log = JSON.stringify(warnings.mock.calls);
    expect(log).toContain(`SAV_AI_HTTP_${status}`); expect(log).not.toContain(input.from);
    expect(log).not.toContain(input.body); expect(log).not.toContain("private provider body"); expect(log).not.toContain("fixture-not-a-real-key");
  });
  it.each([
    ["invalid-json", "SAV_AI_INVALID_JSON"], ["invalid-schema", "SAV_AI_INVALID_SCHEMA"],
    ["abort", "SAV_AI_TIMEOUT"], ["network", "SAV_AI_GENERATION_FAILED"],
  ])("distinguishes %s with no raw provider message", async (kind, code) => {
    if (kind === "invalid-json") network.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "not JSON" }] } }] }));
    if (kind === "invalid-schema") network.mockResolvedValue(response({ private: "customer@example.com" }));
    if (kind === "abort") { const error = new Error("private provider text"); error.name = "AbortError"; network.mockRejectedValue(error); }
    if (kind === "network") network.mockRejectedValue(new Error("customer@example.com key=private-credential"));
    await analyzeSavMessage(input, { messageId });
    expect((await runs())[0]).toMatchObject({ status: "fallback", errorCode: code });
    expect(JSON.stringify(warnings.mock.calls)).not.toMatch(/customer@example.com|private-credential|private provider text/);
  });
  it("records a missing key instead of a successful rules-only analysis", async () => {
    vi.stubEnv("SAV_GEMINI_API_KEY", ""); await analyzeSavMessage(input, { messageId });
    expect((await runs())[0]).toMatchObject({ status: "fallback", errorCode: "SAV_AI_KEY_MISSING" });
    expect(network).not.toHaveBeenCalled();
  });
  it("keeps a failed knowledge lookup distinct and requires human review", async () => {
    state.search.mockRejectedValue(new Error("provider private-credential")); network.mockResolvedValue(response(validOutput));
    const result = await analyzeSavMessage(input, { messageId });
    expect(result.proposal.requiresHumanApproval).toBe(true);
    expect((await runs())[0]).toMatchObject({ status: "fallback", errorCode: "SAV_KNOWLEDGE_LOOKUP_FAILED" });
  });
  it("keeps a verified JSON analysis separate from a provider failure", async () => {
    network.mockResolvedValue(response(validOutput)); await analyzeSavMessage(input, { messageId });
    expect((await runs())[0]).toMatchObject({ status: "succeeded", errorCode: null, runtime: "legacy_gemini" });
    expect(warnings).not.toHaveBeenCalled();
  });
  it("keeps cancellation draft-free in the persisted proposal even if CRM fails", async () => {
    state.crm.mockRejectedValue(new Error("fixture CRM unavailable"));
    const result = await analyzeSavMessage({ ...input, subject: "Résiliation", body: "Je souhaite résilier mon abonnement." }, { messageId });
    expect(result.replyDraft).toBeNull();
    const run = (await runs())[0];
    expect(decryptSavPayload<{ replyDraft: string | null }>(run.proposalCiphertext!).replyDraft).toBeNull();
    expect(network).not.toHaveBeenCalled(); expect(state.agent).not.toHaveBeenCalled();
  });
  it("does not run a second model after the required trace write fails", async () => {
    vi.stubEnv("SAV_ADK_MODE", "on"); state.failTrace = true;
    state.agent.mockResolvedValue({ output: validOutput, evidence: [], toolTrace: [], model: "fixture-model", knowledgeRevision: "not_consulted", ticketRouting: { kind: "new", contactId: "31", reason: "fixture" } });
    await expect(analyzeSavMessage(input, { messageId })).rejects.toThrow("SAV_ANALYSIS_TRACE_REQUIRED");
    expect(state.agent).toHaveBeenCalledTimes(1); expect(state.search).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
});
