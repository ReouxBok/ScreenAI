import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { planSavIntake } from "./engine";
import { evaluationBatch, evaluationEnvironment } from "../../../../test/sav-intake-evaluation";
import { evaluationConfig, evaluationHash } from "./server-contract";
import type { IntakeGeminiCall } from "./model-readers";
import { savGeminiWireBody } from "../gemini-transport";
import { SAV_INTAKE_MODEL_LIMITS } from "./model-limits";
const s = vi.hoisted(() => ({ claim: vi.fn(), reserve: vi.fn(), settle: vi.fn(), save: vi.fn(), read: vi.fn(), engine: vi.fn(), realEngine: null as unknown,
  rawInput: null as Parameters<IntakeGeminiCall>[0] | null, saved: [] as { state: string; value: unknown }[] }));
vi.mock("./server-ledger", () => ({ claimServerEvaluation: s.claim, reserveServerEvaluationCall: s.reserve, settleServerEvaluationCall: s.settle, saveServerEvaluationResult: s.save, readServerEvaluation: s.read }));
vi.mock("./engine", async original => { const m = await original<typeof import("./engine")>(); s.realEngine = m.planSavIntake; return { ...m, planSavIntake: s.engine }; });
vi.mock("./model-readers", async original => {
  const m = await original<typeof import("./model-readers")>();
  return { ...m, createSavIntakeSemanticReaders: (options: Parameters<typeof m.createSavIntakeSemanticReaders>[0]) => s.rawInput
    ? { analyseMessage: () => options.call(s.rawInput!) } : m.createSavIntakeSemanticReaders(options) };
});
import { runServerEvaluation, snapshotEvaluationReaders, evaluationProviderResponse } from "./server-runner";
const analysis = (id: string) => ({ messageId: id, requests: [{ id: "request", kind: "support", currentMessageId: id, quote: "My product displays an error." }] });
const provider = (value: unknown) => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
let network: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  s.rawInput = null;
  s.claim.mockReset().mockResolvedValue({ id: "synthetic-run", claimed: true }); s.reserve.mockReset().mockResolvedValue("synthetic-reservation"); s.settle.mockReset().mockResolvedValue(true);
  s.saved = []; s.save.mockReset().mockImplementation(async (_id, value, state) => { s.saved.push({ state, value: structuredClone(value) }); });
  s.read.mockReset().mockImplementation(async () => s.saved.at(-1) ?? { state: "running" });
  s.engine.mockReset().mockImplementation(s.realEngine as typeof planSavIntake);
  network = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init?.body)); const data = JSON.parse(body.contents[0].parts[0].text); return provider(analysis(data.message.id)); });
});
afterEach(() => vi.restoreAllMocks());
it.each([-1, 0, 1])("keeps the evaluation wire boundary at 128 KiB %+d before reservation or network", async delta => {
  const input: Parameters<IntakeGeminiCall>[0] = { model: "gemini-3.6-flash", phase: "ticket_matching", promptRevision: "fixture",
    signal: new AbortController().signal, allowRetry: false,
    body: { systemInstruction: { parts: [{ text: "Lire tout." }] }, contents: [{ role: "user", parts: [{ text: 'é😀 "citation" \\ chemin\n' }] }],
      generationConfig: { maxOutputTokens: 8192 } } };
  input.body.contents[0].parts[0].text += "x".repeat(SAV_INTAKE_MODEL_LIMITS.wireTextBytes + delta - savGeminiWireBody(input).textBytes);
  expect(savGeminiWireBody(input).textBytes).toBe(SAV_INTAKE_MODEL_LIMITS.wireTextBytes + delta);
  s.rawInput = input;
  s.engine.mockImplementation(async (caseInput, adapters) => {
    await adapters.analyseMessage({ message: caseInput.message, conversation: [] }, new AbortController().signal);
    return { effects: "not_connected", steps: [] };
  });
  network.mockImplementation(async (_url, init) => {
    expect(init?.body).toBe(savGeminiWireBody(input).body); return provider({ fixture: true });
  });
  const batch = evaluationBatch(), env = evaluationEnvironment(batch);
  await runServerEvaluation(batch, evaluationConfig(env), "ugo@limova.ai", new AbortController().signal, { env: () => env, network });
  if (delta <= 0) {
    expect(network).toHaveBeenCalledTimes(3); expect(s.reserve).toHaveBeenCalledTimes(3);
    expect(s.saved.at(-1)?.state).toBe("complete");
  } else {
    expect(network).not.toHaveBeenCalled(); expect(s.reserve).not.toHaveBeenCalled(); expect(s.settle).not.toHaveBeenCalled();
    expect(s.saved.at(-1)?.value).toMatchObject({ stopReason: "SAV_EVAL_REQUEST_REJECTED" });
  }
});
it("runs exactly three synthetic cases through the actual engine/model readers, with no CRM network", async () => {
  const batch = evaluationBatch(), env = evaluationEnvironment(batch);
  await runServerEvaluation(batch, evaluationConfig(env), "ugo@limova.ai", new AbortController().signal, { env: () => env, network });
  expect(network).toHaveBeenCalledTimes(3); expect(s.reserve).toHaveBeenCalledTimes(3); expect(s.saved.at(-1)?.state).toBe("complete");
  for (const [url, init] of network.mock.calls) { expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"); expect(init?.redirect).toBe("error"); }
  expect(JSON.stringify(s.saved)).not.toContain("synthetic-only-not-a-key");
});
it("returns the prior claim without any further provider dispatch", async () => {
  s.claim.mockResolvedValue({ id: "existing", claimed: false });
  const batch = evaluationBatch(), env = evaluationEnvironment(batch); await runServerEvaluation(batch, evaluationConfig(env), "ugo@limova.ai", new AbortController().signal, { env: () => env, network });
  expect(network).not.toHaveBeenCalled(); expect(s.engine).not.toHaveBeenCalled(); expect(s.save).not.toHaveBeenCalled();
});
it("preserves truncated context and performs zero model calls rather than weakening the guard", async () => {
  const batch = evaluationBatch(); for (const item of batch.cases) item.input.message.contentComplete = false;
  const env = evaluationEnvironment(batch); await runServerEvaluation(batch, evaluationConfig(env), "ugo@limova.ai", new AbortController().signal, { env: () => env, network });
  expect(network).not.toHaveBeenCalled(); expect(s.saved.at(-1)?.state).toBe("complete");
});
it("missing snapshots throw instead of inventing a complete empty lookup", async () => {
  const item = evaluationBatch().cases[0]; item.snapshots.lookups = {};
  await expect(snapshotEvaluationReaders(item).findContactsByEmail("fixture@example.invalid", new AbortController().signal)).rejects.toThrow("SAV_EVAL_SNAPSHOT_MISSING");
});
it("stops after uncertain usage without starting another case", async () => {
  s.settle.mockResolvedValue(false); const batch = evaluationBatch(), env = evaluationEnvironment(batch);
  await runServerEvaluation(batch, evaluationConfig(env), "ugo@limova.ai", new AbortController().signal, { env: () => env, network });
  expect(network).toHaveBeenCalledOnce(); expect(s.engine).toHaveBeenCalledOnce(); expect(s.saved.at(-1)?.state).toBe("uncertain");
});
it("stops before network when the durable budget refuses admission", async () => {
  s.reserve.mockRejectedValue(Error("SAV_EVAL_BUDGET_EXHAUSTED")); const batch = evaluationBatch(), env = evaluationEnvironment(batch);
  await runServerEvaluation(batch, evaluationConfig(env), "ugo@limova.ai", new AbortController().signal, { env: () => env, network });
  expect(network).not.toHaveBeenCalled(); expect(s.engine).toHaveBeenCalledOnce(); expect(s.saved.at(-1)?.state).toBe("uncertain");
});
it("rechecks configuration before the next case", async () => {
  const batch = evaluationBatch(), env = evaluationEnvironment(batch);
  network.mockImplementationOnce(async () => { env.SAV_INTAKE_EVAL_ENABLED = ""; return provider(analysis(batch.cases[0].input.message.id)); });
  await runServerEvaluation(batch, evaluationConfig(env), "ugo@limova.ai", new AbortController().signal, { env: () => env, network });
  expect(network).toHaveBeenCalledOnce(); expect(s.engine).toHaveBeenCalledOnce(); expect(s.saved.at(-1)?.state).toBe("uncertain");
});
it("waits for cancellation settlement before saving final status or starting the next case", async () => {
  let release!: () => void; const gate = new Promise<boolean>(resolve => { release = () => resolve(false); }); s.settle.mockReturnValue(gate);
  network.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }); }));
  s.engine.mockImplementationOnce(async (input, adapters) => {
    const controller = new AbortController(); void adapters.analyseMessage({ message: input.message, conversation: [] }, controller.signal).catch(() => {});
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce()); controller.abort(); return { effects: "not_connected", steps: [] };
  });
  const batch = evaluationBatch(), env = evaluationEnvironment(batch); let done = false;
  const task = runServerEvaluation(batch, evaluationConfig(env), "ugo@limova.ai", new AbortController().signal, { env: () => env, network }).then(() => { done = true; });
  await vi.waitFor(() => expect(s.settle).toHaveBeenCalledOnce()); expect(done).toBe(false); expect(s.save).not.toHaveBeenCalled();
  release(); await task; expect(s.engine).toHaveBeenCalledOnce(); expect(s.saved.at(-1)?.state).toBe("uncertain");
});
it("rejects oversized provider responses and honours cancellation", async () => {
  await expect(evaluationProviderResponse(new Response("x".repeat(262145)), new AbortController().signal)).rejects.toThrow("SAV_EVAL_PROVIDER_RESPONSE_REJECTED");
  const controller = new AbortController(); controller.abort(); await expect(evaluationProviderResponse(new Response("{}"), controller.signal)).rejects.toThrow("SAV_EVAL_CANCELLED");
});
function continuationFixture() {
  const original = evaluationBatch(), batch = { ...original, campaignId: "synthetic-second" };
  const env = { ...evaluationEnvironment(batch), SAV_INTAKE_EVAL_CODE_SHA: "b".repeat(40), VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
    SAV_INTAKE_EVAL_PREVIOUS_RUN_ID: "30000000-0000-4000-8000-000000000001", SAV_INTAKE_EVAL_PREVIOUS_CAMPAIGN_ID: original.campaignId,
    SAV_INTAKE_EVAL_PREVIOUS_MANIFEST_SHA256: evaluationHash(JSON.stringify(original)), SAV_INTAKE_EVAL_PREVIOUS_CODE_SHA: "a".repeat(40) };
  return { original, batch, env };
}
it("passes the reconstructed baseline proof to the durable claim before a pinned second evaluation", async () => {
  const { batch, env } = continuationFixture(), config = evaluationConfig(env);
  await runServerEvaluation(batch, config, "ugo@limova.ai", new AbortController().signal, { env: () => env, network });
  expect(s.claim).toHaveBeenCalledExactlyOnceWith(config, "ugo@limova.ai", env.SAV_INTAKE_EVAL_PREVIOUS_MANIFEST_SHA256);
  expect(network).toHaveBeenCalledTimes(3); expect(s.saved.at(-1)?.state).toBe("complete");
});
it("refuses replaced case data before any claim, engine, ledger write or model dispatch", async () => {
  const { batch, env } = continuationFixture(); batch.cases[1].input.message.currentText = "Changed evidence";
  env.SAV_INTAKE_EVAL_MANIFEST_SHA256 = evaluationHash(JSON.stringify(batch)); // Even the new manifest cannot rewrite the first one.
  await expect(runServerEvaluation(batch, evaluationConfig(env), "ugo@limova.ai", new AbortController().signal, { env: () => env, network })).rejects.toThrow("SAV_EVAL_CONTINUATION_REJECTED");
  expect(s.claim).not.toHaveBeenCalled(); expect(s.engine).not.toHaveBeenCalled(); expect(s.save).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});
