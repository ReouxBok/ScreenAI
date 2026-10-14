"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { prepareSavManualTicketPreview, readSavTicketPreviewToken, readSavManualTicketPreviewContext } from "@/lib/sav/manual-ticket-preview";
import { queueSavManualTicket } from "@/lib/sav/manual-tickets";
import { savReleaseStage } from "@/lib/sav/config";
import { savManualTicketError } from "@/lib/sav/manual-ticket-status";

function errorMessage(error: unknown) {
  return savManualTicketError(error instanceof Error ? error.message : null);
}
export async function prepareTicketPreviewAction(input: { threadId: string; reviewId: string; ticketId?: string; distinctIssueReason: string }) {
  const staff = await requireSavApiStaff("admin");
  try {
    if (savReleaseStage() !== "v0") throw new Error("SAV_MANUAL_TICKET_INVALID");
    const threadId = z.uuid().parse(input.threadId);
    return { preview: await prepareSavManualTicketPreview({ ...input, threadId }, staff.email), error: null };
  } catch (error) { return { preview: null, error: errorMessage(error) }; }
}
export async function confirmTicketPreviewAction(token: string) {
  const staff = await requireSavApiStaff("admin");
  try {
    if (savReleaseStage() !== "v0") throw new Error("SAV_MANUAL_TICKET_INVALID");
    const signed = readSavTicketPreviewToken(z.string().max(40_000).parse(token), staff.email);
    const context = await readSavManualTicketPreviewContext(signed.command.threadId);
    if (context.crm.status !== "ready") throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
    const action = await queueSavManualTicket({ ...signed.command, previewToken: token }, staff.email, context);
    revalidatePath("/studio/sav");
    revalidatePath(`/studio/sav/${signed.command.threadId}`);
    return { actionId: action.id, error: null };
  } catch (error) { return { actionId: null, error: errorMessage(error) }; }
}
