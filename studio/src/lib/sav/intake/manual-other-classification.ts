import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savThreads, savMessages, savIntakeRuns, savIntakeConsole, savIntakeExecutions, savIntakeEffects, savIntakeHumanEvents, savActions } from "@/db/schema";
import { classifySavDossierOtherManually, readSavExternalCompletion, savExternalDisposition } from "../external-completion";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { savEffectiveReceivedAt, savNotAfterAnchor } from "../message-order";
import { executionAdministrator } from "./execution-policy";
import { intakeDossierSensitive } from "./observation-binding";
import { readIntakeLaunch } from "./launch-boundary";
import { savIntakeSourceSnapshot } from "./runtime-store";
import { OPERATOR_COMMAND_ACTION } from "./operator-information-contract";
import type { HumanEventPayload } from "./human-binding";
import { intakeRuntimeHash } from "./runtime-contract";

export const MANUAL_OTHER_REVISION = "sav-intake-manual-other.v1";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingFields = { revision: z.literal(MANUAL_OTHER_REVISION), threadId: z.uuid(), messageId: z.uuid(),
  expectedEpoch: z.number().int().positive(), runId: z.uuid(), version: z.number().int().positive(),
  runSourceHash: hash.nullable(), sourceHash: hash };
const bindingSchema = z.object(bindingFields).strict();
const commandSchema = z.object({ ...bindingFields, requestKey: z.uuid(), reason: z.string().trim().min(10).max(2000), confirmed: z.literal(true) }).strict();
export type ManualOtherBinding = z.infer<typeof bindingSchema>;
type Tx = Parameters<NonNullable<Parameters<typeof classifySavDossierOtherManually>[1]>>[0];

/** Read the source the operator is about to classify, including pending runs with
 * no AI result. An absent current run remains ineligible. A GET only reads and never records a command. */
export async function readManualOtherBinding(threadId: string, messageId: string, expectedEpoch: number): Promise<ManualOtherBinding | null> {
  const actor = await executionAdministrator();
  if (actor.email !== "ugo@limova.ai") return null;
  try {
    return await requireDb().transaction(async tx => {
      const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, threadId));
      const [projection] = await tx.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, threadId));
      const [message] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
        .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
      if (!thread || thread.aiPaused || !projection || projection.epoch !== expectedEpoch || !waiting(projection)
        || message?.id !== messageId || message.mailboxId !== thread.mailboxId || await readSavExternalCompletion(message, tx)
        || await intakeDossierSensitive(threadId, thread.hubspotTicketId, tx)) return null;
      const [run] = await tx.select().from(savIntakeRuns).where(and(eq(savIntakeRuns.threadId, threadId), eq(savIntakeRuns.isCurrent, true)));
      if (!run || run.messageId !== messageId) return null;
      const snapshot = await savIntakeSourceSnapshot(tx, message, new Date());
      if (!snapshot.input.message.contentComplete) return null;
      return bindingSchema.parse({ revision: MANUAL_OTHER_REVISION, threadId, messageId, expectedEpoch,
        runId: run.id, version: run.version, runSourceHash: run.sourceHash, sourceHash: snapshot.sourceHash });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch { return null; }
}
function waiting(projection: { view: string | null; status: string }) {
  return (projection.view === "to_validate" || projection.view === null) && projection.status !== "historical_outside_automation";
}

/** Human judgement only. The canonical operation owns auth, admission/thread
 * locks, unsettled commands/effects, active leases, audit, invalidation and retry
 * idempotence. This guard adds exact UI/source/run binding and business vetoes. */
export async function classifyValidSourceAsOther(raw: unknown) {
  // Strict one-version command: no guessed defaults, hidden classification or model verdict.
  const command = commandSchema.parse(raw), commandHash = intakeRuntimeHash(command);
  return classifySavDossierOtherManually({ requestKey: command.requestKey, threadId: command.threadId, messageId: command.messageId, confirmed: command.confirmed }, async (tx: Tx, message) => {
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, message.threadId));
    if (!thread || thread.aiPaused || message.mailboxId !== thread.mailboxId) return false;
    const launch = await readIntakeLaunch(thread.mailboxId, tx);
    if (!launch || message.receivedAt <= new Date(launch.receivedAfter) || message.createdAt <= new Date(launch.createdAfter)
      || await intakeDossierSensitive(thread.id, thread.hubspotTicketId, tx)) return false;
    const [run] = await tx.select().from(savIntakeRuns).where(and(eq(savIntakeRuns.threadId, thread.id), eq(savIntakeRuns.isCurrent, true))).for("update");
    if (!run || run.id !== command.runId || run.version !== command.version || run.sourceHash !== command.runSourceHash
      || run.messageId !== message.id) return false;
    await tx.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, message.threadId), savNotAfterAnchor(message.id)))
      .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(51).for("update");
    const snapshot = await savIntakeSourceSnapshot(tx, message, new Date());
    if (!snapshot.input.message.contentComplete || snapshot.sourceHash !== command.sourceHash) return false;
    // A consumed orientation without an external effect is not a pending write.
    // A refusal, known sensitive correction or any engaged result stays protected.
    const [pendingOperator] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, OPERATOR_COMMAND_ACTION),
      eq(auditLogs.entityType, "sav_intake_operator_command"), eq(auditLogs.entityId, thread.id),
      sql`${auditLogs.technicalMetadata}->>'messageId'=${message.id} and ${auditLogs.technicalMetadata}->>'state' in ('queued','running')`)).limit(1);
    if (pendingOperator) return false;
    const choices = await tx.select().from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.threadId, thread.id), eq(savIntakeHumanEvents.messageId, message.id)));
    if (choices.some(choice => choice.kind === "refuse" || ["finance", "cancellation"].includes(decryptSavPayload<HumanEventPayload>(choice.payloadCiphertext).classification ?? ""))) return false;
    const executions = await tx.select().from(savIntakeExecutions).where(and(eq(savIntakeExecutions.threadId, thread.id), eq(savIntakeExecutions.messageId, message.id))).for("update");
    if (executions.some(execution => execution.state === "confirmed")) return false;
    const effects = executions.length ? await tx.select().from(savIntakeEffects).where(inArray(savIntakeEffects.executionId, executions.map(execution => execution.id))).for("update") : [];
    if (effects.some(effect => effect.state !== "planned" || effect.dispatchedAt || effect.dispatchToken || effect.ackCiphertext || effect.verificationCiphertext || effect.confirmedAt)) return false;
    const legacy = await tx.select().from(savActions).where(eq(savActions.threadId, thread.id));
    if (legacy.some(action => ["pending", "running"].includes(action.status)
      || action.messageId === message.id && (action.payload.ticketCreateDispatchedAt || action.payload.ticketReturnDispatchedAt || action.payload.replySendDispatchedAt || action.payload.forwardDispatchedAt || action.payload.intakeOccupationDispatchedAt))) return false;
    const previous = await readSavExternalCompletion(message, tx);
    if (previous) return previous.technicalMetadata.batchId === command.requestKey && savExternalDisposition(previous).view === "other"
      && previous.technicalMetadata.manualOtherRevision === MANUAL_OTHER_REVISION && previous.technicalMetadata.manualOtherCommandHash === commandHash;
    const [projection] = await tx.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, thread.id)).for("update");
    if (!projection || projection.epoch !== command.expectedEpoch || !waiting(projection)) return false;
    return { manualOther: { revision: MANUAL_OTHER_REVISION, commandHash, sourceHash: snapshot.sourceHash,
      runId: command.runId, runVersion: command.version, reasonCiphertext: encryptSavPayload({ reason: command.reason, confirmed: true }) } };
  });
}
