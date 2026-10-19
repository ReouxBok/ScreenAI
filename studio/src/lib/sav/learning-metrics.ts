import "server-only";
import {and,count,desc,eq,gte,inArray,lte,sql} from "drizzle-orm";
import {requireDb} from "@/db";
import {auditLogs,savAnalysisSnapshots,savMessageTranslations,savObservationCycles,savObservationEvents,savResolutionObservations} from "@/db/schema";
import {decryptSavPayload} from "./crypto";
import {savDerivedBudgets} from "./derived-budget";
import type {SavLearningComparison} from "./learning-comparator";
/** Coverage and usage, never a causal quality score or operator time estimate. */
export async function savCaseLearningMetrics(now=new Date()) {
 const db=requireDb(),since=new Date(now.getTime()-7*86400000),day=new Date(now.toISOString().slice(0,10)+"T00:00:00Z");
 const [{total}]=await db.select({total:count()}).from(savResolutionObservations);
 const [{late}]=await db.select({late:count()}).from(savResolutionObservations).where(lte(savResolutionObservations.nextSyncAt,now));
 const [{incomplete}]=await db.select({incomplete:count()}).from(savResolutionObservations).where(sql`jsonb_array_length(${savResolutionObservations.sourceErrors}) > 0`);
 const stages=await db.select({stage:sql<string>`${auditLogs.technicalMetadata}->>'stage'`,calls:count()}).from(auditLogs).where(and(eq(auditLogs.action,"sav_derived_call_reserved"),gte(auditLogs.createdAt,day))).groupBy(sql`${auditLogs.technicalMetadata}->>'stage'`);
 const translations=await db.select({status:savMessageTranslations.status,total:count()}).from(savMessageTranslations).groupBy(savMessageTranslations.status);
 const comparisons=await db.select().from(savObservationEvents).where(and(eq(savObservationEvents.kind,"case_comparison"),gte(savObservationEvents.occurredAt,since))).orderBy(desc(savObservationEvents.occurredAt)).limit(201);
 const [{comparisonCount}]=await db.select({comparisonCount:count()}).from(savObservationEvents).where(and(eq(savObservationEvents.kind,"case_comparison"),gte(savObservationEvents.occurredAt,since)));
 const cycles=await db.select().from(savObservationCycles).where(gte(savObservationCycles.updatedAt,since)).orderBy(desc(savObservationCycles.updatedAt)).limit(201);
 const observationIds=[...new Set(comparisons.slice(0,200).map(c=>c.observationId))];
 const baselines=observationIds.length?await db.select({observationId:savResolutionObservations.id,codeRevision:savAnalysisSnapshots.codeRevision,payload:savAnalysisSnapshots.payloadCiphertext}).from(savResolutionObservations).leftJoin(savAnalysisSnapshots,eq(savAnalysisSnapshots.id,savResolutionObservations.snapshotId)).where(inArray(savResolutionObservations.id,observationIds)):[];
 const distinct=new Map<string,Set<string>>();
 const cohorts=new Map<string,{domain:string;revision:string;codeRevision:string;model:string;promptRevision:string;playbookVersion:string;independentCases:number;cases:number;axes:Record<string,{supported:number;gap:number;not_evaluable:number}>;inputTokens:number;outputTokens:number;unknownUsage:number;durationMs:number}>();
 for(const event of comparisons.slice(0,200)){
  const comparison=decryptSavPayload<{revision:string;inputTokens:number|null;outputTokens:number|null;durationMs:number;decision:SavLearningComparison;sourceHash:string}>(event.payloadCiphertext);
  const cycle=cycles.find(c=>c.sourceHash===comparison.sourceHash&&c.observationId===event.observationId);
  const domain=cycle?decryptSavPayload<{category?:string}>(cycle.summaryCiphertext).category??"unknown":"unknown";
  const baseline=baselines.find(b=>b.observationId===event.observationId);
  const provenance=baseline?.payload?decryptSavPayload<{model?:string;promptRevision?:string;availableContext?:{activePlaybook?:{versionId?:string}}}>(baseline.payload):null;
  const codeRevision=baseline?.codeRevision??"unknown",model=provenance?.model??"unknown",promptRevision=provenance?.promptRevision??"unknown",playbookVersion=provenance?.availableContext?.activePlaybook?.versionId??"unknown";
  const key=JSON.stringify({domain,evaluator:comparison.revision,codeRevision,model,promptRevision,playbookVersion});
  const cases=distinct.get(key)??new Set<string>();cases.add(event.observationId);distinct.set(key,cases);
  const group=cohorts.get(key)??{domain,revision:comparison.revision,codeRevision,model,promptRevision,playbookVersion,independentCases:0,cases:0,axes:{},inputTokens:0,outputTokens:0,unknownUsage:0,durationMs:0};
  group.cases++;group.independentCases=cases.size;group.inputTokens+=comparison.inputTokens??0;group.outputTokens+=comparison.outputTokens??0;group.durationMs+=comparison.durationMs;
  if(comparison.inputTokens===null||comparison.outputTokens===null)group.unknownUsage++;
  for(const axis of comparison.decision.caseAxes??[]){group.axes[axis.axis]??={supported:0,gap:0,not_evaluable:0};group.axes[axis.axis][axis.state]++;}
  cohorts.set(key,group);
 }
 return {total,late,incomplete,stages,translations,budgets:savDerivedBudgets(),cohorts:[...cohorts.values()],since:since.toISOString(),comparisonCount,sampledComparisons:Math.min(200,comparisons.length),truncated:comparisons.length>200||cycles.length>200};
}
