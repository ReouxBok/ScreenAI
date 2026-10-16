import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ collect: vi.fn(), analyze: vi.fn() }));
vi.mock("./dossier-context", () => ({ collectSavDossierContext: mocks.collect }));
vi.mock("./intelligence", () => ({ analyzeSavMessage: mocks.analyze }));
import { analyzeStoredSavMessage } from "./service";
import { requestSavGeminiJson, SAV_AI_BUDGET, withSavAiBudget, type SavAiPhase } from "./gemini-transport";

const network = vi.fn(async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }] }));
const traces: string[] = [];
async function request(phase: SavAiPhase) {
  const response = await requestSavGeminiJson({ phase, apiKey: "synthetic-only-key", model: "synthetic-model", fetch: network,
    body: { contents: [{ role: "user", parts: [{ text: "Synthetic budget test" }] }], generationConfig: { maxOutputTokens: 256 } } });
  traces.push(response.metadata.transport!.correlationId);
}
beforeEach(() => {
  vi.clearAllMocks(); traces.length = 0;
  mocks.collect.mockImplementation(async () => { await request("ticket_matching"); return { marker: "collected" }; });
});
const input = { from: "client@example.invalid", subject: "Synthetic", body: "Synthetic request" };
const context = { messageId: "10000000-0000-4000-8000-000000000001" };
it("shares one correlation and allowance between persisted CRM collection and nested analysis", async () => {
  mocks.analyze.mockImplementation(() => withSavAiBudget(async () => {
    for (let n = 1; n < SAV_AI_BUDGET.calls; n++) await request("understanding");
    return { marker: "analysis" };
  }));
  await expect(analyzeStoredSavMessage(input, context)).resolves.toEqual({ marker: "analysis" });
  expect(network).toHaveBeenCalledTimes(SAV_AI_BUDGET.calls);
  expect(new Set(traces).size).toBe(1);
  expect(mocks.collect).toHaveBeenCalledWith(context.messageId);
  expect(mocks.analyze).toHaveBeenCalledWith({ ...input, dossierContext: { marker: "collected" } }, context);
});
it("does not reset the allowance after ticket matching", async () => {
  mocks.analyze.mockImplementation(() => withSavAiBudget(async () => {
    for (let n = 0; n < SAV_AI_BUDGET.calls; n++) await request("composition");
  }));
  await expect(analyzeStoredSavMessage(input, context)).rejects.toThrow("SAV_AI_BUDGET_EXCEEDED");
  expect(network).toHaveBeenCalledTimes(SAV_AI_BUDGET.calls);
  expect(new Set(traces).size).toBe(1);
});
