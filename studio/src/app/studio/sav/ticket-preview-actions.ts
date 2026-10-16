"use server";

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { revalidatePath } from "next/cache";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { prepareSavManualTicketPreview, readSavTicketPreviewToken, readSavManualTicketPreviewContext } from "@/lib/sav/manual-ticket-preview";
import { queueSavManualTicket } from "@/lib/sav/manual-tickets";
import { savReleaseStage } from "@/lib/sav/config";
import { savManualTicketError } from "@/lib/sav/manual-ticket-status";
import { dispatchSavTicketCommand } from "@/lib/sav/dispatch";
import { processManualSavTicketActionImmediately } from "@/lib/sav/hubspot";

function errorMessage(error: unknown) {
  return savManualTicketError(error instanceof Error ? error.message : null);
}
async function recordInteraction(actorEmail: string, requestId: string, phase: "preview" | "confirm", result: "requested" | "succeeded" | "refused", threadId?: string, actionId?: string, error?: unknown) {
  const code = error instanceof Error && /^(?:SAV_|HUBSPOT_HTTP_)\w+$/.test(error.message) ? error.message : error ? "SAV_MANUAL_TICKET_INVALID" : null;
  try {
    await requireDb().insert(auditLogs).values({ actorEmail, action: `sav_ticket_${phase}_${result}`, entityType:"sav_ticket_interaction", entityId:requestId,
      technicalMetadata:{ phase, result, ...(threadId && z.uuid().safeParse(threadId).success ? {threadId} : {}), ...(actionId ? {actionId} : {}), errorCode:code } });
  } catch { console.error("sav_ticket_interaction_audit_unavailable", { requestId, phase, result }); }
}
export async function prepareTicketPreviewAction(input: { threadId: string; reviewId: string; ticketId?: string; distinctIssueReason: string }) {
  const staff = await requireSavApiStaff("admin");
  const requestId = randomUUID();
  await recordInteraction(staff.email, requestId, "preview", "requested", input.threadId);
  try {
    if (savReleaseStage() !== "v0") throw new Error("SAV_MANUAL_TICKET_INVALID");
    const threadId = z.uuid().parse(input.threadId);
    const preview = await prepareSavManualTicketPreview({ ...input, threadId }, staff.email);
    await recordInteraction(staff.email, requestId, "preview", "succeeded", threadId);
    return { preview, error: null };
  } catch (error) {
    await recordInteraction(staff.email, requestId, "preview", "refused", input.threadId, undefined, error);
    return { preview: null, error: errorMessage(error) };
  }
}
export async function confirmTicketPreviewAction(token: string) {
  const staff = await requireSavApiStaff("admin");
  const requestId = randomUUID();
  let threadId: string | undefined;
  await recordInteraction(staff.email, requestId, "confirm", "requested");
  try {
    if (savReleaseStage() !== "v0") throw new Error("SAV_MANUAL_TICKET_INVALID");
    const signed = readSavTicketPreviewToken(z.string().max(40_000).parse(token), staff.email);
    threadId = signed.command.threadId;
    const context = await readSavManualTicketPreviewContext(signed.command.threadId);
    if (context.crm.status !== "ready") throw new Error("SAV_TICKET_RETURN_CONTEXT_CHANGED");
    const action = await queueSavManualTicket({ ...signed.command, previewToken: token }, staff.email, context);
    await recordInteraction(staff.email, requestId, "confirm", "succeeded", threadId, action.id);
    let result: Awaited<ReturnType<typeof processManualSavTicketActionImmediately>> | { status: "deferred" };
    try {
      result = await processManualSavTicketActionImmediately(action.id);
    } catch {
      // The command is already durable. Do not ask the user to submit it again.
      result = { status: "deferred" };
    }
    if (result.status === "pending" || result.status === "deferred") await dispatchSavTicketCommand(action.id);
    revalidatePath("/studio/sav");
    revalidatePath(`/studio/sav/${signed.command.threadId}`);
    return { actionId: action.id, status: result.status, error: result.status === "failed" ? savManualTicketError(result.errorCode) : null };
  } catch (error) {
    await recordInteraction(staff.email, requestId, "confirm", "refused", threadId, undefined, error);
    return { actionId: null, status: "failed" as const, error: errorMessage(error) }; }
}
