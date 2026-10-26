import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, staffUsers, savThreads, savMessages, savIntakeConsole, savIntakeRuns, savIntakeExecutions, savActions } from "@/db/schema";
import { canAccessSav } from "../access";
import { encryptSavPayload, savContentHash } from "../crypto";
import { readSavExternalCompletion, hasUnsettledSavIntakeWork } from "../external-completion";
import { executionAdministrator } from "./execution-policy";
import { admissionLock } from "./execution-store";
import { intakeConsoleInstalled } from "./console-capability";
import { intakeThreadHumanHeld } from "./legacy-pause";
import { readIntakeLaunch } from "./launch-boundary";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";

const request = z.object({ requestKey: z.uuid(), threadId: z.uuid(), messageId: z.uuid(),
  expectedEpoch: z.number().int().positive(), reason: z.string().trim().min(10).max(2000) }).strict();
const conflict = (): never => { throw Error("SAV_INTAKE_HOLD_RELEASE_CONFLICT"); };
const action = "sav_intake_human_hold_released";

/** Explicit local administrative action only. Existing attempts, plans, effects
 * and policies are preserved. The normal worker decides any later continuation. */
export async function releaseIntakeHumanHold(raw: unknown) {
  const actor = await executionAdministrator(), command = request.parse(raw), hash = savContentHash(command);
  return requireDb().transaction(async tx => {
    await admissionLock(tx);
    if (!await intakeConsoleInstalled(tx)) return conflict();
    const [active] = await tx.select().from(staffUsers).where(eq(staffUsers.id, actor.id)).for("update");
    if (!active?.active || !["admin", "owner"].includes(active.role) || !canAccessSav(active.email, active.role)
      || active.clerkId !== actor.clerkId || active.email !== actor.email) return conflict();
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, command.threadId)).for("update");
    const [message] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, command.threadId), eq(savMessages.direction, "inbound")))
      .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    if (!thread || !message || message.id !== command.messageId || message.mailboxId !== thread.mailboxId) return conflict();
    const launch = await readIntakeLaunch(thread.mailboxId, tx);
    if (!launch || message.receivedAt <= new Date(launch.receivedAfter) || message.createdAt <= new Date(launch.createdAfter)
      || await readSavExternalCompletion(message, tx)) return conflict();
    const [replay] = await tx.select().from(auditLogs).where(and(eq(auditLogs.action, action), sql`${auditLogs.technicalMetadata}->>'requestKey' = ${command.requestKey}`)).limit(1);
    if (replay) {
      if (replay.entityType !== "sav_thread" || replay.entityId !== thread.id || replay.actorEmail !== active.email
        || replay.technicalMetadata.commandHash !== hash || thread.aiPaused) return conflict();
      return { released: false, replayed: true };
    }
    const [projection] = await tx.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, thread.id)).for("update");
    if (!projection || projection.epoch !== command.expectedEpoch || !await intakeThreadHumanHeld(thread.id, tx)) return conflict();
    const now = new Date();
    const runs = await tx.select({ leaseUntil: savIntakeRuns.leaseUntil }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, thread.id));
    const executions = await tx.select({ leaseUntil: savIntakeExecutions.leaseUntil }).from(savIntakeExecutions).where(eq(savIntakeExecutions.threadId, thread.id));
    if ([...runs, ...executions].some(row => row.leaseUntil && row.leaseUntil > now) || await hasUnsettledSavIntakeWork(thread.id, tx)) return conflict();
    const [legacy] = await tx.select({ id: savActions.id }).from(savActions).where(and(eq(savActions.threadId, thread.id),
      sql`${savActions.status} <> 'succeeded' and (${savActions.status} in ('pending','running')
        or ${savActions.payload}->>'ticketCreateDispatchedAt' is not null or ${savActions.payload}->>'ticketReturnDispatchedAt' is not null
        or ${savActions.payload}->>'replySendDispatchedAt' is not null or ${savActions.payload}->>'forwardDispatchedAt' is not null
        or ${savActions.payload}->>'intakeOccupationDispatchedAt' is not null)`)).limit(1);
    if (legacy) return conflict();
    await tx.update(savThreads).set({ aiPaused: false, updatedAt: now }).where(and(eq(savThreads.id, thread.id), eq(savThreads.aiPaused, true)));
    await tx.insert(auditLogs).values({ actorEmail: active.email, action, entityType: "sav_thread", entityId: thread.id,
      technicalMetadata: { requestKey: command.requestKey, commandHash: hash, messageId: message.id, mailboxId: thread.mailboxId,
        previousEpoch: projection.epoch, reasonCiphertext: encryptSavPayload({ reason: command.reason }) } });
    await tx.execute(sql`select sav.dirty_intake_console(${thread.id}::uuid)`);
    return { released: true, replayed: false };
  });
}
