import "server-only";

import { and, asc, eq, lte } from "drizzle-orm";
import { requireDb } from "@/db";
import { savActions, savFollowups, savThreads } from "@/db/schema";
import { encryptSavPayload } from "./crypto";

const FOLLOWUP_COPY: Record<number, string> = {
  1: "Je reviens vers vous au sujet de votre demande. Avez-vous pu essayer la solution proposée, ou souhaitez-vous me donner les informations manquantes ?",
  2: "Votre demande est toujours en attente de votre retour. Je peux reprendre immédiatement avec vous, ou transmettre le dossier à un membre de l’équipe Limova.",
  3: "Dernière relance concernant votre demande. Sans réponse de votre part, nous laisserons le dossier en attente. Vous pourrez le reprendre à tout moment en répondant à cet email.",
};

export async function processDueFollowups(limit = 50, now = new Date()) {
  const db = requireDb();
  const due = await db.select({ followup: savFollowups, thread: savThreads }).from(savFollowups)
    .innerJoin(savThreads, eq(savThreads.id, savFollowups.threadId))
    .where(and(eq(savFollowups.status, "scheduled"), lte(savFollowups.dueAt, now)))
    .orderBy(asc(savFollowups.dueAt)).limit(Math.min(100, Math.max(1, limit)));
  const results = [];
  for (const { followup, thread } of due) {
    if (thread.status !== "awaiting_customer" || thread.aiPaused) {
      await db.update(savFollowups).set({ status: "cancelled", cancelledAt: now }).where(eq(savFollowups.id, followup.id));
      results.push({ followupId: followup.id, status: "cancelled" });
      continue;
    }
    const text = FOLLOWUP_COPY[followup.sequence];
    if (!text) {
      await db.update(savFollowups).set({ status: "cancelled", cancelledAt: now }).where(eq(savFollowups.id, followup.id));
      continue;
    }
    await db.transaction(async (tx) => {
      const [action] = await tx.insert(savActions).values({
        threadId: thread.id,
        kind: "send_reply",
        idempotencyKey: `reply:followup:${followup.id}`,
        payload: { bodyCiphertext: encryptSavPayload({ text }), followupSequence: followup.sequence },
        actorType: "ai",
      }).onConflictDoNothing().returning();
      if (action) await tx.update(savFollowups).set({ status: "queued", actionId: action.id }).where(eq(savFollowups.id, followup.id));
    });
    results.push({ followupId: followup.id, status: "queued" });
  }
  return results;
}
