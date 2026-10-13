"use server";

import { revalidatePath } from "next/cache";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { prepareSavPartnershipForward, queueSavPartnershipForward, type SavPartnershipPreview } from "@/lib/sav/partnership-forward";
import { processPendingGmailSendActions } from "@/lib/sav/gmail";

const safeError = (error: unknown) => error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_PARTNERSHIP_INVALID";

export async function preparePartnershipTransferAction(threadId: string): Promise<{ preview: SavPartnershipPreview; error?: never } | { error: string; preview?: never }> {
  const staff = await requireSavApiStaff();
  try { return { preview: await prepareSavPartnershipForward(threadId, staff.email) }; }
  catch (error) { return { error: safeError(error) }; }
}

export async function confirmPartnershipTransferAction(token: string): Promise<{ status: "succeeded" | "pending" | "failed"; error?: string }> {
  const staff = await requireSavApiStaff();
  try {
    const action = await queueSavPartnershipForward(token, staff.email);
    const result = action.status === "succeeded" ? { status: "succeeded" as const }
      : (await processPendingGmailSendActions(1, action.id)).processed[0];
    revalidatePath(`/studio/sav/${action.threadId}`);
    revalidatePath("/studio/sav");
    return { status: result?.status === "succeeded" ? "succeeded" : result?.status === "failed" || result?.status === "cancelled" ? "failed" : "pending",
      ...(typeof result?.errorCode === "string" ? { error: result.errorCode } : {}) };
  } catch (error) { return { status: "failed", error: safeError(error) }; }
}
