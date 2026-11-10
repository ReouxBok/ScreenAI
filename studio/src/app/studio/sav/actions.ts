"use server";

import { reconcileSavTicketReturn } from "@/lib/sav/hubspot";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSavApiStaff as requireApiStaff } from "@/lib/sav/auth";
import { continueHubspotBackfill, reconcileSavManualTicket } from "@/lib/sav/hubspot";
import { approveLearningCandidate, rejectLearningCandidate } from "@/lib/sav/learning";
import { retrySavWebhookReceipt } from "@/lib/sav/service";
import { reviewKnowledgeCandidate } from "@/lib/knowledge/review";
import { HUBSPOT_IMPORT_MAX_BYTES } from "@/lib/knowledge/hubspot-input";
import { importHubspotKnowledge, prepareHubspotReview } from "@/lib/knowledge/hubspot-import";
import { assertKnowledgeCandidateReview } from "@/lib/knowledge/contracts";
import { requireDb } from "@/db";
import { knowledgeProjectionCandidates } from "@/db/schema";
import { eq } from "drizzle-orm";
import { proposeActiveOnboardingKnowledge } from "@/lib/knowledge/onboarding-import";
import { reviewSavProposal } from "@/lib/sav/review";
import { qualifySavObservation } from "@/lib/sav/observations";
import { reviewSavDraft } from "@/lib/sav/draft-verdicts";
import { saveSavHumanReplyDraft } from "@/lib/sav/drafts";
import { recordSavDeploymentDecision } from "@/lib/sav/metrics";
import { createReviewedSavReplay, runReviewedSavRuleReplay } from "@/lib/sav/reviewed-replay";
import { SAV_LEGACY_COMMAND_RETIRED, type LegacyCommandKind } from "@/lib/ui/legacy-notice";

// SAV-60 (decision Ugo 28/10): the commands of the retired V0 circuit. The role guard
// runs first, unchanged; the command is then refused here, before any read, provider
// call, queue or log, and its code reaches the archive notice instead of a generic
// error. Pole C's lib functions throw the same code (be24f6c) as a second barrier.
async function refuseLegacyCommand(form: FormData | null, kind?: LegacyCommandKind): Promise<never> {
  await requireApiStaff("admin");
  const threadId = String(form?.get("threadId") ?? "").trim();
  const query = new URLSearchParams({ notice: SAV_LEGACY_COMMAND_RETIRED, ...kind ? { kind } : {} });
  redirect(z.uuid().safeParse(threadId).success ? `/studio/sav/archives/${threadId}?${query}` : `/studio/sav/archives?${query}`);
}

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
  await refuseLegacyCommand(form);
}

export async function qualifyObservationAction(form:FormData) {
  const staff=await requireApiStaff("admin");
  const threadId=id(form,"threadId");let result="observation_qualified";
  try { const evidence=JSON.parse(String(form.get("evidence")||"{}"));
    await qualifySavObservation({observationId:id(form,"observationId"),cycleId:id(form,"cycleId"),sourceHash:id(form,"sourceHash"),outcome:String(form.get("outcome")),evidenceRef:evidence.sourceRef||"",evidenceHash:evidence.contentHash||"",resolution:String(form.get("resolution")||""),justification:String(form.get("justification")||""),customerConfirmationRef:String(form.get("customerConfirmationRef")||""),unconfirmedAcknowledged:form.get("unconfirmedAcknowledged")==="on"},staff.email);
  } catch(error){result=error instanceof Error && /^[A-Z_]+$/.test(error.message)?error.message:"SAV_OBSERVATION_INVALID";}
  revalidatePath(`/studio/sav/${threadId}`);revalidatePath("/studio/sav/resolutions");
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${result}`);
}

export async function reviewDraftAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let result = "draft_reviewed";
  try {
    if (form.has("replyDraft") || form.has("text")) throw new Error("SAV_DRAFT_READ_ONLY");
    await reviewSavDraft({ threadId, messageId: id(form,"messageId"), decisionId: id(form,"decisionId"), agentRunId: id(form,"agentRunId"), sourceHash: id(form,"sourceHash"), expectedVerdictId: String(form.get("verdictId") || "") || null, ...(form.get("draftId") ? {draftId:String(form.get("draftId"))} : {}), status: String(form.get("status")), reason: String(form.get("reason") || ""), reasons: form.getAll("reasons").map(String) }, staff.email);
  } catch (error) { result = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_DRAFT_INVALID"; }
  revalidatePath(`/studio/sav/${threadId}`);
  revalidatePath("/studio/sav/evaluation");
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${result}`);
}

export async function saveHumanDraftAction(form: FormData) {
  const staff=await requireApiStaff("admin");
  const threadId=id(form,"threadId");
  let result="draft_saved";
  try { await saveSavHumanReplyDraft({threadId,messageId:id(form,"messageId"),expectedDraftId:String(form.get("expectedDraftId") || "") || null,text:String(form.get("text") || "")},staff.email); }
  catch(error) { result=error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_DRAFT_INVALID"; }
  revalidatePath(`/studio/sav/${threadId}`);revalidatePath("/studio/sav");
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${result}`);
}

export async function sendStudioReplyAction(form: FormData) {
  await refuseLegacyCommand(form, "reply");
}

export async function sendSuggestedReplyAction(form: FormData) {
  await refuseLegacyCommand(form, "reply");
}

function id(form: FormData, name: string) {
  const value = String(form.get(name) || "").trim();
  if (!value) throw new Error(`${name.toUpperCase()}_REQUIRED`);
  return value;
}


export async function requestHumanAction(form: FormData) {
  await refuseLegacyCommand(form);
}

export async function correctDecisionAction(form: FormData) {
  await refuseLegacyCommand(form);
}

export async function createTicketAction(form: FormData) {
  await refuseLegacyCommand(form, "ticket");
}

export async function linkTicketAction(form: FormData) {
  await refuseLegacyCommand(form, "ticket");
}



export async function retryAnalysisAction(form: FormData) {
  await refuseLegacyCommand(form);
}

export async function refreshSavContextAction(form: FormData) {
  await refuseLegacyCommand(form);
}

export async function repairSavProposalAction(form: FormData) {
  await refuseLegacyCommand(form);
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
  await refuseLegacyCommand(form);
}

export async function retryAction(form: FormData) {
  await refuseLegacyCommand(form);
}

export async function retryWebhookAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  await retrySavWebhookReceipt(id(form, "receiptId"), staff.email);
  revalidatePath("/studio/sav");
}

export async function startPilotBatchAction() {
  await refuseLegacyCommand(null);
}

export async function startSelectedPilotBatchAction(form: FormData) {
  await refuseLegacyCommand(form);
}

export async function cancelPilotBatchAction(form: FormData) {
  await refuseLegacyCommand(form);
}

export async function cancelPilotBatchLabAction(form: FormData) {
  await refuseLegacyCommand(form);
}

export async function reviewPilotItemAction(form: FormData) {
  await refuseLegacyCommand(form);
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
  try {
    if (decision === "approve") await approveLearningCandidate(candidateId, staff.email);
    else if (decision === "reject") await rejectLearningCandidate(candidateId, staff.email);
    else throw new Error("INVALID_LEARNING_DECISION");
  } catch (error) {
    if (error instanceof Error && ["SAV_OBSERVATION_SYNC_IN_PROGRESS", "SAV_OBSERVATION_STALE", "SAV_LEARNING_HISTORICAL_REVIEW_BLOCKED"].includes(error.message))
      redirect(`/studio/sav/resolutions?review=${error.message === "SAV_OBSERVATION_SYNC_IN_PROGRESS" ? "sync_in_progress" : "stale"}`);
    throw error;
  }
  revalidatePath("/studio/sav");
  revalidatePath("/studio/sav/resolutions");
  revalidatePath("/studio/contenus");
}

export async function previewHubspotReviewAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  assertKnowledgeCandidateReview(staff.email, "sav");
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
  const detailCandidate = String(form.get("candidateId") || "");
  if (form.get("returnDetail") === "true" && /^[a-f0-9-]{36}$/i.test(detailCandidate)) redirect(`/studio/sav/connaissances/${detailCandidate}?kind=candidate&result=${errorCode || "draft_ready"}`);
  redirect(`/studio/sav/connaissances/imports?result=${errorCode || "draft_ready"}`);
}

export async function importOnboardingKnowledgeAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  let errorCode = "";
  try { await proposeActiveOnboardingKnowledge(id(form, "itemId"), id(form, "versionId"), staff.email); }
  catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "KNOWLEDGE_IMPORT_FAILED"; }
  revalidatePath("/studio/sav/connaissances");
  redirect(`/studio/sav/connaissances/imports?result=${errorCode || "candidate_ready"}`);
}

export async function reviewProposalAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let errorCode = "";
  try {
    if (form.has("replyDraft")) throw new Error("SAV_DRAFT_READ_ONLY");
    await reviewSavProposal({ reviewScope: "dossier", messageId: id(form, "messageId"), decisionId: id(form, "decisionId"), agentRunId: id(form, "agentRunId"), expectedReviewId: String(form.get("reviewId") || "") || null,
      status: "approved", verdict: String(form.get("verdict")), comment: String(form.get("comment") || "Process corrigé relu et validé manuellement depuis le Studio."), reasons: form.getAll("reasons").map(String),
      dimensions: Object.fromEntries(["classification", "routing", "grounding", "tone", "escalation"].map((key) => [key, String(form.get(`dimension_${key}`))])),
      reusability: String(form.get("reusability")), reusableResolution: String(form.get("reusableResolution") || ""), justification: String(form.get("justification") || ""),
      correction: { category: String(form.get("category")), urgency: String(form.get("urgency")), decisionKind: String(form.get("decisionKind")), reasonCode: String(form.get("reasonCode")), explanation: String(form.get("explanation")), title: String(form.get("title")), description: String(form.get("description")), process: [
        ...Array.from({ length: Math.max(0, Math.min(30, Number(form.get("processCount")) || 0)) }, (_, index) => ({ kind: String(form.get(`processKind_${index}`)), label: String(form.get(`processLabel_${index}`)), sourceIds: JSON.parse(String(form.get(`processSources_${index}`))) })),
        ...String(form.get("additionalSteps") || "").split("\n").map((value) => value.trim()).filter(Boolean).map((label) => ({ kind: "product_step", label, sourceIds: [] })),
      ], internalNote: String(form.get("internalNote") || ""), replyDraft: "", registrationEmail: String(form.get("registrationEmail") || "").trim().toLowerCase(), identityVerified: form.get("identityVerified") === "on",
        ...(form.get("humanProcess") ? { humanProcess: JSON.parse(String(form.get("humanProcess"))) } : {}) },
    }, staff.email);
  } catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "SAV_REVIEW_INVALID"; }
  revalidatePath("/studio/sav");
  revalidatePath(`/studio/sav/${threadId}`);
  revalidatePath("/studio/sav/resolutions");
  revalidatePath("/studio/sav/evaluation");
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
  redirect(`/studio/sav/connaissances/imports?result=${result}`);
}

export async function reconcileTicketReturnAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const threadId = id(form, "threadId");
  let errorCode = "";
  try { await reconcileSavTicketReturn(id(form, "actionId"), id(form, "noteId"), staff.email); }
  catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "SAV_RECONCILIATION_TARGET_INVALID"; }
  revalidatePath("/studio/sav"); revalidatePath(`/studio/sav/${threadId}`);
  redirect(`/studio/sav/${encodeURIComponent(threadId)}?review=${errorCode || "ticket_reconciled"}`);
}
