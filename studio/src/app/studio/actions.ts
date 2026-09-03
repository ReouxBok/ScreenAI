"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDb } from "@/db";
import { contentItems } from "@/db/schema";
import { canEditContent } from "@/lib/access";
import { requireApiStaff, type StaffIdentity } from "@/lib/auth";
import { createEvaluationRun, ensureEvaluationSuite } from "@/lib/evaluations";
import {
  archiveContent,
  deleteContent,
  publish,
  rejectReview,
  rollback,
  saveDraft,
  setContentAiEnabled,
  submitForReview,
} from "@/lib/workflow";

const strings = (value: FormDataEntryValue | null) => String(value ?? "").split("\n").map((item) => item.trim()).filter(Boolean);
const jsonArray = (value: FormDataEntryValue | null) => {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

async function assertContentEditable(staff: StaffIdentity, itemId: string) {
  const [item] = await requireDb().select({ publishedVersionId: contentItems.publishedVersionId })
    .from(contentItems).where(eq(contentItems.id, itemId)).limit(1);
  if (!item) throw new Error("CONTENT_NOT_FOUND");
  if (!canEditContent(staff.role, item.publishedVersionId)) throw new Error("CONTENT_LOCKED_IN_PRODUCTION");
  return item;
}

export async function saveContentAction(form: FormData) {
  const staff = await requireApiStaff();
  const itemId = String(form.get("itemId") || "") || undefined;
  if (itemId) await assertContentEditable(staff, itemId);
  const type = String(form.get("type"));
  const common = {
    type,
    slug: String(form.get("slug")),
    locale: "fr-FR",
    title: String(form.get("title")),
    summary: String(form.get("summary")),
    categorySlug: String(form.get("categorySlug")),
    visibility: "charly_only",
    agentKey: String(form.get("agentKey")),
    ownerEmail: staff.email,
    bodyMarkdown: String(form.get("bodyMarkdown")),
    changeNote: String(form.get("changeNote")),
  };
  let sourceMetadata: Record<string, unknown> = {};
  try {
    sourceMetadata = JSON.parse(String(form.get("sourceMetadata") || "{}"));
  } catch {
    throw new Error("INVALID_SOURCE_METADATA");
  }
  const metadata = type === "article" ? {
    intents: strings(form.get("intents")),
    limovaPaths: strings(form.get("limovaPaths")),
    prerequisites: strings(form.get("prerequisites")),
    expectedResult: String(form.get("expectedResult")),
    troubleshooting: String(form.get("troubleshooting")),
    sourceMetadata,
  } : {
    objective: String(form.get("objective")),
    proposalSignals: strings(form.get("proposalSignals")),
    qualificationQuestions: strings(form.get("qualificationQuestions")),
    expectedPages: strings(form.get("expectedPages")),
    successCriteria: strings(form.get("successCriteria")),
    branches: jsonArray(form.get("branches")),
    fallbacks: strings(form.get("fallbacks")),
    actionSteps: jsonArray(form.get("actionSteps")),
  };
  const result = await saveDraft({ ...common, metadata }, staff.email, itemId);
  revalidatePath("/studio");
  revalidatePath("/studio/contenus");
  redirect(`/studio/contenus/${result.item.id}`);
}

export async function setAiEnabledAction(form: FormData) {
  const staff = await requireApiStaff();
  const id = String(form.get("itemId"));
  await assertContentEditable(staff, id);
  await setContentAiEnabled(id, String(form.get("enabled")) === "true", staff.email);
  revalidatePath("/studio");
  revalidatePath("/studio/contenus");
  revalidatePath(`/studio/contenus/${id}`);
}

export async function submitAction(form: FormData) {
  const staff = await requireApiStaff();
  const id = String(form.get("itemId"));
  await assertContentEditable(staff, id);
  try {
    await submitForReview(id, staff.email, String(form.get("comment") || "Prêt à valider"));
  } catch (error) {
    if (error instanceof Error && error.message === "REAL_EVALUATION_REQUIRED") redirect(`/studio/contenus/${id}?evaluation=required#content-evaluation`);
    throw error;
  }
  revalidatePath(`/studio/contenus/${id}`);
}

export async function prepareEvaluationAction(form: FormData) {
  const staff = await requireApiStaff();
  const id = String(form.get("itemId"));
  await ensureEvaluationSuite(id, staff.email);
  revalidatePath(`/studio/contenus/${id}`);
  redirect(`/studio/contenus/${id}#content-evaluation`);
}

export async function startEvaluationRunAction(form: FormData) {
  const staff = await requireApiStaff();
  const id = String(form.get("itemId"));
  const result = await createEvaluationRun(id, String(form.get("caseId")), staff.email);
  redirect(`/studio/contenus/${id}?testCode=${encodeURIComponent(result.token)}&testCase=${encodeURIComponent(result.run.caseId)}#content-evaluation`);
}

export async function rejectAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const id = String(form.get("itemId"));
  await rejectReview(id, staff.email, String(form.get("comment")));
  revalidatePath(`/studio/contenus/${id}`);
}

export async function publishAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const id = String(form.get("itemId"));
  await publish(id, staff.email);
  revalidatePath(`/studio/contenus/${id}`);
  revalidatePath("/aide");
}

export async function reviewDecisionAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const id = String(form.get("itemId"));
  const decision = String(form.get("decision"));
  if (decision === "publish") {
    await publish(id, staff.email);
    revalidatePath("/studio");
    revalidatePath("/studio/validations");
  } else if (decision === "reject") {
    await rejectReview(id, staff.email, String(form.get("comment")));
  } else {
    throw new Error("INVALID_REVIEW_DECISION");
  }
  revalidatePath(`/studio/contenus/${id}`);
}

export async function emergencyPublishAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const id = String(form.get("itemId"));
  await publish(id, staff.email, { emergency: true, reason: String(form.get("reason")) });
  revalidatePath(`/studio/contenus/${id}`);
}

export async function rollbackAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const id = String(form.get("itemId"));
  await rollback(id, String(form.get("versionId")), staff.email, String(form.get("reason")));
  revalidatePath(`/studio/contenus/${id}`);
}

export async function archiveAction(form: FormData) {
  const staff = await requireApiStaff("admin");
  const id = String(form.get("itemId"));
  await archiveContent(id, staff.email, String(form.get("reason")));
  revalidatePath(`/studio/contenus/${id}`);
  revalidatePath("/aide");
}

export async function deleteContentAction(form: FormData) {
  const staff = await requireApiStaff();
  const id = String(form.get("itemId"));
  await assertContentEditable(staff, id);
  try {
    await deleteContent(id, staff.email);
  } catch (error) {
    if (error instanceof Error && error.message === "CONTENT_USED_IN_ONBOARDING_TEMPLATE") {
      redirect(`/studio/contenus/${id}?delete=used-in-template`);
    }
    throw error;
  }
  revalidatePath("/studio");
  revalidatePath("/studio/contenus");
  revalidatePath("/studio/validations");
  revalidatePath("/studio/tests");
  revalidatePath("/aide");
  redirect("/studio/contenus?deleted=1");
}
