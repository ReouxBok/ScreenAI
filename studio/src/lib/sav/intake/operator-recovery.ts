import "server-only";
import {randomUUID} from "node:crypto";
import {and,desc,eq,inArray} from "drizzle-orm";
import {z} from "zod";
import {requireDb} from "@/db";
import {staffUsers,savThreads,savMessages,savIntakeRuns,savIntakeJournal,savIntakeHumanEvents,savIntakeExecutions,savIntakeEffects,auditLogs} from "@/db/schema";
import {canAccessSav} from "../access";
import {decryptSavPayload,encryptSavPayload} from "../crypto";
import {executionAdministrator} from "./execution-policy";
import {admissionLock,finishVerifiedIdentityRecovery} from "./execution-store";
import {intakeHumanRefused,intakeRunReanalysisConfiguration,intakeRunCandidateContactIds,operatorRecoveryConfigHash,type HumanEventPayload} from "./human-binding";
import {intakeLaunchMatches} from "./launch-boundary";
import {savIntakeSourceSnapshot,intakeSourceMatches} from "./runtime-store";
import {savIntakeRuntimeConfig,intakeRuntimeHash,SAV_INTAKE_RUNTIME_REVISION,type IntakeRuntimePayload} from "./runtime-contract";
import {planSavIntake} from "./engine";
import type {IntakeAdapters} from "./engine-types";
import {reconcileIntakeEffectCandidate} from "./executor";
import {createIntakeExecutorAdapters} from "./execution-adapters";
const request=z.object({threadId:z.uuid(),messageId:z.uuid(),reason:z.string().trim().min(10).max(2000),commandKey:z.uuid().optional()}).strict();
type RecoveryTx=Parameters<typeof admissionLock>[0];
type RecoverySnapshot=Awaited<ReturnType<typeof savIntakeSourceSnapshot>>;
const conflict=():never=>{throw Error("SAV_INTAKE_RECOVERY_CONFLICT");};
/** Explicit administrator continuation, once per message/context/configuration revision. It neither resets
 * automatic attempts nor admits more than the existing three model calls.
 * No credential, model or external write is used while recording the request. */
export async function requestIntakeReinvestigation(raw:unknown){
 const actor=await executionAdministrator(),command=request.parse(raw),config=savIntakeRuntimeConfig();
 if(!config)return conflict();
 return requireDb().transaction(tx=>recordIntakeReinvestigation(tx,actor,command,config));
}
/** Shared atomic recording seam; callers hold the same admission transaction. */
export async function recordIntakeReinvestigation(tx:RecoveryTx,actor:Awaited<ReturnType<typeof executionAdministrator>>,command:z.infer<typeof request>,config:NonNullable<ReturnType<typeof savIntakeRuntimeConfig>>,beforeInformation?:RecoverySnapshot){
  await admissionLock(tx);if(!await intakeLaunchMatches(config,tx))return conflict();
  const [active]=await tx.select().from(staffUsers).where(eq(staffUsers.id,actor.id)).for("update");
  if(!active?.active||!["admin","owner"].includes(active.role)||!canAccessSav(active.email,active.role))return conflict();
  const [thread]=await tx.select().from(savThreads).where(eq(savThreads.id,command.threadId)).for("update");
  const [message]=await tx.select().from(savMessages).where(and(eq(savMessages.threadId,command.threadId),eq(savMessages.direction,"inbound")))
   .orderBy(desc(savMessages.receivedAt),desc(savMessages.createdAt),desc(savMessages.id)).limit(1);
  if(!thread||thread.aiPaused||thread.mailboxId!==config.mailboxId||message?.id!==command.messageId
   ||message.receivedAt<=new Date(config.receivedAfter)||message.createdAt<=new Date(config.createdAfter)||await intakeHumanRefused(message.id,tx))return conflict();
  const runs=await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.messageId,message.id)).for("update");
  if(runs.some(r=>r.leaseUntil&&r.leaseUntil>new Date()))return conflict();
  const events=await tx.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.messageId,message.id));
  if(events.some(e=>["pending","reading"].includes(e.state)))return conflict();
  const bodies=events.map(e=>decryptSavPayload<HumanEventPayload>(e.payloadCiphertext));
  const previous=runs.find(r=>r.isCurrent);
  const priorSnapshot=beforeInformation??await savIntakeSourceSnapshot(tx,message,new Date());
  if(previous?.sourceHash&&(!intakeSourceMatches(priorSnapshot,previous.sourceHash)||!await intakeRunReanalysisConfiguration(previous,config,tx)))return conflict();
  const informationId=(await savIntakeSourceSnapshot(tx,message,new Date())).input.message.operatorInformation?.id??null;
  for(let i=0;i<events.length;i++)if(bodies[i].reinvestigate){
   const parent=runs.find(r=>r.id===events[i].parentRunId);
   const input=parent?decryptSavPayload<IntakeRuntimePayload>(parent.payloadCiphertext).input as {message?:{operatorInformation?:{id:string}}}|undefined:undefined;
   if((input?.message?.operatorInformation?.id??null)===informationId&&events[i].baseConfigHash===config.configHash)return conflict();
  }
  const [execution]=await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId,message.id)).for("update");
  if(execution?.state==="confirmed"||execution?.leaseUntil&&execution.leaseUntil>new Date())return conflict();
  if(execution){const effects=await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId,execution.id)).for("update");
   if(effects.some(e=>e.state!=="planned"||e.dispatchedAt||e.dispatchToken||e.ackCiphertext||e.confirmedAt))return conflict();}
  const snapshot=await savIntakeSourceSnapshot(tx,message,new Date());
  if(snapshot.messageSourceHash!==priorSnapshot.messageSourceHash)return conflict();
  const previousPayload=previous?decryptSavPayload<IntakeRuntimePayload>(previous.payloadCiphertext):null;
  const candidates=previous&&previousPayload?await intakeRunCandidateContactIds(previous,previousPayload,tx):[];
  if(!candidates)return conflict();
  const forbidden=async():Promise<never>=>{throw Error("RECOVERY_RECORDING_HAS_NO_EXTERNAL_CAPABILITY");};
  const scaffold=await planSavIntake(snapshot.input,{analyseMessage:async()=>({messageId:message.id,requests:[]}),
   findContactsByEmail:forbidden,directAssociations:forbidden,getContact:forbidden,ticketsForContact:forbidden,ticketHistory:forbidden,assessIssues:forbidden} satisfies IntakeAdapters,config.policy);
  const [last]=await tx.select({version:savIntakeRuns.version}).from(savIntakeRuns).where(eq(savIntakeRuns.threadId,thread.id)).orderBy(desc(savIntakeRuns.version)).limit(1);
  const payload:IntakeRuntimePayload={revision:SAV_INTAKE_RUNTIME_REVISION,effects:"not_connected",input:snapshot.input,plan:scaffold,
   configuration:{configHash:config.configHash,resourcesHash:config.resourcesHash,policyHash:config.policyHash,codeRevision:config.codeRevision,model:config.model},
   ...(previous?.sourceHash&&previousPayload?{reanalysisParent:{runId:previous.id,payloadHash:intakeRuntimeHash(previousPayload),sourceHash:previous.sourceHash,messageSourceHash:snapshot.messageSourceHash}}:{})};
  await tx.update(savIntakeRuns).set({isCurrent:false,state:"superseded",leaseToken:null,leaseUntil:null,freshUntil:null})
   .where(and(eq(savIntakeRuns.threadId,thread.id),eq(savIntakeRuns.isCurrent,true)));
  const eventId=randomUUID();
  const [parent]=await tx.insert(savIntakeRuns).values({threadId:thread.id,messageId:message.id,version:(last?.version??0)+1,
   configHash:operatorRecoveryConfigHash(config.configHash,eventId),policyHash:config.policyHash,state:"waiting",sourceHash:snapshot.sourceHash,payloadCiphertext:encryptSavPayload(payload)}).returning();
  const value:HumanEventPayload={revision:"sav-intake-human.v1",actor:{id:actor.id,email:actor.email},mailboxId:config.mailboxId,
   policyHash:config.policyHash,resourcesHash:config.resourcesHash,candidatesHash:intakeRuntimeHash(candidates),candidateContactIds:candidates,reason:command.reason,parentPayloadHash:intakeRuntimeHash(payload),reinvestigate:true};
  await tx.insert(savIntakeHumanEvents).values({id:eventId,commandKey:command.commandKey??eventId,threadId:thread.id,messageId:message.id,parentRunId:parent.id,parentVersion:parent.version,
   baseConfigHash:config.configHash,sourceHash:snapshot.sourceHash,kind:"classify",state:"pending",payloadCiphertext:encryptSavPayload(value)});
  await tx.insert(savIntakeJournal).values({runId:parent.id,kind:"operator_reinvestigation_requested",payloadCiphertext:encryptSavPayload({eventId,priorRunIds:runs.map(r=>r.id),automaticAttemptsPreserved:runs.reduce((s,r)=>s+r.attempts,0),outboundSuppressed:true})});
  await tx.update(savMessages).set({analysisStatus:"intake_human_pending"}).where(eq(savMessages.id,message.id));
  if(execution)await tx.update(savIntakeExecutions).set({state:"waiting",leaseToken:null,leaseUntil:null}).where(eq(savIntakeExecutions.id,execution.id));
  await tx.insert(auditLogs).values({actorEmail:actor.email,action:"sav_intake_operator_reinvestigation",entityType:"sav_thread",entityId:thread.id,
   technicalMetadata:{messageId:message.id,eventId,runId:parent.id,priorRunCount:runs.length,outboundSuppressed:true}});
  return {eventId,runId:parent.id};
}
/** Existing receipt only: the selected adapter exposes verify, never dispatch. */
export async function reconcileThreadIdentification(threadId:string){
 await executionAdministrator();z.uuid().parse(threadId);
 const executions=await requireDb().select({id:savIntakeExecutions.id}).from(savIntakeExecutions).where(eq(savIntakeExecutions.threadId,threadId));
 if(!executions.length)return {confirmed:0};
 const effects=await requireDb().select().from(savIntakeEffects).where(and(inArray(savIntakeEffects.executionId,executions.map(e=>e.id)),eq(savIntakeEffects.kind,"identity_send"),inArray(savIntakeEffects.state,["dispatched","acked","uncertain"])));
 if(effects.length>2)return conflict();let confirmed=0;
 const {verify}=createIntakeExecutorAdapters();
 for(const e of effects){const ack=e.ackCiphertext?decryptSavPayload<{id?:string}>(e.ackCiphertext):null;if(!ack?.id)return conflict();
  await reconcileIntakeEffectCandidate(e.id,ack.id,"Rapprochement du reçu Gmail existant après correction de l’identifiant de transport ; aucun renvoi.",{verify});confirmed++;}
 for(const execution of executions)await finishVerifiedIdentityRecovery(execution.id);
 return {confirmed};
}
