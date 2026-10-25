import "server-only";
import { and, eq, gt, isNotNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { savIntakeHumanEvents, savIntakeRuns, savIntakeExecutions, savIntakeEffects } from "@/db/schema";
import { requireIntakeConsoleStaff } from "@/lib/sav/intake/console-auth";
import { decryptSavPayload } from "@/lib/sav/crypto";
import type { HumanEventPayload } from "@/lib/sav/intake/human-binding";
/** UI eligibility only. Canonical recovery/command guards remain authoritative. */
export async function readUxMessageControls(threadId: string, messageId: string) {
  await requireIntakeConsoleStaff(); z.uuid().parse(threadId); z.uuid().parse(messageId);
  try {
    const db = requireDb();
    const [events, activeRuns, executions] = await Promise.all([
      db.select().from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.threadId, threadId), eq(savIntakeHumanEvents.messageId, messageId))),
      db.select({ id: savIntakeRuns.id }).from(savIntakeRuns).where(and(eq(savIntakeRuns.threadId, threadId), eq(savIntakeRuns.messageId, messageId), gt(savIntakeRuns.leaseUntil, new Date()))).limit(1),
      db.select({ id: savIntakeExecutions.id, state: savIntakeExecutions.state, leaseUntil: savIntakeExecutions.leaseUntil }).from(savIntakeExecutions)
        .where(and(eq(savIntakeExecutions.threadId, threadId), eq(savIntakeExecutions.messageId, messageId))).limit(1),
    ]);
    const execution = executions[0];
    if (activeRuns.length || execution?.leaseUntil && execution.leaseUntil > new Date())
      return { blocked: true, reason: "Un traitement détient encore ce dossier. Attendez sa fin et rechargez ses preuves." };
    if (events.some(e => e.kind === "refuse" || ["pending", "reading"].includes(e.state)
      || (() => { const body = decryptSavPayload<HumanEventPayload>(e.payloadCiphertext); return Boolean(body.contactId || body.ticketId || body.reinvestigate); })()))
      return { blocked: true, reason: "Une décision ou reprise existe déjà pour ce message. Consultez sa progression dans l’historique." };
    const effects = execution ? await db.select({ id: savIntakeEffects.id }).from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, execution.id),
      or(ne(savIntakeEffects.state, "planned"), isNotNull(savIntakeEffects.dispatchedAt), isNotNull(savIntakeEffects.dispatchToken), isNotNull(savIntakeEffects.ackCiphertext), isNotNull(savIntakeEffects.confirmedAt)))).limit(1) : [];
    if (execution?.state === "confirmed" || effects.length)
      return { blocked: true, reason: "Des actions sont déjà engagées ou confirmées. Vérifiez leur résultat ; cette nouvelle analyse ne doit pas les rejouer." };
    return { blocked: false };
  } catch { return { blocked: true, reason: "Les preuves de reprise sont temporairement illisibles. Rechargez le dossier ; aucune nouvelle analyse n’est autorisée depuis cet écran." }; }
}
