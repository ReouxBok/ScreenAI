import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savSyncState, auditLogs } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, savIntakeRuntimePins } from "./runtime-contract";
import { executionAdministrator, executionPolicySchema, approveIntakeExecutionPolicy, revokeIntakeExecutionPolicy } from "./execution-policy";
import { recordIntakeLaunch, readIntakeLaunch } from "./launch-boundary";
import { intakeConsoleInstalled } from "./console-capability";
const inputSchema=z.object({runtime:savIntakeRuntimePins,policy:executionPolicySchema}).strict();
const key=(id:string)=>`sav-intake-launch-preview:${id}`;
type Preview={revision:"sav-intake-launch-preview.v1"; actorId:string; input:z.infer<typeof inputSchema>; hash:string; createdAt:string; expiresAt:string; leaseUntil?:string;
  receipt?:{policyId:string;policyHash:string;mailboxId:string;receivedAfter:string;createdAfter:string}};
function validateInput(raw:unknown) {
  const input=inputSchema.parse(raw);
  const runtime=savIntakeRuntimeConfig({...process.env,SAV_INTAKE_RUNTIME_MODE:"observe",SAV_INTAKE_RUNTIME_CONFIG:JSON.stringify(input.runtime)})!;
  const p=input.policy;
  if(p.codeRevision!==runtime.codeRevision||p.mailboxId!==runtime.mailboxId||p.receivedAfter!==runtime.receivedAfter||p.createdAfter!==runtime.createdAfter
    ||p.enginePolicyHash!==runtime.policyHash||p.resourcesHash!==runtime.resourcesHash||p.budgetProfile!==runtime.budgetProfile||p.expiresAt!==runtime.expiresAt
    ||intakeRuntimeHash(savIntakeRuntimePins.parse(JSON.parse(process.env.SAV_INTAKE_RUNTIME_CONFIG??"null")))!==intakeRuntimeHash(input.runtime)) throw Error("SAV_INTAKE_LAUNCH_PIN_MISMATCH");
  return input;
}
/** Preview is a durable local intent only. No authority, launch boundary or
 * provider call is installed by this first click. Its original expiry is fixed. */
export async function previewIntakeLaunch(commandId:string,raw:unknown) {
  z.uuid().parse(commandId);
  const actor=await executionAdministrator(),input=validateInput(raw);
  if(!await intakeConsoleInstalled())throw Error("SAV_INTAKE_CONSOLE_MIGRATION_REQUIRED");
  const launch=await readIntakeLaunch(input.runtime.mailboxId);
  if(launch&&(Date.parse(launch.createdAfter)!==Date.parse(input.runtime.createdAfter)||Date.parse(launch.receivedAfter)!==Date.parse(input.runtime.receivedAfter)))throw Error("SAV_INTAKE_LAUNCH_IMMUTABLE");
  return requireDb().transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key(commandId)}))`);
    const [existing]=await tx.select().from(savSyncState).where(eq(savSyncState.key,key(commandId)));
    if(existing) {
      const old=decryptSavPayload<Preview>(existing.cursor!);
      if(old.actorId!==actor.id||intakeRuntimeHash(old.input)!==intakeRuntimeHash(input))throw Error("SAV_INTAKE_LAUNCH_PREVIEW_CONFLICT");
      return {previewId:commandId,hash:old.hash,expiresAt:old.expiresAt,input:old.input};
    }
    const createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+600000).toISOString();
    const hash=intakeRuntimeHash({revision:"sav-intake-launch-preview.v1",commandId,actorId:actor.id,input,createdAt,expiresAt});
    const payload:Preview={revision:"sav-intake-launch-preview.v1",actorId:actor.id,input,hash,createdAt,expiresAt};
    await tx.insert(savSyncState).values({key:key(commandId),status:"pending",cursor:encryptSavPayload(payload)});
    return {previewId:commandId,hash,expiresAt,input};
  });
}
/** CAS second click. Same command/hash is resumable and idempotent. A crash
 * after the boundary leaves future arrivals HELD; it never enables providers. */
export async function commitIntakeLaunch(commandId:string,hash:string) {
  z.uuid().parse(commandId);z.string().regex(/^[a-f0-9]{64}$/).parse(hash);
  const actor=await executionAdministrator();
  const claim=await requireDb().transaction(async tx=>{
    const [row]=await tx.select().from(savSyncState).where(eq(savSyncState.key,key(commandId))).for("update");
    if(!row?.cursor)throw Error("SAV_INTAKE_LAUNCH_PREVIEW_REQUIRED");
    const value=decryptSavPayload<Preview>(row.cursor);
    if(value.actorId!==actor.id||value.hash!==hash||intakeRuntimeHash({revision:value.revision,commandId,actorId:value.actorId,input:value.input,createdAt:value.createdAt,expiresAt:value.expiresAt})!==hash)throw Error("SAV_INTAKE_LAUNCH_PREVIEW_CONFLICT");
    if(row.status==="committed"&&value.receipt)return {done:value.receipt};
    if(Date.parse(value.expiresAt)<=Date.now()||Date.parse(value.createdAt)>Date.now())throw Error("SAV_INTAKE_LAUNCH_PREVIEW_EXPIRED");
    if(row.status==="committing"&&Date.parse(value.leaseUntil??"")>Date.now())throw Error("SAV_INTAKE_LAUNCH_COMMIT_PENDING");
    validateInput(value.input);
    value.leaseUntil=new Date(Date.now()+30000).toISOString();
    await tx.update(savSyncState).set({status:"committing",cursor:encryptSavPayload(value)}).where(eq(savSyncState.key,row.key));
    return {value};
  });
  if(claim.done)return claim.done;
  const value=claim.value!;
  const launch=await recordIntakeLaunch({mailboxId:value.input.runtime.mailboxId,receivedAfter:value.input.runtime.receivedAfter,createdAfter:value.input.runtime.createdAfter});
  const policy=await approveIntakeExecutionPolicy(value.input.policy,commandId);
  const receipt={policyId:policy.id,policyHash:policy.policyHash,mailboxId:launch.mailboxId,receivedAfter:launch.receivedAfter,createdAfter:launch.createdAfter};
  return requireDb().transaction(async tx=>{
    const [row]=await tx.select().from(savSyncState).where(eq(savSyncState.key,key(commandId))).for("update");
    const current=decryptSavPayload<Preview>(row.cursor!);
    if(current.hash!==hash||current.leaseUntil!==value.leaseUntil)throw Error("SAV_INTAKE_LAUNCH_PREVIEW_CONFLICT");
    await tx.update(savSyncState).set({status:"committed",cursor:encryptSavPayload({...current,receipt})}).where(eq(savSyncState.key,row.key));
    await tx.insert(auditLogs).values({actorEmail:actor.email,action:"sav_intake_launch_committed",entityType:"sav_intake_launch_preview",entityId:commandId,technicalMetadata:{hash,policyId:policy.id,policyHash:policy.policyHash}});
    return receipt;
  });
}
export { revokeIntakeExecutionPolicy };
