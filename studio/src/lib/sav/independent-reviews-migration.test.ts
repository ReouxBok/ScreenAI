import {it,expect,vi} from "vitest";
import {readFile,writeFile,mkdtemp,copyFile,rm} from "node:fs/promises";
import path from "node:path";import {tmpdir} from "node:os";
import {PGlite} from "@electric-sql/pglite";import {vector} from "@electric-sql/pglite-pgvector";
import {drizzle} from "drizzle-orm/pglite";import {migrate} from "drizzle-orm/pglite/migrator";
import {encryptSavPayload} from "./crypto";
it("migrates the real populated V0 journal without interpreting or altering legacy reviews",async()=>{
 vi.stubEnv("SAV_ENCRYPTION_KEY_V1","migration-fixture-key-only-32-characters");
 const client=new PGlite({extensions:{vector}});const folder=await mkdtemp(path.join(tmpdir(),"sav-v0-38-39-migration-"));
 try {
  const migrations=new URL("../../../drizzle/",import.meta.url);const journal=JSON.parse(await readFile(new URL("meta/_journal.json",migrations),"utf8"));
  const oldEntries=journal.entries.filter((e:{tag:string})=>e.tag!=="0033_sav_v0_independent_reviews");
  const {mkdir}=await import("node:fs/promises");await mkdir(path.join(folder,"meta"));
  for(const e of oldEntries)await copyFile(new URL(`${e.tag}.sql`,migrations),path.join(folder,`${e.tag}.sql`));
  await writeFile(path.join(folder,"meta/_journal.json"),JSON.stringify({...journal,entries:oldEntries}));
  const db=drizzle(client);await migrate(db,{migrationsFolder:folder});
  const cipher=encryptSavPayload({fixture:"legacy encrypted review and editable draft"});
  await client.query("INSERT INTO sav.mailboxes(id,email) VALUES ('10000000-0000-4000-8000-000000000001','fixture@example.invalid')");
  await client.query("INSERT INTO sav.threads(id,mailbox_id,gmail_thread_id,subject,customer_email) VALUES ('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','fixture','Fictif','fixture@example.invalid')");
  await client.query("INSERT INTO sav.messages(id,thread_id,mailbox_id,direction,from_email,subject,body_ciphertext,received_at) VALUES ('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','inbound','fixture@example.invalid','Fictif',$1,now())",[cipher]);
  await client.query("INSERT INTO sav.agent_runs(id,message_id,runtime,mode,status,model,prompt_revision,input_hash,proposal_ciphertext) VALUES ('10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000003','fixture','off','succeeded','fixture','fixture','fixture',$1)",[cipher]);
  await client.query("INSERT INTO sav.decisions(id,message_id,agent_run_id,kind,reason_code,explanation,confidence) VALUES ('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004','ticket_pending','fixture','Fictif',800)");
  await client.query("INSERT INTO sav.proposal_reviews(id,message_id,decision_id,agent_run_id,revision,status,verdict,dimensions,before_ciphertext,after_ciphertext,comment_ciphertext,reusability,reviewed_by) VALUES ('10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000004',1,'approved','correct','{}',$1,$1,$1,'none','ugo@limova.ai')",[cipher]);
  await client.query("INSERT INTO sav.reply_drafts(thread_id,message_id,decision_id,agent_run_id,review_id,revision,status,body_ciphertext,created_by) VALUES ('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000006',1,'validated',$1,'ugo@limova.ai')",[cipher]);
  await copyFile(new URL("0033_sav_v0_independent_reviews.sql",migrations),path.join(folder,"0033_sav_v0_independent_reviews.sql"));await writeFile(path.join(folder,"meta/_journal.json"),JSON.stringify(journal));await migrate(db,{migrationsFolder:folder});await migrate(db,{migrationsFolder:folder});
  const reviews=await client.query<{review_scope:string;dossier_source_hash:null;after_ciphertext:string}>("SELECT review_scope,dossier_source_hash,after_ciphertext FROM sav.proposal_reviews");expect(reviews.rows).toEqual([{review_scope:"legacy_global",dossier_source_hash:null,after_ciphertext:cipher}]);
  expect((await client.query("SELECT source_hash,body_ciphertext FROM sav.reply_drafts")).rows).toEqual([{source_hash:null,body_ciphertext:cipher}]);expect((await client.query("SELECT count(*)::int AS count FROM sav.draft_verdicts")).rows).toEqual([{count:0}]);
  await client.query("DELETE FROM sav.threads WHERE id='10000000-0000-4000-8000-000000000002'");expect((await client.query("SELECT count(*)::int AS count FROM sav.reply_drafts")).rows).toEqual([{count:0}]);
 } finally {await client.close();await rm(folder,{recursive:true,force:true});vi.unstubAllEnvs();}
},30000);
