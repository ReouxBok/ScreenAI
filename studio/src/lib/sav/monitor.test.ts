import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createSavTestDb } from "../../../test/sav-db";
import { savMailboxes, savMessages, savThreads, savSyncState, auditLogs, savIntakeRuns, savGmailQuarantine, savIntakeConsole } from "@/db/schema";
import { encryptSavPayload } from "./crypto";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
import { collectSavMonitorSnapshot, recordSavWorkerPulse, runSavServerMonitor } from "./monitor";
let f: Awaited<ReturnType<typeof createSavTestDb>>, mailboxId: string;
beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 30000);
afterAll(async () => { await f?.client.close(); });
beforeEach(async () => {
  await f.client.exec("TRUNCATE sav.mailboxes, sav.sync_state, audit_logs CASCADE");
  const markerValues = ["sav-intake-console-schema-v1", "sav-intake-execution-schema-v1"].map(key => ({ key, status: "installed" }));
  await f.db.insert(savSyncState).values(markerValues);
  mailboxId = (await f.db.insert(savMailboxes).values({ email: "support@example.invalid", watchStatus: "active", watchExpiration: new Date(Date.now()+86400000) }).returning())[0].id;
  for (const [key, value] of Object.entries({ SAV_INTAKE_RUNTIME_MODE: "off", SAV_INTAKE_EXECUTION_MODE: "off", SAV_MONITOR_SLACK_WEBHOOK_URL: "", SAV_INTAKE_OTHER_RULES_JSON: "" })) vi.stubEnv(key, value);
  vi.stubEnv("SAV_ENCRYPTION_KEY_V1","synthetic-monitor-encryption-key-123456789");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("NO_REAL_NETWORK"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function launch() {
  const at = new Date(Date.now()-3600000).toISOString();
  await f.db.insert(savSyncState).values({ key: `sav-intake-launch:${mailboxId}`, status: "intake_launch_v1", cursor: JSON.stringify({ receivedAfter: at, createdAfter: at }) });
}
async function workerFailed() {
  const id = randomUUID(), started = new Date().toISOString();
  await recordSavWorkerPulse(id, started); await recordSavWorkerPulse(id, started, true);
}
it("records monotone worker start/finish and refuses an older finisher", async () => {
  const old = randomUUID(), recent = randomUUID(), now = Date.now();
  await recordSavWorkerPulse(old, new Date(now-10000).toISOString());
  await recordSavWorkerPulse(recent, new Date(now).toISOString());
  await recordSavWorkerPulse(old, new Date(now-10000).toISOString(), true);
  const [row] = await f.db.select().from(savSyncState).where(eq(savSyncState.key, "sav-monitor:v1:worker"));
  expect(JSON.parse(row.cursor!).id).toBe(recent); expect(row.status).toBe("running");
  await recordSavWorkerPulse(recent, new Date(now).toISOString(), false);
  expect((await collectSavMonitorSnapshot()).issues).toEqual([]);
});
it("collects watch/worker problems without reading absent intake state before launch", async () => {
  await f.db.update(savMailboxes).set({ watchExpiration: new Date(0) });
  const snapshot = await collectSavMonitorSnapshot();
  expect(snapshot.complete).toBe(true); expect(snapshot.metrics.launchedMailboxes).toBe(0);
  expect(snapshot.issues.map(i => i.code)).toEqual(["worker_missing", "watch_unavailable"]);
});
it("serializes all raw SQL timestamps as strings for the native PostgreSQL adapter",async()=>{
  await launch();
  const actual=state.db;
  state.db={transaction:(work:(tx:unknown)=>Promise<unknown>)=>f.db.transaction(tx=>work(new Proxy(tx,{
    get(target,key){
      if(key==='execute')return(statement:Parameters<typeof tx.execute>[0])=>{
        const compiled=new PgDialect().sqlToQuery(typeof statement==='string'?sql.raw(statement):statement.getSQL());
        expect(compiled.params.some(p=>p instanceof Date)).toBe(false);
        return target.execute(statement);
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }
  })))};
  try {expect((await collectSavMonitorSnapshot()).complete).toBe(true);}
  finally{state.db=actual;}
});
it("counts only new latest unpaused pending messages and excludes historical mail", async () => {
  await launch();
  for (const [age, paused] of [[1200,false],[7200,false],[1500,true]] as const) {
    const at = new Date(Date.now()-age*1000);
    const thread = (await f.db.insert(savThreads).values({ mailboxId, gmailThreadId: randomUUID(), customerEmail: "client@example.invalid", aiPaused: paused }).returning())[0];
    await f.db.insert(savMessages).values({ mailboxId, threadId: thread.id, direction: "inbound", fromEmail: "client@example.invalid", receivedAt: at, createdAt: at, bodyCiphertext: "not-read", analysisStatus: "intake_pending" });
  }
  const s = await collectSavMonitorSnapshot();
  expect(s.complete).toBe(true); expect(s.metrics.pending).toBe(1);
  expect(s.issues).toEqual(expect.arrayContaining([{ code: "analysis_delayed", count: 1, severity: "warning" }]));
  expect(s.issues.some(i => i.code === "collection_failed")).toBe(false);
});
it("captures durable incidents without a configured transport or operational writes", async () => {
  const before = (await f.db.select().from(savMessages)).length;
  const result = await runSavServerMonitor(); expect(result).toMatchObject({ complete: true, delivery: "unconfigured" });
  expect(fetch).not.toHaveBeenCalled(); expect((await f.db.select().from(savMessages)).length).toBe(before);
  expect((await f.db.select().from(auditLogs))[0].action).toBe("sav_monitor_observed");
  expect((await f.db.select().from(savSyncState)).filter(r => r.key.startsWith("sav-monitor:v1:"))).toHaveLength(2);
});
it("delivers a confirmed Slack alert once and preserves uncertain transport without retry", async () => {
  vi.stubEnv("SAV_MONITOR_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T123/B456/synthetic");
  vi.mocked(fetch).mockResolvedValue(new Response("ok", { status: 200 }));
  expect(await runSavServerMonitor()).toMatchObject({ delivery: "sent" }); expect(fetch).toHaveBeenCalledTimes(1);
  await runSavServerMonitor(); expect(fetch).toHaveBeenCalledTimes(1);
  await workerFailed(); vi.mocked(fetch).mockRejectedValue(new Error("timeout"));
  expect(await runSavServerMonitor()).toMatchObject({ delivery: "uncertain" }); expect(fetch).toHaveBeenCalledTimes(2);
  vi.stubEnv("SAV_MONITOR_SLACK_WEBHOOK_URL", ""); await runSavServerMonitor();
  vi.stubEnv("SAV_MONITOR_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T123/B456/synthetic"); await runSavServerMonitor();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("allows one monitor lease, and an expired dispatched attempt becomes uncertain", async () => {
  await runSavServerMonitor();
  const [row] = await f.db.select().from(savSyncState).where(eq(savSyncState.key, "sav-monitor:v1:state"));
  const stored = JSON.parse(row.cursor!); stored.leaseUntil = new Date(Date.now()+60000).toISOString();
  await f.db.update(savSyncState).set({ cursor: JSON.stringify(stored) }).where(eq(savSyncState.key, row.key));
  expect(await runSavServerMonitor()).toEqual({ skipped: "already_running" });
  stored.leaseUntil = new Date(0).toISOString(); stored.delivery.state = "dispatched";
  await f.db.update(savSyncState).set({ cursor: JSON.stringify(stored) }).where(eq(savSyncState.key, row.key));
  expect(await runSavServerMonitor()).toMatchObject({ delivery: "uncertain" }); expect(fetch).not.toHaveBeenCalled();
});
it("treats schema/configuration failures as partial without falsely closing incidents", async () => {
  await runSavServerMonitor(); await launch();
  await f.db.delete(savSyncState).where(eq(savSyncState.key, "sav-intake-console-schema-v1"));
  const snapshot = await collectSavMonitorSnapshot(); expect(snapshot.complete).toBe(false);
  expect(snapshot.issues.map(i => i.code)).toContain("schema_missing");
  vi.stubEnv("SAV_INTAKE_EXECUTION_MODE", "execute");
  expect((await collectSavMonitorSnapshot()).issues.map(i => i.code)).toContain("configuration_invalid");
});
it("converts SQL exceptions into an explicit partial collection", async () => {
  const actual = state.db; state.db = { transaction: async () => { throw Error("SYNTHETIC_SQL_FAILED"); } };
  try { expect(await collectSavMonitorSnapshot()).toMatchObject({ complete: false, issues: [{ code: "collection_failed", count: 1, severity: "critical" }] }); }
  finally { state.db = actual; }
});
it("detects repeated worker starts without completion instead of hiding killed workers", async () => {
  const now=Date.now();
  for(const age of [1200,900,600,300,0])await recordSavWorkerPulse(randomUUID(),new Date(now-age*1000).toISOString());
  const snapshot=await collectSavMonitorSnapshot();
  expect(snapshot.metrics.workerAgeSeconds).toBeLessThan(5);
  expect(snapshot.issues).toContainEqual({code:"worker_stalled",count:1,severity:"critical"});
});
it("keeps an unresolved old quarantine visible after its timestamps age",async()=>{
  await f.db.insert(savGmailQuarantine).values({mailboxId,gmailMessageId:randomUUID(),cause:"synthetic",lastFailedAt:new Date(Date.now()-2*86400000)});
  expect((await collectSavMonitorSnapshot()).issues).toContainEqual({code:"quarantine",count:1,severity:"warning"});
});
it("preserves the last worker failure across later starts until a successful finish",async()=>{
  await workerFailed();
  const id=randomUUID(), startedAt=new Date().toISOString();await recordSavWorkerPulse(id,startedAt);
  expect((await collectSavMonitorSnapshot()).issues).toContainEqual({code:"worker_failed",count:1,severity:"critical"});
  await recordSavWorkerPulse(id,startedAt,false);
  expect((await collectSavMonitorSnapshot()).issues.some(i=>i.code==='worker_failed')).toBe(false);
});
it("distinguishes exhausted technical analysis from a normal human context question",async()=>{
  await launch();
  const old=new Date(Date.now()-1200000);
  for(const payload of [{reason:"SAV_INTAKE_RUNTIME_SOURCES_STALE"},{plan:{decision:{disposition:{kind:"collect_context"}}}}]) {
    const thread=(await f.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"client@example.invalid"}).returning())[0];
    const message=(await f.db.insert(savMessages).values({mailboxId,threadId:thread.id,direction:"inbound",fromEmail:"client@example.invalid",receivedAt:old,createdAt:old,bodyCiphertext:"not-read",analysisStatus:"intake_waiting"}).returning())[0];
    await f.db.insert(savIntakeRuns).values({threadId:thread.id,messageId:message.id,version:1,state:"waiting",attempts:2,configHash:"a".repeat(64),policyHash:"b".repeat(64),payloadCiphertext:encryptSavPayload(payload),createdAt:old,updatedAt:old});
  }
  const snapshot=await collectSavMonitorSnapshot();expect(snapshot.complete).toBe(true);
  expect(snapshot.issues).toContainEqual({code:"analysis_waiting",count:1,severity:"critical"});
});
it("isolates an uncertain delivery but still sends a new distinct incident",async()=>{
  vi.stubEnv("SAV_MONITOR_SLACK_WEBHOOK_URL","https://hooks.slack.com/services/T123/B456/synthetic");
  vi.mocked(fetch).mockRejectedValue(new Error("timeout"));
  expect(await runSavServerMonitor()).toMatchObject({delivery:"uncertain"});
  await f.db.update(savMailboxes).set({watchExpiration:new Date(0)});
  vi.mocked(fetch).mockResolvedValue(new Response("ok"));
  expect(await runSavServerMonitor()).toMatchObject({delivery:"sent"});
  expect(fetch).toHaveBeenCalledTimes(2);
  await runSavServerMonitor();expect(fetch).toHaveBeenCalledTimes(2);
  expect((await f.db.select().from(savSyncState)).filter(r=>r.status==='delivery_uncertain')).toHaveLength(1);
});
it("bounds retries to a failed batch while allowing a later incident its own attempts",async()=>{
  vi.stubEnv("SAV_MONITOR_SLACK_WEBHOOK_URL","https://hooks.slack.com/services/T123/B456/synthetic");
  vi.mocked(fetch).mockImplementation(async()=>new Response("rejected",{status:400}));
  for(let i=0;i<4;i++)await runSavServerMonitor();
  expect(fetch).toHaveBeenCalledTimes(3);
  await f.db.update(savMailboxes).set({watchExpiration:new Date(0)});
  vi.mocked(fetch).mockResolvedValue(new Response("ok"));
  expect(await runSavServerMonitor()).toMatchObject({delivery:"sent"});expect(fetch).toHaveBeenCalledTimes(4);
});
it("surfaces launched mail that cannot move without a person: held thread, sources to re-investigate, waiting dossier",async()=>{
  await launch();
  const old=new Date(Date.now()-2400000), recent=new Date(Date.now()-300000);
  const thread=async(paused=false)=>(await f.db.insert(savThreads).values({mailboxId,gmailThreadId:randomUUID(),customerEmail:"client@example.invalid",aiPaused:paused}).returning())[0];
  const inbound=async(threadId:string,at:Date)=>f.db.insert(savMessages).values({mailboxId,threadId,direction:"inbound",fromEmail:"client@example.invalid",receivedAt:at,createdAt:at,bodyCiphertext:"not-read",analysisStatus:"intake_waiting"});
  const held=await thread(true); await inbound(held.id,old);
  const fresh=await thread(true); await inbound(fresh.id,recent);
  const statuses=[["context_changed",old],["waiting",old],["waiting",recent],["followup_started",old]] as const;
  for(const [status,at] of statuses){const t=await thread();await inbound(t.id,at);
    await f.db.insert(savIntakeConsole).values({threadId:t.id,mailboxId,status}).onConflictDoUpdate({target:savIntakeConsole.threadId,set:{status}});
    await f.db.update(savIntakeConsole).set({updatedAt:at}).where(eq(savIntakeConsole.threadId,t.id));}
  const snapshot=await collectSavMonitorSnapshot();expect(snapshot.complete).toBe(true);
  expect(snapshot.issues).toEqual(expect.arrayContaining([{code:"intake_held",count:1,severity:"warning"},
    {code:"sources_changed_waiting",count:1,severity:"warning"},{code:"dossier_waiting",count:1,severity:"warning"}]));
});
