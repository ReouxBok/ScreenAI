import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { coverageFixture, geminiFixture, understandingContent, understandingFixture } from "../../../test/sav-understanding-fixtures";
import { savAgentRuns, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { analyzeSavMessage } from "./intelligence";
import { decryptSavPayload, encryptSavPayload } from "./crypto";
import { defaultSavPlaybook } from "./playbook-contract";
import { savSemanticPlan, type SavUnderstandingV1 } from "./understanding";
import type { SavAgentOutput } from "./agent/contracts";
import type { SavStructuredProposal } from "./proposal";

const state = vi.hoisted(() => ({ db: null as unknown, failTrace: false, search: vi.fn(), agent: vi.fn(), crm: vi.fn(), context: vi.fn(), playbook: vi.fn(), retrieval: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.failTrace ? { insert: () => { throw new Error("fixture-db-failed"); } } : state.db }));
vi.mock("./playbook", () => ({ readActiveSavPlaybook: state.playbook }));
vi.mock("./request-retrieval-db", () => ({ searchSavKnowledgeByRequest: state.retrieval }));
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
const understanding = understandingFixture({
  requests: [{ id: "request-1", summary: input.body, nature: "how_to", financialScope: "none", product: null, feature: "couleur", evidenceIds: ["evidence-1"] }],
  evidence: [{ id: "evidence-1", source: "current_message", sourceId: "current_body", excerpt: input.body }],
});
function outputFor(u = understanding): SavAgentOutput {
  const coverage = coverageFixture(u).map(part => ({ ...part, text: u.language === "en"
    ? `The team needs to review your request: ${u.requests.find(request => request.id === part.requestId)!.summary.replace(/\?/g, ".")}` : part.text.replace(/\?/g, ".") }));
  return { category: savSemanticPlan(u).category, urgency: "normal", ticketRequired: true,
    reasonCode: "needs_context", explanation: "Le dossier nécessite une vérification humaine.", confidence: 0.99,
    requiresHuman: true, replyDraft: coverage.map(part => part.text).join("\n\n"), internalNote: "Dossier interne fictif.",
    responseKind: "handoff", coverage, citations: [], evidenceIds: [] };
}
function successfulGeneration(u = understanding) {
  network.mockResolvedValueOnce(geminiFixture(understandingContent(u)))
    .mockResolvedValueOnce(geminiFixture(outputFor(u)))
    .mockResolvedValueOnce(geminiFixture({ passed: true, coveredRequestIds: u.requests.map(request => request.id), issues: [] }));
}
const phases = ["understanding", "composition", "coherence"] as const;
type Phase = typeof phases[number];
function beforeFailure(phase: Phase) {
  if (phase !== "understanding") network.mockResolvedValueOnce(geminiFixture(understandingContent(understanding)));
  if (phase === "coherence") network.mockResolvedValueOnce(geminiFixture(outputFor()));
}
function promptAt(index: number): string { return JSON.parse(network.mock.calls[index][1].body).contents[0].parts[0].text; }
async function runs() { return fixture.db.select().from(savAgentRuns).where(eq(savAgentRuns.messageId, messageId)); }
async function persistedProposal() { return decryptSavPayload<SavStructuredProposal>((await runs())[0].proposalCiphertext!); }
async function expectFailedPhase(phase: Phase, code: string) {
  const result = await analyzeSavMessage(input, { messageId });
  expect(result.proposal).toMatchObject({ requiresHumanApproval: true, reasonCode: phase === "understanding" ? "understanding_unavailable" : "analysis_unverified" });
  const recorded = await runs();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ status: "fallback", runtime: phase === "understanding" ? "semantic_policy" : "legacy_gemini", model: "fixture-model", errorCode: code });
  if (phase === "composition") expect(recorded[0].fallbackRuntime).toBe("rules");
  const snapshot = await persistedProposal();
  expect(snapshot.replyAssessment?.errorCode).toBe(code);
  if (phase === "understanding") {
    expect(snapshot.understanding).toMatchObject({ status: "unavailable", trace: { errorCode: code } });
    expect(snapshot.replyDraft).toBeNull();
    expect(state.search).not.toHaveBeenCalled();
  } else {
    expect(snapshot.understanding).toMatchObject({ status: "qualified", trace: { errorCode: null } });
    expect(snapshot.replyAssessment?.kind).toBe("human_handoff");
    expect(snapshot.replyDraft).not.toBe(outputFor().replyDraft);
    expect(snapshot.replyDraft).toContain(input.body);
    if (phase === "coherence") expect(snapshot.replyAssessment?.coherence).toMatchObject({ status: "unavailable", errorCode: code });
  }
  expect(network).toHaveBeenCalledTimes(phases.indexOf(phase) + 1 + (["SAV_AI_TIMEOUT", "SAV_AI_GENERATION_FAILED", "SAV_AI_HTTP_429", "SAV_AI_HTTP_503"].includes(code) ? 1 : 0) + (phase === "understanding" && code === "SAV_AI_INVALID_SCHEMA" ? 1 : 0) + (phase === "composition" && ["SAV_AI_INVALID_SCHEMA", "SAV_AI_INVALID_JSON"].includes(code) ? 2 : 0));
  expect(state.agent).not.toHaveBeenCalled();
}

beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30_000);
afterAll(async () => { await fixture.client.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); warnings.mockRestore(); errors.mockRestore(); });
beforeEach(async () => {
  vi.resetAllMocks(); state.failTrace = false;
  state.playbook.mockResolvedValue({ versionId: "existing-process-v1", version: 0, document: defaultSavPlaybook });
  state.retrieval.mockImplementation(async options => {
    let failed = false;
    for (const request of options.requests) try { await state.search({ query: [request.product, request.feature, request.summary].filter(Boolean).join(" — "), locale: options.locale }); } catch { failed = true; }
    return { contractRevision: "fixture", revision: "offline", requests: options.requests.map((r: { id: string }) => ({ requestId: r.id, status: failed ? "search_unavailable" : "no_source", candidateKeys: [], limitations: [] })), sources: [], alerts: [], metrics: { attempts: 1, queryCount: options.requests.length, embeddingBatchesUpperBound: 1, serializedBytes: 100, contextTextTokensUpperBound: 100 } };
  });
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
  const [message] = await fixture.db.insert(savMessages).values({ mailboxId: mailbox.id, threadId: thread.id, direction: "inbound", fromEmail: input.from, bodyCiphertext: encryptSavPayload({text:input.body}), receivedAt: new Date() }).returning();
  messageId = message.id;
});

describe("SAV generation diagnostics on isolated PostgreSQL", () => {
  it("reads CRM before generation and includes its result in the prompt and encrypted snapshot", async () => {
    successfulGeneration();
    await analyzeSavMessage(input, { messageId });
    expect(state.crm.mock.invocationCallOrder[0]).toBeLessThan(network.mock.invocationCallOrder[0]);
    const qualification = JSON.parse(promptAt(0));
    expect(qualification.sources).toContainEqual({ source: "crm", sourceId: "crm_snapshot", text: JSON.stringify(await state.crm.mock.results[0].value) });
    expect(JSON.parse(promptAt(1)).context.payload.crm).toMatchObject({ contactFound: true, status: "ready" });
    expect(network).toHaveBeenCalledTimes(3);
    expect((await persistedProposal()).dossierContext?.crm.data?.contactId).toBe("31");
  });
  it("prepares a contextual proposal in V0 even when the thread is paused, keeping human approval mandatory", async () => {
    vi.stubEnv("SAV_RELEASE_STAGE", "v0");
    state.context.mockResolvedValue({ senderMatchesCustomer: false, aiPaused: true });
    successfulGeneration();
    const analysis = await analyzeSavMessage(input, { messageId });
    expect(network).toHaveBeenCalledTimes(3);
    expect(analysis.understanding?.requests[0].summary).toBe(input.body);
    expect(analysis.replyDraft).toMatch(/^Bonjour,/);
    expect(analysis.replyDraft).toMatch(/Bien à vous,$/);
    expect(analysis.replyDraft).toContain("Sur quel produit");
    expect(analysis.replyAssessment?.coherence?.status).toBe("passed");
    expect(analysis.proposal).toMatchObject({ kind: "human_review_required", requiresHumanApproval: true });
    expect(analysis.structuredProposal?.dossierContext?.crm.data?.contactId).toBe("31");
  });
  it("persists separated current declarations and provenance while the original remains untouched", async () => {
    const body = "Hello, how can I invite 3 users?\nI am available Tuesday at 14:00.\nOn Tuesday, Support wrote:\nPlease cancel my subscription.";
    const u: SavUnderstandingV1 = understandingFixture({ language: "en",
      requests: [{ id: "request-1", summary: "How can I invite 3 users?", nature: "how_to", financialScope: "none", product: null, feature: "user invitations", evidenceIds: ["evidence-1"] }],
      knownFacts: [{ id: "fact-users", key: "access_count", text: "3 users", evidenceIds: ["evidence-1"] }, { id: "fact-availability", key: "callback_availability", text: "Tuesday at 14:00", evidenceIds: ["evidence-2"] }],
      evidence: [{ id: "evidence-1", source: "current_message", sourceId: "current_body", excerpt: "Hello, how can I invite 3 users?" }, { id: "evidence-2", source: "current_message", sourceId: "current_body", excerpt: "I am available Tuesday at 14:00." }],
    });
    successfulGeneration(u);
    const result = await analyzeSavMessage({ ...input, subject: "Re: Account", body }, { messageId });
    expect(JSON.parse(promptAt(0)).sources).toEqual(expect.arrayContaining([
      { source: "current_message", sourceId: "current_body", text: "Hello, how can I invite 3 users?\nI am available Tuesday at 14:00." },
      expect.objectContaining({ source: "history", sourceId: "quoted_history", text: expect.stringContaining("cancel my subscription") }),
    ]));
    expect(JSON.parse(promptAt(1)).context.payload.current.text).toContain("Hello, how can I invite 3 users?");
    expect(state.search).toHaveBeenCalledWith(expect.objectContaining({ locale: "en-US", query: expect.not.stringContaining("cancel my subscription") }));
    const snapshot = await persistedProposal();
    expect(snapshot.messageContext?.currentText).not.toContain("cancel");
    expect(snapshot.messageContext?.quotedText).toContain("cancel my subscription");
    expect(snapshot.messageContext?.facts).toEqual([]);
    expect(snapshot.understanding?.knownFacts).toEqual(u.knownFacts);
    expect(snapshot.understanding?.evidence).toEqual(u.evidence);
    expect(snapshot.understanding?.requests).toEqual(u.requests);
    expect(snapshot.replyAssessment?.coherence?.status).toBe("passed");
    expect(result.structuredProposal?.ticket.description).toBe(body);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(body);
  });
  it.each(phases.flatMap(phase => [401, 402, 404, 429, 503].map(status => ({ phase, status }))))("retains HTTP $status during $phase without recording false success", async ({ phase, status }) => {
    beforeFailure(phase);
    network.mockResolvedValueOnce(new Response("private provider body", { status }));
    if ([429, 503].includes(status)) network.mockResolvedValueOnce(new Response("private provider body", { status }));
    await expectFailedPhase(phase, `SAV_AI_HTTP_${status}`);
    const log = JSON.stringify(warnings.mock.calls);
    if (phase !== "coherence") expect(log).toContain(`SAV_AI_HTTP_${status}`);
    expect(log).not.toContain(input.from);
    expect(log).not.toContain(input.body); expect(log).not.toContain("private provider body"); expect(log).not.toContain("fixture-not-a-real-key");
  });
  it.each(phases.flatMap(phase => [
    ["invalid-json", "SAV_AI_INVALID_JSON"], ["invalid-schema", "SAV_AI_INVALID_SCHEMA"],
    ["abort", "SAV_AI_TIMEOUT"], ["network", "SAV_AI_GENERATION_FAILED"],
  ].map(([kind, code]) => ({ phase, kind, code }))))("distinguishes $kind during $phase with no raw provider message", async ({ phase, kind, code }) => {
    beforeFailure(phase);
    if (kind === "invalid-json") network.mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: "not JSON" }] } }] }));
    if (kind === "invalid-schema") network.mockResolvedValueOnce(geminiFixture({ private: "customer@example.com" }));
    if (kind === "abort") { const error = new Error("private provider text"); error.name = "AbortError"; network.mockRejectedValueOnce(error).mockRejectedValueOnce(error); }
    if (kind === "network") network.mockRejectedValueOnce(new Error("customer@example.com key=private-credential")).mockRejectedValueOnce(new Error("private retry failure"));
    await expectFailedPhase(phase, code);
    expect(JSON.stringify(warnings.mock.calls)).not.toMatch(/customer@example.com|private-credential|private provider text/);
  });
  it("records a missing key instead of a successful rules-only analysis", async () => {
    vi.stubEnv("SAV_GEMINI_API_KEY", ""); await analyzeSavMessage(input, { messageId });
    expect((await runs())[0]).toMatchObject({ status: "fallback", errorCode: "SAV_AI_KEY_MISSING" });
    expect(network).not.toHaveBeenCalled();
    expect(state.search).not.toHaveBeenCalled(); expect(state.agent).not.toHaveBeenCalled();
    expect((await persistedProposal()).understanding).toMatchObject({ status: "unavailable", trace: { errorCode: "SAV_AI_KEY_MISSING" } });
  });
  it("keeps a failed knowledge lookup distinct and requires human review", async () => {
    state.search.mockRejectedValue(new Error("provider private-credential")); successfulGeneration();
    const result = await analyzeSavMessage(input, { messageId });
    expect(result.proposal.requiresHumanApproval).toBe(true);
    expect((await runs())[0]).toMatchObject({ status: "fallback", errorCode: "SAV_KNOWLEDGE_LOOKUP_FAILED" });
    expect(network).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("private-credential");
  });
  it("keeps a verified JSON analysis separate from a provider failure", async () => {
    successfulGeneration(); await analyzeSavMessage(input, { messageId });
    expect(network).toHaveBeenCalledTimes(3);
    expect((await runs())[0]).toMatchObject({ status: "succeeded", errorCode: null, runtime: "legacy_gemini", inputTokens: 30, outputTokens: 60, totalTokens: 90 });
    expect((await persistedProposal()).replyAssessment?.coherence?.status).toBe("passed");
    expect(warnings).not.toHaveBeenCalled();
  });
  it("keeps cancellation draft-free in the persisted proposal even if CRM fails", async () => {
    state.crm.mockRejectedValue(new Error("fixture CRM unavailable"));
    const body = "Je souhaite résilier mon abonnement.";
    const u = understandingFixture({ requests: [{ ...understanding.requests[0], nature: "cancellation", summary: body, feature: null }],
      evidence: [{ id: "evidence-1", source: "current_message", sourceId: "current_body", excerpt: body }] });
    network.mockResolvedValueOnce(geminiFixture(understandingContent(u)));
    const result = await analyzeSavMessage({ ...input, subject: "Résiliation", body }, { messageId });
    expect(result.replyDraft).toBeNull();
    const snapshot = await persistedProposal();
    expect(snapshot.replyDraft).toBeNull();
    expect(snapshot.understanding?.requests).toEqual(u.requests);
    expect(snapshot.replyAssessment).toMatchObject({ kind: "forbidden", errorCode: null });
    expect(snapshot.dossierContext?.crm.status).toBe("error");
    expect(network).toHaveBeenCalledOnce(); expect(state.search).not.toHaveBeenCalled(); expect(state.agent).not.toHaveBeenCalled();
  });
  it("does not run a second model after the required trace write fails", async () => {
    vi.stubEnv("SAV_ADK_MODE", "on"); state.failTrace = true;
    network.mockResolvedValueOnce(geminiFixture(understandingContent(understanding))).mockResolvedValueOnce(geminiFixture(outputFor()));
    state.agent.mockResolvedValue({ output: outputFor(), evidence: [], toolTrace: [], model: "fixture-model", knowledgeRevision: "not_consulted",
      promptRevision: "fixture-prompt", inputHash: "fixture-input", outputHash: "fixture-output", durationMs: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30,
      ticketRouting: { kind: "new", contactId: "31", reason: "fixture" } });
    await expect(analyzeSavMessage(input, { messageId })).rejects.toThrow("SAV_ANALYSIS_TRACE_REQUIRED");
    expect(state.agent).not.toHaveBeenCalled(); expect(state.search).toHaveBeenCalledOnce(); expect(network).toHaveBeenCalledTimes(2);
    expect(await runs()).toEqual([]);
    expect(errors).toHaveBeenCalledWith("sav_agent_trace_write_failed", { errorCode: "Error" });
  });
});
