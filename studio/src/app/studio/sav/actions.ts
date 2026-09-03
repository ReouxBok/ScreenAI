"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { start } from "workflow/api";
import { requireApiStaff } from "@/lib/auth";
import { continueHubspotBackfill } from "@/lib/sav/hubspot";
import { approveLearningCandidate, rejectLearningCandidate } from "@/lib/sav/learning";
import {
  approveSavDraft,
  cancelSavPilotBatch,
  correctSavDecision,
  queueSavTicketCreation,
  requestHumanIntervention,
  retrySavAction,
  retrySavWebhookReceipt,
  reviewSavPilotItem,
  startSavPilotBatch,
} from "@/lib/sav/service";
import { analyzeSavPilotBatchWorkflow } from "@/workflows/sav-pilot";

function id(form: FormData, name: string) {
  const value = String(form.get(name) || "").trim();
  if (!value) throw new Error(`${name.toUpperCase()}_REQUIRED`);
  return value;
}

async function enqueuePilotBatch(batchId: string, actorEmail: string) {
  let launch: "instant" | "deferred" = "instant";
  try {
    const run = await start(analyzeSavPilotBatchWorkflow, [batchId]);
    console.info("sav_pilot_workflow_enqueued", { batchId, runId: run.runId, actorEmail });
  } catch (error) {
    launch = "deferred";
    console.error("sav_pilot_workflow_enqueue_failed", {
      batchId,
      actorEmail,
      errorCode: error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN_ERROR",
    });
  }
  return launch;
}

export async function requestHumanAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  await requestHumanIntervention(threadId, staff.email, String(form.get("reason") || "Reprise demandée par l’administrateur"));
  revalidatePath("/studio/sav");
  revalidatePath(`/studio/sav/${threadId}`);
}

export async function correctDecisionAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  await correctSavDecision(id(form, "decisionId"), {
    kind: String(form.get("kind")),
    reasonCode: String(form.get("reasonCode")),
    explanation: String(form.get("explanation")),
  }, staff.email);
  revalidatePath("/studio/sav");
  revalidatePath(`/studio/sav/${threadId}`);
}

export async function createTicketAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  await queueSavTicketCreation(threadId, staff.email);
  revalidatePath("/studio/sav");
  revalidatePath(`/studio/sav/${threadId}`);
}

export async function approveDraftAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  await approveSavDraft(id(form, "draftActionId"), staff.email);
  revalidatePath(`/studio/sav/${threadId}`);
}

export async function retryAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  await retrySavAction(id(form, "actionId"), staff.email);
  revalidatePath(`/studio/sav/${threadId}`);
}

export async function retryWebhookAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  await retrySavWebhookReceipt(id(form, "receiptId"), staff.email);
  revalidatePath("/studio/sav");
}

export async function startPilotBatchAction() {
  const staff = await requireApiStaff("admin");
  const batch = await startSavPilotBatch(staff.email, 10);
  const launch = await enqueuePilotBatch(batch.id, staff.email);
  revalidatePath("/studio/sav");
  redirect(`/studio/sav?batch=${batch.id}&launch=${launch}`);
}

export async function startSelectedPilotBatchAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const messageIds = [...new Set(form.getAll("messageIds").map(String).map((value) => value.trim()).filter(Boolean))];
  if (messageIds.length !== 10) redirect("/studio/sav/pilote?error=select_10");
  let batch: Awaited<ReturnType<typeof startSavPilotBatch>> | null = null;
  let errorCode = "";
  try {
    batch = await startSavPilotBatch(staff.email, messageIds);
  } catch (error) {
    errorCode = error instanceof Error ? error.message : "SAV_PILOT_START_FAILED";
  }
  if (!batch) redirect(`/studio/sav/pilote?error=${errorCode === "SAV_PILOT_SELECTION_STALE" ? "selection_stale" : "start_failed"}`);
  const launch = await enqueuePilotBatch(batch.id, staff.email);
  revalidatePath("/studio/sav");
  revalidatePath("/studio/sav/pilote");
  redirect(`/studio/sav/pilote?batch=${batch.id}&launch=${launch}`);
}

export async function cancelPilotBatchAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  await cancelSavPilotBatch(
    id(form, "pilotBatchId"),
    staff.email,
    String(form.get("reason") || "Batch invalide : relance demandée après audit"),
  );
  revalidatePath("/studio/sav");
  redirect("/studio/sav?batchCancelled=1");
}

export async function cancelPilotBatchLabAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  await cancelSavPilotBatch(
    id(form, "pilotBatchId"),
    staff.email,
    String(form.get("reason") || "Batch annulé depuis le laboratoire SAV"),
  );
  revalidatePath("/studio/sav");
  revalidatePath("/studio/sav/pilote");
  redirect("/studio/sav/pilote?batchCancelled=1");
}

export async function reviewPilotItemAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  await reviewSavPilotItem(id(form, "pilotItemId"), {
    verdict: String(form.get("verdict")),
    feedbackCodes: form.getAll("feedbackCodes").map(String),
    comment: String(form.get("comment") || ""),
    correctedDraft: String(form.get("correctedDraft") || ""),
  }, staff.email);
  revalidatePath("/studio/sav");
  revalidatePath("/studio/sav/pilote");
  revalidatePath(`/studio/sav/${threadId}`);
  if (String(form.get("returnTo")) === "pilot") redirect(`/studio/sav/pilote?batch=${encodeURIComponent(String(form.get("pilotBatchId") || ""))}#batch-review`);
}

export async function continueBackfillAction() {
  await requireApiStaff("admin");
  const result = await continueHubspotBackfill(1);
  revalidatePath("/studio/sav");
  revalidatePath("/studio/sav/resolutions");
  redirect(`/studio/sav/resolutions?backfill=${"blocked" in result && result.blocked ? "permission_required" : result.complete ? "complete" : "continued"}`);
}

export async function reviewLearningAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const candidateId = id(form, "candidateId");
  const decision = String(form.get("decision"));
  if (decision === "approve") await approveLearningCandidate(candidateId, staff.email);
  else if (decision === "reject") await rejectLearningCandidate(candidateId, staff.email);
  else throw new Error("INVALID_LEARNING_DECISION");
  revalidatePath("/studio/sav");
  revalidatePath("/studio/sav/resolutions");
  revalidatePath("/studio/contenus");
}
