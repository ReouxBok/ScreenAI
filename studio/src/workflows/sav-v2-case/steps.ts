import "server-only";
import { CASE_WAKE_STEP_BUDGET_MS, runCaseReplySend, runCaseSettleWake } from "@/lib/sav/cases/case-v2-latency-wakes";
import type { OwnerHandoverTransition } from "@/lib/sav/cases/owner-handover-markers";

export async function resumeSavV2CaseAfterSettleStep(caseId: string, wakeAt: string) {
  "use step";
  // Model calls are bounded by the case ledger; a step retry would add a passage nobody asked for.
  return runCaseSettleWake(caseId, wakeAt, { env: process.env, deadlineMs: Date.now() + CASE_WAKE_STEP_BUDGET_MS });
}
resumeSavV2CaseAfterSettleStep.maxRetries = 0;

export async function sendSavV2QueuedReplyStep(executionId: string) {
  "use step";
  // Effects are fenced by the execution's claim and lease; an uncertain outcome is verified by the catch-up, never retried here.
  return runCaseReplySend(executionId, { env: process.env, deadlineMs: Date.now() + CASE_WAKE_STEP_BUDGET_MS });
}
sendSavV2QueuedReplyStep.maxRetries = 0;

export async function runSavV2OwnerHandoverStep(input: OwnerHandoverTransition) {
  "use step";
  const { runSavOwnerHandover } = await import("@/lib/sav/cases/owner-handover");
  return runSavOwnerHandover(input, { deadlineMs: Date.now() + CASE_WAKE_STEP_BUDGET_MS });
}
runSavV2OwnerHandoverStep.maxRetries = 0;
