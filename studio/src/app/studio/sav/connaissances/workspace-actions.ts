"use server";

import { revalidatePath } from "next/cache";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { activateSavKnowledgeVersion, getSavKnowledgeDetail, paginateSavKnowledge, previewSavKnowledgeProposal, previewSavKnowledgeReview, publishSavKnowledgeVersion, reviewSavKnowledgeProposal, saveSavKnowledgeProposal, startSavKnowledgeRevision, submitSavKnowledgeProposal } from "@/lib/knowledge/workspace";
import { knowledgeErrorMessage } from "./workspace-labels";

function message(error: unknown) { return knowledgeErrorMessage(error instanceof Error ? error.message : "ACTION_FAILED"); }
function refresh() { revalidatePath("/studio/sav/connaissances", "layout"); revalidatePath("/studio/contenus"); revalidatePath("/studio/sav"); }
export async function saveKnowledgeProposalAction(input: Parameters<typeof saveSavKnowledgeProposal>[0]) {
  const staff = await requireSavApiStaff();
  try { const draft = await saveSavKnowledgeProposal(input, staff.email); refresh(); return { draft, error: null }; }
  catch (error) { return { draft: null, error: message(error) }; }
}
export async function previewKnowledgeProposalAction(draftId: string) {
  const staff = await requireSavApiStaff();
  try { return { preview: await previewSavKnowledgeProposal(draftId, staff.email), error: null }; }
  catch (error) { return { preview: null, error: message(error) }; }
}
export async function submitKnowledgeProposalAction(input: Parameters<typeof submitSavKnowledgeProposal>[0]) {
  const staff = await requireSavApiStaff();
  try { const candidate = await submitSavKnowledgeProposal(input, staff.email); refresh(); return { candidate, error: null }; }
  catch (error) { return { candidate: null, error: message(error) }; }
}
export async function findKnowledgeAction(q: string) {
  await requireSavApiStaff();
  try { const result = await paginateSavKnowledge({ tab: "production", q: q.slice(0, 200), page: 1, pageSize: 20 }); return { rows: result.rows, total: result.total, error: null }; }
  catch (error) { return { rows: [], total: 0, error: message(error) }; }
}
export async function loadKnowledgeTargetAction(itemId: string) {
  const staff = await requireSavApiStaff();
  try { return { detail: await getSavKnowledgeDetail({ itemId }, staff.email), error: null }; }
  catch (error) { return { detail: null, error: message(error) }; }
}
export async function previewKnowledgeReviewAction(candidateId: string, document?: Parameters<typeof previewSavKnowledgeReview>[2]) {
  const staff = await requireSavApiStaff();
  try { return { preview: await previewSavKnowledgeReview(candidateId, staff.email, document), error: null }; }
  catch (error) { return { preview: null, error: message(error) }; }
}
export async function reviewKnowledgeWorkspaceAction(input: Parameters<typeof reviewSavKnowledgeProposal>[0]) {
  const staff = await requireSavApiStaff();
  try { await reviewSavKnowledgeProposal(input, staff.email); refresh(); return { success: true, error: null }; }
  catch (error) { return { success: false, error: message(error) }; }
}
export async function publishKnowledgeWorkspaceAction(input: Parameters<typeof publishSavKnowledgeVersion>[0]) {
  const staff = await requireSavApiStaff();
  try { await publishSavKnowledgeVersion(input, staff.email); refresh(); return { success: true, error: null }; }
  catch (error) { return { success: false, error: message(error) }; }
}
export async function activateKnowledgeWorkspaceAction(input: Parameters<typeof activateSavKnowledgeVersion>[0]) {
  const staff = await requireSavApiStaff();
  try { await activateSavKnowledgeVersion(input, staff.email); refresh(); return { success: true, error: null }; }
  catch (error) { return { success: false, error: message(error) }; }
}

export async function startKnowledgeRevisionAction(candidateId: string) {
  const staff = await requireSavApiStaff();
  try { const draft = await startSavKnowledgeRevision(candidateId, staff.email); refresh(); return { draft, error: null }; }
  catch (error) { return { draft: null, error: message(error) }; }
}
