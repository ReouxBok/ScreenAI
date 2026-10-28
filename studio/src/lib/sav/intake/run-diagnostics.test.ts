import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { savIntakeJournal, savIntakeRuns, savMessages, savMailboxes, savThreads } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { intakeDiagnosticPayload, readIntakeRunDiagnostics } from "./run-diagnostics";
import { GET } from "@/app/api/internal/sav/intake/[id]/diagnostics/route";

const s = vi.hoisted(() => ({ db: null as unknown, role: "admin", allowed: true }));
vi.mock("@/db", () => ({ requireDb: () => { if (!s.db) throw Error("DB_FORBIDDEN"); return s.db; } }));
vi.mock("./console-auth", () => ({ requireIntakeConsoleStaff: async () => { if (!s.allowed) throw Error("UNAUTHORIZED"); return {role:s.role}; } }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string, threadId: string, messageId: string;
beforeAll(async () => { fixture=await createSavTestDb();s.db=fixture.db; }, 30000);
afterAll(async () => { await fixture?.client.close(); });
beforeEach(async () => {
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1","synthetic-diagnostic-only-key-at-least-32");
  await fixture.client.exec("TRUNCATE sav.mailboxes CASCADE");
  const [mb]=await fixture.db.insert(savMailboxes).values({email:"support@example.invalid"}).returning();mailboxId=mb.id;
  const [t]=await fixture.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"private@example.invalid"}).returning();threadId=t.id;
  const [m]=await fixture.db.insert(savMessages).values({mailboxId,threadId,gmailMessageId:randomUUID(),direction:"inbound",fromEmail:"private@example.invalid",
    bodyCiphertext:encryptSavPayload({text:"PRIVATE BODY"}),receivedAt:new Date(),analysisStatus:"intake_pending"}).returning();messageId=m.id;
});
afterEach(() => {s.role="admin";s.allowed=true;s.db=fixture.db;vi.unstubAllEnvs();});
async function run(version:number, attempts:number, isCurrent:boolean, payload:unknown={}, mid=messageId) {
  return (await fixture.db.insert(savIntakeRuns).values({threadId,messageId:mid,version,attempts,isCurrent,state:isCurrent?"pending":"superseded",
    configHash:String(version).padStart(64,"0"),policyHash:"b".repeat(64),payloadCiphertext:encryptSavPayload(payload)}).returning())[0];
}
it("retains exhausted older versions and attempt-level failures without inheriting a plan or side effects",async()=>{
  const previous=await run(1,2,false,{reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT",input:{message:{contentComplete:false,currentText:"PRIVATE BODY"}},
    plan:{decision:{disposition:{kind:"collect_context",reasons:["classification_incomplete"]}},steps:[{mutation:"create_ticket"}]}});
  await fixture.db.insert(savIntakeJournal).values({runId:previous.id,kind:"waiting",payloadCiphertext:encryptSavPayload({reason:"SAV_INTAKE_MODEL_CITATION_REJECTED"})});
  const current=await run(2,0,true);
  const before=await fixture.client.query("select row_to_json(m) as row from sav.messages m");
  const result=(await readIntakeRunDiagnostics(threadId))!;
  // An earlier version that produced an analysis does not exhaust the new one (defect B).
  expect(result).toMatchObject({messageId,totalAttempts:2,attemptsExhausted:false,attemptBudget:{runAttempts:0,failed:0,total:2,exhausted:null},versionsTruncated:false,eventsTruncated:false});
  expect(result.runs[0]).toMatchObject({runId:current.id,state:"pending",attempts:0,diagnostic:{reason:null}});
  expect(result.runs[1]).toMatchObject({isCurrent:false,diagnostic:{reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT",contextReasons:["classification_incomplete"]},events:[{diagnostic:{reason:"SAV_INTAKE_MODEL_CITATION_REJECTED"}}]});
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE BODY|private@|mutation|create_ticket|steps|plan/);
  expect(await fixture.client.query("select row_to_json(m) as row from sav.messages m")).toEqual(before);
  for(const table of ["intake_executions","intake_effects","intake_model_calls","actions"])expect((await fixture.client.query(`select count(*)::int as n from sav.${table}`)).rows).toEqual([{n:0}]);
  expect((await fixture.db.select().from(savIntakeRuns)).map(r=>r.attempts).sort()).toEqual([0,2]);
});
it("does not assign a previous message's exhausted attempts or diagnostic to a new inbound",async()=>{
  await run(1,2,false,{reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT"});
  const [fresh]=await fixture.db.insert(savMessages).values({mailboxId,threadId,gmailMessageId:randomUUID(),direction:"inbound",fromEmail:"private@example.invalid",
    bodyCiphertext:encryptSavPayload({text:"NEW PRIVATE BODY"}),receivedAt:new Date(Date.now()+1000)}).returning();
  await run(2,0,true,{},fresh.id);
  expect(await readIntakeRunDiagnostics(threadId)).toMatchObject({messageId:fresh.id,totalAttempts:0,attemptsExhausted:false,runs:[{version:2,diagnostic:{reason:null}}]});
});
it("counts attempts outside the bounded displayed versions and explicitly reports omitted versions/events",async()=>{
  const old=await run(1,2,false,{reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT"});
  for(let version=2;version<=22;version++)await run(version,0,version===22);
  const rows=await fixture.db.select().from(savIntakeRuns);
  const visible=rows.find(r=>r.version===22)!;
  await fixture.db.insert(savIntakeJournal).values(Array.from({length:125},()=>({runId:visible.id,kind:"waiting",payloadCiphertext:encryptSavPayload({reason:"paused"})})));
  const result=(await readIntakeRunDiagnostics(threadId))!;
  expect(result.totalAttempts).toBe(2);expect(result.runs).toHaveLength(20);expect(result.runs.some(r=>r.runId===old.id)).toBe(false);
  expect(result.versionsTruncated).toBe(true);expect(result.eventsTruncated).toBe(true);expect(result.runs.flatMap(r=>r.events)).toHaveLength(120);
});
it("projects only bounded diagnostic facts from historical traces",()=>{
  const result=intakeDiagnosticPayload(encryptSavPayload({reason:"PRIVATE CUSTOMER CONTENT",input:{message:{contentComplete:false,currentText:"PRIVATE BODY"}},
    configuration:{codeRevision:"a".repeat(40)},attachments:{textComplete:true,inventory:{complete:false},read:{observations:[{filename:"PRIVATE FILENAME",text:"PRIVATE OCR",status:"not_read",reason:"image_limit"}]}},
    traces:[{operation:"email_lookup",status:"failed",reason:"HUBSPOT_HTTP_403",raw:"PRIVATE RESPONSE"},
      {phase:"ticket_matching",accepted:false,errorCode:"SAV_INTAKE_MODEL_CONTEXT_LIMIT",contextLimit:{stage:"data",bytes:50000,limitBytes:40000},validationFailure:{reason:"wrong_anchor_source",path:"PRIVATE PATH"}},
      {phase:"ticket_matching",accepted:false,errorCode:"SAV_INTAKE_MODEL_CONTEXT_LIMIT",contextLimit:{stage:"wire",bytes:140000,limitBytes:131072,breakdown:{sections:{contextBlocks:1000},history:{nestedComparisons:250,nestedComparisonsSkipped:40,nestedScanComplete:0}}}},
      {method:"assessIssues",errorCode:"SAV_INTAKE_SEMANTIC_COVERAGE_REJECTED",input:"PRIVATE SOURCE"}]}));
  expect(result).toMatchObject({readable:true,reason:null,input:{contentComplete:false,currentTextLength:12},attachments:{textComplete:true,inventoryComplete:false,observations:[{reason:"image_limit"}]} });
  expect(result.traces[1]).toMatchObject({contextLimit:{stage:"data",bytes:50000,limitBytes:40000},validationReason:"wrong_anchor_source"});
  expect(result.traces[2].contextLimit).toMatchObject({stage:"wire",bytes:140000,breakdown:{sections:{contextBlocks:1000},history:{nestedComparisons:250,nestedComparisonsSkipped:40,nestedScanComplete:0}}});
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(intakeDiagnosticPayload("corrupt").readable).toBe(false);
  expect(intakeDiagnosticPayload("x".repeat(262145)).readable).toBe(false);
  expect(intakeDiagnosticPayload(encryptSavPayload({traces:Array.from({length:41},()=>({}))}))).toMatchObject({tracesTruncated:true,traces:expect.any(Array)});
});
it.each(["member","viewer","none"])("rejects %s before any database query",async role=>{
  s.role=role;s.allowed=role!=="none";s.db=null;
  const response=await GET(new Request("https://example.invalid"),{params:Promise.resolve({id:threadId})});
  expect(response.status).toBe(403);expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("validates UUID and reads through the authenticated endpoint without a model/network capability",async()=>{
  expect((await GET(new Request("https://example.invalid"),{params:Promise.resolve({id:"invalid"})})).status).toBe(400);
  await run(1,2,true,{reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT"});
  const result=await GET(new Request("https://example.invalid"),{params:Promise.resolve({id:threadId})});
  expect(result.status).toBe(200);expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await result.json()).toMatchObject({diagnostics:{totalAttempts:2}});
  expect((await GET(new Request("https://example.invalid"),{params:Promise.resolve({id:randomUUID()})})).status).toBe(404);
});
it("exposes retry/origin/schema facts without their cached results or rejected values",()=>{
 const result=intakeDiagnosticPayload(encryptSavPayload({semantics:{records:[{method:"analyseMessage",result:{nature:"newsletter",requests:[],ticketSummary:{description:"PRIVATE"}}}]},readRecovery:{state:"scheduled",attempts:2,operation:"ticket_history",code:"SAV_HUBSPOT_READ_UNAVAILABLE",expiresAt:new Date(Date.now()+30000).toISOString(),cache:[{result:{data:"PRIVATE"}}]},traces:[{operation:"ticket_history",status:"failed",reason:"SAV_HUBSPOT_READ_UNAVAILABLE",transport:{origin:"transport",code:"SAV_HUBSPOT_READ_UNAVAILABLE",attempts:2,status:0,durationMs:216,raw:"PRIVATE"}},{phase:"understanding",validationFailure:{reason:"output_schema_invalid",path:"images.0.regions.0.box",issues:[{path:"images.0.regions.0.box",code:"too_big",maximum:4,rejectedValue:"PRIVATE"},{path:"PRIVATE",code:"invalid_type"}]}}]}));
 expect(result).toMatchObject({qualification:{nature:"newsletter",requestCount:0},readRecovery:{state:"scheduled",technicalAttempts:2,operation:"ticket_history",expired:false}});
 expect(result.traces[0]).toMatchObject({transport:{origin:"transport",attempts:2,status:0,durationMs:216}});expect(result.traces[1]).toHaveProperty("schemaIssues",[{path:"images.0.regions.0.box",code:"too_big",maximum:4},{path:"output",code:"invalid_type"}]);
 expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("reports a durable blocking marker on the current run as exhausted, with its attempt budget",async()=>{
  await run(1,2,false,{reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT"});
  const current=await run(2,2,true,{reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT"});
  await fixture.db.insert(savIntakeJournal).values({runId:current.id,kind:"attempts_exhausted",payloadCiphertext:encryptSavPayload({cause:"failed_per_message"})});
  expect(await readIntakeRunDiagnostics(threadId)).toMatchObject({attemptsExhausted:true,attemptBudget:{runAttempts:2,failed:4,total:4,exhausted:"per_version"}});
});

it("a large analysed payload is never read as a failure: no false exhaustion from the censored display (review P2)",async()=>{
  const bulky={plan:{decision:{disposition:{kind:"collect_context",reasons:["classification_incomplete"]}}},padding:"x".repeat(300_000)};
  await run(1,2,false,bulky); await run(2,2,false,bulky);
  await run(3,0,true);
  const result=(await readIntakeRunDiagnostics(threadId))!;
  expect(result.attemptsExhausted).toBe(false);
  expect(result.attemptBudget).toMatchObject({runAttempts:0,failed:0,unknown:0,total:4,exhausted:null});
  // The displayed page stays censored: no payload text is exposed.
  expect(JSON.stringify(result)).not.toContain("xxxxxxxx");
});
it("counts every version for the budget even when the displayed list is truncated, and an unreadable payload stays unknown",async()=>{
  const failedPayload={reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT"};
  for(let v=1;v<=21;v++) await run(v,0,false,{});
  await run(22,2,false,failedPayload); await run(23,1,false,"not-a-valid-ciphertext");
  await fixture.db.update(savIntakeRuns).set({payloadCiphertext:"not-a-valid-ciphertext"}).where(eq(savIntakeRuns.version,23));
  await run(24,0,true);
  const result=(await readIntakeRunDiagnostics(threadId))!;
  expect(result.versionsTruncated).toBe(true);
  // One unreadable attempt plus two failed ones cannot reach the failed cap of 4: verdict stays decidable.
  expect(result.attemptBudget).toMatchObject({failed:2,unknown:1,total:3,exhausted:null});
  expect(result.attemptsExhausted).toBe(false);
});

it("beyond the row bound the exact total still decides: 202 versions reaching the lifetime cap are exhausted (review P2)",async()=>{
  for(let v=1;v<=201;v++) await run(v,v<=4?2:0,false,{plan:{synthetic:true}});
  const current=await run(202,0,true);
  const result=(await readIntakeRunDiagnostics(threadId))!;
  expect(result.totalAttempts).toBe(8);
  expect(result.attemptBudget).toMatchObject({runAttempts:0,failed:0,unknown:0,total:8,exhausted:"total_per_message"});
  expect(result.attemptsExhausted).toBe(true);
  expect(result.runs[0].runId).toBe(current.id);
});
it("attempts the bounded reader cannot classify never turn into attempts remaining",async()=>{
  await run(1,2,false,{reason:"SAV_INTAKE_MODEL_CONTEXT_LIMIT"});
  await run(2,2,false,{});
  await fixture.db.update(savIntakeRuns).set({payloadCiphertext:"not-a-valid-ciphertext"}).where(eq(savIntakeRuns.version,2));
  await run(3,0,true);
  const result=(await readIntakeRunDiagnostics(threadId))!;
  expect(result.attemptBudget).toMatchObject({failed:2,unknown:2,total:4,exhausted:"undetermined"});
  expect(result.attemptsExhausted).toBeNull();
});

// ---- SAV-45 C: causes without a public code, uncertain usages and budget sub-limits.
import { savIntakeModelCalls } from "@/db/schema";
import { intakeRuntimeHash } from "./runtime-contract";
it("SAV-45 C: a wait without technical code keeps its engine cause or says it is unknown", async () => {
  await run(1, 2, true, { plan: { decision: { disposition: { kind: "collect_context", reasons: ["history_incomplete", "same_issue_unresolved"] } }, progress: { kind: "collect_context" } } });
  const [current] = (await readIntakeRunDiagnostics(threadId))!.runs;
  expect(current.diagnostic).toMatchObject({ reason: null, waitingCause: "context_required", contextReasons: ["history_incomplete", "same_issue_unresolved"] });
  expect(intakeDiagnosticPayload(encryptSavPayload({}))).toMatchObject({ reason: null, waitingCause: "unknown" });
  expect(intakeDiagnosticPayload(encryptSavPayload({ reason: "SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED", budgetLimit: "per_message" }))).toMatchObject({ waitingCause: null, budgetLimit: "per_message" });
  expect(intakeDiagnosticPayload(encryptSavPayload({ reason: "SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED", budgetLimit: "raise_me" }))).toMatchObject({ budgetLimit: null });
});
it("SAV-45 C: uncertain usages are described from the ledger, never settled, zeroed or retried", async () => {
  const r = await run(1, 1, true, { reason: "SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN" }), key = intakeRuntimeHash(messageId);
  const row = (state: string, payload: unknown, hash: string) => ({ runId: r.id, messageKey: key, requestHash: hash, state, reservedNanoUsd: 817_152_000, chargedNanoUsd: state === "settled" ? 0 : 817_152_000, payloadCiphertext: encryptSavPayload(payload) });
  await fixture.db.insert(savIntakeModelCalls).values([
    row("uncertain", { metadata: {} }, "a".repeat(64)), row("uncertain", { metadata: { inputTokens: 100 } }, "b".repeat(64)),
    row("settled", { metadata: {}, usageReconciliation: "provider_http_error_unbilled.v1", providerStatus: 503 }, "c".repeat(64)), row("dispatched", { model: "gemini-3.6-flash" }, "d".repeat(64))]);
  const before = await fixture.db.select().from(savIntakeModelCalls);
  const calls = (await readIntakeRunDiagnostics(threadId))!.modelCalls;
  expect(calls.map(c => c.usage).sort()).toEqual(["counters_incomplete", "in_flight_or_lost", "no_usage_received", "provider_http_unbilled"]);
  expect(calls.find(c => c.usage === "provider_http_unbilled")).toMatchObject({ providerStatus: 503, chargedNanoUsd: 0, state: "settled" });
  expect(calls.filter(c => c.state === "uncertain").every(c => c.chargedNanoUsd === 817_152_000)).toBe(true);
  expect(await fixture.db.select().from(savIntakeModelCalls)).toEqual(before);
  expect(JSON.stringify(calls)).not.toMatch(/gemini|metadata|inputTokens/);
});
