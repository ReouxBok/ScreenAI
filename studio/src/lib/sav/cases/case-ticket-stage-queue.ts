// V2 ticket states (local, OFF): admission of the `ticket_stage` effect. ONE case execution per (case, target, trigger), planned by pole A's rule (`planCaseTicketStage`).
// « Waiting for the customer » is queued INSIDE the transaction that records a confirmed reply (so a confirmed reply without its stage cannot exist, and a replay or a
// recovery returns the same row); « closed » is queued by `case-resolution.ts`. This file depends on no driver: the reply driver calls it from its receipt.
import "server-only";
import { and, desc, eq, gt, max } from "drizzle-orm";
import { savCaseEffectExecutions, savCaseEvents } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { executionJournal, type ExecutionTx } from "../intake/execution-store";
import { TICKET_STAGE_CONTRACT, type TicketStagePayload } from "./case-ticket-stage";
import { caseTeamPartRequests, SAV_CASE_AWAITING_V2_ATTRIBUTION, type CaseSnapshot } from "./case-types";
import { caseHandoffStageEnabled, planCaseTicketStage, readCaseTicketStageConfig, type CaseTicketStageTrigger } from "./customer-return";


export type EnqueueTicketStageResult =
  | Readonly<{ ok: true; executionId: string; created: boolean; key: string }>
  | Readonly<{ ok: false; reason: string }>;
type StageCase = Pick<CaseSnapshot, "caseId" | "ticketId" | "owner" | "phase" | "sensitivity" | "body" | "threadIds" | "admission">;

/**
 * SAV-92 (review of batch 2, finding 2): the team still has its part of the customer's message. Only the team parts of the admission in force (the latest
 * mail: a new customer mail re-qualifies the case and ends the freeze of the previous one), and only until a person replies on the case after that admission
 * (an observed `human_outbound`: the team answered its part). A request handed off for another reason never freezes the stage. Read in the caller's transaction.
 */
export async function caseTeamPartPending(tx: ExecutionTx, snapshot: Pick<CaseSnapshot, "caseId" | "admission" | "body">): Promise<boolean> {
  if (!caseTeamPartRequests(snapshot).length) return false;
  const [reply] = await tx.select({ id: savCaseEvents.id }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, snapshot.caseId), eq(savCaseEvents.kind, "outbound_observed"),
    eq(savCaseEvents.direction, "human_outbound"), gt(savCaseEvents.caseVersion, snapshot.admission?.version ?? 0))).limit(1);
  return !reply;
}

/** Date of the latest customer mail recorded on the case, read in the caller's transaction. */
export async function lastCustomerInboundAt(tx: ExecutionTx, caseId: string): Promise<string | null> {
  const [row] = await tx.select({ at: max(savCaseEvents.occurredAt) }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, caseId), eq(savCaseEvents.kind, "inbound_confirmed")));
  return row?.at ? new Date(row.at).toISOString() : null;
}

/**
 * SAV-92 (17/11): the version of the V2 hand-over still in force, read in the caller's transaction: the case is with the team on a hand-over nobody took yet
 * (`human_takeover` sets `humanSince`; a case waiting for its V2 attribution is not a hand-over). The latest `owner_changed` is then that hand-over.
 */
export async function openHandoffVersion(tx: ExecutionTx, snapshot: Pick<CaseSnapshot, "caseId" | "owner" | "phase" | "body">): Promise<number | undefined> {
  const handoff = snapshot.body.handoff;
  if (snapshot.owner !== "human" || snapshot.phase !== "handoff_pending" || !handoff || handoff.humanSince || handoff.reason === SAV_CASE_AWAITING_V2_ATTRIBUTION) return undefined;
  const [row] = await tx.select({ version: savCaseEvents.caseVersion }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, snapshot.caseId), eq(savCaseEvents.kind, "owner_changed")))
    .orderBy(desc(savCaseEvents.caseVersion)).limit(1);
  return row?.version;
}

/** A's rule on the facts read in the caller's transaction, exactly as the queue applies it (also read by the reply's summary note, SAV-92 16/11, so the
 * note names only a stage this very rule plans). Null: the key could not be built. Writes nothing. */
export async function planCaseTicketStageNow(tx: ExecutionTx, input: Readonly<{ snapshot: StageCase; trigger: CaseTicketStageTrigger; env: () => Record<string, string | undefined> }>) {
  const { snapshot } = input;
  // Read outside the catch, as before: an unreadable configuration fails the caller's transaction, it is never taken for « no stage ».
  const config = readCaseTicketStageConfig(input.env());
  const handoff = input.trigger.kind === "handoff_recorded";
  try {
    // SAV-92 (17/11): a hand-over trigger reads only what its rule needs (its switch, the hand-over in force); the other triggers read exactly what they read before.
    const handoffVersion = handoff ? await openHandoffVersion(tx, snapshot) : undefined;
    return planCaseTicketStage({
      config, caseId: snapshot.caseId, ticketId: snapshot.ticketId,
      case: { owner: snapshot.owner, phase: snapshot.phase, sensitivity: snapshot.sensitivity, cycle: snapshot.body.cycle,
        ...(!handoff && await caseTeamPartPending(tx, snapshot) ? { teamPartPending: true } : {}), ...(handoffVersion === undefined ? {} : { handoffVersion }) },
      trigger: input.trigger, lastCustomerInboundAt: handoff ? null : await lastCustomerInboundAt(tx, snapshot.caseId),
      ...(handoff ? { handoffStage: caseHandoffStageEnabled(input.env()) } : {}),
    });
  } catch { return null; }
}

/**
 * Plans with A's rule, then queues. Inside the caller's transaction, the case already locked by the caller. Idempotent: the unique key makes a second call, a concurrent call or
 * a replay the same execution; a cancelled execution stays cancelled (its key is never reused). Never throws for a rule that says no: the reason is returned.
 */
export async function enqueueCaseTicketStage(tx: ExecutionTx, input: Readonly<{
  snapshot: StageCase; trigger: CaseTicketStageTrigger; policy: Readonly<{ id: string; hash: string }>; env: () => Record<string, string | undefined>; threadId?: string;
  /** SAV-92 (16/11): sealed with a « closed » stage only (its closure note's families); never part of the key, never read for « waiting ». */
  closureFamilies?: readonly string[];
}>): Promise<EnqueueTicketStageResult> {
  const { snapshot } = input;
  const planned = await planCaseTicketStageNow(tx, input);
  if (!planned) return { ok: false, reason: "key_invalid" };
  if (!planned.plan) return { ok: false, reason: planned.reason };
  const threadId = input.threadId ?? snapshot.threadIds.at(-1);
  if (!threadId) return { ok: false, reason: "no_thread" };
  const key = planned.intent.key;
  const payload: TicketStagePayload = { contract: TICKET_STAGE_CONTRACT, intent: planned.intent, trigger: input.trigger,
    ...(planned.intent.target === "closed" && input.closureFamilies ? { closureFamilies: [...new Set(input.closureFamilies)].slice(0, 20) } : {}) };
  const [created] = await tx.insert(savCaseEffectExecutions).values({
    caseId: snapshot.caseId, replyKey: key, threadId, policyId: input.policy.id, policyHash: input.policy.hash, payloadCiphertext: encryptSavPayload(payload),
  }).onConflictDoNothing().returning({ id: savCaseEffectExecutions.id });
  if (created) {
    await executionJournal(tx, created.id, "ticket_stage_admitted", { key, target: planned.intent.target, trigger: input.trigger.kind });
    return { ok: true, executionId: created.id, created: true, key };
  }
  const [existing] = await tx.select({ id: savCaseEffectExecutions.id }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.replyKey, key));
  return existing ? { ok: true, executionId: existing.id, created: false, key } : { ok: false, reason: "key_conflict" };
}

