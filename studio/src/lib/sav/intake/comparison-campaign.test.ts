/** Lot 4: the separate comparison campaign on a frozen list of stored dossiers, through the real
 * readers, engine, dispatcher and both ledgers. Never on the live path, no write, own budget. */
import { createHash, randomUUID } from "node:crypto";
import { encodeSimpleWireFixture } from "./simple-wire.fixture";
import { readIntakeOtherRules } from "./other-routing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savIntakeRuns, savIntakeModelCalls, savActions, savIntakeExecutions, auditLogs } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DATABASE_ALLOWED"); return state.db; } }));
import { encryptSavPayload } from "../crypto";
import { intakeRuntimeHash } from "./runtime-contract";
import { claimSavIntakeComparison, compareIntakeSides, readSavIntakeComparisonReport, reserveSavIntakeComparisonCall, runSavIntakeComparisonBatch, savIntakeComparisonSpend } from "./comparison-campaign";

const KEY = "synthetic-intake-runtime-encryption-key";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
function env(mailbox: string, messageIds: string[], over: Record<string, unknown> = {}) {
  const policy = { relationRevision: "synthetic-no-associations", admittedRelations: [], resources: {} };
  return { SAV_INTAKE_RUNTIME_MODE: "observe", SAV_CODE_REVISION: "a".repeat(40), SAV_AI_MODEL: "gemini-3.6-flash", SAV_GEMINI_API_KEY: "fake-model", HUBSPOT_ACCESS_TOKEN: "fake-crm",
    SAV_ENCRYPTION_KEY_V1: KEY, SAV_INTAKE_RUNTIME_POLICY: JSON.stringify(policy), SAV_INTAKE_RUNTIME_RESOURCES: "[]",
    SAV_INTAKE_COMPARISON_JSON: JSON.stringify({ campaignId: "sample-60", messageIds, maxNanoUsd: 5_000_000_000, until: new Date(Date.now() + 86_400_000).toISOString(), ...over }),
    SAV_INTAKE_RUNTIME_CONFIG: JSON.stringify({ mailboxId: mailbox, receivedAfter: new Date(Date.now() - 3600_000).toISOString(), createdAfter: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 }) };
}
async function stored(text = "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.", attachments: unknown[] = []) {
  const threadId = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid" }).returning())[0].id;
  const [m] = await f.db.insert(savMessages).values({ mailboxId, threadId, direction: "inbound", fromEmail: "client@example.invalid", toEmails: ["support@example.invalid"],
    subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text, attachments, headers: {} }),
    receivedAt: new Date(Date.now() - 86_400_000), createdAt: new Date(Date.now() - 86_400_000), analysisStatus: "intake_observed" }).returning();
  return m;
}
/** Synthetic Gemini for both readers and an empty, read-only CRM; records every request. */
function provider(options: { currentStatus?: number; simpleStatus?: number } = {}) {
  const seen: string[] = [], crm: { method: string; url: string }[] = [];
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text), simple = typeof data.current === "string", messageId = data.message?.id ?? data.message?.messageId;
      seen.push(simple ? "simple" : "current");
      if (!simple && options.currentStatus) return new Response("{}", { status: options.currentStatus });
      if (simple && options.simpleStatus) return Response.json({ error: { status: "INVALID_ARGUMENT", message: "Schema has too many states. private@example.test" } }, { status: options.simpleStatus });
      const id = simple ? data.message.id : data.message.id;
      const answer = simple
        ? { messageId: id, nature: "request", requests: [{ id: "r1", kind: "support", summary: "Synchronisation.", sourceIds: ["current"] }], ticketTitle: "Échec de synchronisation de l'agenda",
          ticketDescription: "Erreur 500.", identity: { kind: "unknown", contactIds: [], why: "Aucune fiche." }, tickets: [], missing: [], rationale: "Support." }
        : { messageId: id, requests: [{ id: "r1", kind: "support", currentMessageId: id, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
          ticketSummary: { title: "Échec de synchronisation de l'agenda", description: "Erreur 500.", requestIds: ["r1"] } };
      void messageId;
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(typeof data.current === "string" ? encodeSimpleWireFixture(answer, data.outputReferences) : answer) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, thoughtsTokenCount: 0, totalTokenCount: 360 } });
    }
    if (String(url).startsWith("https://api.hubapi.com/")) { crm.push({ method: init?.method ?? "GET", url: String(url) }); return Response.json({ total: 0, results: [] }); }
    throw Error("EXTERNAL_NETWORK_FORBIDDEN");
  });
  return { network, seen, crm };
}
const ledger = () => f.db.select().from(auditLogs).where(and(eq(auditLogs.action, "sav_intake_comparison"), eq(auditLogs.entityType, "sav_intake_comparison")));

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30_000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("EXTERNAL_NETWORK_FORBIDDEN"));
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("comparison campaign (lot 4)", () => {
  it("is off without its configuration", async () => {
    const e = env(mailboxId, [randomUUID()]); delete (e as Record<string, unknown>).SAV_INTAKE_COMPARISON_JSON;
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: provider().network })).toEqual({ skipped: "off" });
    expect(await ledger()).toEqual([]);
  });
  it("compares both readers on one frozen snapshot, on its own ledger, without touching runs, the live ledger or the CRM", async () => {
    const a = await stored(), b = await stored("Bonjour, ma connexion échoue encore."), p = provider(), e = env(mailboxId, [a.id, b.id]);
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 5 })).toMatchObject({ compared: [{ messageId: a.id, verdict: "identical" }, { messageId: b.id, verdict: "identical" }] });
    expect(p.seen.filter(s => s === "simple")).toHaveLength(2);
    expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
    expect(await f.db.select().from(savIntakeRuns)).toEqual([]);
    expect(p.crm.every(c => c.method === "GET" || c.url.endsWith("/search"))).toBe(true);
    expect(await f.db.select().from(savActions)).toHaveLength(0); expect(await f.db.select().from(savIntakeExecutions)).toHaveLength(0);
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report).toMatchObject({ configured: true, denominators: { listed: 2, done: 2, interrupted: 0, pending: 0 }, verdicts: { identical: 2 } });
    expect(report.configured && report.spend.nanoUsd).toBeGreaterThan(0);
    expect(report.configured && report.rows[0].detail).toMatchObject({ snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/), coverage: [] });
    // Already compared: a new batch does nothing.
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: p.network })).toMatchObject({ compared: [] });
  });
  it("two concurrent batches never compare the same dossier twice (review P2)", async () => {
    const a = await stored(), b = await stored(), p = provider(), e = env(mailboxId, [a.id, b.id]);
    await Promise.all([runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 2 }), runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 2 })]);
    expect(p.seen.filter(s => s === "simple")).toHaveLength(2);
    expect((await ledger()).filter(x => x.technicalMetadata.event === "result")).toHaveLength(2);
    expect(await claimSavIntakeComparison("sample-60", a.id)).toBeNull();
  });
  it("an expired campaign cannot reserve another paid dispatch (review P2)", async () => {
    const a = await stored(), e = env(mailboxId, [a.id], { until: new Date(Date.now() - 1000).toISOString() });
    await expect(reserveSavIntakeComparisonCall(() => e, "sample-60", a.id, randomUUID(), "a".repeat(64), "gemini-3.6-flash")).rejects.toThrow("SAV_INTAKE_COMPARISON_EXPIRED");
    expect(await ledger()).toEqual([]);
  });
  it("spend does not depend on the order events are returned in (review P2)", () => {
    expect(savIntakeComparisonSpend([{ callId: "c", event: "settled", state: "settled", chargedNanoUsd: 1 }, { callId: "c", event: "reserved", reservedNanoUsd: 817152000 }])).toBe(1);
    expect(savIntakeComparisonSpend([{ callId: "c", event: "reserved", reservedNanoUsd: 817152000 }, { callId: "c", event: "settled", state: "uncertain", chargedNanoUsd: 0 }])).toBe(817152000);
    expect(savIntakeComparisonSpend([{ callId: "c", event: "reserved", reservedNanoUsd: 817152000 }])).toBe(817152000);
  });
  it("a failure of the current reader is technical evidence, never a divergence of judgement (review P2)", async () => {
    const a = await stored(), e = env(mailboxId, [a.id]);
    const result = await runSavIntakeComparisonBatch({ env: () => e, network: provider({ currentStatus: 500 }).network });
    expect(result).toMatchObject({ compared: [{ verdict: "incomplete" }] });
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report.configured && report.rows[0].detail).toMatchObject({ differences: ["current:SAV_AI_HTTP_500", "simple:ok"] });
    expect(compareIntakeSides({ summary: null, technical: "SAV_AI_HTTP_500", uncertain: false, calls: 1 }, { summary: { classification: "support" } as never, technical: null, uncertain: false, calls: 1 }, []).verdict).toBe("incomplete");
  });
  it("its own money cap stops the campaign, recorded as incomplete", async () => {
    const a = await stored(), p = provider(), e = env(mailboxId, [a.id], { maxNanoUsd: 1 });
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: p.network })).toMatchObject({ compared: [{ verdict: "incomplete" }] });
    expect(p.seen).toEqual([]);
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report.configured && report.spend.nanoUsd).toBe(0);
  });
  it("a dossier with attachments is reported as not comparable here, never as a judgement", async () => {
    const a = await stored("Voir la capture.", [{ filename: "capture.png" }]), e = env(mailboxId, [a.id]);
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: provider().network })).toMatchObject({ compared: [{ verdict: "non_comparable" }] });
  });
  it("an interrupted dossier (claim without result) is reported and never re-sent automatically", async () => {
    const a = await stored(), b = await stored(), p = provider(), e = env(mailboxId, [a.id, b.id]);
    await claimSavIntakeComparison("sample-60", a.id);
    await runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 5 });
    expect(p.seen.filter(s => s === "simple")).toHaveLength(1);
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report).toMatchObject({ denominators: { listed: 2, done: 1, interrupted: 1, pending: 0 } });
  });
});

it("REVIEW an incomplete CRM capture is not counted as comparable judgement",async()=>{
 const m=await stored(),e=env(mailboxId,[m.id]),p=provider();
 const network:typeof fetch=async(url,init)=>String(url).startsWith("https://api.hubapi.com/")?new Response("{}",{status:503}):p.network(url,init);
 await runSavIntakeComparisonBatch({env:()=>e,network});
 const report=await readSavIntakeComparisonReport(()=>e);
 expect(["non_comparable","incomplete"]).toContain(report.configured && report.rows[0].verdict);
});

import * as hubspotReaders from "./hubspot-readers";
function reviewText(seed:number,size:number){return Array.from({length:size},(_,i)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return i%12===11?" ":String.fromCharCode(97+(seed>>>8)%26);}).join("")+" FIN";}
it("REVIEW the campaign gives current grouped matching a working preflight",async()=>{
 const m=await stored(),e=env(mailboxId,[m.id]),base=provider(),at=new Date(Date.now()-2*86400000).toISOString();
 const tickets=["201","202"].map(id=>({id,contactIds:["101"],stage:"open" as const,createdAt:at,ownerId:null,subject:"Synchronisation",content:"Erreur"}));
 const complete=<T>(data:T)=>({status:"complete" as const,data,observedAt:new Date().toISOString()});
 const spy=vi.spyOn(hubspotReaders,"createSavIntakeHubspotReaders").mockReturnValue({
  findContactsByEmail:async()=>complete([{id:"101",emails:["client@example.invalid"]}]),directAssociations:async()=>complete([]),getContact:async()=>complete({id:"101",emails:["client@example.invalid"]}),
  ticketsForContact:async()=>complete(tickets),ticketHistory:async(id)=>complete([0,1,2].map(i=>({id:`note-${id}-${i}`,kind:"note" as const,at,text:reviewText(Number(id)*10+i,90000)})))
 });
 const network:typeof fetch=async(url,init)=>{
  if(String(url).startsWith("https://generativelanguage.googleapis.com/")){
   const d=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
   if(d.tickets && typeof d.current!=="string"){
    const ans={investigationComplete:true,tickets:d.tickets.map(({ticket}:{ticket:{id:string}})=>({ticketId:ticket.id,relation:"same",requestIds:["r1"],evidenceIds:["current",`ticket-${ticket.id}`,`history-${ticket.id}`],rationale:"Same issue",grounding:["current",`ticket-${ticket.id}`,`history-${ticket.id}`].map(src=>({quoteId:d.citationCatalogue.find((x:{sourceId:string})=>x.sourceId===src).id}))}))};
    return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(ans)}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:60,thoughtsTokenCount:0,totalTokenCount:360}});
   }
  }
  return base.network(url,init);
 };
 try{
  await runSavIntakeComparisonBatch({env:()=>e,network});
  const report=await readSavIntakeComparisonReport(()=>e);
  const detail=report.configured && report.rows[0].detail as {current:{technical:string|null}};
  expect(detail && detail.current.technical).toBeNull();
 }finally{spy.mockRestore();}
},30000);
it("a dossier an approved Other rule matches is not comparable here, never a judgement", async () => {
  const text = "Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.", m = await stored(text), p = provider();
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const rules = [{ id: "r1", family: "own_campaign_copy", mailboxId, subjectSha256: sha("Synchronisation agenda"), bodySha256: sha(text) }];
  const catalogue = { version: 1, resource: { resourceId: "synthetic", revisionId: "1", sha256: sha(JSON.stringify(rules)) }, approvedBy: "synthetic-admin",
    approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), rules };
  const e: Record<string, string | undefined> = { ...env(mailboxId, [m.id]), SAV_INTAKE_OTHER_RULES_JSON: JSON.stringify(catalogue) };
  expect(await runSavIntakeComparisonBatch({ env: () => e, network: p.network })).toMatchObject({ compared: [{ verdict: "non_comparable" }] });
  const report = await readSavIntakeComparisonReport(() => e);
  expect(report.configured && report.rows[0].detail).toMatchObject({ differences: ["qualified_other_candidate"] });
});

function reviewCatalogue(subject:string,text:string,box:string,expired=false){
 const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
 const rules=[{id:"r1",family:"own_campaign_copy",mailboxId:box,subjectSha256:sha(subject),bodySha256:sha(text)}];
 return {version:1,resource:{resourceId:"synthetic",revisionId:"1",sha256:sha(JSON.stringify(rules))},approvedBy:"synthetic-admin",approvedAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+(expired?-1000:3600000)).toISOString(),rules};
}
it("REVIEW a valid nonmatching Other catalogue still allows the support comparison",async()=>{
 const m=await stored(),p=provider();
 const e={...env(mailboxId,[m.id]),SAV_INTAKE_OTHER_RULES_JSON:JSON.stringify(reviewCatalogue("different subject","different body",mailboxId))};
 expect(readIntakeOtherRules(e.SAV_INTAKE_OTHER_RULES_JSON)).not.toBeNull();
 await runSavIntakeComparisonBatch({env:()=>e,network:p.network});
 const report=await readSavIntakeComparisonReport(()=>e);
 expect(report.configured && report.rows[0].verdict).toBe("identical");
});
it.each(["malformed","expired"])("REVIEW an %s Other catalogue cannot silently yield a production-equivalent judgement",async(kind)=>{
 const m=await stored(),p=provider();
 const raw=kind==="malformed"?"[]":JSON.stringify(reviewCatalogue("Synchronisation agenda","Bonjour, la synchronisation de mon agenda échoue avec une erreur 500.",mailboxId,true));
 expect(()=>readIntakeOtherRules(raw)).toThrow("SAV_INTAKE_OTHER_CONFIGURATION_REQUIRED");
 const e={...env(mailboxId,[m.id]),SAV_INTAKE_OTHER_RULES_JSON:raw};
 await runSavIntakeComparisonBatch({env:()=>e,network:p.network});
 const report=await readSavIntakeComparisonReport(()=>e);
 expect(["non_comparable","incomplete"]).toContain(report.configured && report.rows[0].verdict);
 expect(report.configured && report.rows[0].detail).toMatchObject({ differences: ["SAV_INTAKE_OTHER_CONFIGURATION_REQUIRED"] });
 expect(p.seen).toEqual([]);
});

it("allows a model answer beyond the CRM deadline within the existing AI transport allowance", async () => {
  const m = await stored(), e = env(mailboxId, [m.id]), p = provider();
  let currentStarted = false, simpleStarted = false;
  const network: typeof fetch = async (url, init) => {
    if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return p.network(url, init);
    const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
    const simple = typeof data.current === "string";
    const answer = new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { void p.network(url, init).then(resolve, reject); }, 12_000);
      init!.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(init!.signal!.reason); }, { once: true });
    });
    if (simple) simpleStarted = true; else currentStarted = true;
    return answer;
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const work = runSavIntakeComparisonBatch({ env: () => e, network, limit: 1 });
    let finished = false; const completed = work.finally(() => { finished = true; });
    await vi.waitFor(() => expect(currentStarted).toBe(true)); await vi.advanceTimersByTimeAsync(12_000);
    await vi.waitFor(() => expect(simpleStarted).toBe(true)); await vi.advanceTimersByTimeAsync(12_000);
    await vi.waitFor(() => expect(finished).toBe(true)); await completed;
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report.configured && report.rows[0]).toMatchObject({ verdict: "identical", detail: {
      current: { technical: null, uncertain: false }, simple: { technical: null, uncertain: false }, coverage: [] } });
    expect((await ledger()).filter(x => x.technicalMetadata.event === "reserved")).toHaveLength(2);
    expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
    expect(await f.db.select().from(savIntakeRuns)).toEqual([]);
  } finally { vi.useRealTimers(); }
}, 30_000);

it("a simple HTTP400 uses the shared zero-charge settlement and persists only allowlisted rejection facts", async () => {
  const m = await stored(), e = env(mailboxId, [m.id]), p = provider({ simpleStatus: 400 });
  await runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 1 });
  const all = (await ledger()).map(x => x.technicalMetadata);
  const settled = all.filter(x => x?.event === "settled");
  expect(settled).toHaveLength(2);
  expect(settled[1]).toMatchObject({ state: "settled", chargedNanoUsd: 0 });
  const report = await readSavIntakeComparisonReport(() => e);
  if (!report.configured) throw Error("FIXTURE_CAMPAIGN_REQUIRED");
  expect(report.rows[0].detail).toMatchObject({ simple: { calls: 1, uncertain: false, diagnostics: { dispatches: 1, httpResponses: 1, requests: [expect.objectContaining({ httpStatus: 400, providerRejection: { status: "INVALID_ARGUMENT", reason: "schema_complexity", fields: [], bodyRead: "complete", bytesRead: expect.any(Number) }, schema: expect.objectContaining({ boundedArrays: 0 }) })] } } });
  expect(JSON.stringify(report.rows[0].detail)).not.toContain("private@example.test");
  expect(p.seen).toEqual(["current", "simple"]);
  expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
});
it.each([400, 429, 503])("a received provider HTTP %s settles at zero without retrying or touching the operational ledger", async status => {
  const m = await stored(), e = env(mailboxId, [m.id]), p = provider({ currentStatus: status });
  await runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 1 });
  const rows = await ledger(), reserved = rows.filter(x => x.technicalMetadata.event === "reserved");
  expect(reserved).toHaveLength(2);
  expect(rows.find(x => x.technicalMetadata.event === "settled" && x.technicalMetadata.callId === reserved[0].technicalMetadata.callId)?.technicalMetadata).toMatchObject({ state: "settled", chargedNanoUsd: 0 });
  expect(p.seen).toEqual(["current", "simple"]);
  expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
});
it("a lost provider response remains uncertain and is never resent by the campaign", async () => {
  const m = await stored(), e = env(mailboxId, [m.id]), p = provider(); let sent = 0;
  const network: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/") && sent++ === 0) throw Error("SYNTHETIC_RESPONSE_LOST");
    return p.network(url, init);
  };
  await runSavIntakeComparisonBatch({ env: () => e, network, limit: 1 });
  const report = await readSavIntakeComparisonReport(() => e);
  expect(report.configured && report.rows[0]).toMatchObject({ verdict: "incomplete", detail: { current: { uncertain: true, technical: "SAV_AI_GENERATION_FAILED" } } });
  expect(report.configured && report.spend.nanoUsd).toBeGreaterThanOrEqual(817_152_000);
  expect(await runSavIntakeComparisonBatch({ env: () => e, network, limit: 1 })).toMatchObject({ compared: [] });
  expect(sent).toBe(2);
});
it("a reservation waiting beyond the side deadline cannot reserve or dispatch after the lock is obtained", async () => {
  const m = await stored(), e = env(mailboxId, [m.id]), p = provider();
  const transaction = f.db.transaction.bind(f.db); let count = 0, waiting = false;
  const spy = vi.spyOn(f.db, "transaction").mockImplementation(async (...args: Parameters<typeof transaction>) => {
    if (++count === 2) { waiting = true; await new Promise(resolve => setTimeout(resolve, 61_000)); }
    return transaction(...args);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let finished = false; const work = runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 1 }).finally(() => { finished = true; });
    await vi.waitFor(() => expect(waiting).toBe(true));
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(() => expect(finished).toBe(true)); await work;
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report.configured && report.rows[0]).toMatchObject({ verdict: "incomplete", detail: { current: { technical: "SAV_INTAKE_COMPARISON_DEADLINE", uncertain: false }, simple: { technical: null, uncertain: false } } });
    expect(p.seen).toEqual(["simple"]);
    expect((await ledger()).filter(x => x.technicalMetadata.event === "reserved")).toHaveLength(1);
    expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
  } finally { spy.mockRestore(); vi.useRealTimers(); }
}, 30_000);

it("a verified cost settled after the deadline never turns an expired side into a comparable judgement", async () => {
  const m = await stored(), e = env(mailboxId, [m.id]), p = provider();
  const query = f.client.query.bind(f.client); let delaying = false;
  const spy = vi.spyOn(f.client, "query").mockImplementation(async (...args: Parameters<typeof query>) => {
    const result = await query(...args);
    if (!delaying && String(args[0]).startsWith('insert into "audit_logs"') && JSON.stringify(args[1]).includes('\\"event\\":\\"settled\\"')) {
      delaying = true; await new Promise(resolve => setTimeout(resolve, 61_000));
    }
    return result;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let finished = false; const work = runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 1 }).finally(() => { finished = true; });
    await vi.waitFor(() => expect(delaying).toBe(true)); await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor(() => expect(finished).toBe(true)); await work;
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report.configured && report.rows[0]).toMatchObject({ verdict: "incomplete", detail: { current: { summary: null, technical: "SAV_INTAKE_COMPARISON_DEADLINE", uncertain: false } } });
    const rows = await ledger();
    expect(rows.filter(x => x.technicalMetadata.event === "settled").every(x => x.technicalMetadata.state === "settled")).toBe(true);
    expect(report.configured && report.spend.nanoUsd).toBeGreaterThan(0);
  } finally { spy.mockRestore(); vi.useRealTimers(); }
}, 30_000);

import * as semanticReadersInvestigation from "./model-readers";
it("INVESTIGATION matching citation detail exists in reader but is discarded by campaign",async()=>{
 const message=await stored(),e=env(mailboxId,[message.id]),base=provider(),at=new Date(Date.now()-2*86400000).toISOString();
 const complete=<T>(data:T)=>({status:"complete" as const,data,observedAt:new Date().toISOString()});
 const ticket={id:"201",contactIds:["101"],stage:"open" as const,createdAt:at,ownerId:null,subject:"Agenda",content:"Synchronisation impossible"};
 const crmSpy=vi.spyOn(hubspotReaders,"createSavIntakeHubspotReaders").mockReturnValue({
  findContactsByEmail:async()=>complete([{id:"101",emails:["client@example.invalid"]}]),directAssociations:async()=>complete([]),
  getContact:async()=>complete({id:"101",emails:["client@example.invalid"]}),ticketsForContact:async()=>complete([ticket]),
  ticketHistory:async()=>complete([{id:"n1",at,kind:"note" as const,text:"Synchronisation de l'agenda en panne"}]),
 });
 const original=semanticReadersInvestigation.createSavIntakeSemanticReaders,traces: import("./model-readers").IntakeModelTrace[]=[];
 const traceSpy=vi.spyOn(semanticReadersInvestigation,"createSavIntakeSemanticReaders").mockImplementation(options=>original({...options,onTrace:trace=>{traces.push(trace);options.onTrace?.(trace)}}));
 const network:typeof fetch=async(url,init)=>{
  if(!String(url).startsWith("https://generativelanguage.googleapis.com/"))return base.network(url,init);
  const data=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
  if(data.current!==undefined){
   const answer={messageId:data.message.id,nature:"request",requests:[{id:"r1",kind:"support",summary:"Agenda en panne",sourceIds:["current"]}],
    identity:{kind:"unique",contactIds:["101"],why:"Sender record"},tickets:[{ticketId:"201",relation:"same",why:"Same problem",sourceIds:["current","ticket-201","history-201"]}],missing:[],rationale:"Support"};
   return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(typeof data.current === "string" ? encodeSimpleWireFixture(answer, data.outputReferences) : answer)}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:60,thoughtsTokenCount:0,totalTokenCount:360}});
  }
  if(data.tickets){
   // Valid quoteId, but current alone cannot ground a positive match against this ticket/history.
   const answer={investigationComplete:true,tickets:[{ticketId:"201",relation:"same",requestIds:["r1"],evidenceIds:["current","ticket-201","history-201"],rationale:"Same problem",grounding:[{quoteId:data.citationCatalogue.find((x:{sourceId:string})=>x.sourceId==="current").id}]}]};
   return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(answer)}]}}],usageMetadata:{promptTokenCount:300,candidatesTokenCount:60,thoughtsTokenCount:0,totalTokenCount:360}});
  }
  return base.network(url,init);
 };
 try{
  await runSavIntakeComparisonBatch({env:()=>e,network,limit:1});
  expect(traces).toContainEqual(expect.objectContaining({phase:"ticket_matching",errorCode:"SAV_INTAKE_MODEL_CITATION_REJECTED",validationFailure:{reason:"required_source_missing",path:"grounding",stage:"evidence"}}));
  const report=await readSavIntakeComparisonReport(()=>e);if(!report.configured)throw Error("TEST_CONFIG");
  expect(report.rows[0].detail).toMatchObject({current:{technical:"SAV_INTAKE_MODEL_CITATION_REJECTED"}});
  expect(report.rows[0].detail).toMatchObject({current:{diagnostics:{failures:[{phase:"ticket_matching",code:"SAV_INTAKE_MODEL_CITATION_REJECTED",validationFailure:{reason:"required_source_missing",path:"grounding",stage:"evidence"}}]}}});
  expect(JSON.stringify(report.rows[0].detail)).not.toContain("client@example.invalid");
  expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
  expect(await f.db.select().from(savActions)).toEqual([]);
 }finally{traceSpy.mockRestore();crmSpy.mockRestore()}
},30000);

it("SAV46 the real simple campaign dispatcher admits a38s answer, leaving current standard",async()=>{
 const m=await stored(),e=env(mailboxId,[m.id]),p=provider();let started=false;
 const network:typeof fetch=async(url,init)=>{
  if(!String(url).startsWith("https://generativelanguage.googleapis.com/"))return p.network(url,init);
  const data=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
  if(typeof data.current!=="string")return p.network(url,init);
  started=true;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{void p.network(url,init).then(resolve,reject)},38_000);
   init!.signal!.addEventListener("abort",()=>{clearTimeout(timer);reject(init!.signal!.reason)},{once:true});});
 };
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
 try{
  let finished=false;const work=runSavIntakeComparisonBatch({env:()=>e,network,limit:1}).finally(()=>{finished=true});
  await vi.waitFor(()=>expect(started).toBe(true));await vi.advanceTimersByTimeAsync(38_000);await vi.waitFor(()=>expect(finished).toBe(true));await work;
  const report=await readSavIntakeComparisonReport(()=>e);if(!report.configured)throw Error("TEST_CONFIG");
  expect(report.rows[0].verdict).toBe("identical");
  expect(report.rows[0].detail).toMatchObject({current:{diagnostics:{requests:[{generationBudget:"standard",dispatched:true,httpStatus:200}],dispatches:1,httpResponses:1}},simple:{diagnostics:{requests:[{generationBudget:"single_pass",dispatched:true,httpStatus:200}],dispatches:1,httpResponses:1}}});
  expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
 }finally{vi.useRealTimers()}
},30000);
it("SAV46 a timeout preserves the counted reservation and reports one send even with zero trace responses",async()=>{
 const m=await stored(),e=env(mailboxId,[m.id]),p=provider();
 const network:typeof fetch=async(url,init)=>{
  if(String(url).startsWith("https://generativelanguage.googleapis.com/")){
   const data=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
   if(typeof data.current==="string")throw Error("SYNTHETIC_LOST_BODY");
  }return p.network(url,init);
 };
 await runSavIntakeComparisonBatch({env:()=>e,network,limit:1});
 const report=await readSavIntakeComparisonReport(()=>e);if(!report.configured)throw Error("TEST_CONFIG");
 expect(report.rows[0].detail).toMatchObject({simple:{uncertain:true,calls:1,diagnostics:{dispatches:1,httpResponses:0,requests:[{dispatched:true,httpStatus:null,transport:{attempts:1}}]}}});
 expect(report.spend.nanoUsd).toBeGreaterThanOrEqual(817152000);
 expect(await runSavIntakeComparisonBatch({env:()=>e,network,limit:1})).toMatchObject({compared:[]});
});
it("reports a truncated simple response as one dispatched call with settled safe metadata", async () => {
 const m=await stored(),e=env(mailboxId,[m.id]),p=provider();
 const network:typeof fetch=async(url,init)=>{
  if(String(url).startsWith("https://generativelanguage.googleapis.com/")){
   const data=JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text);
   if(typeof data.current==="string")return Response.json({candidates:[{finishReason:"MAX_TOKENS",content:{parts:[{text:'{"syntheticPartial":'}]}}],
    usageMetadata:{promptTokenCount:170106,candidatesTokenCount:8177,thoughtsTokenCount:0,totalTokenCount:178283}});
  }return p.network(url,init);
 };
 await runSavIntakeComparisonBatch({env:()=>e,network,limit:1});
 const report=await readSavIntakeComparisonReport(()=>e);if(!report.configured)throw Error("TEST_CONFIG");
 expect(report.rows[0].detail).toMatchObject({simple:{technical:"SAV_AI_OUTPUT_TRUNCATED",uncertain:false,calls:1,
  diagnostics:{dispatches:1,httpResponses:1,requests:[{dispatched:true,httpStatus:200,finishReason:"MAX_TOKENS",inputTokens:170106,outputTokens:8177,thoughtTokens:0,totalTokens:178283}]}}});
 expect(JSON.stringify(report.rows[0].detail)).not.toContain("syntheticPartial");
 expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
 expect(await f.db.select().from(savActions)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// SAV-46: private qualification receipts. Synthetic dossier: one contact, one open ticket owned by
// "777", one note. Both readers link it; the receipt must keep what the summary projection loses.
import * as cryptoModule from "../crypto";
import { frozenComparisonCrm, readSavIntakeComparisonEvidence } from "./comparison-campaign";
import { SAV_READER_EVIDENCE_LIMITS } from "./comparison-evidence";
function ticketDossier(options: { historyText?: string; historyEntries?: number; tickets?: string[] } = {}) {
  const at = new Date(Date.now() - 2 * 86400000).toISOString(), reads: string[] = [];
  const complete = <T>(data: T) => ({ status: "complete" as const, data, observedAt: new Date().toISOString() });
  const ids = options.tickets ?? ["201"];
  const spy = vi.spyOn(hubspotReaders, "createSavIntakeHubspotReaders").mockReturnValue({
    findContactsByEmail: async email => { reads.push(`contacts:${email}`); return complete([{ id: "101", emails: ["client@example.invalid"] }]); },
    directAssociations: async id => { reads.push(`associations:${id}`); return complete([]); },
    getContact: async id => { reads.push(`contact:${id}`); return complete({ id: "101", emails: ["client@example.invalid"] }); },
    ticketsForContact: async id => { reads.push(`tickets:${id}`); return complete(ids.map(t => ({ id: t, contactIds: ["101"], stage: "open" as const, createdAt: at, ownerId: "777", subject: "Agenda", content: "Synchronisation impossible" }))); },
    ticketHistory: async id => { reads.push(`history:${id}`); return complete(Array.from({ length: options.historyEntries ?? 1 }, (_, i) => ({ id: `n${id}-${i}`, at, kind: "note" as const, text: options.historyText ?? "Synchronisation de l'agenda en panne" }))); },
  });
  return { spy, reads };
}
function ticketNetwork(base: ReturnType<typeof provider>, onModel?: (simple: boolean) => void): typeof fetch {
  return async (url, init) => {
    if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return base.network(url, init);
    const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text), simple = typeof data.current === "string";
    onModel?.(simple); base.seen.push(simple ? "simple" : "current");
    const reply = (answer: unknown) => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, thoughtsTokenCount: 0, totalTokenCount: 360 } });
    if (simple) return reply(encodeSimpleWireFixture({ messageId: data.message.id, nature: "request",
      requests: [{ id: "r1", kind: "support", summary: "SYN agenda en panne", sourceIds: ["current"] }, { id: "r2", kind: "support", summary: "SYN erreur 500", sourceIds: ["current"] }],
      identity: { kind: "unique", contactIds: ["101"], why: "SYN fiche" }, tickets: data.tickets.map((t: { ticketId: string }) => ({ ticketId: t.ticketId, relation: "same", why: "SYN même panne", sourceIds: ["current", `ticket-${t.ticketId}`, `history-${t.ticketId}`] })),
      missing: [], rationale: "SYN support" }, data.outputReferences));
    const quote = (sourceId: string) => data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === sourceId).id;
    if (data.tickets) return reply({ investigationComplete: true, tickets: data.tickets.map(({ ticket }: { ticket: { id: string } }) => ({ ticketId: ticket.id, relation: "same", requestIds: ["r1"],
      evidenceIds: ["current", `ticket-${ticket.id}`, `history-${ticket.id}`], rationale: "SYN même panne", grounding: ["current", `ticket-${ticket.id}`, `history-${ticket.id}`].map(src => ({ quoteId: quote(src) })) })) });
    return reply({ messageId: data.message.id, requests: [{ id: "r1", kind: "support", currentMessageId: data.message.id, quoteId: quote("current") }],
      ticketSummary: { title: "Échec de synchronisation de l'agenda", description: "Erreur 500.", requestIds: ["r1"] } });
  };
}
const resultRows = async () => (await ledger()).filter(x => x.technicalMetadata.event === "result");
/** A stored receipt is the canonical AES-GCM envelope of exactly its receipt, and none of the
 * receipt's readable content shows through. Only fragments holding a character outside the
 * envelope alphabet (space, accent, "@", ":") are searched: those cannot occur in it by chance,
 * whereas a short token such as "SYN" was observed inside random base64url ciphertext. */
const ENVELOPE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/;
function expectSealedReceipt(stored: unknown) {
  expect(typeof stored).toBe("string");
  const text = String(stored);
  expect(text).toMatch(ENVELOPE);
  const receipt = cryptoModule.decryptSavPayload<unknown>(text), json = JSON.stringify(receipt);
  expect(Buffer.from(text.split(".")[3], "base64url").length).toBe(Buffer.byteLength(json, "utf8"));
  const readable: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") { if (/[^A-Za-z0-9_.-]/.test(value)) readable.push(value); }
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(receipt);
  expect(readable.length).toBeGreaterThan(0);
  for (const fragment of [json, ...readable]) expect(text.includes(fragment)).toBe(false);
  return receipt;
}

describe("SAV-46 qualification receipts", () => {
  it("the receipt check refuses a plaintext receipt and accepts a real envelope, even when its random ciphertext contains \"SYN\"", () => {
    const receipt = { summary: "SYN agenda en panne", note: "SYN erreur 500 ".repeat(150) };
    expect(() => expectSealedReceipt(JSON.stringify(receipt))).toThrow();
    const [version, iv, tag] = encryptSavPayload(receipt).split(".");
    expect(() => expectSealedReceipt(`${version}.${iv}.${tag}.${Buffer.from(JSON.stringify(receipt)).toString("base64url")}`)).toThrow();
    let sealed = encryptSavPayload(receipt);
    for (let i = 0; i < 20_000 && !sealed.includes("SYN"); i++) sealed = encryptSavPayload(receipt);
    expect(sealed).toContain("SYN");
    expect(expectSealedReceipt(sealed)).toEqual(receipt);
  });
  it("stores one encrypted v1 receipt with the result; the list decrypts no receipt and the detail verifies it", async () => {
    const m = await stored(), e = env(mailboxId, [m.id]), p = provider(), { spy, reads } = ticketDossier();
    try {
      await runSavIntakeComparisonBatch({ env: () => e, network: ticketNetwork(p), limit: 1 });
      const [row] = await resultRows();
      const sealedReceipt = expectSealedReceipt(row.technicalMetadata.evidence);
      const decrypt = vi.spyOn(cryptoModule, "decryptSavPayload");
      const report = await readSavIntakeComparisonReport(() => e); if (!report.configured) throw Error("TEST_CONFIG");
      expect(decrypt.mock.calls.every(([payload]) => payload !== row.technicalMetadata.evidence)).toBe(true);
      expect(report.rows[0]).toMatchObject({ verdict: "identical", qualificationEvidence: "complete", attestation: null, detail: { evidence: { status: "complete", stored: true, parts: { common: "complete", simple: "complete" } } } });
      expect(report.qualificationEvidence).toMatchObject({ complete: 1, legacy: 0, attested: 0 });
      const detail = await readSavIntakeComparisonEvidence(m.id, () => e);
      expect(detail).toMatchObject({ qualificationEvidence: "complete", verification: { ok: true, reason: null } });
      expect(detail.receipt).toEqual(sealedReceipt);
      const receipt = detail.receipt as { sides: { simple: { plan: { noteText: string | null }; validated: { value: { requests: { summary: string }[] } }[]; mutationExpectations: { items: { mutation: string; ownerBaseline?: unknown }[] } } };
        common: { crm: { entries: { key: string }[] }; source: { engineInput: { message: { currentText: string } } } } };
      expect(receipt.sides.simple.validated[0].value.requests.map(r => r.summary)).toEqual(["SYN agenda en panne", "SYN erreur 500"]);
      expect(receipt.sides.simple.mutationExpectations.items.find(i => i.mutation === "set_ticket_new")?.ownerBaseline).toMatchObject({ status: "observed", ownerId: "777" });
      expect(receipt.common.source.engineInput.message.currentText).toContain("synchronisation de mon agenda");
      // One capture serves both readers: every live CRM read happened once, during the capture.
      expect(new Set(reads).size).toBe(reads.length);
      expect(receipt.common.crm.entries.map(x => x.key)).toEqual(expect.arrayContaining(["tickets:101", "history:201"]));
      expect(JSON.stringify(detail.receipt)).not.toMatch(/fake-model|fake-crm|Bearer|usageMetadata|thoughtsTokenCount/);
      expect(await f.db.select().from(savActions)).toEqual([]); expect(await f.db.select().from(savIntakeExecutions)).toEqual([]); expect(await f.db.select().from(savIntakeModelCalls)).toEqual([]);
    } finally { spy.mockRestore(); }
  }, 30_000);
  it("the ledger and the list never load a stored receipt, for later claims, reservations and settlements", async () => {
    const a = await stored(), b = await stored(), e = env(mailboxId, [a.id, b.id]), p = provider(), { spy } = ticketDossier();
    try {
      await runSavIntakeComparisonBatch({ env: () => e, network: ticketNetwork(p), limit: 1 });
      const sealed = String((await resultRows())[0].technicalMetadata.evidence), marker = sealed.slice(-64);
      const query = f.client.query.bind(f.client), loaded: string[] = [];
      const watch = vi.spyOn(f.client, "query").mockImplementation(async (...args: Parameters<typeof query>) => {
        const result = await query(...args); if (JSON.stringify(result.rows).includes(marker)) loaded.push(String(args[0]).slice(0, 80)); return result;
      });
      try {
        await runSavIntakeComparisonBatch({ env: () => e, network: ticketNetwork(p), limit: 1 });
        await readSavIntakeComparisonReport(() => e);
      } finally { watch.mockRestore(); }
      expect(loaded).toEqual([]);
      expect((await resultRows())).toHaveLength(2);
    } finally { spy.mockRestore(); }
  }, 30_000);
  it("spend, uncertain reservations and claims are computed exactly as before from the projected ledger", async () => {
    const a = await stored(), e = env(mailboxId, [a.id]), p = provider(); let sent = 0;
    const network: typeof fetch = async (url, init) => { if (String(url).startsWith("https://generativelanguage.googleapis.com/") && sent++ === 0) throw Error("SYNTHETIC_RESPONSE_LOST"); return p.network(url, init); };
    await runSavIntakeComparisonBatch({ env: () => e, network, limit: 1 });
    const all = (await ledger()).map(x => x.technicalMetadata as Record<string, string | number | boolean | null>);
    const report = await readSavIntakeComparisonReport(() => e); if (!report.configured) throw Error("TEST_CONFIG");
    expect(report.spend.nanoUsd).toBe(savIntakeComparisonSpend(all));
    expect(report.spend.nanoUsd).toBeGreaterThanOrEqual(817_152_000);
    expect(await claimSavIntakeComparison("sample-60", a.id)).toBeNull();
  });
  it("a tampered receipt fails closed in the detail; a legacy result stays readable but not qualifiable", async () => {
    const m = await stored(), e = env(mailboxId, [m.id]), p = provider(), { spy } = ticketDossier();
    try {
      await runSavIntakeComparisonBatch({ env: () => e, network: ticketNetwork(p), limit: 1 });
      const [row] = await resultRows(), receipt = (await readSavIntakeComparisonEvidence(m.id, () => e)).receipt as { sides: { simple: { plan: { noteText: string } } } };
      receipt.sides.simple.plan.noteText = "SYN note altérée";
      await f.db.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, evidence: encryptSavPayload(receipt) } }).where(eq(auditLogs.id, row.id));
      expect(await readSavIntakeComparisonEvidence(m.id, () => e)).toMatchObject({ qualificationEvidence: "invalid", receipt: null, verification: { ok: false } });
      await f.db.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, evidence: "v1.x.y.z" } }).where(eq(auditLogs.id, row.id));
      expect(await readSavIntakeComparisonEvidence(m.id, () => e)).toMatchObject({ qualificationEvidence: "invalid", verification: { ok: false } });
    } finally { spy.mockRestore(); }
    const legacy = await stored(), le = env(mailboxId, [legacy.id]), claimId = randomUUID();
    await f.db.insert(auditLogs).values([{ actorEmail: "system", action: "sav_intake_comparison", entityType: "sav_intake_comparison", entityId: claimId, technicalMetadata: { campaignId: "sample-60", messageId: legacy.id, claimId, event: "claimed" } },
      { actorEmail: "system", action: "sav_intake_comparison", entityType: "sav_intake_comparison", entityId: claimId, technicalMetadata: { campaignId: "sample-60", messageId: legacy.id, claimId, event: "result", verdict: "identical",
        payload: encryptSavPayload({ revision: "sav-intake-comparison-2026-10-28.v3", coverage: [], simple: { summary: { classification: "support" }, technical: null, uncertain: false } }) } }]);
    const report = await readSavIntakeComparisonReport(() => le); if (!report.configured) throw Error("TEST_CONFIG");
    expect(report.rows[0]).toMatchObject({ state: "done", verdict: "identical", qualificationEvidence: "legacy", detail: { coverage: [] } });
    expect(await readSavIntakeComparisonEvidence(legacy.id, () => le)).toMatchObject({ qualificationEvidence: "legacy", receipt: null });
  }, 30_000);
  it("an identifier outside the campaign list is refused before any lookup", async () => {
    const m = await stored(), e = env(mailboxId, [m.id]), query = vi.spyOn(f.client, "query");
    await expect(readSavIntakeComparisonEvidence(randomUUID(), () => e)).rejects.toThrow("SAV_INTAKE_COMPARISON_SCOPE_INVALID");
    expect(query).not.toHaveBeenCalled();
  });
  it("a failed persistence keeps the claim consumed: interrupted, never paid for a second time", async () => {
    const m = await stored(), e = env(mailboxId, [m.id]), p = provider();
    const query = f.client.query.bind(f.client);
    const fail = vi.spyOn(f.client, "query").mockImplementation(async (...args: Parameters<typeof query>) => {
      if (String(args[0]).startsWith('insert into "audit_logs"') && JSON.stringify(args[1]).includes('\\"event\\":\\"result\\"')) throw Error("SYNTHETIC_PERSIST_FAILURE private@example.test");
      return query(...args);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { await expect(runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 1 })).rejects.toThrow("SAV_INTAKE_COMPARISON_PERSIST_FAILED"); }
    finally { fail.mockRestore(); }
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private@example|SYN|Synchronisation/);
    const seen = p.seen.length;
    expect(await runSavIntakeComparisonBatch({ env: () => e, network: p.network, limit: 1 })).toMatchObject({ compared: [] });
    expect(p.seen).toHaveLength(seen);
    const report = await readSavIntakeComparisonReport(() => e);
    expect(report).toMatchObject({ denominators: { done: 0, interrupted: 1 } });
  });
  it("an oversize common capture makes zero model call and is recorded, never truncated", async () => {
    const m = await stored(), e = env(mailboxId, [m.id]), p = provider();
    const entries = Math.ceil(SAV_READER_EVIDENCE_LIMITS.commonBytes / 90_000) + 2;
    const { spy } = ticketDossier({ historyText: reviewText(7, 90_000), historyEntries: entries });
    try {
      expect(await runSavIntakeComparisonBatch({ env: () => e, network: ticketNetwork(p), limit: 1 })).toMatchObject({ compared: [{ verdict: "non_comparable", qualificationEvidence: "oversize" }] });
      expect(p.seen).toEqual([]);
      const [row] = await resultRows();
      expect(row.technicalMetadata.evidence).toBeUndefined();
      const report = await readSavIntakeComparisonReport(() => e); if (!report.configured) throw Error("TEST_CONFIG");
      expect(report.rows[0]).toMatchObject({ qualificationEvidence: "oversize", detail: { coverage: ["evidence_common_oversize"], evidence: { status: "oversize", parts: { common: "oversize" } } } });
      expect(report.spend.nanoUsd).toBe(0);
    } finally { spy.mockRestore(); }
  }, 30_000);
  it("each side has its own wall clock (simple never counts current) and no model call is added", async () => {
    const m = await stored(), e = env(mailboxId, [m.id]), p = provider(), { spy } = ticketDossier();
    let now = 0;
    try {
      await runSavIntakeComparisonBatch({ env: () => e, network: ticketNetwork(p, simple => { now += simple ? 300 : 1000; }), limit: 1, clock: () => now });
      const receipt = (await readSavIntakeComparisonEvidence(m.id, () => e)).receipt as { sides: Record<"current" | "simple", { timing: { wallMs: number; scope: string; requests: { productionAttemptMs: number }[] } }> };
      expect(p.seen).toEqual(["current", "current", "simple"]);
      expect(receipt.sides.current.timing.wallMs).toBe(2000);
      expect(receipt.sides.simple.timing.wallMs).toBe(300);
      expect(receipt.sides.simple.timing.scope).toBe("comparison_measurement_not_production_envelope");
      expect(receipt.sides.simple.timing.requests.every(r => [18_000, 37_000].includes(r.productionAttemptMs))).toBe(true);
    } finally { spy.mockRestore(); }
  }, 30_000);
});

describe("SAV-46 one immutable CRM capture", () => {
  it("a reader cannot alter what the other one sees; a record not captured is a miss, not a fresh read", async () => {
    const live = { calls: 0 };
    const complete = <T>(data: T) => ({ status: "complete" as const, data, observedAt: "2026-10-31T10:00:00.000Z" });
    const crm = frozenComparisonCrm({ findContactsByEmail: async () => { live.calls++; return complete([{ id: "101", emails: ["syn@example.test"] }]); },
      directAssociations: async () => complete([]), getContact: async () => complete({ id: "101", emails: ["syn@example.test"] }),
      ticketsForContact: async () => { live.calls++; return complete([{ id: "201", contactIds: ["101"], stage: "open" as const, ownerId: "777", subject: "SYN", content: "SYN" }]); },
      ticketHistory: async () => complete([]) });
    const signal = new AbortController().signal;
    await crm.capture.findContactsByEmail("syn@example.test", signal); await crm.capture.ticketsForContact("101", signal);
    const frozen = await crm.freeze();
    const first = await crm.frozen.ticketsForContact("101", signal); first.data[0].ownerId = "999";
    expect((await crm.frozen.ticketsForContact("101", signal)).data[0].ownerId).toBe("777");
    expect(crm.unchanged(frozen.hash)).toBe(true);
    expect(await crm.frozen.ticketHistory("201", signal)).toMatchObject({ status: "failed" });
    expect([...crm.misses]).toEqual(["history:201"]); expect(live.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// SAV-46 R2: the frozen capture covers every address the engine may look up as a declared account,
// before any paid call, for both readers. Synthetic CRM keyed by address; the sender is unknown.
describe("SAV-46 R2 declared account capture", () => {
  function declaredDossier(byEmail: Record<string, { id: string; emails: string[] }[]>, outcomes: Record<string, "failed" | "partial"> = {}) {
    const reads: string[] = [];
    const complete = <T>(data: T) => ({ status: "complete" as const, data, observedAt: new Date().toISOString() });
    const resolved = (email: string) => {
      const observedAt = new Date().toISOString();
      return outcomes[email] === "failed" ? { status: "failed" as const, data: [], observedAt }
        : outcomes[email] === "partial" ? { status: "partial" as const, data: byEmail[email] ?? [], observedAt, reconstructedAsOf: observedAt } : complete(byEmail[email] ?? []);
    };
    const contacts = Object.values(byEmail).flat();
    const spy = vi.spyOn(hubspotReaders, "createSavIntakeHubspotReaders").mockReturnValue({
      findContactsByEmail: async email => { reads.push(`contacts:${email}`); return resolved(email); },
      directAssociations: async id => { reads.push(`associations:${id}`); return complete([]); },
      getContact: async id => { reads.push(`contact:${id}`); return complete(contacts.find(c => c.id === id)!); },
      ticketsForContact: async id => { reads.push(`tickets:${id}`); return complete([]); },
      ticketHistory: async id => { reads.push(`history:${id}`); return complete([]); },
    });
    return { spy, reads };
  }
  /** Both readers return the same support request and the given declared address. */
  function declaredNetwork(base: ReturnType<typeof provider>, address: string, readsAtFirstModel: { value: number | null }, reads: string[]): typeof fetch {
    return async (url, init) => {
      if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return base.network(url, init);
      readsAtFirstModel.value ??= reads.length;
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text), simple = typeof data.current === "string";
      base.seen.push(simple ? "simple" : "current");
      const reply = (answer: unknown) => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, thoughtsTokenCount: 0, totalTokenCount: 360 } });
      if (simple) return reply(encodeSimpleWireFixture({ messageId: data.message.id, nature: "request", requests: [{ id: "r1", kind: "support", summary: "SYN connexion Outlook", sourceIds: ["current"] }],
        ticketTitle: "Connexion de la boîte Outlook", identity: { kind: data.contacts.length === 1 ? "unique" : "unknown", contactIds: data.contacts.length === 1 ? [data.contacts[0].contactId] : [], why: "SYN" },
        tickets: [], missing: [], rationale: "SYN support", registration: { address, quote: data.current } }, data.outputReferences));
      const quote = data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id;
      return reply({ messageId: data.message.id, requests: [{ id: "r1", kind: "support", currentMessageId: data.message.id, quoteId: quote }],
        ticketSummary: { title: "Connexion de la boîte Outlook", description: "SYN connexion.", requestIds: ["r1"] }, registration: { address, sourceMessageId: data.message.id, quoteId: quote } });
    };
  }
  /** The current message plus the same sender's earlier inbound messages in its thread. */
  async function storedWithHistory(prior: string[], text: string) {
    const m = await stored(text);
    for (const [i, earlier] of prior.entries()) await f.db.insert(savMessages).values({ mailboxId, threadId: m.threadId, direction: "inbound", fromEmail: "client@example.invalid",
      toEmails: ["support@example.invalid"], subject: "Synchronisation agenda", gmailMessageId: randomUUID(), bodyCiphertext: encryptSavPayload({ text: earlier, attachments: [], headers: {} }),
      receivedAt: new Date(Date.now() - 2 * 86_400_000 + i * 1000), createdAt: new Date(Date.now() - 2 * 86_400_000 + i * 1000), analysisStatus: "intake_observed" });
    return m;
  }
  async function campaign(text: string, address: string, byEmail: Record<string, { id: string; emails: string[] }[]>, prior: string[] = [], outcomes: Record<string, "failed" | "partial"> = {}) {
    const m = prior.length ? await storedWithHistory(prior, text) : await stored(text), e = env(mailboxId, [m.id]), p = provider(), { spy, reads } = declaredDossier(byEmail, outcomes), first = { value: null as number | null };
    try {
      await runSavIntakeComparisonBatch({ env: () => e, network: declaredNetwork(p, address, first, reads), limit: 1 });
      const report = await readSavIntakeComparisonReport(() => e); if (!report.configured) throw Error("TEST_CONFIG");
      return { m, e, p, reads, readsAtFirstModel: first.value, row: report.rows[0] as unknown as { verdict: string; detail: { coverage: string[]; current: { summary: { disposition: string; contactId: string | null; reasons: string[] } | null }; simple: { summary: { disposition: string; contactId: string | null; reasons: string[] } | null } } } };
    } finally { spy.mockRestore(); }
  }
  it("an explicit account different from the sender is captured before both readers: comparable, same plan, no live read after the freeze", async () => {
    const r = await campaign("Bonjour, mon compte Limova est account@customer.test. Comment connecter Outlook ?", "account@customer.test",
      { "account@customer.test": [{ id: "301", emails: ["account@customer.test"] }] });
    expect(r.row.detail.coverage).toEqual([]);
    expect(r.row.verdict).toBe("identical");
    expect(r.row.detail.current.summary).toMatchObject({ disposition: "ticket", contactId: "301" });
    expect(r.row.detail.simple.summary).toMatchObject({ disposition: "ticket", contactId: "301" });
    expect(r.reads).toContain("contacts:account@customer.test");
    expect(r.readsAtFirstModel).toBe(r.reads.length);
    expect(new Set(r.reads).size).toBe(r.reads.length);
    const detail = await readSavIntakeComparisonEvidence(r.m.id, () => r.e);
    expect(detail).toMatchObject({ qualificationEvidence: "complete", verification: { ok: true } });
    const receipt = detail.receipt as { common: { crm: { entries: { key: string }[] } }; crmUse: { misses: string[]; failedUsed: string[]; immutable: boolean } };
    expect(receipt.common.crm.entries.map(x => x.key)).toContain("contacts:account@customer.test");
  }, 30_000);
  it("a resource to connect is neither captured nor looked up: both sides take the unknown sender's identification path", async () => {
    const r = await campaign("Bonjour, comment connecter resource@connector.test à Outlook pour retrouver mes factures ?", "resource@connector.test",
      { "resource@connector.test": [{ id: "555", emails: ["resource@connector.test"] }] });
    expect(r.row.detail.coverage).toEqual([]);
    expect(r.row.verdict).toBe("identical");
    // This campaign policy has no approved identification text: the sender path stops visibly there.
    for (const side of [r.row.detail.current.summary, r.row.detail.simple.summary])
      expect(side).toMatchObject({ disposition: "collect_context", contactId: null, reasons: ["private_resource_unavailable"] });
    expect(r.reads.some(x => x.includes("resource@connector.test") || x.endsWith(":555"))).toBe(false);
  }, 30_000);
  it("more admissible declared addresses than the cap, across distinct messages, are refused before any CRM read or paid call", async () => {
    const r = await campaign("Mon compte Limova est a3@customer.test.", "a3@customer.test", {}, ["Mon compte Limova est a1@customer.test.", "Mon compte Limova est a2@customer.test."]);
    expect(r.row.verdict).toBe("non_comparable");
    expect(r.row.detail.coverage).toEqual(["declared_address_cap_exceeded"]);
    expect(r.p.seen).toEqual([]); expect(r.reads).toEqual([]);
    expect((await ledger()).filter(x => x.technicalMetadata.event === "reserved")).toEqual([]);
  }, 30_000);
  it.each(["failed", "partial"] as const)("R2: a declared-account capture already %s before dispatch is refused with its gap: no provider call, no reservation", async status => {
    const r = await campaign("Bonjour, mon compte Limova est account@customer.test. Comment connecter Outlook ?", "account@customer.test",
      { "account@customer.test": [{ id: "301", emails: ["account@customer.test"] }] }, [], { "account@customer.test": status });
    expect(r.reads).toContain("contacts:account@customer.test");
    expect(r.row.verdict).toBe("non_comparable");
    expect(r.row.detail.coverage).toEqual(expect.arrayContaining(["evidence_common_incomplete", `crm_${status}:contacts`]));
    expect(r.p.seen).toEqual([]); expect(r.readsAtFirstModel).toBeNull();
    expect((await ledger()).filter(x => x.technicalMetadata.event === "reserved")).toEqual([]);
  }, 30_000);
  it("R2 witness: a complete empty search for the declared account is no gap; both readers run", async () => {
    const r = await campaign("Bonjour, mon compte Limova est account@customer.test. Comment connecter Outlook ?", "account@customer.test", {});
    expect(r.row.detail.coverage).toEqual([]);
    expect(new Set(r.p.seen)).toEqual(new Set(["current", "simple"]));
  }, 30_000);
  it("R7: two accounts declared in the current message are refused as ambiguous before any CRM read or paid call", async () => {
    const r = await campaign("Mon compte Limova est a1@customer.test. Mon compte Limova est a2@customer.test.", "a1@customer.test", {});
    expect(r.row.verdict).toBe("non_comparable");
    expect(r.row.detail.coverage).toEqual(["declared_address_ambiguous"]);
    expect(r.p.seen).toEqual([]); expect(r.reads).toEqual([]);
    expect((await ledger()).filter(x => x.technicalMetadata.event === "reserved")).toEqual([]);
  }, 30_000);
});
