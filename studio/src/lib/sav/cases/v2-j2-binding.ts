import { savSharedSpendAvailable } from "../shared-spend";
import "server-only";
import { and, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savCaseReplyValidations, savIntakeEffects } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { readSavAgentPause } from "../intake/agent-pause";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import type { AdmissionPolicyRecord } from "./admission-runtime";
import { caseReplyKey, j2TriggerEventId, readCaseEffectsMode, type CaseReplyProposal } from "./case-effects";
import { enqueueApprovedCaseReply, type CaseReplyStoreDeps } from "./case-reply-store";
import { readCase } from "./case-store";
import { nextSweepPage } from "./case-sweep-cursor";
import { createCaseTicketOwnerPort } from "./case-v2-wake-ports";
import { caseProvenanceReaders } from "./investigation-pilot-readers";
import { readCaseV2SpendDay, readCaseV2SpendPolicy } from "./investigation-v2-spend";
import { pilotProvenanceGate } from "./pilot-passage-provenance";
import type { J2ReminderEffect, J2Timer } from "./timer-lifecycle";
import { revalidateJ2Timer, runDueJ2Pass, type J2Ports } from "./timer-store";
import { savV2EntryEnabled } from "./v2-entry";
import { immediateSendDeadline, type ImmediateCaseReplyOutcome, type ImmediateCaseReplySend } from "./immediate-send-budget";

type Env = Record<string, string | undefined>;
/** `sendNow` (11/11): the immediate sender for a reminder this tick queued; absent, the real one; null, none (the effects catch-up sends it). */
type Tick = { env: Env; deadlineMs: number; network?: typeof fetch; sendNow?: ImmediateCaseReplySend | null };

export async function readJ2ReminderEffect(timer: Pick<J2Timer,"caseId"|"id">): Promise<J2ReminderEffect> {
  const key = caseReplyKey(timer.caseId, j2TriggerEventId(timer.id)), db = requireDb();
  const [effect] = await db.select({ kind: savIntakeEffects.kind, state: savIntakeEffects.state })
    .from(savIntakeEffects).where(eq(savIntakeEffects.businessKey, key));
  if (effect) {
    if (effect.kind !== "reply_send") return "uncertain";
    switch (effect.state) {
      case "planned": case "dispatched": case "confirmed": case "failed": return effect.state;
      default: return "uncertain";
    }
  }
  // The parent can be durably enqueued before its executor writes the effect row.
  const [parent] = await db.select({ id: savCaseEffectExecutions.id }).from(savCaseEffectExecutions)
    .where(and(eq(savCaseEffectExecutions.caseId,timer.caseId),eq(savCaseEffectExecutions.replyKey,key)));
  return parent ? "planned" : "none";
}

export async function j2BudgetAvailable(env: Env, now: Date) {
  const read = readCaseV2SpendPolicy(env);
  if (!read.ok) return false;
  for (const purpose of ["model","embedding"] as const) {
    const day = await readCaseV2SpendDay(purpose,now.toISOString().slice(0,10));
    const section = read.policy[purpose], held = day?.heldMicroUsd ?? 0, settled = day?.settledMicroUsd ?? 0;
    if (![held,settled].every(n=>Number.isSafeInteger(n)&&n>=0) || held+settled+section.reserveMicroUsdPerCall>section.dailyCapMicroUsd) return false;
  }
  return savSharedSpendAvailable((read.policy.model.reserveMicroUsdPerCall + read.policy.embedding.reserveMicroUsdPerCall) * 1000, now);
}

export async function enqueueApprovedJ2(timer: Pick<J2Timer,"id"|"caseId">, caseVersion: number,
  policy: {id:string;hash:string}, deps: CaseReplyStoreDeps, onQueued?: (executionId: string) => void) {
  const trigger = j2TriggerEventId(timer.id), key = caseReplyKey(timer.caseId,trigger);
  const [row] = await requireDb().select().from(savCaseReplyValidations).where(and(eq(savCaseReplyValidations.replyKey,key),
    eq(savCaseReplyValidations.caseId,timer.caseId),eq(savCaseReplyValidations.state,"approved")));
  if (!row) return "reminder_approval_missing";
  const proposal = decryptSavPayload<CaseReplyProposal>(row.proposalCiphertext);
  if (proposal.purpose !== "reminder" || proposal.triggerEventId !== trigger || proposal.caseId !== timer.caseId ||
      proposal.caseVersion !== caseVersion || row.caseVersion !== caseVersion) return "reminder_approval_stale";
  const result = await enqueueApprovedCaseReply({validationId:row.id,policy,deps});
  if (result.ok && result.created) onQueued?.(result.executionId);
  return result.ok ? (result.created ? "queued" : "already_queued") : result.code;
}

/** A wake may fire a due timer and enqueue an already approved, versioned reminder. It cannot author or approve a reminder. */
export async function reconcileCaseJ2({env,deadlineMs,network,sendNow}:Tick) {
  if (!savV2EntryEnabled(env) || env.SAV_V2_J2 !== "on" || readCaseEffectsMode(env).mode !== "supervised") return { skipped:"j2_off" };
  const expired = () => !Number.isFinite(deadlineMs) || Date.now() >= deadlineMs;
  if (expired()) return { skipped:"deadline" };
  const limit = Number(env.SAV_V2_J2_BATCH);
  if (!Number.isInteger(limit) || limit<1 || limit>200) return { skipped:"j2_batch_unconfigured" };
  const config = intakeExecutionConfig(env);
  if (!config) return { skipped:"execution_off" };
  for (const id of ["intake","v2"] as const) {
    const pause = await readSavAgentPause(requireDb(),id);
    if (pause.invalid || pause.level!=="running") return { skipped:"paused" };
  }
  const {policy} = await readIntakeExecutionAuthority(config);
  if (policy.admission.kind!=="automatic" || !policy.mutations.includes("send_case_reply")) return { skipped:"reminder_not_granted" };
  const readPolicyRecord = async (): Promise<AdmissionPolicyRecord|null> => {
    const raw = env.SAV_V2_ADMISSION_POLICY_JSON;
    if (!raw || raw.length>65536) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const provenance = caseProvenanceReaders({env:()=>env,readPolicyRecord});
  const revision = await provenance.currentPolicyRevision();
  if (!revision) return { skipped:"admission_policy_missing" };
  const budgetAvailable = ()=>j2BudgetAvailable(env,new Date());
  if (!await budgetAvailable()) return { skipped:"v2_budget_unavailable" };
  const deps:CaseReplyStoreDeps={env:()=>env,currentPolicyRevision:provenance.currentPolicyRevision,
    readTicketOwner:createCaseTicketOwnerPort({env:()=>env,network}),pilotProvenance:pilotProvenanceGate(provenance)};
  const outcomes: {timerId:string;status:string}[] = [];
  const observed = new Set<string>(), queued: string[] = [];
  const ports:J2Ports={reminderEffect:readJ2ReminderEffect,budgetAvailable,
    onConditionsMet:async ({timer,caseVersion})=>{
      const status=expired()?"deadline":await enqueueApprovedJ2(timer,caseVersion,{id:config.policyId,hash:config.policyHash},deps,id=>queued.push(id));
      outcomes.push({timerId:timer.id,status});
    }};
  for(let i=0;i<limit&&!expired();i++) {
    const pass=await runDueJ2Pass({now:new Date(),maxEvents:1,currentPolicyRevision:revision,ports});
    for(const outcome of pass.outcomes) {
      observed.add(outcome.timerId);
      if(!outcomes.some(x=>x.timerId===outcome.timerId)) outcomes.push({timerId:outcome.timerId,status:outcome.revalidation.status});
    }
    if(!pass.outcomes[0]?.fired) break;
  }
  // The reminders this tick queued leave at once, as they did when the effects ran in this worker, within the worker's budget (after the timer
  // transactions, never inside one). Short of budget, or on any refusal, they stay queued for the effects catch-up.
  const sentNow = await sendQueuedJ2Now(queued, { env, deadlineMs, sendNow });
  // A fired timer survives a crash after its transaction. Scan only the timer still named by each
  // current waiting case; the durable cursor advances even when an earlier case still lacks approval.
  if(!expired()) {
    const page=await nextSweepPage({name:"j2_reminder",since:new Date(policy.createdAfter),limit});
    let handled=0;
    for(const id of page.ids) {
      if(expired()) break;
      const timerId=(await readCase(id))?.body.waiting?.timerId;
      if(timerId&&!observed.has(timerId)) {
        const result=await revalidateJ2Timer({timerId,caseId:id,currentPolicyRevision:revision,now:new Date(),ports});
        if(result.status!=="not_fired"&&!outcomes.some(x=>x.timerId===timerId)) outcomes.push({timerId,status:result.status});
      }
      handled++;
    }
    await page.commit(handled);
  }
  return {outcomes,deadlineReached:expired(),...(sentNow.length?{sentNow}:{})};
}

/** Immediate send of the reminders a J2 tick queued, one after the other, each only while the caller's budget allows a full send (`immediateSendDeadline`).
 * Never throws: what is not sent stays queued for the effects catch-up. */
export async function sendQueuedJ2Now(executionIds: readonly string[], input: { env: Env; deadlineMs: number; sendNow?: ImmediateCaseReplySend | null }) {
  const out: { executionId: string; outcome: ImmediateCaseReplyOutcome }[] = [];
  if (!executionIds.length || input.sendNow === null) return out;
  let sendNow = input.sendNow;
  for (const executionId of executionIds) {
    if (immediateSendDeadline(input.deadlineMs) === null) { out.push({ executionId, outcome: { skipped: "caller_budget" } }); continue; }
    try {
      sendNow ??= (await import("./v2-effects-binding")).sendQueuedCaseReplyNow;
      out.push({ executionId, outcome: await sendNow({ env: input.env, executionId, callerDeadlineMs: input.deadlineMs }) });
    } catch { out.push({ executionId, outcome: { failed: "SAV_V2_IMMEDIATE_SEND_THREW" } }); }
  }
  return out;
}
