"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { recordSavEmailOpened } from "@/lib/sav/opened-email";

export async function openSavEmailAction(form: FormData) {
  const staff = await requireSavApiStaff("admin");
  const threadId = z.uuid().parse(form.get("threadId"));
  const messageId = z.uuid().parse(form.get("messageId"));
  let notice = "SAV_GMAIL_FILING_FAILED";
  try { notice = (await recordSavEmailOpened({ threadId, messageId }, staff.email)).notice; }
  catch { /* Reading the dossier remains possible even when filing is unavailable. */ }
  revalidatePath("/studio/sav");
  redirect(`/studio/sav/${threadId}?filing=${encodeURIComponent(notice)}`);
}
