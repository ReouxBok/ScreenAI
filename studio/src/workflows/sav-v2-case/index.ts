import { sleep } from "workflow";
import type { OwnerHandoverTransition } from "@/lib/sav/cases/owner-handover-markers";
import { resumeSavV2CaseAfterSettleStep, runSavV2OwnerHandoverStep, sendSavV2QueuedReplyStep } from "./steps";

/** SAV-92 (16/11): wakes the case when its inbound settle window ends. Carries only the case id and the date; the step re-reads everything. */
export async function processSavV2CaseSettleWakeWorkflow(caseId: string, wakeAt: string) {
  "use workflow";
  await sleep(new Date(wakeAt));
  return resumeSavV2CaseAfterSettleStep(caseId, wakeAt);
}

/** SAV-92 (16/11): sends ONE queued V2 reply in its own step, with its own budget. Carries only the execution id; the sender re-reads every guard. */
export async function processSavV2ReplySendWorkflow(executionId: string) {
  "use workflow";
  return sendSavV2QueuedReplyStep(executionId);
}

export async function processSavV2OwnerHandoverWorkflow(input: OwnerHandoverTransition, wakeAt: string) {
  "use workflow";
  await sleep(new Date(wakeAt));
  return runSavV2OwnerHandoverStep(input);
}
