import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, staffUsers, savActions, savThreads, savMessages, savIntakeRuns,
  savIntakeExecutions, savIntakeEffects, savIntakeExecutionPolicies, savIntakeHumanEvents } from "@/db/schema";
import { canAccessSav } from "../access";
import { decryptSavPayload } from "../crypto";
import { hasUnsettledSavHumanAction } from "../external-completion";
import { executionAdministrator } from "./execution-policy";
import { admissionLock, releaseKeys } from "./execution-store";
import { reconcileIntakeEffectCandidate } from "./executor";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import type { EffectAck, EffectIntent } from "./execution-types";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";

const request = z.object({ threadId: z.uuid(), messageId: z.uuid() }).strict();
const conflict = (): never => { throw Error("SAV_INTAKE_NOTE_RECONCILIATION_REQUIRED"); };

/** Administrative receipt verification, not execution continuation. Only an
 * existing provider ACK can select a note. No dispatch adapter is exposed. */
export async function reconcileIntakeNoteForClosure(raw: unknown) {
  const actor = await executionAdministrator(), input = request.parse(raw), db = requireDb();
  const [execution] = await db.select().from(savIntakeExecutions).where(and(
    eq(savIntakeExecutions.threadId, input.threadId), eq(savIntakeExecutions.messageId, input.messageId)));
  if (!execution?.ticketId || execution.state !== "uncertain") return conflict();
  const [policy] = await db.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, execution.policyId));
  if (policy?.state !== "revoked") return conflict();
  const effects = await db.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, execution.id));
  // This repair addresses a single historical note creation. Other or partial
  // effects retain the normal reconciliation requirements.
  const effect = effects[0];
  if (effects.length !== 1 || effect.kind !== "note_create" || !effect.ackCiphertext
    || !["dispatched", "acked", "uncertain", "confirmed"].includes(effect.state) || !effect.dispatchedAt) return conflict();
  const ack = decryptSavPayload<EffectAck>(effect.ackCiphertext), intent = decryptSavPayload<EffectIntent>(effect.intentCiphertext);
  if (!ack.id || !/^\d{1,30}$/.test(ack.id) || ack.operatorCandidate === true || intent.kind !== "note_create"
    || intent.sourceMessageId !== input.messageId || intent.ticketId !== execution.ticketId || !intent.properties) return conflict();
  const noteId = ack.id;
  const { verify } = createIntakeExecutorAdapters();
  if (effect.state !== "confirmed") {
    await reconcileIntakeEffectCandidate(effect.id, ack.id,
      "Vérification administrateur du reçu original de la note existante, sans nouvelle création.", { verify });
  }
  const association = await verify({ kind: "note_associate", permission: "append_ticket_note",
    key: `note-association:${input.messageId}:${execution.ticketId}`, sourceMessageId: input.messageId,
    ticketId: execution.ticketId, objectId: ack.id, expectedProperties: intent.properties,
    confirmedNoteCreate: { effectId: effect.id, objectId: ack.id } }, ack, effect.dispatchedAt, AbortSignal.timeout(15000));
  if (!association.confirmed || !association.attributed || association.ack?.id !== ack.id) return conflict();

  await db.transaction(async tx => {
    await admissionLock(tx);
    const [current] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, execution.id)).for("no key update");
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, input.threadId)).for("update");
    const [staff] = await tx.select().from(staffUsers).where(eq(staffUsers.id, actor.id)).for("update");
    const [latest] = await tx.select({ id: savMessages.id }).from(savMessages).where(and(
      eq(savMessages.threadId, input.threadId), eq(savMessages.direction, "inbound")))
      .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    const runs = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.threadId, input.threadId)).for("update");
    const run = runs.find(row => row.id === execution.runId);
    const [authority] = await tx.select().from(savIntakeExecutionPolicies).where(eq(savIntakeExecutionPolicies.id, execution.policyId)).for("update");
    const commands = await tx.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents).where(and(
      eq(savIntakeHumanEvents.threadId, input.threadId), inArray(savIntakeHumanEvents.state, ["pending", "reading", "waiting"])));
    const actions = await tx.select().from(savActions).where(eq(savActions.threadId, input.threadId));
    const now = new Date();
    if (!staff?.active || !["admin", "owner"].includes(staff.role) || staff.email !== actor.email || staff.clerkId !== actor.clerkId
      || !canAccessSav(staff.email, staff.role) || !thread || thread.aiPaused || latest?.id !== input.messageId
      || !current || current.state !== "uncertain" || current.payloadCiphertext !== execution.payloadCiphertext
      || current.runId !== execution.runId || current.runVersion !== execution.runVersion
      || current.policyId !== execution.policyId || current.ticketId !== execution.ticketId
      || current.leaseUntil && current.leaseUntil > now || authority?.state !== "revoked"
      || !run?.isCurrent || run.state !== "observed" || run.messageId !== input.messageId || run.version !== current.runVersion
      || runs.some(row => row.leaseUntil && row.leaseUntil > now) || commands.length || hasUnsettledSavHumanAction(actions)) return conflict();
    const verified = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, execution.id)).for("update");
    const receipt = verified[0];
    if (verified.length !== 1 || receipt.id !== effect.id || receipt.state !== "confirmed"
      || receipt.intentCiphertext !== effect.intentCiphertext || !receipt.verificationCiphertext || !receipt.ackCiphertext
      || decryptSavPayload<EffectAck>(receipt.ackCiphertext).id !== ack.id) return conflict();
    const proof = decryptSavPayload<{confirmed?:boolean;attributed?:boolean;ack?:EffectAck}>(receipt.verificationCiphertext);
    if (proof.confirmed !== true || proof.attributed !== true || proof.ack?.id !== ack.id) return conflict();
    // Retire only the revoked continuation's scope; never fabricate success for
    // the remainder of its original plan or change the customer's CRM status.
    await releaseKeys(tx, execution.id);
    await tx.insert(auditLogs).values({ actorEmail: actor.email, action: "sav_existing_note_reconciled_for_closure",
      entityType: "sav_thread", entityId: input.threadId, technicalMetadata: {
        version: 1, messageId: input.messageId, executionId: execution.id, effectId: effect.id,
        noteId, ticketId: execution.ticketId, originalReceiptVerified: true, associationVerified: true,
        dispatch: false, executionStatePreserved: current.state, automaticAttemptsPreserved: true,
      } });
  });
  return { confirmed: 1 };
}
