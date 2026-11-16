"use server";
import { redirect } from "next/navigation";
import { savBlockBriefFromForm, validateSavBlockBrief } from "@/lib/sav/blocks/block-brief";
import { saveSavBlockBuilder, savBlockBuilderAdministrator } from "@/lib/sav/blocks/block-builder-admin";

export async function saveBlockBriefAction(form: FormData) {
  await savBlockBuilderAdministrator();
  const brief = savBlockBriefFromForm(form);
  const prepare = form.get("intent") === "prepare";
  // Save unfinished work and show actionable reasons; never advance a failed check.
  const accepted = prepare && validateSavBlockBrief(brief).ok;
  await saveSavBlockBuilder(brief, accepted);
  redirect(`/studio/sav/blocs/assistant?bloc=${encodeURIComponent(brief.blockId)}&result=${prepare ? accepted ? "prepared" : "blocked" : "saved"}`);
}
