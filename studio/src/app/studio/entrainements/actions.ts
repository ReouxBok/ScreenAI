"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireApiStaff } from "@/lib/auth";
import { assertManageableTraining, convertTrainingToContent, createTraining, deleteTraining, recoverUploadedTraining, restartTraining, updateTraining } from "@/lib/training";

export type TrainingConversionState = { error?: string };

export async function createTrainingAction(form: FormData) {
  const staff = await requireApiStaff();
  const { session, token } = await createTraining({ title: String(form.get("title")), goal: String(form.get("goal")), agentKey: String(form.get("agentKey")), startPath: String(form.get("startPath") || "/") }, staff.email);
  revalidatePath("/studio/entrainements");
  redirect(`/studio/entrainements/${session.id}?token=${encodeURIComponent(token)}`);
}

export async function restartTrainingAction(form: FormData) {
  const staff = await requireApiStaff();
  const sessionId = String(form.get("sessionId"));
  await assertManageableTraining(sessionId, staff);
  const { session, token } = await restartTraining(sessionId, staff.email);
  revalidatePath("/studio/entrainements");
  redirect(`/studio/entrainements/${session.id}?token=${encodeURIComponent(token)}&restarted=1`);
}

export async function deleteTrainingAction(form: FormData) {
  const staff = await requireApiStaff();
  const sessionId = String(form.get("sessionId"));
  await assertManageableTraining(sessionId, staff);
  await deleteTraining(sessionId, staff.email);
  revalidatePath("/studio/entrainements");
  redirect("/studio/entrainements?deleted=1");
}

export async function recoverTrainingAction(form: FormData) {
  const staff = await requireApiStaff();
  const sessionId = String(form.get("sessionId"));
  await assertManageableTraining(sessionId, staff);
  await recoverUploadedTraining(sessionId, staff.email);
  revalidatePath("/studio/entrainements");
  revalidatePath(`/studio/entrainements/${sessionId}`);
  redirect(`/studio/entrainements/${sessionId}?recovered=1`);
}

export async function updateTrainingAction(form: FormData) {
  const staff = await requireApiStaff();
  const sessionId = String(form.get("sessionId"));
  await assertManageableTraining(sessionId, staff);
  await updateTraining(sessionId, {
    title: String(form.get("title") ?? ""),
    goal: String(form.get("goal") ?? ""),
    agentKey: String(form.get("agentKey") ?? ""),
    startPath: String(form.get("startPath") ?? "/"),
  }, staff.email);
  revalidatePath("/studio/entrainements");
  revalidatePath(`/studio/entrainements/${sessionId}`);
  redirect(`/studio/entrainements/${sessionId}?updated=1`);
}

export async function convertTrainingAction(_previousState: TrainingConversionState, form: FormData): Promise<TrainingConversionState> {
  const staff = await requireApiStaff();
  const sessionId = String(form.get("sessionId"));
  await assertManageableTraining(sessionId, staff);
  let itemId: string;
  try {
    itemId = await convertTrainingToContent(sessionId, staff.email);
  } catch (error) {
    console.error("training_conversion_failed", {
      sessionId,
      code: error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN_ERROR",
    });
    return { error: "Le parcours n’a pas pu être créé. Rien n’a été perdu : réessaie dans quelques instants." };
  }
  revalidatePath("/studio/entrainements");
  revalidatePath("/studio/contenus");
  redirect(`/studio/contenus/${itemId}`);
}
