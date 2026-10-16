"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { triageSavLearningSignal } from "@/lib/sav/learning-signals";
export async function triageLearningSignal(form: FormData) {
  const staff = await requireSavApiStaff();
  const decision = String(form.get("decision"));
  if (decision !== "prepare" && decision !== "reject") throw new Error("INVALID_ACTION");
  const result = await triageSavLearningSignal({ groupId: String(form.get("groupId")), decision }, staff.email);
  revalidatePath("/studio/sav/connaissances/apprentissage");
  if (result.draftId) redirect(`/studio/sav/connaissances/proposer?draft=${result.draftId}`);
}
