import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createSavTestDb } from "../../../test/sav-db";
import { savMailboxes, savMessages, savThreads } from "@/db/schema";
import { activateSavV0Cutover } from "./cutover";
import { encryptSavPayload } from "./crypto";
const state = vi.hoisted(() => ({ db:null as unknown, classified:null as (()=>Promise<void>)|null }));
vi.mock("@/db", () => ({ requireDb:()=>state.db }));
vi.mock("./dashboard-source", async importOriginal => {
  const source=await importOriginal<typeof import("./dashboard-source")>();
  return { ...source, listSavDossierDashboardReference:async (...args:Parameters<typeof source.listSavDossierDashboardReference>)=>{
    const result=await source.listSavDossierDashboardReference(...args);
    if(state.classified) await state.classified();
    return result;
  } };
});
import { listSavDossierDashboardSql, refreshSavDashboardProjection } from "./dashboard-projection";
let fixture:Awaited<ReturnType<typeof createSavTestDb>>|undefined;
beforeAll(async()=>{if(process.env.SAV_TEST_POSTGRES_URL){fixture=await createSavTestDb();state.db=fixture.db;}},30_000);
afterAll(async()=>fixture?.client.close());
afterEach(()=>{state.classified=null;vi.unstubAllEnvs();});
it.skipIf(!process.env.SAV_TEST_POSTGRES_URL)("cannot acknowledge a concurrent source version with an old snapshot",async()=>{
  const f=fixture!;
  vi.stubEnv("SAV_RELEASE_STAGE","v0");vi.stubEnv("SAV_PILOT_MODE","false");vi.stubEnv("SAV_OTHER_OBSERVATION_RULES_JSON","");vi.stubEnv("SAV_ENCRYPTION_KEY_V1","test-only-sav-encryption-key-32-characters");
  await f.client.exec("TRUNCATE sav.mailboxes CASCADE; TRUNCATE sav.sync_state; TRUNCATE audit_logs");
  const [mailbox]=await f.db.insert(savMailboxes).values({email:"contact@limova.ai"}).returning();
  await activateSavV0Cutover({receivedAfter:"2026-10-01T00:00:00Z",mailboxEmail:mailbox.email,intakeRecipient:"contact@limova.ai",deploymentSha:"a".repeat(40),activatedBy:"ugo@limova.ai"});
  const [thread]=await f.db.insert(savThreads).values({mailboxId:mailbox.id,gmailThreadId:"fixture-concurrent",customerEmail:"fixture@example.invalid"}).returning();
  const [message]=await f.db.insert(savMessages).values({mailboxId:mailbox.id,threadId:thread.id,gmailMessageId:"fixture-concurrent-message",direction:"inbound",fromEmail:thread.customerEmail,subject:"Before",bodyCiphertext:encryptSavPayload({text:"Synthetic"}),receivedAt:new Date("2026-10-03")}).returning();
  await refreshSavDashboardProjection();
  await f.db.update(savMessages).set({subject:"Intermediate"}).where(eq(savMessages.id,message.id));
  let captured!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{captured=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  state.classified=async()=>{captured();await gate;};
  const builder=refreshSavDashboardProjection();await ready;
  const writer=f.db.update(savMessages).set({subject:"Changed"}).where(eq(savMessages.id,message.id)).execute();
  try {
    let blocked=false;
    for(let i=0;i<100;i++){
      const result=await f.client.query<{count:number}>("select count(*)::int as count from pg_stat_activity where application_name='codex_sav_validation' and wait_event_type='Lock'");
      if(result.rows[0].count){blocked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(blocked).toBe(true);
  } finally {release();state.classified=null;}
  await builder;await writer;
  const version=await f.client.query<{dirty:boolean}>("select version <> indexed_version as dirty from sav.dashboard_projection where thread_id=$1",[thread.id]);
  expect(version.rows[0].dirty).toBe(true);
  expect((await listSavDossierDashboardSql({query:"Changed"})).rows[0]?.messageId).toBe(message.id);
  expect((await listSavDossierDashboardSql({query:"Intermediate"})).total).toBe(0);
},20_000);
