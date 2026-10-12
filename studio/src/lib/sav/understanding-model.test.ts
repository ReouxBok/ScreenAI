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
  it.each([402, 429, 500])("returns unavailable without retry or lexical fallback for HTTP %i", async status => {
    const network = vi.fn<typeof fetch>(async () => new Response("fixture", { status }));
    const result = await understandSavMessage({ subject: "Remboursement", body: "Je souhaite résilier et être remboursé." }, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "unavailable", requests: [], primaryRequestId: null, trace: { errorCode: `SAV_AI_HTTP_${status}` } });
  });
  it.each(["schema", "proof", "json"])("rejects invalid %s without retry", async invalid => {
    const content = understandingContent(); content.evidence[0].excerpt = "Une preuve qui n’existe pas.";
    const network = vi.fn<typeof fetch>(async () => invalid === "json" ? new Response("not-json") : geminiFixture(invalid === "schema" ? { version: 2 } : content));
    const result = await understandSavMessage(input, { apiKey: "fixture", fetch: network });
    expect(network).toHaveBeenCalledOnce(); expect(result.status).toBe("unavailable");
    expect(result.uncertainties).toContainEqual({ code: "invalid_output", requestIds: [] });
    expect(result.trace.errorCode).toMatch(/INVALID/);
  });
  it.each([false, true])("does not call the provider when disabled or missing a key: %s", disabled => {
    vi.stubEnv("SAV_AI_ANALYSIS", disabled ? "false" : "true");
    const network = vi.fn();
    return understandSavMessage(input, { apiKey: disabled ? "fixture" : "", fetch: network }).then(result => {
      expect(network).not.toHaveBeenCalled(); expect(result.status).toBe("unavailable");
      expect(result.trace.errorCode).toBe(disabled ? "SAV_AI_ANALYSIS_DISABLED" : "SAV_AI_KEY_MISSING");
    });
  });
  it("aborts at the 18 second bound without another request", async () => {
    vi.useFakeTimers();
    const network = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = understandSavMessage(input, { apiKey: "fixture", fetch: network });
    await vi.advanceTimersByTimeAsync(18_000);
    expect(await pending).toMatchObject({ status: "unavailable", trace: { errorCode: "SAV_AI_TIMEOUT", durationMs: 18_000 } });
    expect(network).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("SAV understanding bounded sources", () => {
  it("separates a quoted cancellation and signature from the current request and inherited subject", () => {
    const context = savUnderstandingSources({ subject: "Re: Résiliation", body: `${input.body}\n-- \nPersonne Fictive\nOn Tuesday, Support wrote:\nJe veux résilier mon abonnement.` });
    expect(context.sources.filter(s => s.source === "current_message")).toEqual([{ source: "current_message", sourceId: "current_body", text: input.body }]);
    expect(context.sources).toContainEqual(expect.objectContaining({ source: "history", sourceId: "quoted_history" }));
    expect(context.sources).toContainEqual(expect.objectContaining({ source: "history", sourceId: "signature_identity_only" }));
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
