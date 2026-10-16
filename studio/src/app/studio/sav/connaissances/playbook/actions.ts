"use server";
import { revalidatePath } from "next/cache";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { activateSavPlaybook, getSavPlaybookWorkspace, reviewSavPlaybook, saveSavPlaybook } from "@/lib/sav/playbook";

export async function changeSavPlaybook(input: { action: "save" | "review" | "activate"; document?: unknown; prompt?: string; versionId?: string; expectedDraftId?: string | null; expectedActiveId?: string | null }) {
  const staff = await requireSavApiStaff();
  try {
    if (input.action === "save") await saveSavPlaybook({ document: input.document, prompt: input.prompt, expectedDraftId: input.expectedDraftId ?? null }, staff.email);
    else if (input.action === "review" && input.versionId) await reviewSavPlaybook({ versionId: input.versionId }, staff.email);
    else if (input.action === "activate" && input.versionId) await activateSavPlaybook({ versionId: input.versionId, expectedActiveId: input.expectedActiveId ?? null }, staff.email);
    else throw new Error("INVALID_ACTION");
    revalidatePath("/studio/sav/connaissances/playbook");
    return { workspace: await getSavPlaybookWorkspace(staff.email), error: null };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return { workspace: null, error: code === "SAV_PLAYBOOK_STALE" ? "Une autre modification a été enregistrée. Rechargez la page avant de continuer."
      : code === "SAV_PLAYBOOK_ACCESS_FORBIDDEN" ? "La gestion du master prompt est réservée à Ugo et contact."
      : code === "SAV_PLAYBOOK_REVIEW_REQUIRED" ? "Relisez et validez cette version avant de l’activer."
      : "L’action n’a pas abouti. Vérifiez les champs, les clés uniques et la longueur du master prompt. Votre saisie est conservée." };
  }
}
