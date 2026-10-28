import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestSavGeminiJson, SAV_AI_BUDGET, savGeminiGenerationConfig, withSavAiBudget } from "./gemini-transport";
import { geminiFixture } from "../../../test/sav-understanding-fixtures";

const request = { phase: "understanding" as const, apiKey: "private-key-fixture", model: "gemini-3.6-flash", body: { contents: [{ parts: [{ text: "private-client-payload" }] }], generationConfig: { maxOutputTokens: 8192, temperature: 0 } } };
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded read/generation transport", () => {
  it.each([401, 402, 403, 404])("does not retry HTTP %s or leak provider body, URL key, input or exception text", async status => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-provider-error", { status }));
    await expect(requestSavGeminiJson({ ...request, fetch: network })).rejects.toMatchObject({ message: `SAV_AI_HTTP_${status}`, metadata: { transport: { attempts: 1 } } });
    expect(network).toHaveBeenCalledOnce();
    expect(String(network.mock.calls[0][0])).not.toContain(request.apiKey);
    expect(network.mock.calls[0][1]?.headers).toMatchObject({ "x-goog-api-key": request.apiKey });
    expect(JSON.stringify([vi.mocked(console.warn).mock.calls, vi.mocked(console.info).mock.calls])).not.toMatch(/private-key-fixture|private-client-payload|private-provider-error/);
  });
  it.each([429, 503])("honors Retry-After for HTTP %s then records one retry and successful usage", async status => {
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status, headers: { "Retry-After": "2" } })).mockResolvedValueOnce(geminiFixture({ accepted: true }));
    const result = requestSavGeminiJson({ ...request, fetch: network });
    await vi.advanceTimersByTimeAsync(1999); expect(network).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({ json: { accepted: true }, metadata: { transport: { attempts: 2, retries: 1, phase: "understanding" } } });
    expect(network).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not retry earlier than a Retry-After beyond the phase deadline", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "120" } }));
    await expect(requestSavGeminiJson({ ...request, fetch: network })).rejects.toMatchObject({ message: "SAV_AI_HTTP_429" });
    expect(network).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("shares one retry across all phases and keeps their correlation stable", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(geminiFixture({ ok: true })).mockResolvedValueOnce(new Response("", { status: 429 }));
    const result = withSavAiBudget(async () => {
      const first = await requestSavGeminiJson({ ...request, fetch: network });
      const second = await requestSavGeminiJson({ ...request, phase: "composition", fetch: network }).catch(error => error);
      return { first, second };
    });
    await vi.advanceTimersByTimeAsync(300);
    const { first, second } = await result;
    expect(second).toMatchObject({ message: "SAV_AI_HTTP_429", metadata: { transport: { attempts: 1, correlationId: first.metadata.transport!.correlationId } } });
    expect(network).toHaveBeenCalledTimes(3);
  });
  it("allows a complete 18s retry within the 37s phase deadline", async () => {
    const network = vi.fn<typeof fetch>((_, init) => new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("private", "AbortError")))));
    const pending = requestSavGeminiJson({ ...request, fetch: network });
    const assertion = expect(pending).rejects.toMatchObject({ message: "SAV_AI_TIMEOUT", metadata: { transport: { attempts: 2, durationMs: expect.any(Number) } } });
    await vi.advanceTimersByTimeAsync(37000); await assertion;
    await pending.catch(error => {
      expect(error.metadata.transport.durationMs).toBeGreaterThanOrEqual(36000);
      expect(error.metadata.transport.durationMs).toBeLessThanOrEqual(37000);
    });
    expect(network).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    ["SAV_AI_OUTPUT_TRUNCATED", { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"partial":' }] } }] }],
    ["SAV_AI_EMPTY_OUTPUT", { candidates: [{ finishReason: "STOP", content: { parts: [] } }] }],
    ["SAV_AI_INVALID_JSON", { candidates: [{ content: { parts: [{ text: "invalid-json" }] } }] }],
  ])("rejects %s without a transport retry or partial JSON acceptance", async (code, payload) => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    await expect(requestSavGeminiJson({ ...request, fetch: network })).rejects.toMatchObject({ message: code }); expect(network).toHaveBeenCalledOnce();
  });
  it("caps calls across phases even after successful outputs", async () => {
    const network = vi.fn<typeof fetch>().mockImplementation(async () => geminiFixture({ ok: true }));
    await withSavAiBudget(async () => {
      for (let i = 0; i < SAV_AI_BUDGET.calls; i++) await requestSavGeminiJson({ ...request, fetch: network });
      await expect(requestSavGeminiJson({ ...request, phase: "coherence", fetch: network })).rejects.toMatchObject({ message: "SAV_AI_BUDGET_EXCEEDED" });
    });
    expect(network).toHaveBeenCalledTimes(SAV_AI_BUDGET.calls);
  });
  it("refuses oversized input before the provider and respects strict no-retry callers", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    await expect(requestSavGeminiJson({ ...request, body: { ...request.body, contents: "x".repeat(SAV_AI_BUDGET.tokenAllowance) }, fetch: network })).rejects.toMatchObject({ message: "SAV_AI_BUDGET_EXCEEDED" });
    expect(network).not.toHaveBeenCalled();
    await expect(requestSavGeminiJson({ ...request, fetch: network, allowRetry: false })).rejects.toMatchObject({ message: "SAV_AI_HTTP_503" });
    expect(network).toHaveBeenCalledOnce();
  });
  it("uses the documented Gemini 3 setting and leaves unrecognized models untouched", () => {
    expect(savGeminiGenerationConfig("gemini-3.6-flash", { temperature: 0, maxOutputTokens: 8192 })).toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "low" } });
    expect(savGeminiGenerationConfig("gemini-2.5-flash", { temperature: 0 })).toEqual({ temperature: 0 });
  });
});

it("keeps an explicit parent cancellation in the persisted trace contract", async () => {
  const { savAiTransportTraceSchema } = await import("./understanding");
  const parent = new AbortController();
  const network = vi.fn<typeof fetch>(async (_url, init) => {
    parent.abort(Error("SAV_INTAKE_COMPARISON_DEADLINE")); throw init!.signal!.reason;
  });
  const error = await requestSavGeminiJson({ ...request, signal: parent.signal, fetch: network, allowRetry: false }).catch(error => error);
  expect(error).toMatchObject({ message: "SAV_INTAKE_COMPARISON_DEADLINE", metadata: { transport: { failureCategory: "cancelled", attempts: 1 } } });
  expect(savAiTransportTraceSchema.parse(error.metadata.transport).failureCategory).toBe("cancelled");
  expect(network).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it("does not retry or mislabel a cancelled response body", async () => {
  const parent = new AbortController();
  const network = vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream({ start(controller) {
    init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
    setTimeout(() => parent.abort(Error("SAV_INTAKE_COMPARISON_DEADLINE")), 1000);
  } })));
  const work = requestSavGeminiJson({ ...request, signal: parent.signal, fetch: network, allowRetry: false });
  const assertion = expect(work).rejects.toMatchObject({ message: "SAV_INTAKE_COMPARISON_DEADLINE", metadata: { transport: { failureCategory: "cancelled" } } });
  await vi.advanceTimersByTimeAsync(1000); await assertion;
  expect(network).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

// Investigation only: no real network, fake-clock reproduction of the live37s cutoff.
it.each([36_000,38_000])("INVESTIGATION single-pass large input, synthetic response at %sms",async(delay)=>{
 const network=vi.fn<typeof fetch>((_,init)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>resolve(geminiFixture({ok:true})),delay);
  init!.signal!.addEventListener("abort",()=>{clearTimeout(timer);reject(new DOMException("synthetic abort","AbortError"));},{once:true});
 }));
 const big={...request,allowRetry:false,body:{...request.body,contents:[{parts:[{text:"synthetic context ".repeat(10000)}]}]}};
 const work=requestSavGeminiJson({...big,fetch:network}).then(value=>({value}),error=>({error}));
 await vi.advanceTimersByTimeAsync(38_000);
 const result=await work;
 expect(SAV_AI_BUDGET.durationMs).toBe(60_000);
 expect(network).toHaveBeenCalledTimes(1);
 if(delay===36_000)expect(result).toHaveProperty("value.json.ok",true);
 else expect(result).toMatchObject({error:{message:"SAV_AI_TIMEOUT",metadata:{transport:{attempts:1,retries:0,durationMs:37_000}}}});
 expect(vi.getTimerCount()).toBe(0);
});

it("SAV46 single-pass uses the existing60s allowance once, not the legacy37s phase",async()=>{
 const network=vi.fn<typeof fetch>((_,init)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>resolve(geminiFixture({ok:true})),38_000);
  init!.signal!.addEventListener("abort",()=>{clearTimeout(timer);reject(init!.signal!.reason)},{once:true});
 }));
 const work=requestSavGeminiJson({...request,generationBudget:"single_pass",allowRetry:false,fetch:network});
 await vi.advanceTimersByTimeAsync(38_000);expect(await work).toMatchObject({json:{ok:true}});
 expect(network).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it.each(["parent","budget"])("SAV46 single-pass respects %s cancellation without retry",async(kind)=>{
 const controller=new AbortController();
 const network=vi.fn<typeof fetch>((_,init)=>new Promise((_,reject)=>init!.signal!.addEventListener("abort",()=>reject(init!.signal!.reason),{once:true})));
 if(kind==="parent")setTimeout(()=>controller.abort(Error("SAV_INTAKE_COMPARISON_DEADLINE")),20_000);
 const work=requestSavGeminiJson({...request,generationBudget:"single_pass",allowRetry:false,signal:controller.signal,fetch:network});
 const assertion=expect(work).rejects.toMatchObject({message:kind==="parent"?"SAV_INTAKE_COMPARISON_DEADLINE":"SAV_AI_TIMEOUT"});
 await vi.advanceTimersByTimeAsync(60_000);await assertion;
 expect(network).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it("SAV46 single-pass cannot enable retries or derived work",async()=>{
 const network=vi.fn<typeof fetch>();
 await expect(requestSavGeminiJson({...request,generationBudget:"single_pass",fetch:network})).rejects.toThrow("SAV_AI_BUDGET_EXCEEDED");
 await expect(requestSavGeminiJson({...request,phase:"translation",generationBudget:"single_pass",allowRetry:false,fetch:network})).rejects.toThrow("SAV_AI_BUDGET_EXCEEDED");
 expect(network).not.toHaveBeenCalled();
});
