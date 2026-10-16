import { executeSavTicketCommandStep, refreshSavContextStep } from "./steps";

export async function executeSavTicketCommandWorkflow(actionId: string) {
  "use workflow";
  return executeSavTicketCommandStep(actionId);
}
export async function refreshSavContextWorkflow(threadId: string, requestId: string, actorEmail: string) {
  "use workflow";
  return refreshSavContextStep(threadId, requestId, actorEmail);
}
