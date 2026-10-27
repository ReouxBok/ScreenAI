"use server";
import { revalidatePath } from "next/cache";
import { setIntakeDailyBudget } from "@/lib/sav/intake/budget-admin";
import { parseUsdToNano } from "@/lib/sav/intake/budget-amount";
export type BudgetAdminState = { ok: boolean; message: string; code?: string };
const text = (form: FormData, key: string) => typeof form.get(key) === "string" ? String(form.get(key)).trim() : "";
export async function setBudgetAction(_previous: BudgetAdminState, form: FormData): Promise<BudgetAdminState> {
  try {
    const reset = text(form, "mode") === "reset";
    await setIntakeDailyBudget({ maxNanoUsd: reset ? null : parseUsdToNano(text(form, "usd")), reason: text(form, "reason") });
    revalidatePath("/studio/sav/intake/budget");
    return { ok: true, message: reset ? "Plafond quotidien revenu à la valeur de la configuration." : "Plafond quotidien enregistré. Il s’applique dès le prochain dossier, sans redéploiement." };
  } catch (error) {
    const code = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_INTAKE_BUDGET_INVALID_COMMAND";
    return { ok: false, message: "Le changement a été refusé. Vérifiez le montant (2 décimales maximum, dans la limite affichée) et le motif.", code };
  }
}
