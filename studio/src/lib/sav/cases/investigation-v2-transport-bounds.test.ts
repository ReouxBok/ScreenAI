import { expect, it, vi } from "vitest";
import { readCaseV2TransportPolicy } from "./investigation-v2-spend";
import { caseGeminiDecisionProvider, caseGeminiEmbeddingTransport } from "./investigation-v2-providers";
import type { CaseInvestigationModelRequest } from "./investigation-runner";
const policy={revision:"synthetic",approvedBy:"20000000-0000-4000-8000-000000000004",approvedAt:"2026-11-01T00:00:00Z",
 transport:{model:"synthetic-model",embeddingModel:"synthetic-embedding",priceExpiresAt:"2027-01-01T00:00:00Z",maxInputTokens:131072,maxOutputTokens:1024,maxInputBytes:100_000,embeddingMaxInputTokens:2048,embeddingMaxTexts:3,embeddingMaxTextBytes:1024},
 model:{dailyCapMicroUsd:2_000_000,reserveMicroUsdPerCall:200_000,microUsdPerMillionInputTokens:1_000_000,microUsdPerMillionOutputTokens:1_000_000},
 embedding:{dailyCapMicroUsd:2_000_000,reserveMicroUsdPerCall:10_000,microUsdPerMillionInputTokens:1_000_000}};
const env=(p:unknown=policy)=>({SAV_V2_GEMINI_API_KEY:"synthetic-key",SAV_V2_MODEL:"synthetic-model",SAV_V2_EMBEDDING_MODEL:"synthetic-embedding",SAV_V2_SPEND_POLICY_JSON:JSON.stringify(p)});
const request={purpose:"decision",snapshot:{version:1,body:{openRequests:[],facts:[],questions:[],trials:[]}},knowledge:[],coverage:null,feedback:[],closure:[]} as unknown as CaseInvestigationModelRequest;
it("requires explicit priced model pins and sufficient full-window reservation",()=>{
 expect(readCaseV2TransportPolicy(env()).maxOutputTokens).toBe(1024);
 for(const p of [{...policy,transport:{...policy.transport,maxInputTokens:1}},{...policy,transport:{...policy.transport,embeddingMaxInputTokens:1}},{...policy,transport:undefined},{...policy,model:{...policy.model,reserveMicroUsdPerCall:1}},
 {...policy,transport:{...policy.transport,model:"other"}},{...policy,transport:{...policy.transport,priceExpiresAt:"2020-01-01T00:00:00Z"}},
 {...policy,embedding:{...policy.embedding,microUsdPerMillionInputTokens:0}}]) expect(()=>readCaseV2TransportPolicy(env(p))).toThrow();
});
it("sends one bounded output request and refuses excessive UTF8 input before network",async()=>{
 const network=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({candidates:[{content:{parts:[{text:"{}"}]},finishReason:"STOP"}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,thoughtsTokenCount:3}}));
 expect(await caseGeminiDecisionProvider({env:()=>env(),network})(request)).toMatchObject({usage:{inputTokens:10,outputTokens:5}});
 expect(network).toHaveBeenCalledTimes(1);
 expect(JSON.parse(String(network.mock.calls[0]![1].body)).generationConfig.maxOutputTokens).toBe(1024);
 network.mockClear();
 expect(await caseGeminiDecisionProvider({env:()=>env({...policy,transport:{...policy.transport,maxInputBytes:1}}),network})(request)).toMatchObject({result:{status:"failed",uncertain:false}});
 expect(network).not.toHaveBeenCalled();
});
it("embedding refuses unbounded input and missing durable reservation without network",async()=>{
 const network=vi.fn();const embed=caseGeminiEmbeddingTransport({env:()=>env(),network});
 for(const texts of [["a","b","c","d"],["é".repeat(3000)],["ok"]])
 await expect(embed({texts,signal:AbortSignal.timeout(1000)})).rejects.toThrow();
 expect(network).not.toHaveBeenCalled();
});
