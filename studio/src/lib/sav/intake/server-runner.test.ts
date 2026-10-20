import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { planSavIntake } from "./engine";
import { evaluationBatch, evaluationEnvironment } from "../../../../test/sav-intake-evaluation";
import { evaluationConfig } from "./server-contract";
const s = vi.hoisted(() => ({ claim: vi.fn(), reserve: vi.fn(), settle: vi.fn(), save: vi.fn(), read: vi.fn(), engine: vi.fn(), realEngine: null as unknown,
  saved: [] as { state: string; value: unknown }[] }));
vi.mock("./server-ledger", () => ({ claimServerEvaluation: s.claim, reserveServerEvaluationCall: s.reserve, settleServerEvaluationCall: s.settle, saveServerEvaluationResult: s.save, readServerEvaluation: s.read }));
vi.mock("./engine", async original => { const m = await original<typeof import("./engine")>(); s.realEngine = m.planSavIntake; return { ...m, planSavIntake: s.engine }; });
import { runServerEvaluation, snapshotEvaluationReaders, evaluationProviderResponse } from "./server-runner";
const analysis = (id: string) => ({ messageId: id, requests: [{ id: "request", kind: "support", currentMessageId: id, quote: "My product displays an error." }] });
const provider = (value: unknown) => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0, totalTokenCount: 150 } });
let network: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  s.claim.mockReset().mockResolvedValue({ id: "synthetic-run", claimed: true }); s.reserve.mockReset().mockResolvedValue("synthetic-reservation"); s.settle.mockReset().mockResolvedValue(true);
  s.saved = []; s.save.mockReset().mockImplementation(async (_id, value, state) => { s.saved.push({ state, value: structuredClone(value) }); });
  s.read.mockReset().mockImplementation(async () => s.saved.at(-1) ?? { state: "running" });
  s.engine.mockReset().mockImplementation(s.realEngine as typeof planSavIntake);
  network = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init?.body)); const data = JSON.parse(body.contents[0].parts[0].text); return provider(analysis(data.message.id)); });
});
afterEach(() => vi.restoreAllMocks());
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
