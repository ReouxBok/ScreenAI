"use server";
import { revalidatePath } from "next/cache";
import { runIntakeComparisonOperator } from "@/lib/sav/intake/comparison-operator";
export type ComparisonActionState = { ok: boolean; message: string; code?: string };
export async function runComparisonAction(_previous: ComparisonActionState, form: FormData): Promise<ComparisonActionState> {
  try {
    const batch = await runIntakeComparisonOperator({ stage: String(form.get("stage") ?? ""), reviewed: form.get("reviewed") === "confirmed" });
    revalidatePath("/studio/sav/intake/comparison");
    return { ok: true, message: "Requête terminée. Vérifiez les résultats dans le rapport avant de poursuivre.", ...("skipped" in batch ? { code: "SAV_INTAKE_COMPARISON_OFF" } : {}) };
  } catch (error) {
    return { ok: false, message: "Le lot n’a pas été relancé automatiquement. Consultez le rapport et le diagnostic.",
      code: error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_COMPARISON_COMMAND_FAILED" };
  }
}
