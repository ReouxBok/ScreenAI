"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { recordSavDossierOpened, recordSavEmailOpened } from "@/lib/sav/opened-email";
import { savDashboardReturnHref } from "@/lib/sav/dashboard-state";
import { enqueueSavContextRefresh } from "@/lib/sav/dispatch";

export async function openSavEmailAction(form: FormData) {
  const staff = await requireSavApiStaff("admin");
  const threadId = z.uuid().parse(form.get("threadId"));
  const messageId = z.uuid().parse(form.get("messageId"));
  let refreshId = "";
  try { refreshId = await enqueueSavContextRefresh(threadId,staff.email); }
  catch { /* Enrichment failure must not prevent reading the dossier. */ }
  let notice = "SAV_GMAIL_FILING_FAILED";
  try { notice = (await recordSavEmailOpened({ threadId, messageId }, staff.email)).notice; }
  catch { /* Reading the dossier remains possible even when filing is unavailable. */ }
  revalidatePath("/studio/sav");
  revalidatePath(`/studio/sav/${threadId}`);
  const returnTo = savDashboardReturnHref(form.get("returnTo"));
  const contextQuery = refreshId ? `context=refreshing&refreshId=${refreshId}` : "context=failed";
  redirect(`/studio/sav/${threadId}?filing=${encodeURIComponent(notice)}&${contextQuery}&returnTo=${encodeURIComponent(returnTo)}`);
}

export async function recordSavDossierOpenedAction(threadId: string, messageId: string) {
  const staff = await requireSavApiStaff("admin");
  try {
    await recordSavDossierOpened({ threadId, messageId }, staff.email);
    revalidatePath("/studio/sav");
    return { ok: true };
  } catch { return { ok: false }; }
}
