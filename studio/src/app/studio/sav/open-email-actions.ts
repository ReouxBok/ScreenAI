"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { recordSavDossierOpened } from "@/lib/sav/opened-email";
import { requestSavEmailOpening } from "@/lib/sav/email-opening-command";
import { savDashboardReturnHref } from "@/lib/sav/dashboard-state";
import { enqueueSavContextRefresh, dispatchSavEmailOpening } from "@/lib/sav/dispatch";

export async function openSavEmailAction(form: FormData) {
  const staff = await requireSavApiStaff("admin");
  const threadId = z.uuid().parse(form.get("threadId"));
  const messageId = z.uuid().parse(form.get("messageId"));
  let refreshId = "";
  try { refreshId = await enqueueSavContextRefresh(threadId,staff.email,after); }
  catch { /* Enrichment failure must not prevent reading the dossier. */ }
  let notice = "SAV_GMAIL_FILING_FAILED", commandId = "";
  try {
    const command = await requestSavEmailOpening({ threadId, messageId }, staff.email);
    notice = command.notice; commandId = command.commandId;
    after(async () => { await dispatchSavEmailOpening(command.commandId); });
  }
  catch { /* Reading the dossier remains possible even when filing is unavailable. */ }
  revalidatePath("/studio/sav");
  revalidatePath(`/studio/sav/${threadId}`);
  const returnTo = savDashboardReturnHref(form.get("returnTo"));
  const contextQuery = refreshId ? `context=refreshing&refreshId=${refreshId}` : "context=failed";
  redirect(`/studio/sav/${threadId}?filing=${encodeURIComponent(notice)}${commandId ? `&filingId=${commandId}` : ""}&${contextQuery}&returnTo=${encodeURIComponent(returnTo)}`);
}

export async function recordSavDossierOpenedAction(threadId: string, messageId: string) {
  const staff = await requireSavApiStaff("admin");
  try {
    const result = await recordSavDossierOpened({ threadId, messageId }, staff.email);
    if (result.changed) revalidatePath("/studio/sav");
    return { ok: true };
  } catch { return { ok: false }; }
}
