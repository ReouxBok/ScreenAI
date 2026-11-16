import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, staffUsers, savActions, savThreads, savMessages, savIntakeRuns, savIntakeExecutions, savIntakeHumanEvents } from "@/db/schema";
import { canAccessSav } from "../access";
import { lockSavSharedSpend } from "../shared-spend";
import { decryptSavPayload } from "../crypto";
import { hasUnsettledSavHumanAction, readSavExternalCompletion } from "../external-completion";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";
import { executionAdministrator } from "./execution-policy";
import { activeExecutionEffects, admissionLock, claimEffectRecovery, confirmExecutionEffect, releaseEffectRecovery, withEffectRecoveryLease, type ExecutionTx } from "./execution-store";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import { readSavAgentPause, savAgentPauseCode } from "./agent-pause";
import { intakeRuntimeHash } from "./runtime-contract";
import { intakeVersionStillCurrent, type IntakeVersionPrecondition } from "./version-precondition";
import type { Effect, EffectAck, EffectIntent, Execution, ExecutorAdapters } from "./execution-types";

/** Strict: no caller-supplied object id, ack or effect id is ever accepted. */
const request = z.object({ threadId: z.uuid(), messageId: z.uuid() }).strict();
const refuse = (code: string): never => { throw Error(`SAV_INTAKE_EFFECT_RECONCILIATION_${code}`); };
/** V1 CRM writes whose existence AND attribution the read-only adapter proves from a stored
 * receipt or a stored object id. Excluded: Gmail sends (their own reconcile_identification path),
 * stage_new/owner_assign (a ticket state proves no authorship), ticket_create (finalization and
 * owner proof stay with the worker) and V2 kinds (no V1 verify). */
export const RECONCILABLE_EFFECT_KINDS = ["note_create", "note_associate", "email_create", "email_associate"] as const;
const reconcilable: ReadonlySet<string> = new Set(RECONCILABLE_EFFECT_KINDS);
const engaged = ["dispatched", "acked", "uncertain"];
const numeric = (v: unknown): v is string => typeof v === "string" && /^\d{1,30}$/.test(v);
const ackOf = (e: Effect) => e.ackCiphertext ? decryptSavPayload<EffectAck>(e.ackCiphertext) : null;
const intentOf = (e: Effect) => decryptSavPayload<EffectIntent>(e.intentCiphertext);

type Actor = Awaited<ReturnType<typeof executionAdministrator>>;
type Selected = { effect: Effect; intent: EffectIntent; ack: EffectAck | null; expectedId: string };

/** The unique unsettled effect, its stored receipt and its confirmed dependencies. Null when every
 * effect is already confirmed (idempotent no-op). Never reads anything the caller supplied. */
function selectEffect(execution: Execution, effects: Effect[], messageId: string): Selected | null {
  const open = effects.filter(e => e.state !== "confirmed");
  if (!open.length) return null;
  if (open.length !== 1) return refuse("MULTIPLE_UNSETTLED");
  const effect = open[0];
  if (!engaged.includes(effect.state) || !effect.dispatchedAt) return refuse("NOT_DISPATCHED");
  if (!reconcilable.has(effect.kind)) return refuse("KIND_UNSUPPORTED");
  const intent = intentOf(effect), ack = ackOf(effect);
  if (intent.kind !== effect.kind || intent.key !== effect.businessKey || intent.sourceMessageId !== messageId) return refuse("INTENT_MISMATCH");
  if (ack?.operatorCandidate === true) return refuse("ACK_NOT_PROVIDER");
  const confirmed = (kind: string) => effects.filter(e => e.kind === kind && e.state === "confirmed");
  const creation = effects.find(e => e.kind === "ticket_create");
  // Final ticket: the admitted one, or the confirmed provider receipt of this execution's creation.
  const ticketId = execution.ticketId ?? (creation?.state === "confirmed" ? ackOf(creation)?.id ?? null : null);
  if (!numeric(ticketId) || intent.ticketId !== ticketId) return refuse("DEPENDENCY_UNCONFIRMED");
  if (effect.kind === "note_create" || effect.kind === "email_create") {
    // A creation is attributable only through the provider's own receipt. Matching content
    // (even exact, even on the right ticket) never identifies this attempt's object.
    if (!numeric(ack?.id)) return refuse("ACK_MISSING");
    if (intent.objectId && intent.objectId !== ack.id) return refuse("ACK_CONFLICT");
    return { effect, intent, ack, expectedId: ack.id };
  }
  // Associations: the object id is the stored one, taken from the confirmed creation's receipt.
  const createKind = effect.kind === "note_associate" ? "note_create" : "email_create";
  const creations = confirmed(createKind);
  if (creations.length !== 1) return refuse("DEPENDENCY_UNCONFIRMED");
  const created = creations[0], createdId = ackOf(created)?.id;
  if (!numeric(createdId) || intent.objectId !== createdId || ack?.id && ack.id !== createdId) return refuse("DEPENDENCY_UNCONFIRMED");
  if (effect.kind === "note_associate" && (intent.confirmedNoteCreate?.effectId !== created.id || intent.confirmedNoteCreate.objectId !== createdId))
    return refuse("DEPENDENCY_UNCONFIRMED");
  if (intakeRuntimeHash(intent.expectedProperties ?? null) !== intakeRuntimeHash(intentOf(created).properties ?? null)) return refuse("DEPENDENCY_UNCONFIRMED");
  return { effect, intent, ack, expectedId: createdId };
}

/** Every local fence of the existing administrative reconciliations, read under the caller's locks.
 * Without `token`: no execution lease may be active. With it: only this call's recovery lease.
 * ONE lock order for the pre-check and the confirmation (review Astra on 8958159):
 *   admission advisory lock -> execution -> thread -> staff -> runs -> agent-pause (shared budget) advisory lock
 *   (-> console via the version check -> effect row on confirmation).
 * It extends existing orders without a cycle: withEffectRecoveryLease (admission -> execution),
 * reconcile_note (admission -> execution -> thread -> staff -> runs), model reservations
 * (runtime-store assertLease/assertHumanAnalysis: thread -> run -> budget lock) and setSavAgentPause
 * (budget lock alone). The budget lock is transaction-scoped and taken BEFORE the pause is read: a
 * pause committed by setSavAgentPause either precedes this read or waits for this transaction's
 * commit, so no effect is confirmed under a pause recorded in between. */
async function assertLocal(tx: ExecutionTx, actor: Actor, input: z.infer<typeof request>, snapshot: Execution, expected: IntakeVersionPrecondition | undefined, token?: string) {
  const now = new Date();
  await admissionLock(tx);
  const [current] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, snapshot.id)).for("no key update");
  const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, input.threadId)).for("update");
  const [staff] = await tx.select().from(staffUsers).where(eq(staffUsers.id, actor.id)).for("update");
  const [latest] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, input.threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  const runs = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.threadId, input.threadId)).for("update");
  await lockSavSharedSpend(tx);
  if (!staff?.active || !["admin", "owner"].includes(staff.role) || staff.email !== actor.email || staff.clerkId !== actor.clerkId
    || !canAccessSav(staff.email, staff.role)) return refuse("UNAUTHORIZED");
  // Any agent pause level stops this operator path too: nothing may be handed back while paused.
  if (savAgentPauseCode(await readSavAgentPause(tx))) return refuse("LOCKED");
  const run = runs.find(row => row.id === snapshot.runId);
  const commands = await tx.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents).where(and(
    eq(savIntakeHumanEvents.threadId, input.threadId), inArray(savIntakeHumanEvents.state, ["pending", "reading", "waiting"])));
  const actions = await tx.select().from(savActions).where(eq(savActions.threadId, input.threadId));
  const lease = token ? current?.leaseToken === token && Boolean(current.leaseUntil && current.leaseUntil > now) : !(current?.leaseUntil && current.leaseUntil > now);
  // thread.aiPaused covers both a manual pause and a human hold.
  if (!thread || thread.aiPaused || latest?.id !== input.messageId || commands.length || hasUnsettledSavHumanAction(actions)
    || runs.some(row => row.leaseUntil && row.leaseUntil > now) || !lease) return refuse("LOCKED");
  if (await readSavExternalCompletion(latest, tx)) return refuse("LOCKED");
  if (!current || current.state !== "uncertain" || current.threadId !== input.threadId || current.messageId !== input.messageId
    || current.payloadCiphertext !== snapshot.payloadCiphertext || current.runId !== snapshot.runId || current.runVersion !== snapshot.runVersion
    || current.policyId !== snapshot.policyId || current.ticketId !== snapshot.ticketId
    || !run?.isCurrent || run.state !== "observed" || run.messageId !== input.messageId || run.version !== current.runVersion) return refuse("CHANGED");
  if (expected && !await intakeVersionStillCurrent(tx, input.threadId, expected)) return refuse("CHANGED");
}

/** Administrative, read-only reconciliation of the ONE unsettled effect of the current message's
 * uncertain V1 execution, from its existing receipt. Never dispatches, never accepts an id from the
 * caller, never resets attempts, budget or leases. It writes only a verified, attributed proof for
 * the very receipt already stored; any other outcome refuses and changes nothing. A fully confirmed
 * execution is then left to the normal worker (no closure, no send is forced here). */
export async function reconcileIntakeUncertainEffect(raw: unknown, expected?: IntakeVersionPrecondition,
  adapters: Pick<ExecutorAdapters, "verify"> = createIntakeExecutorAdapters()) {
  const actor = await executionAdministrator(), input = request.parse(raw), db = requireDb();
  const [execution] = await db.select().from(savIntakeExecutions).where(and(
    eq(savIntakeExecutions.threadId, input.threadId), eq(savIntakeExecutions.messageId, input.messageId)));
  if (!execution) return refuse("NOT_UNCERTAIN");
  if (execution.state !== "uncertain") return refuse("NOT_UNCERTAIN");
  // Read-only pre-check: a refusal here holds no lease and writes nothing.
  const planned = await db.transaction(async tx => {
    await assertLocal(tx, actor, input, execution, expected);
    return selectEffect(execution, await activeExecutionEffects(execution.id, tx), input.messageId);
  });
  if (!planned) return { reconciled: false as const, alreadyConfirmed: true as const };
  const lease = await claimEffectRecovery(execution.id);
  if (!lease) return refuse("BUSY");
  try {
    const { effect, intent, ack, expectedId } = planned;
    const proof = await adapters.verify(intent, ack, effect.dispatchedAt!, AbortSignal.timeout(15000));
    if (!proof.confirmed || !proof.attributed || proof.ack?.id !== expectedId) return refuse("NOT_PROVEN");
    const persisted = await withEffectRecoveryLease(lease, async tx => {
      await assertLocal(tx, actor, input, execution, expected, lease.token);
      const again = selectEffect(execution, await activeExecutionEffects(execution.id, tx), input.messageId);
      if (!again) return refuse("CHANGED");
      const latest = again.effect;
      if (latest.id !== effect.id || latest.attemptId !== effect.attemptId || latest.state !== effect.state
        || latest.intentCiphertext !== effect.intentCiphertext || latest.ackCiphertext !== effect.ackCiphertext || again.expectedId !== expectedId) return refuse("CHANGED");
      await confirmExecutionEffect(latest, proof, proof.ack, tx);
      await tx.insert(auditLogs).values({ actorEmail: actor.email, action: "sav_intake_effect_reconciled_from_receipt",
        entityType: "sav_thread", entityId: input.threadId, technicalMetadata: {
          version: 1, messageId: input.messageId, executionId: execution.id, effectId: effect.id, kind: effect.kind, objectId: expectedId,
          receipt: ack?.id ? "stored_ack" : "stored_object_id", previousState: effect.state, reconcileAttemptsPreserved: effect.reconcileAttempts,
          dispatch: false, executionStatePreserved: "uncertain",
        } });
      return { kind: effect.kind, objectId: expectedId };
    });
    if (!persisted.owned) return refuse("BUSY");
    return { reconciled: true as const, ...persisted.value };
  } finally { await releaseEffectRecovery(lease); }
}
