import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { savLearningAdmissionAttempts, savLearningCandidates } from "@/db/schema";

export function isSavAutomaticLearning(candidate: Pick<typeof savLearningCandidates.$inferSelect, "sourceRef" | "createdBy">) {
  return candidate.createdBy !== "human" || candidate.sourceRef.startsWith("sav-observation:");
}

/** A hidden legacy card must not bypass admission through another UI or server action. */
export async function assertSavLearningAdmitted(candidate: typeof savLearningCandidates.$inferSelect, db: Pick<ReturnType<typeof requireDb>, "select">) {
  if (!isSavAutomaticLearning(candidate)) return;
  const [admission] = await db.select().from(savLearningAdmissionAttempts).where(eq(savLearningAdmissionAttempts.candidateId, candidate.id)).limit(1);
  if (!candidate.admissionGroupKey || !admission) throw new Error("SAV_LEARNING_HISTORICAL_REVIEW_BLOCKED");
}
