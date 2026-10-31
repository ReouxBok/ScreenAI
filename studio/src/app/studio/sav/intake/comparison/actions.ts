"use server";
import { revalidatePath } from "next/cache";
import { attestIntakeComparison, runIntakeComparisonOperator } from "@/lib/sav/intake/comparison-operator";
export type ComparisonActionState = { ok: boolean; message: string; code?: string };
export async function runComparisonAction(_previous: ComparisonActionState, form: FormData): Promise<ComparisonActionState> {
  try {
    const batch = await runIntakeComparisonOperator({ stage: String(form.get("stage") ?? ""), expectedMessageId: String(form.get("expectedMessageId") ?? ""), expectedCampaignId: String(form.get("expectedCampaignId") ?? ""), reviewed: form.get("reviewed") === "confirmed" });
    revalidatePath("/studio/sav/intake/comparison");
    return { ok: true, message: "Requête terminée. Vérifiez les résultats dans le rapport avant de poursuivre.", ...("skipped" in batch ? { code: "SAV_INTAKE_COMPARISON_OFF" } : {}) };
  } catch (error) {
    return { ok: false, message: "Le lot n’a pas été relancé automatiquement. Consultez le rapport et le diagnostic.",
      code: error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_COMPARISON_COMMAND_FAILED" };
  }
}
export async function attestComparisonAction(_previous: ComparisonActionState, form: FormData): Promise<ComparisonActionState> {
  try {
    await attestIntakeComparison({ kind: "attestation", expectedCampaignId: String(form.get("expectedCampaignId") ?? ""), messageId: String(form.get("messageId") ?? ""),
      receiptSha256: String(form.get("receiptSha256") ?? ""), oracleSha256: String(form.get("oracleSha256") ?? "").trim().toLowerCase(),
      outcome: String(form.get("outcome") ?? ""), confirmed: form.get("confirmed") === "confirmed" });
    revalidatePath("/studio/sav/intake/comparison");
    return { ok: true, message: "Attestation enregistrée. Elle ne lance aucune comparaison." };
  } catch (error) {
    return { ok: false, message: "Attestation refusée : aucune donnée n’a été modifiée.",
      code: error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_COMPARISON_INVALID_COMMAND" };
  }
}
