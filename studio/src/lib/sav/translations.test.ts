import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {eq} from "drizzle-orm";
import {createSavTestDb} from "../../../test/sav-db";
import {v0Proposal} from "../../../test/sav-v0-review-fixture";
import {auditLogs,savAgentRuns,savDecisions,savMailboxes,savMessages,savMessageTranslations,savThreads} from "@/db/schema";
import {encryptSavPayload} from "./crypto";
import {activateSavV0Cutover} from "./cutover";
import {enqueueSavTranslation,getSavTranslations,protectSavTranslationText,reconcileSavTranslations,translateSavMessageText} from "./translations";
import {dispatchSavDerivedCall,reserveSavDerivedCallTx,savDerivedBudgets,settleSavDerivedCall} from "./derived-budget";
const state=vi.hoisted(()=>({db:null as unknown}));vi.mock("@/db",()=>({requireDb:()=>state.db}));
let f:Awaited<ReturnType<typeof createSavTestDb>>,messageId:string,threadId:string;
const source="Hello, error ERR_42 ECONNRESET at -24 °C $10 on https://example.invalid/test for demo@example.invalid: 24 kg and 12.5 MB.\nPlease help.";
const response=(result:unknown)=>Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(result)}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:20,thoughtsTokenCount:0,totalTokenCount:30}});
const translatedFetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));return response({language:"en",status:"complete",text:"Traduction française : "+body.contents[0].parts[0].text});});
beforeAll(async()=>{f=await createSavTestDb();state.db=f.db;},30000);afterAll(async()=>f.client.close());
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
beforeEach(async()=>{
 vi.stubEnv("SAV_ENCRYPTION_KEY_V1","synthetic-sav86-translation-key-only-32-characters");vi.stubEnv("SAV_RELEASE_STAGE","v0");vi.stubEnv("SAV_AI_ANALYSIS","true");vi.stubGlobal("fetch",()=>{throw new Error("NO_REAL_NETWORK");});translatedFetch.mockClear();
 await f.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs;");
 const [mailbox]=await f.db.insert(savMailboxes).values({email:"contact@limova.ai"}).returning();await activateSavV0Cutover({receivedAfter:"2026-10-01T00:00:00Z",mailboxEmail:"contact@limova.ai",intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
 const [thread]=await f.db.insert(savThreads).values({mailboxId:mailbox.id,gmailThreadId:"translation-fixture",customerEmail:"sender@example.invalid"}).returning();threadId=thread.id;
 const [message]=await f.db.insert(savMessages).values({threadId,mailboxId:mailbox.id,direction:"inbound",gmailMessageId:"synthetic",fromEmail:"sender@example.invalid",subject:"Fixture",bodyCiphertext:encryptSavPayload({text:source}),receivedAt:new Date("2026-10-19T12:00:00Z")}).returning();messageId=message.id;
});
async function work(){return reconcileSavTranslations(2,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:translatedFetch});}
describe("SAV86 cached French translation",()=>{
 it("protects codes, addresses, links, numbers and units exactly once",async()=>{const result=await translateSavMessageText(source,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:translatedFetch});for(const token of ["ERR_42","ECONNRESET","-24 °C","$10","https://example.invalid/test","demo@example.invalid","24 kg","12.5 MB"])expect(result.text).toContain(token);expect(()=>protectSavTranslationText(source).restore("missing tokens")).toThrow("PROTECTED_VALUE_CHANGED");});
 it.each(["fr","mixed","unknown","unsupported","es","de","it","pt"])("uses strict source language %s and shows only complete supported translations",async language=>{const status=language==="fr"?"not_required":["mixed","unknown","unsupported"].includes(language)?"unsupported":"complete";const fetcher=async(_url:unknown,init?:RequestInit)=>response({language,status,text:status==="complete"?JSON.parse(String(init?.body)).contents[0].parts[0].text:""});const result=await translateSavMessageText(source,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:fetcher});expect(result.text===null).toBe(status!=="complete");});
 it("rejects unsupported complete, malformed status and altered protected values",async()=>{for(const result of [{language:"mixed",status:"complete",text:"Bonjour"},{language:"xx",status:"complete",text:"Bonjour"},{language:"en",status:"success",text:"Bonjour"},{language:"en",status:"complete",text:"Bonjour"}])await expect(translateSavMessageText(source,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:async()=>response(result)})).rejects.toThrow();});
 it("keeps partial/unavailable outputs behind the complete original",async()=>{expect((await translateSavMessageText(source,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:async()=>response({language:"en",status:"partial",text:"Bonjour"})})).text).toBeNull();await enqueueSavTranslation(messageId);await reconcileSavTranslations(2,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:async()=>new Response(null,{status:503})});expect((await getSavTranslations([messageId]))[messageId]).toMatchObject({status:"unavailable",text:null});});
 it("only enqueues once, uses cache and never calls the provider from reads",async()=>{await enqueueSavTranslation(messageId);await enqueueSavTranslation(messageId);expect(await f.db.select().from(savMessageTranslations)).toHaveLength(1);await getSavTranslations([messageId]);expect(translatedFetch).not.toHaveBeenCalled();await work();await work();await getSavTranslations([messageId]);expect(translatedFetch).toHaveBeenCalledTimes(1);expect((await getSavTranslations([messageId]))[messageId].status).toBe("complete");});
 it("marks known French without any quota or provider call",async()=>{const proposal=v0Proposal("Réponse française");const [run]=await f.db.insert(savAgentRuns).values({messageId,runtime:"fixture",mode:"off",status:"succeeded",model:"gemini-3.6-flash",promptRevision:"fixture",inputHash:"fixture",proposalCiphertext:encryptSavPayload({...proposal,understanding:{language:"fr"}})}).returning();await f.db.insert(savDecisions).values({messageId,agentRunId:run.id,kind:"human_review_required",reasonCode:"fixture",explanation:"fixture",confidence:0});await enqueueSavTranslation(messageId);await work();expect((await getSavTranslations([messageId]))[messageId].status).toBe("not_required");expect(translatedFetch).not.toHaveBeenCalled();expect((await f.db.select().from(auditLogs)).filter(a=>a.action==="sav_derived_call_reserved")).toHaveLength(0);});
 it("defers paused, disabled and out of time work without dispatch",async()=>{await enqueueSavTranslation(messageId);await f.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));await work();await f.db.update(savThreads).set({aiPaused:false}).where(eq(savThreads.id,threadId));vi.stubEnv("SAV_AI_ANALYSIS","false");await work();vi.stubEnv("SAV_AI_ANALYSIS","true");await reconcileSavTranslations(2,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:translatedFetch,deadlineMs:Date.now()+100});expect(translatedFetch).not.toHaveBeenCalled();expect((await getSavTranslations([messageId]))[messageId].status).toBe("pending");});
 it("does not let two old paused translations starve a later eligible English mail",async()=>{await f.db.update(savThreads).set({aiPaused:true}).where(eq(savThreads.id,threadId));await enqueueSavTranslation(messageId);const [mailbox]=await f.db.select().from(savMailboxes);let eligibleId="";for(const [index,paused] of [true,false].entries()){const [thread]=await f.db.insert(savThreads).values({mailboxId:mailbox.id,gmailThreadId:`starvation-${index}`,customerEmail:"sender@example.invalid",aiPaused:paused}).returning();const [message]=await f.db.insert(savMessages).values({mailboxId:mailbox.id,threadId:thread.id,gmailMessageId:`starvation-${index}`,direction:"inbound",fromEmail:"sender@example.invalid",bodyCiphertext:encryptSavPayload({text:source}),receivedAt:new Date("2026-10-19T13:00:00Z")}).returning();await enqueueSavTranslation(message.id);if(!paused)eligibleId=message.id;}await work();expect(translatedFetch).toHaveBeenCalledTimes(1);expect((await getSavTranslations([eligibleId]))[eligibleId].status).toBe("complete");expect((await getSavTranslations([messageId]))[messageId].status).toBe("pending");});
 it("does not blindly repeat a claimed call after interrupted delivery",async()=>{await enqueueSavTranslation(messageId);await f.db.update(savMessageTranslations).set({attempts:1,leaseUntil:new Date(0)});await work();expect(translatedFetch).not.toHaveBeenCalled();expect((await getSavTranslations([messageId]))[messageId].errorCode).toBe("SAV_TRANSLATION_INTERRUPTED");});
 it("hides cached translation when original content changes",async()=>{await enqueueSavTranslation(messageId);await work();await f.db.update(savMessages).set({bodyCiphertext:encryptSavPayload({text:source+"Changed"})}).where(eq(savMessages.id,messageId));expect((await getSavTranslations([messageId]))[messageId].status).toBe("not_prepared");});
});
describe("SAV86 durable stage and shared budget",()=>{
 it("bounds malformed configuration",()=>{vi.stubEnv("SAV_COMPARISON_DAILY_CALLS","-2");vi.stubEnv("SAV_TRANSLATION_DAILY_CALLS","bad");expect(savDerivedBudgets()).toMatchObject({comparison:0,translation:0,simulation:0});});
 it("separates stage limits under a shared total and consumes uncertain calls",async()=>{vi.stubEnv("SAV_COMPARISON_DAILY_CALLS","1");vi.stubEnv("SAV_TRANSLATION_DAILY_CALLS","2");vi.stubEnv("SAV_DERIVED_DAILY_CALLS","2");const first=await f.db.transaction(tx=>reserveSavDerivedCallTx(tx,"comparison"));await dispatchSavDerivedCall(first.reservationId,"comparison","gemini-3.6-flash",{systemInstruction:{parts:[{text:"Synthetic"}]},contents:[{parts:[{text:"Synthetic"}]}],generationConfig:{maxOutputTokens:4096}});await settleSavDerivedCall(first.reservationId,{inputTokens:10,outputTokens:20,thoughtTokens:0,totalTokens:30});await expect(f.db.transaction(tx=>reserveSavDerivedCallTx(tx,"comparison"))).rejects.toThrow("BUDGET_EXHAUSTED");await f.db.transaction(tx=>reserveSavDerivedCallTx(tx,"translation"));await expect(f.db.transaction(tx=>reserveSavDerivedCallTx(tx,"translation"))).rejects.toThrow("BUDGET_EXHAUSTED");expect((await f.db.select().from(auditLogs)).filter(a=>a.action==="sav_derived_call_reserved")).toHaveLength(2);});
});

it("preserves pending translation and resumes automatically after a monetary wait",async()=>{
 await enqueueSavTranslation(messageId);await f.db.transaction(tx=>reserveSavDerivedCallTx(tx,"comparison"));
 await work();expect(translatedFetch).not.toHaveBeenCalled();expect((await getSavTranslations([messageId]))[messageId]).toMatchObject({status:"pending",errorCode:"SAV_DERIVED_MONETARY_BUDGET_EXHAUSTED"});
 const [pending]=await f.db.select().from(savMessageTranslations);expect(pending.attempts).toBe(0);
 const tomorrow=new Date(Date.now()+86400000);vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(tomorrow);
 try{await reconcileSavTranslations(2,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:translatedFetch,now:tomorrow});expect(translatedFetch).toHaveBeenCalledTimes(1);expect((await getSavTranslations([messageId]))[messageId].status).toBe("complete");}finally{vi.useRealTimers();}
});

it("releases its own untranslated lease when dispatch crosses UTC midnight and resumes without a lost attempt",async()=>{
 const reservedAt=new Date("2026-10-19T23:59:59Z"), dispatchedAt=new Date("2026-10-20T00:00:00Z");
 await enqueueSavTranslation(messageId);
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(dispatchedAt);
 try{
  await reconcileSavTranslations(2,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:translatedFetch,now:reservedAt});
  expect(translatedFetch).not.toHaveBeenCalled();
  const [pending]=await f.db.select().from(savMessageTranslations);
  expect(pending).toMatchObject({status:"pending",errorCode:"SAV_DERIVED_RESERVATION_STALE",attempts:0,leaseToken:null,leaseUntil:null});
  await reconcileSavTranslations(2,{apiKey:"synthetic",model:"gemini-3.6-flash",fetch:translatedFetch,now:dispatchedAt});
  expect(translatedFetch).toHaveBeenCalledTimes(1);
  expect((await getSavTranslations([messageId]))[messageId]).toMatchObject({status:"complete",errorCode:null});
 }finally{vi.useRealTimers();}
});
