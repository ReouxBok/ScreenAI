import "server-only";
import { readIntakeObservationBinding } from "./intake/observation-binding";
import { readSavCaseLearningQualification } from "./case-qualification";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savLearningCandidates, savTicketSnapshots, savObservationCycles, savResolutionObservations } from "@/db/schema";
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
  if (candidate.sourceRef.startsWith("sav-observation:")) {
    const [cycle] = await db.select().from(savObservationCycles).where(eq(savObservationCycles.id, candidate.sourceRef.slice("sav-observation:".length)));
    const [observation] = cycle ? await db.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, cycle.observationId)) : [];
    if (observation?.trackingOrigin === "intake") {
      const binding = await readIntakeObservationBinding(observation.id, db), qualification = await readSavCaseLearningQualification(observation.threadId, db);
      const ciphertext = candidate.proposedPatch.ciphertext;
      const patch = typeof ciphertext === "string" ? decryptSavPayload<{ intakeOrigin?: { baselineHash: string; qualificationHash: string } }>(ciphertext) : null;
      if (!qualification.allowed || !binding || patch?.intakeOrigin?.baselineHash !== binding.baselineHash
        || patch.intakeOrigin.qualificationHash !== qualification.fingerprint) throw Error("SAV_OBSERVATION_STALE");
    }
  }
  if (candidate.createdBy === "human" || !candidate.sourceRef.startsWith("hubspot:")) return;
  const ciphertext = candidate.proposedPatch.ciphertext;
  if (typeof ciphertext !== "string") throw new Error("SAV_OBSERVATION_STALE");
  const proof = decryptSavPayload<{ sourceSnapshotId?: string; sourceSnapshotHash?: string; sourceCycleStartedAt?: string }>(ciphertext);
  if (!candidate.hubspotTicketId || !proof.sourceSnapshotId || !proof.sourceSnapshotHash || !proof.sourceCycleStartedAt
    || !await isSavCrmLearningSourceCurrent({ ticketId: candidate.hubspotTicketId, snapshotId: proof.sourceSnapshotId,
      snapshotHash: proof.sourceSnapshotHash, cycleStartedAt: proof.sourceCycleStartedAt }, db, lock)) throw new Error("SAV_OBSERVATION_STALE");
}
