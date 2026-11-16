import { runOwnerHandover } from "@/lib/sav/cases/owner-handover";
export async function resumeOwnerHandoverStep(ticketId: string, token: string) {
  "use step";
  return runOwnerHandover(ticketId, token, { env: process.env });
}
resumeOwnerHandoverStep.maxRetries = 0;
