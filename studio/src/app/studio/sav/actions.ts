"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { start } from "workflow/api";
import { requireSavApiStaff as requireApiStaff } from "@/lib/sav/auth";
import { continueHubspotBackfill, reconcileSavManualTicket } from "@/lib/sav/hubspot";
import { approveLearningCandidate, rejectLearningCandidate } from "@/lib/sav/learning";
import {
  approveSavDraft,
  cancelSavPilotBatch,
  correctSavDecision,
  requestHumanIntervention,
  retrySavAction,
  retrySavWebhookReceipt,
  reviewSavPilotItem,
  startSavPilotBatch,
} from "@/lib/sav/service";
import { analyzeSavPilotBatchWorkflow } from "@/workflows/sav-pilot";
import { reviewKnowledgeCandidate } from "@/lib/knowledge/review";
import { HUBSPOT_IMPORT_MAX_BYTES } from "@/lib/knowledge/hubspot-input";
import { importHubspotKnowledge, prepareHubspotReview } from "@/lib/knowledge/hubspot-import";
import { assertKnowledgeUgoApproval } from "@/lib/knowledge/contracts";
import { requireDb } from "@/db";
import { knowledgeProjectionCandidates } from "@/db/schema";
import { eq } from "drizzle-orm";
import { proposeSavFromOnboarding } from "@/lib/knowledge/candidates";
import { reviewSavProposal } from "@/lib/sav/review";
import { queueSavManualTicket } from "@/lib/sav/manual-tickets";
import { retrySavAnalysis, repairSavProposal } from "@/lib/sav/service";
import { collectSavDossierContext } from "@/lib/sav/dossier-context";
import { saveSavReplyDraft } from "@/lib/sav/drafts";
import { assertSavManualReplyEnabled, queueSavManualReply } from "@/lib/sav/manual-replies";
import { processPendingGmailSendActions } from "@/lib/sav/gmail";
import { recordSavDeploymentDecision } from "@/lib/sav/metrics";
import { createReviewedSavReplay, runReviewedSavRuleReplay } from "@/lib/sav/reviewed-replay";

async function evaluationAction(operation: () => Promise<unknown>, success: string) {
  let result = success;
  try { await operation(); } catch (error) { result = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_EVALUATION_INVALID"; }
  revalidatePath("/studio/sav/evaluation");
  redirect(`/studio/sav/evaluation?origin=all&notice=${result}`);
}

export async function recordDeploymentDecisionAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  await evaluationAction(() => recordSavDeploymentDecision({ snapshotHash: String(form.get("snapshotHash")), versionId: String(form.get("versionId")), decision: String(form.get("decision")), reason: String(form.get("reason") || "") }, staff.email), "decision_saved");
}
export async function approveReplayAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  await evaluationAction(() => createReviewedSavReplay({ reviewId: id(form, "reviewId"), title: String(form.get("title") || ""), scenario: String(form.get("scenario") || ""), expectedKind: String(form.get("expectedKind")), requiresHumanApproval: form.get("requiresHumanApproval") === "on", anonymizationConfirmed: form.get("anonymizationConfirmed") === "on" }, staff.email), "replay_saved");
}
export async function runReviewedReplayAction() {
  const staff = await requireApiStaff("admin");
  await evaluationAction(() => runReviewedSavRuleReplay(staff.email), "replay_done");
}

export async function saveReplyDraftAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let result = "draft_saved";
  try { await saveSavReplyDraft({ threadId, messageId: id(form, "messageId"), decisionId: id(form, "decisionId"), agentRunId: id(form, "agentRunId"),
    reviewId: String(form.get("reviewId") || "") || null, knowledgeRevision: String(form.get("knowledgeRevision") || "") || null,
    expectedDraftId: String(form.get("draftId") || "") || null, status: String(form.get("status") || "draft"), text: String(form.get("replyDraft") || form.get("text") || "") }, staff.email); }
  catch (error) { result = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_DRAFT_INVALID"; }
  revalidatePath(`/studio/sav/${threadId}`);
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${result}`);
}

export async function sendStudioReplyAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let result = "reply_queued";
  try {
    assertSavManualReplyEnabled();
    const draft = await saveSavReplyDraft({ threadId, messageId: id(form, "messageId"), decisionId: id(form, "decisionId"), agentRunId: id(form, "agentRunId"),
      reviewId: String(form.get("reviewId") || "") || null, knowledgeRevision: String(form.get("knowledgeRevision") || "") || null,
      expectedDraftId: String(form.get("draftId") || "") || null, status: "draft", text: String(form.get("replyDraft") || "") }, staff.email);
    const action = await queueSavManualReply({ threadId, draftId: draft.id }, staff.email);
    if (action.status === "succeeded") result = "reply_sent";
    else {
      const delivery = await processPendingGmailSendActions(1, action.id);
      const processed = delivery.processed[0];
      result = processed?.status === "succeeded" ? "reply_sent" : typeof processed?.errorCode === "string" ? processed.errorCode : "reply_queued";
    }
  } catch (error) { result = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_REPLY_MANUAL_INVALID"; }
  revalidatePath(`/studio/sav/${threadId}`);
  revalidatePath("/studio/sav");
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${result}`);
}

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
  let errorCode = "";
  try { await queueSavManualTicket({ threadId, reviewId: id(form, "reviewId"), kind: "create_ticket", distinctIssueReason: String(form.get("distinctIssueReason") || "") }, staff.email); }
  catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "SAV_MANUAL_TICKET_INVALID"; }
  revalidatePath("/studio/sav");
  revalidatePath(`/studio/sav/${threadId}`);
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${errorCode || "ticket_queued"}`);
}

export async function linkTicketAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let errorCode = "";
  try { await queueSavManualTicket({ threadId, reviewId: id(form, "reviewId"), kind: "link_ticket", ticketId: id(form, "ticketId") }, staff.email); }
  catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "SAV_MANUAL_TICKET_INVALID"; }
  revalidatePath("/studio/sav"); revalidatePath(`/studio/sav/${threadId}`);
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${errorCode || "ticket_queued"}`);
}

export async function retryAnalysisAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  await retrySavAnalysis(id(form, "messageId"), staff.email);
  revalidatePath("/studio/sav"); revalidatePath(`/studio/sav/${id(form, "threadId")}`);
}

export async function refreshSavContextAction(form: FormData) {
  await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let notice = "context_refreshed";
  try { await collectSavDossierContext(id(form, "messageId")); }
  catch { notice = "SAV_CONTEXT_REFRESH_FAILED"; }
  revalidatePath(`/studio/sav/${threadId}`);
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${notice}`);
}

export async function repairSavProposalAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let notice = "proposal_repaired";
  try { await repairSavProposal(id(form, "messageId"), staff.email); }
  catch (error) { notice = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_PROPOSAL_REPAIR_FAILED"; }
  revalidatePath("/studio/sav"); revalidatePath(`/studio/sav/${threadId}`);
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${notice}`);
}

export async function reconcileTicketAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let errorCode = "";
  try { await reconcileSavManualTicket(id(form, "actionId"), id(form, "ticketId"), staff.email, String(form.get("reason") || "")); }
  catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "SAV_RECONCILIATION_FAILED"; }
  revalidatePath("/studio/sav"); revalidatePath(`/studio/sav/${threadId}`);
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${errorCode || "ticket_reconciled"}`);
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
    dimensions: {
      classification: String(form.get("dimensionClassification")),
      routing: String(form.get("dimensionRouting")),
      grounding: String(form.get("dimensionGrounding")),
      tone: String(form.get("dimensionTone")),
      escalation: String(form.get("dimensionEscalation")),
    },
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

export async function previewHubspotReviewAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  assertKnowledgeUgoApproval(staff.email);
  try {
    const [candidate] = await requireDb().select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, id(form, "candidateId")));
    if (!candidate || candidate.status !== "pending" || candidate.targetSurface !== "sav" || candidate.revisionId !== id(form, "revisionId")) throw new Error("KNOWLEDGE_CANDIDATE_STALE");
    return { comparison: await prepareHubspotReview(candidate, JSON.parse(String(form.get("document")))), error: null };
  } catch (error) {
    return { comparison: null, error: error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "KNOWLEDGE_REVIEW_INVALID" };
  }
}

export async function reviewKnowledgeAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  let errorCode = "";
  try {
    const decision = String(form.get("decision"));
    if (decision !== "approve" && decision !== "reject") throw new Error("INVALID_LEARNING_DECISION");
    await reviewKnowledgeCandidate(id(form, "candidateId"), { expectedRevisionId: id(form, "revisionId"), decision, reason: String(form.get("reason") || ""), comparison: { snapshot: String(form.get("comparisonSnapshot") || ""), acknowledged: form.get("comparisonAcknowledged") === "on" }, ...(decision === "approve" ? { document: JSON.parse(String(form.get("document"))) } : {}) }, staff.email);
  } catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "KNOWLEDGE_REVIEW_INVALID"; }
  revalidatePath("/studio/sav/connaissances");
  redirect(`/studio/sav/connaissances?result=${errorCode || "draft_ready"}`);
}

export async function importOnboardingKnowledgeAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  let errorCode = "";
  try { await proposeSavFromOnboarding(id(form, "itemId"), id(form, "versionId"), staff.email); }
  catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "KNOWLEDGE_IMPORT_FAILED"; }
  revalidatePath("/studio/sav/connaissances");
  redirect(`/studio/sav/connaissances?result=${errorCode || "candidate_ready"}`);
}

export async function reviewProposalAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let errorCode = "";
  try {
    await reviewSavProposal({ messageId: id(form, "messageId"), decisionId: id(form, "decisionId"), agentRunId: id(form, "agentRunId"), expectedReviewId: String(form.get("reviewId") || "") || null,
      status: "approved", verdict: String(form.get("verdict")), comment: String(form.get("comment") || "Process corrigé relu et validé manuellement depuis le Studio."),
      dimensions: Object.fromEntries(["classification", "routing", "grounding", "tone", "escalation"].map((key) => [key, String(form.get(`dimension_${key}`))])),
      reusability: String(form.get("reusability")), reusableResolution: String(form.get("reusableResolution") || ""), justification: String(form.get("justification") || ""),
      correction: { category: String(form.get("category")), urgency: String(form.get("urgency")), decisionKind: String(form.get("decisionKind")), reasonCode: String(form.get("reasonCode")), explanation: String(form.get("explanation")), title: String(form.get("title")), description: String(form.get("description")), process: [
        ...Array.from({ length: Math.max(0, Math.min(30, Number(form.get("processCount")) || 0)) }, (_, index) => ({ kind: String(form.get(`processKind_${index}`)), label: String(form.get(`processLabel_${index}`)), sourceIds: JSON.parse(String(form.get(`processSources_${index}`))) })),
        ...String(form.get("additionalSteps") || "").split("\n").map((value) => value.trim()).filter(Boolean).map((label) => ({ kind: "product_step", label, sourceIds: [] })),
      ], internalNote: String(form.get("internalNote") || ""), replyDraft: String(form.get("replyDraft") || ""), registrationEmail: String(form.get("registrationEmail") || "").trim().toLowerCase(), identityVerified: form.get("identityVerified") === "on" },
    }, staff.email);
  } catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "SAV_REVIEW_INVALID"; }
  revalidatePath("/studio/sav");
  revalidatePath(`/studio/sav/${threadId}`);
  revalidatePath("/studio/sav/resolutions");
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${errorCode || "saved"}`);
}

export async function importHubspotKnowledgeAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  let result = "hubspot_candidates_ready";
  try {
    const file = form.get("knowledgeFile");
    if (!(file instanceof File) || file.size === 0) throw new Error("HUBSPOT_IMPORT_FILE_REQUIRED");
    if (file.size > HUBSPOT_IMPORT_MAX_BYTES) throw new Error("HUBSPOT_IMPORT_TOO_LARGE");
    await importHubspotKnowledge(await file.text(), staff.email);
  } catch (error) {
    // Never expose a private payload, schema details or DB errors in the URL/logs.
    result = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "HUBSPOT_IMPORT_INVALID";
  }
  revalidatePath("/studio/sav/connaissances");
  redirect(`/studio/sav/connaissances?result=${result}`);
}
