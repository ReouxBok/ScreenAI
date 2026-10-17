import { afterEach, describe, expect, it, vi } from "vitest";
import { savUnderstandingSources, understandSavMessage } from "./understanding-model";
import { geminiFixture, understandingContent } from "../../../test/sav-understanding-fixtures";
import type { SavConversation } from "./conversation";

const input = { subject: "Téléphone", body: "L’agent téléphone cesse de répondre." };
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("SAV understanding provider boundary", () => {
  it("performs one request and retains source, prompt, usage and hash provenance", async () => {
    const network = vi.fn<typeof fetch>(async () => geminiFixture(understandingContent()));
    const result = await understandSavMessage(input, { apiKey: "fixture-key", model: "fixture-model", fetch: network });
    expect(network).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "qualified", trace: { model: "fixture-model", inputTokens: 10, outputTokens: 20, totalTokens: 30, errorCode: null } });
    expect(result.trace.inputHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const request = JSON.parse(String(network.mock.calls[0]?.[1]?.body));
    expect(request.generationConfig).toMatchObject({ temperature: 0, maxOutputTokens: 8192 });
    expect(request.tools).toBeUndefined();
    expect(JSON.parse(request.contents[0].parts[0].text).sources).toContainEqual({ source: "current_message", sourceId: "current_body", text: input.body });
  });
  it.each([402, 429, 500])("applies only the bounded transient retry and returns unavailable for HTTP %i", async status => {
    const network = vi.fn<typeof fetch>(async () => new Response("fixture", { status }));
    const result = await understandSavMessage({ subject: "Remboursement", body: "Je souhaite résilier et être remboursé." }, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(status === 429 ? 2 : 1);
    expect(result).toMatchObject({ status: "unavailable", requests: [], primaryRequestId: null, trace: { errorCode: `SAV_AI_HTTP_${status}` } });
  });
  it.each(["schema", "proof", "json"])("rejects invalid %s after at most one contract recovery", async invalid => {
    const content = understandingContent(); content.evidence[0].excerpt = "Une preuve qui n’existe pas.";
    const network = vi.fn<typeof fetch>(async () => invalid === "json" ? new Response("not-json") : geminiFixture(invalid === "schema" ? { version: 2 } : content));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledTimes(invalid === "json" ? 1 : 2); expect(result.status).toBe("unavailable");
    expect(result.uncertainties).toContainEqual({ code: "invalid_output", requestIds: [] });
    expect(result.trace.errorCode).toMatch(/INVALID|REPAIR_REJECTED/);
  });
  it.each([false, true])("does not call the provider when disabled or missing a key: %s", disabled => {
    vi.stubEnv("SAV_AI_ANALYSIS", disabled ? "false" : "true");
    const network = vi.fn();
    return understandSavMessage(input, { apiKey: disabled ? "fixture" : "", fetch: network }).then(result => {
      expect(network).not.toHaveBeenCalled(); expect(result.status).toBe("unavailable");
      expect(result.trace.errorCode).toBe(disabled ? "SAV_AI_ANALYSIS_DISABLED" : "SAV_AI_KEY_MISSING");
    });
  });
  it("aborts two full 18 second attempts within the 37 second phase bound", async () => {
    vi.useFakeTimers();
    const network = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = understandSavMessage(input, { apiKey: "fixture", fetch: network });
    await vi.advanceTimersByTimeAsync(37_000);
    const result = await pending;
    expect(result).toMatchObject({ status: "unavailable", trace: { errorCode: "SAV_AI_TIMEOUT" } });
    expect(result.trace.durationMs).toBeGreaterThanOrEqual(36_000);
    expect(result.trace.durationMs).toBeLessThanOrEqual(37_000);
    expect(network).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("SAV understanding bounded sources", () => {
  it("separates a quoted cancellation and signature from the current request and inherited subject", () => {
    const context = savUnderstandingSources({ subject: "Re: Résiliation", body: `${input.body}\n-- \nPersonne Fictive\nOn Tuesday, Support wrote:\nJe veux résilier mon abonnement.` });
    expect(context.sources.filter(s => s.source === "current_message")).toEqual([{ source: "current_message", sourceId: "current_body", text: input.body }]);
    expect(context.sources).toContainEqual(expect.objectContaining({ source: "history", sourceId: "quoted_history" }));
    expect(context.sources).toContainEqual(expect.objectContaining({ source: "history", sourceId: "signature_identity_only" }));
  });
  it("keeps selected-ticket notes ahead of long older history and excludes candidate-only notes", () => {
    const event = { sourceId: "hubspot:notes:1", ticketId: "99", kind: "note" as const, occurredAt: "2026-10-14T00:00:00Z", updatedAt: null, text: "Version déjà confirmée", truncated: false };
    const context = savUnderstandingSources({ ...input, dossierContext: { version: 1, messageId: "fixture", collectedAt: "2026-10-16T00:00:00Z", customerIdentity: { kind: "sender", email: "fixture@example.invalid" },
      crm: { status: "ready", errorCode: null, data: { contactFound: true, contactId: "42", tickets: [], routing: { kind: "new", reason: "fixture" }, history: { ticketIds: ["99", "98"], relevantTicketId: "99", limitations: [], events: [event, { ...event, sourceId: "candidate-only", ticketId: "98", text: "Unrelated private note" }] } } },
      conversation: { threadId: "fixture", currentMessageId: "current", hubspotTicketId: "99", status: "open", aiPaused: false, senderMatchesCustomer: true, messages: Array.from({ length: 10 }, (_, i) => ({ id: `old-${i}`, direction: "inbound", from: "fixture@example.invalid", receivedAt: "2026-10-12T00:00:00Z", text: "a".repeat(16000), truncated: false })), olderSummary: [], historyTruncated: false, attachmentNotice: "Not read" },
      conversationError: null, otherConversations: [], otherConversationsError: null } });
    expect(context.sources).toContainEqual(expect.objectContaining({ sourceId: event.sourceId, text: expect.stringContaining(event.text) }));
    expect(JSON.stringify(context.sources)).not.toContain("Unrelated private note");
    expect(context.truncated).toBe(true);
  });
  it("enforces the source budget and preserves the explicit truncation signal", async () => {
    const conversation: SavConversation = { threadId: "fixture", currentMessageId: "current", hubspotTicketId: null, status: "open", aiPaused: false, senderMatchesCustomer: true,
      messages: Array.from({ length: 10 }, (_, i) => ({ id: `old-${i}`, direction: "inbound", from: "fixture@example.invalid", receivedAt: "2026-10-12T00:00:00Z", text: "a".repeat(16000), truncated: false })), olderSummary: [], historyTruncated: false, attachmentNotice: "Not read" };
    const context = savUnderstandingSources({ ...input, conversation });
    expect(context.sources.reduce((sum, s) => sum + s.text.length, 0)).toBeLessThanOrEqual(40000);
    expect(context.sources.every(s => s.text.length <= 16000)).toBe(true); expect(context.truncated).toBe(true);
    const result = await understandSavMessage({ ...input, conversation }, { apiKey: "fixture", fetch: vi.fn<typeof fetch>(async () => geminiFixture(understandingContent())) });
    expect(result.uncertainties).toContainEqual({ code: "truncated_context", requestIds: [] });
  });
});

it("repairs only the model citation before deriving the server-owned card reference", async () => {
  const valid = understandingContent();
  valid.attemptedSteps = [{ id: "attempt-1", key: "open", checkId: "open", checkCardId: null, checkVersionId: "v1", outcome: "not_expected", text: input.body, evidenceIds: ["evidence-1"] }];
  const invalid = structuredClone(valid); invalid.evidence[0].excerpt = "Une paraphrase non présente.";
  let calls = 0;
  const conversation: SavConversation = { threadId: "fixture", currentMessageId: "current", hubspotTicketId: null, status: "open", aiPaused: false, senderMatchesCustomer: true,
    messages: [], olderSummary: [], historyTruncated: false, attachmentNotice: "Not read", diagnosticChecks: [{ cardId: "card", id: "open", versionId: "v1", instruction: "Contrôle fictif", expectedResult: "Résultat fictif", messageId: "sent" }] };
  const result = await understandSavMessage({ ...input, conversation }, { apiKey: "fixture", fetch: vi.fn<typeof fetch>(async () => geminiFixture(calls++ ? valid : invalid)) });
  expect(calls).toBe(2);
  expect(result.status).toBe("qualified");
  expect(result.trace.validationRepair?.succeeded).toBe(true);
  expect(result.attemptedSteps[0].checkCardId).toBe("card");
});
