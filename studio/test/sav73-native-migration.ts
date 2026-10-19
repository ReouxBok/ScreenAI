/** Populated 0035 -> 0036 recipe; refuses any nonempty/nonlocal target. */
import { readFile, mkdir, mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { validateSavNativeTestTarget } from "./sav-native-db";
import { encryptSavPayload } from "../src/lib/sav/crypto";
const url=process.env.SAV_TEST_POSTGRES_URL ?? "";
validateSavNativeTestTarget(url,process.env.SAV_TEST_POSTGRES_TOKEN);
const client=postgres(url,{max:1,prepare:false,onnotice:()=>{}}),db=drizzle(client);
const folder=await mkdtemp(path.join(tmpdir(),"sav73-native-migration-"));
try {
  const [identity]=await client`select current_setting('codex.test_token', true) as token`;
  assert.equal(identity.token,process.env.SAV_TEST_POSTGRES_TOKEN,"Dedicated test instance required");
  const [empty]=await client`select to_regclass('sav.threads') is null as empty`;
  assert.equal(empty.empty,true,"Dedicated empty target required");
  const directory=new URL("../drizzle/",import.meta.url);
  const journal=JSON.parse(await readFile(new URL("meta/_journal.json",directory),"utf8"));
  const entries=journal.entries.filter((entry:{tag:string})=>entry.tag<"0036_sav_dashboard_projection");
  await mkdir(path.join(folder,"meta"));
  for(const entry of entries)await copyFile(new URL(`${entry.tag}.sql`,directory),path.join(folder,`${entry.tag}.sql`));
  await writeJournal();
  async function writeJournal(){const {writeFile}=await import("node:fs/promises");await writeFile(path.join(folder,"meta/_journal.json"),JSON.stringify({...journal,entries}));}
  await migrate(db,{migrationsFolder:folder});
  const ciphertext=encryptSavPayload({text:"Native synthetic migration fixture; preserve human versions byte for byte."});
  const [mailbox]=await client`insert into sav.mailboxes(email) values ('fixture@example.invalid') returning id`;
  const [thread]=await client`insert into sav.threads(mailbox_id,gmail_thread_id,customer_email,ai_paused) values (${mailbox.id},'native-migration73','fixture@example.invalid',true) returning id`;
  const [message]=await client`insert into sav.messages(thread_id,mailbox_id,direction,from_email,body_ciphertext,received_at) values (${thread.id},${mailbox.id},'inbound','fixture@example.invalid',${ciphertext},now()) returning id`;
  const [run]=await client`insert into sav.agent_runs(message_id,runtime,mode,status,model,prompt_revision,input_hash,proposal_ciphertext) values (${message.id},'fixture','off','succeeded','fixture','fixture','fixture',${ciphertext}) returning id`;
  const [decision]=await client`insert into sav.decisions(message_id,agent_run_id,kind,reason_code,explanation,confidence) values (${message.id},${run.id},'ticket_pending','fixture','Synthetic',800) returning id`;
  const [review]=await client`insert into sav.proposal_reviews(message_id,decision_id,agent_run_id,revision,status,verdict,dimensions,before_ciphertext,after_ciphertext,comment_ciphertext,reviewed_by,review_scope) values (${message.id},${decision.id},${run.id},1,'approved','correct','{}',${ciphertext},${ciphertext},${ciphertext},'ugo@limova.ai','dossier') returning id`;
  await client`insert into sav.reply_drafts(thread_id,message_id,decision_id,agent_run_id,review_id,revision,status,body_ciphertext,created_by) values (${thread.id},${message.id},${decision.id},${run.id},${review.id},1,'validated',${ciphertext},'ugo@limova.ai')`;
  const snapshot=async()=>JSON.stringify(await client`select t.ai_paused,m.body_ciphertext,r.after_ciphertext,d.body_ciphertext as draft from sav.threads t join sav.messages m on m.thread_id=t.id join sav.proposal_reviews r on r.message_id=m.id join sav.reply_drafts d on d.message_id=m.id`);
  const before=await snapshot();
  await migrate(db,{migrationsFolder:path.resolve("drizzle")});await migrate(db,{migrationsFolder:path.resolve("drizzle")});
  assert.equal(await snapshot(),before);
  const [projection]=await client`select count(*)::int as rows,count(*) filter(where indexed_version<>version)::int as dirty from sav.dashboard_projection`;
  assert.deepEqual({...projection},{rows:1,dirty:1});
  const [journalCount]=await client`select count(*)::int as migrations from drizzle.__drizzle_migrations`;
  const [triggers]=await client`select count(*)::int as triggers from pg_trigger where not tgisinternal and tgname like 'sav_dashboard_%'`;
  console.log(JSON.stringify({status:"pass",upgrade:"populated0035-to0036",migratorRunTwice:true,sourceSnapshotSha256:createHash("sha256").update(before).digest("hex"),humanCiphertextUnchanged:true,pauseUnchanged:true,projection,journalCount,triggers}));
} finally {await client.end();await rm(folder,{recursive:true,force:true});}
