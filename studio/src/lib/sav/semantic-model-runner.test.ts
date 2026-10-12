import { describe, expect, it, vi } from "vitest";
import { assertSavEvaluationEnvironment, createSavEvaluationFetch, runSavPrivateModelCase, type SavEvaluationRequest, type SavIsolatedAnalysis } from "./semantic-model-runner";

describe("private semantic model runner isolation", () => {
  const env = { SAV_EVAL_ALLOW_MODEL_CALLS: "1", SAV_EVAL_GEMINI_API_KEY: "synthetic-evaluation-key" };
  it("requires explicit opt-in and a dedicated key, rejects operational credentials", () => {
    expect(() => assertSavEvaluationEnvironment({})).toThrow("SAV_SEMANTIC_EXPLICIT_MODEL_OPT_IN_REQUIRED");
    expect(() => assertSavEvaluationEnvironment(env)).not.toThrow();
    for (const key of ["DATABASE_URL", "DIRECT_URL", "POSTGRES_URL", "NEON_DATABASE_URL", "PGPASSWORD", "HUBSPOT_ACCESS_TOKEN", "GMAIL_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS", "SAV_GEMINI_API_KEY", "GEMINI_API_KEY"]) {
      expect(() => assertSavEvaluationEnvironment({ ...env, [key]: "synthetic-forbidden" })).toThrow("SAV_SEMANTIC_PRODUCTION_ENV_FORBIDDEN");
    }
  });
  it("blocks every non-model destination and follows no redirect", async () => {
    const realFetch = vi.fn(async () => new Response(JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2 }, responseId: "fixture-request" }), { status: 200 }));
    const requests: SavEvaluationRequest[] = [];
    const fetch = createSavEvaluationFetch({ apiKey: env.SAV_EVAL_GEMINI_API_KEY, model: "fixture-model", fetch: realFetch, requests });
    for (const url of ["https://api.hubapi.com/crm/v3/objects/tickets", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", "https://generativelanguage.googleapis.com/v1beta/models/other:generateContent?key=synthetic-evaluation-key", "https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent?key=wrong"]) {
      await expect(fetch(url, { method: "POST" })).rejects.toThrow("SAV_SEMANTIC_EXTERNAL_REQUEST_BLOCKED");
    }
    expect(realFetch).not.toHaveBeenCalled();
    await fetch("https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent?key=synthetic-evaluation-key", { method: "POST" });
    expect(realFetch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ redirect: "error" }));
    expect(requests[0]).toMatchObject({ inputTokens: 10, outputTokens: 6, requestId: "fixture-request", status: 200 });
    expect(JSON.stringify(requests)).not.toContain(env.SAV_EVAL_GEMINI_API_KEY);
  });
  it("keeps absent usage unknown and captures streamed SDK usage", async () => {
    const requests: SavEvaluationRequest[] = [];
    const realFetch = vi.fn().mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response('data: {"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2},"responseId":"sdk-fixture"}\n\n'));
    const fetch = createSavEvaluationFetch({ apiKey: env.SAV_EVAL_GEMINI_API_KEY, model: "fixture-model", fetch: realFetch, requests });
    const url = "https://generativelanguage.googleapis.com/v1beta/models/fixture-model:streamGenerateContent?alt=sse";
    await fetch(url, { method: "POST", headers: { "x-goog-api-key": env.SAV_EVAL_GEMINI_API_KEY } });
    await fetch(url, { method: "POST", headers: { "x-goog-api-key": env.SAV_EVAL_GEMINI_API_KEY } });
    expect(requests[0]).toMatchObject({ inputTokens: null, outputTokens: null, requestId: null });
    expect(requests[1]).toMatchObject({ inputTokens: 3, outputTokens: 2, requestId: "sdk-fixture" });
  });
  it("uses only fixture adapters and never supplies expected outcomes or creates human reviews", async () => {
    const input = { id: "synthetic-case", input: { from: "person@example.invalid", subject: "Synthetic", body: "Synthetic example." }, knowledge: { revision: "synthetic", results: [] }, crm: { contactFound: false } };
    const analyze: SavIsolatedAnalysis = vi.fn(async (_, context) => {
      expect(context).not.toHaveProperty("messageId");
      expect(context).not.toHaveProperty("pilotBatchId");
      expect(context.evaluation.pilot).toBe(true);
      expect(await context.evaluation.searchKnowledge()).toEqual(input.knowledge);
      expect(await context.evaluation.readHubspotContext()).toEqual(input.crm);
      return { understanding: { status: "needs_clarification" } };
    });
    const result = await runSavPrivateModelCase(input, { apiKey: env.SAV_EVAL_GEMINI_API_KEY, model: "fixture-model", mode: "pilot", analyze, fetch: vi.fn() });
    expect(result.humanReview).toBeNull();
    expect(result.requests).toEqual([]);
    expect(analyze).toHaveBeenCalledOnce();
  });
  it("retains failed request attempts with unknown usage rather than a fabricated zero", async () => {
    const requests: SavEvaluationRequest[] = [];
    const fetch = createSavEvaluationFetch({ apiKey: env.SAV_EVAL_GEMINI_API_KEY, model: "fixture-model", fetch: vi.fn(async () => { throw new Error("synthetic transport failure"); }), requests });
    await expect(fetch("https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent?key=synthetic-evaluation-key", { method: "POST" })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ status: null, errorCode: "transport_failure", inputTokens: null, outputTokens: null });
  });
});
