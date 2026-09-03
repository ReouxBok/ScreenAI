"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireApiStaff } from "@/lib/auth";
import { publishOnboardingTemplate, saveOnboardingTemplateDraft } from "@/lib/onboarding-template";

export async function saveOnboardingTemplateAction(form: FormData) {
  const staff = await requireApiStaff();
  let definition: unknown;
  try {
    definition = JSON.parse(String(form.get("definition") || "{}"));
  } catch {
    throw new Error("INVALID_TEMPLATE_DEFINITION");
  }
  await saveOnboardingTemplateDraft(definition, staff.email, String(form.get("changeNote") || ""));
  revalidatePath("/studio/trame");
  redirect("/studio/trame?saved=1");
}

export async function publishOnboardingTemplateAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  await publishOnboardingTemplate(String(form.get("versionId") || ""), staff.email);
  revalidatePath("/studio/trame");
  revalidatePath("/studio");
  redirect("/studio/trame?published=1");
}
