"use server";
import { revalidatePath } from "next/cache";
import { classifyValidSourceAsOther } from "@/lib/sav/intake/manual-other-classification";
import type { IntakeChoiceFormState } from "./actions";

export async function classifyManualOtherAction(_previous: IntakeChoiceFormState, form: FormData): Promise<IntakeChoiceFormState> {
  try {
    const result = await classifyValidSourceAsOther({ revision: form.get("revision"), requestKey: form.get("requestKey"),
      threadId: form.get("threadId"), messageId: form.get("messageId"), runId: form.get("runId"), version: Number(form.get("version")),
      runSourceHash: form.get("runSourceHash") || null, sourceHash: form.get("sourceHash"), expectedEpoch: Number(form.get("expectedEpoch")),
      reason: form.get("reason"), confirmed: form.get("confirmed") === "on" });
    if (!result.marked && !result.alreadyCompleted) return { ok: false, message: result.skipped.active_worker
      ? "Un traitement est encore en cours. Attendez sa fin et rechargez le dossier."
      : "Classement refusé : le dossier a changé, une pause ou une action reste à vérifier, ou une demande sensible est connue. Rechargez les sources." };
    revalidatePath(`/studio/sav/intake/${String(form.get("threadId"))}`);
    revalidatePath("/studio/sav/intake");
    return { ok: true, message: "Message classé dans Autres sur votre décision. Aucun verdict IA, mail envoyé ou modification HubSpot. Une nouvelle réponse reviendra dans le flux." };
  } catch { return { ok: false, message: "Impossible de confirmer le résultat du classement. Rechargez le dossier pour vérifier sa vue avant tout nouvel essai. Cette commande ne déclenche aucune action externe." }; }
}
