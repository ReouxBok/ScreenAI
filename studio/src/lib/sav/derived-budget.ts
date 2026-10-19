import "server-only";
import { and,count,eq,gte,sql } from "drizzle-orm";
import { requireDb } from "@/db";
import {auditLogs} from "@/db/schema";
type Tx=Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
export function savDerivedBudgets(){const bound=(name:string,fallback:number)=>{const value=Number(process.env[name]??fallback);return Number.isFinite(value)?Math.min(1000,Math.max(0,Math.floor(value))):fallback;};return {comparison:bound("SAV_COMPARISON_DAILY_CALLS",20),translation:bound("SAV_TRANSLATION_DAILY_CALLS",50),total:bound("SAV_DERIVED_DAILY_CALLS",60),simulation:0};}
/** One durable reservation per provider attempt. Failed/unknown calls consume quota.
 * Distinct stages share a total cap; simulations require a separate authorization. */
export async function reserveSavDerivedCallTx(tx:Tx,stage:"comparison"|"translation",now=new Date(),proofKey?:string){
 await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-derived-model-budget'))`);
 const day=new Date(now.toISOString().slice(0,10)+"T00:00:00.000Z"),limits=savDerivedBudgets();
 const [total]=await tx.select({n:count()}).from(auditLogs).where(and(eq(auditLogs.action,"sav_derived_call_reserved"),gte(auditLogs.createdAt,day)));
 const [used]=await tx.select({n:count()}).from(auditLogs).where(and(eq(auditLogs.action,"sav_derived_call_reserved"),gte(auditLogs.createdAt,day),sql`${auditLogs.technicalMetadata}->>'stage'=${stage}`));
 if(total.n>=limits.total||used.n>=limits[stage])throw new Error("SAV_DERIVED_DAILY_BUDGET_EXHAUSTED");
 await tx.insert(auditLogs).values({actorEmail:"system",action:"sav_derived_call_reserved",entityType:"sav_derived_budget",entityId:now.toISOString().slice(0,10),technicalMetadata:{stage,...(proofKey?{proofKey}:{}),reservedInputBytes:240000,reservedOutputTokens:8192},createdAt:now});
 return {used:used.n+1,total:total.n+1,limits};
}
