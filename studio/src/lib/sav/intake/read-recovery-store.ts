import "server-only";
import { and,eq,sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs,savIntakeRuns,savThreads,savIntakeModelCalls,savMessages } from "@/db/schema";
import { decryptSavPayload,encryptSavPayload } from "../crypto";
import type { IntakeRuntimeConfig,IntakeRuntimePayload } from "./runtime-contract";
import type { IntakeReadRecovery } from "./read-recovery";
type Tx=Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
export const readRecoveryMarker=(runId:string)=>and(eq(auditLogs.entityType,"sav_intake_read_recovery"),eq(auditLogs.entityId,runId),eq(auditLogs.action,"sav_intake_read_recovery"));
export async function writeReadRecoveryMarker(tx:Tx,runId:string,r:IntakeReadRecovery){
 const [prior]=await tx.select().from(auditLogs).where(readRecoveryMarker(runId)).for("update");
 const technicalMetadata={...prior?.technicalMetadata,state:r.state,retryAt:r.retryAt,expiresAt:r.expiresAt,technicalAttempts:r.attempts,configHash:r.configHash};
 if(prior)await tx.update(auditLogs).set({technicalMetadata}).where(eq(auditLogs.id,prior.id));
 else await tx.insert(auditLogs).values({actorEmail:"system",action:"sav_intake_read_recovery",entityType:"sav_intake_read_recovery",entityId:runId,technicalMetadata});
}
/** Queryable timestamps are hints only. The encrypted state and the ordinary
 * run/source/permission fences are rechecked at claim; this grants no authority. */
export function readRecoverySql(runId:ReturnType<typeof sql>,config:IntakeRuntimeConfig,now:Date){
 return sql`exists(select 1 from public.audit_logs r where r.entity_type='sav_intake_read_recovery' and r.action='sav_intake_read_recovery' and r.entity_id=${runId}::text
  and r.technical_metadata->>'state' in ('scheduled','claimed') and r.technical_metadata->>'configHash'=${config.configHash}
  and (case when jsonb_typeof(r.technical_metadata->'technicalAttempts')='number' then (r.technical_metadata->>'technicalAttempts')::numeric<${config.readRecovery?.maxAttempts??3} else false end)
  and r.technical_metadata->>'retryAt'<=${now.toISOString()} and r.technical_metadata->>'expiresAt'>${now.toISOString()})`;
}
export function noReadRecoverySql(runId:ReturnType<typeof sql>){return sql`not exists(select 1 from public.audit_logs r where r.entity_type='sav_intake_read_recovery' and r.action='sav_intake_read_recovery' and r.entity_id=${runId}::text)`;}
/** Expired markers are excluded BEFORE scheduler LIMIT even if this bounded
 * cleanup has more work left. Expiration never consumes a semantic attempt. */
export async function expireIntakeReadRecoveries(config:IntakeRuntimeConfig,now=new Date()){
 const rows=await requireDb().select({id:auditLogs.id,runId:auditLogs.entityId}).from(auditLogs).where(and(eq(auditLogs.entityType,"sav_intake_read_recovery"),eq(auditLogs.action,"sav_intake_read_recovery"),
  sql`${auditLogs.technicalMetadata}->>'state' in ('scheduled','claimed') and ${auditLogs.technicalMetadata}->>'configHash'=${config.configHash} and ${auditLogs.technicalMetadata}->>'expiresAt'<=${now.toISOString()}`)).limit(20);
 let expired=0;
 for(const marker of rows)await requireDb().transaction(async tx=>{
  if(!marker.runId)return;
  const [initial]=await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,marker.runId));if(!initial){
   const [m]=await tx.select().from(auditLogs).where(eq(auditLogs.id,marker.id)).for("update");if(m)await tx.update(auditLogs).set({technicalMetadata:{...m.technicalMetadata,state:"invalidated"}}).where(eq(auditLogs.id,m.id));return;
  }
  await tx.select().from(savThreads).where(eq(savThreads.id,initial.threadId)).for("update");
  const [run]=await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,initial.id)).for("update");
  if(run.leaseUntil&&run.leaseUntil>now)return;
  const payload=decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext),r=payload.readRecovery;
  if(!r){const [m]=await tx.select().from(auditLogs).where(eq(auditLogs.id,marker.id)).for("update");if(m)await tx.update(auditLogs).set({technicalMetadata:{...m.technicalMetadata,state:"complete"}}).where(eq(auditLogs.id,m.id));return;}
  if(Date.parse(r.expiresAt)>now.getTime())return;
  r.state="exhausted";
  if(run.isCurrent&&run.configHash===config.configHash&&["waiting","analysing"].includes(run.state)){
   const pending=await tx.select({id:savIntakeModelCalls.id}).from(savIntakeModelCalls).where(and(eq(savIntakeModelCalls.runId,run.id),sql`${savIntakeModelCalls.state} in ('dispatched','uncertain')`)).limit(1);
   payload.reason="SAV_INTAKE_READ_RECOVERY_EXPIRED";
   await tx.update(savIntakeRuns).set({payloadCiphertext:encryptSavPayload(payload),state:pending.length?"uncertain":"waiting",leaseToken:null,leaseUntil:null,freshUntil:null}).where(eq(savIntakeRuns.id,run.id));
   await tx.update(savMessages).set({analysisStatus:pending.length?"intake_uncertain":"intake_waiting"}).where(eq(savMessages.id,run.messageId));
  }
  await writeReadRecoveryMarker(tx,run.id,r);expired++;
 });
 return expired;
}
