import { afterEach, expect, it, vi } from "vitest";
import { encodeSimpleWireFixture } from "./simple-wire.fixture";
vi.mock("./runtime-store", () => ({ settleSavIntakeCall: vi.fn(async () => true) }));
import { parseSavGeminiJson, readSavGeminiResponse, savGeminiDiagnosticMetadata } from "../gemini-response";
import { createIntakeModelDispatcher, intakeDispatchCounts } from "./model-dispatch";
import { createSavIntakeSimpleReaders } from "./simple-readers";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import type { EnginePolicy } from "./engine-types";
import type { IntakeModelTrace, IntakeGeminiCall } from "./model-readers";
afterEach(() => vi.restoreAllMocks());
it("MAX_TOKENS alone causes truncation even if the visible text is complete JSON; STOP with broken JSON is a different failure", () => {
  const payload = (finishReason: string, text: string) => readSavGeminiResponse({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
  expect(() => parseSavGeminiJson(payload("MAX_TOKENS", '{"ok":true}'))).toThrow("SAV_AI_OUTPUT_TRUNCATED");
  expect(() => parseSavGeminiJson(payload("STOP", '{"partial":'))).toThrow("SAV_AI_INVALID_JSON");
  expect(parseSavGeminiJson(payload("STOP", '{"ok":true}'))).toEqual({ok:true});
});
it("a received HTTP200 MAX_TOKENS is settled from usage, not uncertain, with safe diagnostics and one real dispatch despite absent trace metadata", async () => {
  vi.spyOn(console,"warn").mockImplementation(()=>{}); vi.spyOn(console,"info").mockImplementation(()=>{});
  const usage = {promptTokenCount:170106,candidatesTokenCount:8177,thoughtsTokenCount:0,totalTokenCount:178283};
  const network=vi.fn<typeof fetch>(async (_url,init)=>{
    const body=JSON.parse(String(init?.body));
    expect(body.generationConfig).toMatchObject({maxOutputTokens:8192,thinkingConfig:{thinkingLevel:"low"}});
    return Response.json({candidates:[{finishReason:"MAX_TOKENS",content:{parts:[{text:'{"partial":'}]}}],usageMetadata:usage});
  });
  const settle=vi.fn(async()=>true), reserve=vi.fn(async()=>({id:"fixture-reservation",cached:null}));
  const dispatcher=createIntakeModelDispatcher({config:{model:"gemini-3.6-flash"} as IntakeRuntimeConfig,live:async()=>{},network,settle,reserve,
    signal:new AbortController().signal,env:()=>({SAV_GEMINI_API_KEY:"synthetic-key"}),generationBudget:"single_pass",captureDiagnostics:true});
  const complete=(data:unknown)=>({status:"complete" as const,data,observedAt:"2026-10-28T19:00:00Z"});
  const crm={findContactsByEmail:async()=>complete([]),directAssociations:async()=>complete([]),getContact:async()=>complete(null),ticketsForContact:async()=>complete([]),ticketHistory:async()=>complete([])};
  const traces:IntakeModelTrace[]=[];
  const reader=createSavIntakeSimpleReaders({model:"gemini-3.6-flash",call:dispatcher.call,crm:crm as never,policy:{admittedRelations:[]} as unknown as EnginePolicy,onTrace:t=>traces.push(t)});
  await expect(reader.analyseMessage({message:{id:"10000000-0000-4000-8000-000000000001",threadId:"20000000-0000-4000-8000-000000000001",receivedAt:"2026-10-28T19:00:00Z",fromEmail:"sender@example.test",toEmails:["support@example.test"],direction:"inbound",currentText:"Mon agenda ne fonctionne plus.",contentComplete:true},conversation:[]},new AbortController().signal)).rejects.toThrow("SAV_AI_OUTPUT_TRUNCATED");
  expect(network).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledExactlyOnceWith("fixture-reservation",expect.objectContaining({finishReason:"MAX_TOKENS",inputTokens:170106,outputTokens:8177,thoughtTokens:0,totalTokens:178283}));
  expect(dispatcher.uncertain).toBe(false);
  expect(dispatcher.diagnostics).toHaveLength(1); expect(dispatcher.diagnostics[0]).toMatchObject({dispatched:true,httpStatus:200,transport:{attempts:1,retries:0,errorCode:"SAV_AI_OUTPUT_TRUNCATED"}});
  expect(dispatcher.diagnostics[0]).toMatchObject({finishReason:"MAX_TOKENS",inputTokens:170106,outputTokens:8177,thoughtTokens:0,totalTokens:178283});
  expect(intakeDispatchCounts(dispatcher.diagnostics)).toEqual({dispatches:1,httpResponses:1});
  expect(JSON.stringify(dispatcher.diagnostics)).not.toContain("partial");
  expect(traces).toHaveLength(1); expect(traces[0]).toMatchObject({accepted:false,errorCode:"SAV_AI_OUTPUT_TRUNCATED"});
  expect(traces[0].metadata).toBeUndefined(); expect(traces.filter(t=>t.metadata)).toHaveLength(0);
});

it("provider schema omits optional nested array bounds while the server still rejects an overlong why with only one format repair", async () => {
  const complete=(data:unknown)=>({status:"complete" as const,data,observedAt:"2026-10-28T19:00:00Z"});
  const crm={findContactsByEmail:async()=>complete([]),directAssociations:async()=>complete([]),getContact:async()=>complete(null),ticketsForContact:async()=>complete([]),ticketHistory:async()=>complete([])};
  const mid="10000000-0000-4000-8000-000000000001";
  const call=vi.fn<IntakeGeminiCall>(async(input)=>{
    type Schema = { maxItems?: string; minItems?: string; properties: Record<string, Schema>; items: Schema };
    const schema=input.body.generationConfig.responseSchema as unknown as Schema;
    expect(schema.properties.t).not.toHaveProperty("maxLength");
    expect(schema.properties.i.properties.w).not.toHaveProperty("maxLength");
    expect(schema.properties.j).not.toHaveProperty("maxItems");
    expect(schema.properties.r).not.toHaveProperty("maxItems");
    expect(schema.properties.r.items.properties.e).not.toHaveProperty("minItems");
    expect(schema.properties.r.items.properties.e).not.toHaveProperty("maxItems");
    return {json:encodeSimpleWireFixture({messageId:mid,nature:"request",requests:[{id:"r1",kind:"support",summary:"Agenda en panne",sourceIds:["current"]}],identity:{kind:"unknown",contactIds:[],why:"x".repeat(501)},tickets:[],missing:[],rationale:"Aucun contact"},JSON.parse(input.body.contents[0].parts[0].text).outputReferences),metadata:{inputTokens:10,outputTokens:10,thoughtTokens:0,totalTokens:20}};
  });
  const reader=createSavIntakeSimpleReaders({model:"gemini-3.6-flash",call:call as never,crm:crm as never,policy:{admittedRelations:[]} as unknown as EnginePolicy});
  await expect(reader.analyseMessage({message:{id:mid,threadId:"20000000-0000-4000-8000-000000000001",receivedAt:"2026-10-28T19:00:00Z",fromEmail:"sender@example.test",toEmails:["support@example.test"],direction:"inbound",currentText:"Mon agenda ne fonctionne plus.",contentComplete:true},conversation:[]},new AbortController().signal)).rejects.toThrow("SAV_INTAKE_MODEL_OUTPUT_REJECTED");
  expect(call).toHaveBeenCalledTimes(2);
});

it("diagnostics allowlist enum names and bounded counters, discarding arbitrary properties", () => {
  expect(savGeminiDiagnosticMetadata(readSavGeminiResponse({promptFeedback:{blockReason:"SAFETY"},usageMetadata:{promptTokenCount:3,candidatesTokenCount:0,thoughtsTokenCount:0,totalTokenCount:3}}).metadata))
    .toEqual({blockReason:"SAFETY",inputTokens:3,outputTokens:0,thoughtTokens:0,totalTokens:3});
  expect(savGeminiDiagnosticMetadata({ finishReason: "private text", blockReason: "private block", inputTokens: -1,
    outputTokens: 1.5, thoughtTokens: 0, totalTokens: 2_147_483_648, body: "private body", secret: "private key" } as never))
    .toEqual({ finishReason: "UNKNOWN", blockReason: "UNKNOWN", thoughtTokens: 0 });
});
