import { sleep } from "workflow";
import { resumeOwnerHandoverStep } from "./steps";
export async function processSavV2OwnerHandoverWorkflow(ticketId: string, token: string, wakeAt: string) {
  "use workflow";
  await sleep(new Date(wakeAt));
  return resumeOwnerHandoverStep(ticketId, token);
}
