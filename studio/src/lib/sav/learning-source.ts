import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savLearningCandidates, savTicketSnapshots } from "@/db/schema";
import { decryptSavPayload } from "./crypto";
type Db = Pick<ReturnType<typeof requireDb>, "select">;
type Proof = { ticketId: string; snapshotId: string; snapshotHash: string; cycleStartedAt: Date | string };
export async function isSavCrmLearningSourceCurrent(proof: Proof, db: Db, lock = false) {
  if (!z.uuid().safeParse(proof.snapshotId).success || !proof.snapshotHash || !Number.isFinite(new Date(proof.cycleStartedAt).getTime())) return false;
  const query = db.select().from(savTicketSnapshots).where(and(eq(savTicketSnapshots.id, proof.snapshotId), eq(savTicketSnapshots.hubspotTicketId, proof.ticketId)));
  const [snapshot] = await (lock ? query.for("update") : query);
  return Boolean(snapshot?.status === "closed" && snapshot.humanIntervened && snapshot.contentHash === proof.snapshotHash
    && snapshot.learningCycleStartedAt?.getTime() === new Date(proof.cycleStartedAt).getTime());
}
/** Source locks precede candidate/catalogue locks in admission and human review. */
export async function assertSavCrmLearningSource(candidate: typeof savLearningCandidates.$inferSelect, db: Db, lock = false) {
  if (candidate.createdBy === "human" || !candidate.sourceRef.startsWith("hubspot:")) return;
  const ciphertext = candidate.proposedPatch.ciphertext;
  if (typeof ciphertext !== "string") throw new Error("SAV_OBSERVATION_STALE");
  const proof = decryptSavPayload<{ sourceSnapshotId?: string; sourceSnapshotHash?: string; sourceCycleStartedAt?: string }>(ciphertext);
  if (!candidate.hubspotTicketId || !proof.sourceSnapshotId || !proof.sourceSnapshotHash || !proof.sourceCycleStartedAt
    || !await isSavCrmLearningSourceCurrent({ ticketId: candidate.hubspotTicketId, snapshotId: proof.sourceSnapshotId,
      snapshotHash: proof.sourceSnapshotHash, cycleStartedAt: proof.sourceCycleStartedAt }, db, lock)) throw new Error("SAV_OBSERVATION_STALE");
}
