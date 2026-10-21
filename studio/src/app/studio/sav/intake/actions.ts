"use server";
import { revalidatePath } from "next/cache";
import { recordIntakeHumanCommand } from "@/lib/sav/intake/human-commands";
export type IntakeChoiceFormState = { ok: boolean; message: string };
export async function saveIntakeChoice(_previous: IntakeChoiceFormState, form: FormData): Promise<IntakeChoiceFormState> {
  const text = (key: string) => typeof form.get(key) === "string" ? String(form.get(key)) : "";
  const kind = text("kind");
  try {
    const result = await recordIntakeHumanCommand({ commandKey: text("commandKey"), threadId: text("threadId"), messageId: text("messageId"),
      runId: text("runId"), version: Number(text("version")), sourceHash: text("sourceHash"), candidatesHash: text("candidatesHash"), kind,
      ...(kind === "select" && text("contactId") ? { contactId: text("contactId") } : {}),
      ...(kind === "select" && text("ticketId") ? { ticketId: text("ticketId") } : {}),
      ...(kind === "classify" ? { classification: text("classification") } : {}), reason: text("reason") });
    revalidatePath(`/studio/sav/intake/${text("threadId")}`);
    revalidatePath("/studio/sav/intake");
    return { ok: true, message: result.status === "recorded" ? kind === "refuse"
      ? "Refus enregistré. La proposition reste arrêtée ; les éventuels résultats externes en cours seront rapprochés."
      : "Choix enregistré. Le worker doit revalider les preuves avant toute reprise." : "Choix conservé." };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return { ok: false, message: code === "SAV_INTAKE_HUMAN_CONFLICT"
      ? "Le dossier a changé ou un choix existe déjà. Rechargez sa dernière version avant de corriger."
      : code === "SAV_INTAKE_SEMANTIC_PROVENANCE_MISSING"
      ? "Cette analyse ne conserve pas les résultats validés nécessaires à une reprise. Une réinvestigation est requise."
      : "Le choix n’a pas été enregistré. Vérifiez votre accès, le motif et la version courante." };
  }
}
