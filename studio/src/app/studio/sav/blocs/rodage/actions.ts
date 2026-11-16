"use server";
import { redirect } from "next/navigation";
import { rodageAdministrator, rodageWindowSchema, saveRodageVerdict } from "@/lib/sav/blocks/block-rodage";

export async function saveRodageVerdictAction(form: FormData) {
  await rodageAdministrator();
  const window = rodageWindowSchema.parse({ blockId: form.get("blockId"), from: form.get("from"), to: form.get("to") });
  await saveRodageVerdict({ blockId: window.blockId, caseId: form.get("caseId"), draftId: form.get("draftId"),
    verdict: form.get("verdict"), category: form.get("category") || null, reason: form.get("reason") ?? "" }, window);
  redirect(`/studio/sav/blocs/rodage?${new URLSearchParams({ bloc: window.blockId, from: window.from, to: window.to, saved: "1" })}`);
}
