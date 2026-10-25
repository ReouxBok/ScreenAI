import "server-only";
import { start } from "workflow/api";
import { and,eq,sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs,savIntakeRuns,savThreads,savMessages,savIntakeHumanEvents } from "@/db/schema";
import { decryptSavPayload,encryptSavPayload } from "../crypto";
import { savIntakeRuntimeConfig,type IntakeRuntimePayload } from "./runtime-contract";
import { readRecoveryDue } from "./read-recovery";
import { readRecoveryMarker,writeReadRecoveryMarker } from "./read-recovery-store";
import { processSavIntakeReadRecoveryWorkflow } from "@/workflows/sav-intake-read-recovery";
type Env=Record<string,string|undefined>;
type Options={env?:Env;start?:(runId:string)=>Promise<unknown>;now?:Date};
/** No source, model output or credential leaves the server-side step. */
export async function readReadRecoveryWake(runId:string,env:Env=process.env,now=new Date()){
 if(env.SAV_INTAKE_EVENT_DISPATCH!=="on")return {state:"off" as const};
 const config=savIntakeRuntimeConfig(env);if(!config)return {state:"off" as const};
 return requireDb().transaction(async tx=>{
  const [initial]=await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,runId));if(!initial)return {state:"stopped" as const};
  const [thread]=await tx.select().from(savThreads).where(eq(savThreads.id,initial.threadId)).for("update");
  const [run]=await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,runId)).for("update");
  if(!run.isCurrent||run.configHash!==config.configHash)return {state:"stopped" as const};
  if(run.state==="observed")return {state:"observed" as const};
  const payload=decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext),r=readRecoveryDue(payload.readRecovery,config,now,true);
  if(!r)return {state:"stopped" as const};
  const [human]=await tx.select({id:savIntakeHumanEvents.id}).from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.messageId,run.messageId)).limit(1);
  const [message]=await tx.select().from(savMessages).where(eq(savMessages.id,run.messageId));
  if(!message)return {state:"stopped" as const};
  const [newer]=await tx.select({id:savMessages.id}).from(savMessages).where(and(eq(savMessages.threadId,run.threadId),eq(savMessages.direction,"inbound"),
    sql`(${savMessages.receivedAt},${savMessages.createdAt},${savMessages.id})>(select original.received_at,original.created_at,original.id from sav.messages original where original.id=${run.messageId}::uuid)`)).limit(1);
  let compatible=Boolean(message&&message.mailboxId===config.mailboxId&&message.createdAt>new Date(config.createdAfter)&&message.receivedAt>new Date(config.receivedAfter)&&!newer);
  if(compatible&&message){const snapshot=await (await import("./runtime-store")).savIntakeSourceSnapshot(tx,message,now);compatible=snapshot.sourceHash===r.sourceHash;}
  if(!thread||thread.aiPaused||thread.humanRequestedAt||human||!compatible){
   if(!run.leaseUntil||run.leaseUntil<=now){r.state="invalidated";payload.readRecovery=r;await tx.update(savIntakeRuns).set({payloadCiphertext:encryptSavPayload(payload)}).where(eq(savIntakeRuns.id,runId));await writeReadRecoveryMarker(tx,runId,r);}
   return {state:"stopped" as const};
  }
  return {state:"scheduled" as const,retryAt:new Date(Math.max(Date.parse(r.retryAt),run.leaseUntil?.getTime()??0)).toISOString(),expiresAt:r.expiresAt,technicalAttempts:r.attempts};
 });
}
/** A start is a bounded hint, separate from the encrypted retry counter.
 * Duplicate workflows still contend on the ordinary thread/run claim fence. */
export async function requestReadRecoveryWake(runId:string,options:Options={}){
 const env=options.env??process.env,now=options.now??new Date();
 if(env.SAV_INTAKE_EVENT_DISPATCH!=="on")return {started:false,reason:"event_dispatch_off"};
 try{
  const state=await readReadRecoveryWake(runId,env,now);if(state.state!=="scheduled")return {started:false,reason:state.state};
  const permitted=await requireDb().transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`intake-read-wake:${runId}`}))`);
   const [marker]=await tx.select().from(auditLogs).where(readRecoveryMarker(runId)).for("update");if(!marker)return false;
   const m=marker.technicalMetadata,starts=Number(m.workflowStarts)||0;
   if(starts>=3||typeof m.wakeUntil==="string"&&Date.parse(m.wakeUntil)>now.getTime())return false;
   await tx.update(auditLogs).set({technicalMetadata:{...m,workflowStarts:starts+1,wakeUntil:new Date(Math.min(Date.parse(state.expiresAt),Math.max(Date.parse(state.retryAt),now.getTime())+90_000)).toISOString(),wakeState:"starting"}}).where(eq(auditLogs.id,marker.id));return true;
  });
  if(!permitted)return {started:false,reason:"already_started_or_bounded"};
  await (options.start??(id=>start(processSavIntakeReadRecoveryWorkflow,[id])))(runId);
  return {started:true,reason:"scheduled"};
 }catch{
  console.info("sav_intake_read_wake",{runId,reason:"start_deferred"});return {started:false,reason:"start_deferred"};
 }
}
export async function dispatchPendingReadRecoveryWakes(options:Options={}){
 const env=options.env??process.env,now=options.now??new Date();if(env.SAV_INTAKE_EVENT_DISPATCH!=="on")return {started:0};
 const config=savIntakeRuntimeConfig(env);if(!config)return {started:0};
 const rows=await requireDb().select({runId:auditLogs.entityId}).from(auditLogs).where(and(eq(auditLogs.entityType,"sav_intake_read_recovery"),eq(auditLogs.action,"sav_intake_read_recovery"),
  sql`${auditLogs.technicalMetadata}->>'state' in ('scheduled','claimed') and ${auditLogs.technicalMetadata}->>'configHash'=${config.configHash} and ${auditLogs.technicalMetadata}->>'expiresAt'>${now.toISOString()}
    and (case when jsonb_typeof(${auditLogs.technicalMetadata}->'workflowStarts')='number' then (${auditLogs.technicalMetadata}->>'workflowStarts')::numeric<3 else true end)
    and (${auditLogs.technicalMetadata}->>'wakeUntil' is null or ${auditLogs.technicalMetadata}->>'wakeUntil'<=${now.toISOString()})`)).limit(4);
 let started=0;for(const row of rows)if(row.runId&&(await requestReadRecoveryWake(row.runId,options)).started)started++;return {started};
}
