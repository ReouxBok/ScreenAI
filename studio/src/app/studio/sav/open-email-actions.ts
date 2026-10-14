"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { recordSavDossierOpened, recordSavEmailOpened } from "@/lib/sav/opened-email";
import { savDashboardReturnHref } from "@/lib/sav/dashboard-state";
import { collectLatestSavDossierContext } from "@/lib/sav/dossier-context";

export async function openSavEmailAction(form: FormData) {
  const staff = await requireSavApiStaff("admin");
  const threadId = z.uuid().parse(form.get("threadId"));
  const messageId = z.uuid().parse(form.get("messageId"));
  let context = "refreshed";
  try {
    const dossier = await collectLatestSavDossierContext(threadId);
    if (dossier.crm.status !== "ready") context = "failed";
  } catch {
    context = "failed";
  }
  let notice = "SAV_GMAIL_FILING_FAILED";
  try { notice = (await recordSavEmailOpened({ threadId, messageId }, staff.email)).notice; }
  catch { /* Reading the dossier remains possible even when filing is unavailable. */ }
  revalidatePath("/studio/sav");
  revalidatePath(`/studio/sav/${threadId}`);
  const returnTo = savDashboardReturnHref(form.get("returnTo"));
  redirect(`/studio/sav/${threadId}?filing=${encodeURIComponent(notice)}&context=${context}&returnTo=${encodeURIComponent(returnTo)}`);
}

export async function recordSavDossierOpenedAction(threadId: string, messageId: string) {
  const staff = await requireSavApiStaff("admin");
  try {
    await recordSavDossierOpened({ threadId, messageId }, staff.email);
    revalidatePath("/studio/sav");
    return { ok: true };
  } catch { return { ok: false }; }
}
