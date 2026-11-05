// V2 ticket states (local, OFF): admission of the `ticket_stage` effect. ONE case execution per (case, target, trigger), planned by pole A's rule (`planCaseTicketStage`).
// « Waiting for the customer » is queued INSIDE the transaction that records a confirmed reply (so a confirmed reply without its stage cannot exist, and a replay or a
// recovery returns the same row); « closed » is queued by `case-resolution.ts`. This file depends on no driver: the reply driver calls it from its receipt.
import "server-only";
import { and, eq, max } from "drizzle-orm";
import { savCaseEffectExecutions, savCaseEvents } from "@/db/schema";
import { encryptSavPayload } from "../crypto";
import { executionJournal, type ExecutionTx } from "../intake/execution-store";
import { TICKET_STAGE_CONTRACT, type TicketStagePayload } from "./case-ticket-stage";
import type { CaseSnapshot } from "./case-types";
import { planCaseTicketStage, readCaseTicketStageConfig, type CaseTicketStageTrigger } from "./customer-return";


export type EnqueueTicketStageResult =
  | Readonly<{ ok: true; executionId: string; created: boolean; key: string }>
  | Readonly<{ ok: false; reason: string }>;
type StageCase = Pick<CaseSnapshot, "caseId" | "ticketId" | "owner" | "phase" | "sensitivity" | "body" | "threadIds">;

/** Date of the latest customer mail recorded on the case, read in the caller's transaction. */
export async function lastCustomerInboundAt(tx: ExecutionTx, caseId: string): Promise<string | null> {
  const [row] = await tx.select({ at: max(savCaseEvents.occurredAt) }).from(savCaseEvents).where(and(eq(savCaseEvents.caseId, caseId), eq(savCaseEvents.kind, "inbound_confirmed")));
  return row?.at ? new Date(row.at).toISOString() : null;
}

/**
 * Plans with A's rule, then queues. Inside the caller's transaction, the case already locked by the caller. Idempotent: the unique key makes a second call, a concurrent call or
 * a replay the same execution; a cancelled execution stays cancelled (its key is never reused). Never throws for a rule that says no: the reason is returned.
 */
export async function enqueueCaseTicketStage(tx: ExecutionTx, input: Readonly<{
  snapshot: StageCase; trigger: CaseTicketStageTrigger; policy: Readonly<{ id: string; hash: string }>; env: () => Record<string, string | undefined>; threadId?: string;
}>): Promise<EnqueueTicketStageResult> {
  const config = readCaseTicketStageConfig(input.env());
  const { snapshot } = input;
  let planned: ReturnType<typeof planCaseTicketStage>;
  try {
    planned = planCaseTicketStage({
      config, caseId: snapshot.caseId, ticketId: snapshot.ticketId, case: { owner: snapshot.owner, phase: snapshot.phase, sensitivity: snapshot.sensitivity, cycle: snapshot.body.cycle },
      trigger: input.trigger, lastCustomerInboundAt: await lastCustomerInboundAt(tx, snapshot.caseId),
    });
  } catch { return { ok: false, reason: "key_invalid" }; }
  if (!planned.plan) return { ok: false, reason: planned.reason };
  const threadId = input.threadId ?? snapshot.threadIds.at(-1);
  if (!threadId) return { ok: false, reason: "no_thread" };
  const key = planned.intent.key;
  const payload: TicketStagePayload = { contract: TICKET_STAGE_CONTRACT, intent: planned.intent, trigger: input.trigger };
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

