/** Lot 4: the separate comparison campaign on a frozen list of stored dossiers, through the real
 * readers, engine, dispatcher and both ledgers. Never on the live path, no write, own budget. */
import { createHash, randomUUID } from "node:crypto";
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
function provider(options: { currentStatus?: number } = {}) {
  const seen: string[] = [], crm: { method: string; url: string }[] = [];
  const network = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) {
      const data = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text), simple = typeof data.current === "string", messageId = data.message?.id ?? data.message?.messageId;
      seen.push(simple ? "simple" : "current");
      if (!simple && options.currentStatus) return new Response("{}", { status: options.currentStatus });
      const id = simple ? data.message.id : data.message.id;
      const answer = simple
        ? { messageId: id, nature: "request", requests: [{ id: "r1", kind: "support", summary: "Synchronisation.", sourceIds: ["current"] }], ticketTitle: "Échec de synchronisation de l'agenda",
          ticketDescription: "Erreur 500.", identity: { kind: "unknown", contactIds: [], why: "Aucune fiche." }, tickets: [], missing: [], rationale: "Support." }
        : { messageId: id, requests: [{ id: "r1", kind: "support", currentMessageId: id, quoteId: data.citationCatalogue.find((x: { sourceId: string }) => x.sourceId === "current").id }],
          ticketSummary: { title: "Échec de synchronisation de l'agenda", description: "Erreur 500.", requestIds: ["r1"] } };
      void messageId;
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60, thoughtsTokenCount: 0, totalTokenCount: 360 } });
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
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1", KEY);
  await f.client.exec("TRUNCATE sav.intake_model_calls, sav.mailboxes CASCADE; TRUNCATE public.audit_logs");
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid" }).returning())[0].id;
});
afterEach(() => vi.unstubAllEnvs());

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

it.each([429, 503])("a received provider HTTP %s settles at zero without retrying or touching the operational ledger", async status => {
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
