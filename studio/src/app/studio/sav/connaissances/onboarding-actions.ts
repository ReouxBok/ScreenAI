"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireDb } from "@/db";
import { knowledgeProjectionCandidates } from "@/db/schema";
import { requireApiStaff } from "@/lib/auth";
import { requireSavApiStaff } from "@/lib/sav/auth";
import { assertKnowledgeCandidateReview } from "@/lib/knowledge/contracts";
import { continueOnboardingImport, prepareOnboardingReview, startOnboardingImport } from "@/lib/knowledge/onboarding-import";
import { reviewKnowledgeCandidate } from "@/lib/knowledge/review";
import { assertSavActor } from "@/lib/sav/access";

const path = "/studio/sav/connaissances";
const statuses = new Set(["all", "pending", "needs_completion", "needs_recording", "not_applicable", "approved", "rejected"]);
const sources = new Set(["all", "onboarding", "hubspot", "sav"]);

function errorCode(error: unknown) {
  return error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "ONBOARDING_ACTION_INVALID";
}

function returnUrl(form: FormData, result: string) {
  const query = new URLSearchParams({ result });
  const page = Number(form.get("returnPage"));
  const status = String(form.get("returnStatus") ?? "all");
  const source = String(form.get("returnSource") ?? "all");
  if (Number.isSafeInteger(page) && page > 0) query.set("page", String(page));
  if (statuses.has(status) && status !== "all") query.set("status", status);
  if (sources.has(source) && source !== "all") query.set("source", source);
  const batch = z.uuid().safeParse(form.get("returnBatch"));
  const candidate = z.uuid().safeParse(form.get("returnCandidate"));
  if (batch.success) query.set("batch", batch.data);
  if (candidate.success) query.set("candidate", candidate.data);
  return `${path}?${query.toString()}${candidate.success ? `#candidate-${candidate.data}` : ""}`;
}

export async function startOnboardingImportAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  assertSavActor(staff.email);
  let result = "onboarding_import_started";
  try { await startOnboardingImport(staff.email); }
  catch (error) { result = errorCode(error); }
  revalidatePath(path);
  redirect(returnUrl(form, result));
}

export async function continueOnboardingImportAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  assertSavActor(staff.email);
  let result = "onboarding_import_continued";
  try { await continueOnboardingImport(z.uuid().parse(form.get("importId")), staff.email, 10); }
  catch (error) { result = errorCode(error); }
  revalidatePath(path);
  redirect(returnUrl(form, result));
}

export async function previewOnboardingReviewAction(form: FormData) {
  const staff = await requireSavApiStaff();
  assertKnowledgeCandidateReview(staff.email, "sav");
  try {
    const candidateId = z.uuid().parse(form.get("candidateId"));
    const revisionId = z.uuid().parse(form.get("revisionId"));
    const [candidate] = await requireDb().select().from(knowledgeProjectionCandidates).where(eq(knowledgeProjectionCandidates.id, candidateId)).limit(1);
    if (!candidate || candidate.targetSurface !== "sav" || candidate.revisionId !== revisionId || !["pending", "needs_completion"].includes(candidate.status)) throw new Error("KNOWLEDGE_CANDIDATE_STALE");
    const comparison = await prepareOnboardingReview(candidate, JSON.parse(String(form.get("document"))));
    return { comparison, error: null };
  } catch (error) {
    return { comparison: null, error: errorCode(error) };
  }
}

export async function reviewOnboardingKnowledgeAction(form: FormData) {
  const staff = await requireSavApiStaff();
  assertKnowledgeCandidateReview(staff.email, "sav");
  let result = "draft_ready";
  try {
    const decision = z.enum(["approve", "reject"]).parse(form.get("decision"));
    await reviewKnowledgeCandidate(z.uuid().parse(form.get("candidateId")), {
      expectedRevisionId: z.uuid().parse(form.get("revisionId")), decision,
      reason: String(form.get("reason") ?? ""),
      ...(decision === "approve" ? {
        document: JSON.parse(String(form.get("document"))),
        comparison: { snapshot: String(form.get("comparisonSnapshot") ?? ""), acknowledged: form.get("comparisonAcknowledged") === "on" },
        completionNote: String(form.get("completionNote") ?? ""),
        missingAcknowledged: form.get("missingAcknowledged") === "on",
      } : {}),
    }, staff.email);
  } catch (error) { result = errorCode(error); }
  revalidatePath(path);
  redirect(returnUrl(form, result));
}
