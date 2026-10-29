import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savThreads, savMessages, savIntakeRuns, savIntakeConsole, savIntakeExecutions, savIntakeEffects, savIntakeHumanEvents, savActions } from "@/db/schema";
import { classifySavDossierOtherManually, readSavExternalCompletion, savExternalDisposition, hasUnsettledSavIntakeWork } from "../external-completion";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { savEffectiveReceivedAt, savNotAfterAnchor } from "../message-order";
import { executionAdministrator } from "./execution-policy";
import { intakeDossierSensitive } from "./observation-binding";
import { readIntakeLaunch } from "./launch-boundary";
import { savIntakeSourceSnapshot } from "./runtime-store";
import { OPERATOR_COMMAND_ACTION } from "./operator-information-contract";
import type { HumanEventPayload } from "./human-binding";
import { intakeRuntimeHash } from "./runtime-contract";
import { savAttachmentInventorySchema, savAttachmentMetadataSchema } from "../attachment-contract";
import { intakeHtmlDocumentText } from "./html-message";

export const MANUAL_OTHER_REVISION = "sav-intake-manual-other.v2";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bindingFields = { revision: z.literal(MANUAL_OTHER_REVISION), threadId: z.uuid(), messageId: z.uuid(),
  expectedEpoch: z.number().int().positive(), runId: z.uuid(), version: z.number().int().positive(),
  runSourceHash: hash.nullable(), sourceHash: hash, attachmentCount: z.number().int().min(0).max(100) };
const bindingSchema = z.object(bindingFields).strict();
const commandSchema = z.object({ ...bindingFields, requestKey: z.uuid(), reason: z.string().trim().min(10).max(2000), confirmed: z.literal(true) }).strict();
export type ManualOtherBinding = z.infer<typeof bindingSchema>;
type Tx = Parameters<NonNullable<Parameters<typeof classifySavDossierOtherManually>[1]>>[0];

export const manualOtherUnavailableLabels = {
  unauthorized: "Ce classement est réservé à Ugo, administrateur actif.",
  paused: "Une pause humaine protège ce dossier.",
  binding_changed: "Le dossier ou sa version a changé. Rechargez ses preuves.",
  not_waiting: "Ce dossier n’attend pas un classement humain.",
  already_handled: "Ce message a déjà reçu un classement administratif.",
  sensitive: "Une demande sensible est connue dans ce dossier.",
  current_run_missing: "Aucune version courante ne correspond au dernier message.",
  source_text_incomplete: "Le texte intégral du message n’est pas disponible pour ce classement.",
  inventory_incomplete: "L’inventaire des pièces jointes est incomplet ou non certifié.",
  active_worker: "Un traitement est encore actif. Attendez sa fin et rechargez le dossier.",
  pending_command: "Une commande humaine reste à vérifier.",
  human_refusal: "Un refus humain protège ce dossier.",
  effects_engaged: "Une action engagée ou son résultat reste à vérifier.",
  outside_launch: "Ce message est hors du périmètre lancé.",
  read_failed: "Les preuves n’ont pas pu être relues. Aucun classement n’est disponible.",
} as const;
export type ManualOtherUnavailableReason = keyof typeof manualOtherUnavailableLabels;
export type ManualOtherEligibility = { binding: ManualOtherBinding | null; reason: ManualOtherUnavailableReason | null };
type Snapshot = Awaited<ReturnType<typeof savIntakeSourceSnapshot>>;
/** Human review requires whole message text and an exhaustive attachment inventory,
 * independently of AI attachment reading. The unchanged source hash binds both. */
function humanSourceReview(snapshot: Snapshot): { reason: "source_text_incomplete" | "inventory_incomplete" | null; attachmentCount: number } {
  const body = snapshot.body;
  if (!snapshot.provenance.get(snapshot.input.message.id)?.textComplete || !intakeHtmlDocumentText(body.text).trim())
    return { reason: "source_text_incomplete", attachmentCount: 0 };
  const attachments = savAttachmentMetadataSchema.array().max(100).safeParse(body.attachments ?? []);
  const inventory = savAttachmentInventorySchema.safeParse(body.attachmentInventory);
  if (!attachments.success || (attachments.data.length > 0 || body.attachmentInventory !== undefined) && (!inventory.success || !inventory.data.complete))
    return { reason: "inventory_incomplete", attachmentCount: 0 };
  return { reason: null, attachmentCount: attachments.data.length };
}
function waiting(projection: { view: string | null; status: string }) {
  return (projection.view === "to_validate" || projection.view === null)
    && !["historical_outside_automation", "paused", "human_hold", "human_refused", "human_revalidation"].includes(projection.status);
}
/** GET is read-only, gives bounded reasons, and never queues analysis or a command.
 * Processing is represented by view=null; only a non-active run can be classified. */
export async function readManualOtherEligibility(threadId: string, messageId: string, expectedEpoch: number): Promise<ManualOtherEligibility> {
  const actor = await executionAdministrator();
  const unavailable = (reason: ManualOtherUnavailableReason): ManualOtherEligibility => ({ binding: null, reason });
  if (actor.email !== "ugo@limova.ai") return unavailable("unauthorized");
  try {
    return await requireDb().transaction(async tx => {
      const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, threadId));
      const [projection] = await tx.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, threadId));
      const [message] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
        .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
      if (!thread || !projection || projection.epoch !== expectedEpoch || message?.id !== messageId || message.mailboxId !== thread.mailboxId) return unavailable("binding_changed");
      if (thread.aiPaused) return unavailable("paused");
      if (await readSavExternalCompletion(message, tx)) return unavailable("already_handled");
      if (!waiting(projection)) return unavailable("not_waiting");
      const launch = await readIntakeLaunch(thread.mailboxId, tx);
      if (!launch || message.receivedAt <= new Date(launch.receivedAfter) || message.createdAt <= new Date(launch.createdAfter)) return unavailable("outside_launch");
      if (await intakeDossierSensitive(threadId, thread.hubspotTicketId, tx)) return unavailable("sensitive");
      const runs = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.threadId, threadId));
      const run = runs.find(value => value.isCurrent);
      if (!run || run.messageId !== messageId) return unavailable("current_run_missing");
      const executions = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.threadId, threadId));
      if (!["pending", "waiting", "observed", "uncertain"].includes(run.state) || [...runs, ...executions].some(value => value.leaseUntil && value.leaseUntil > new Date())) return unavailable("active_worker");
      const choices = await tx.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.threadId, threadId));
      if (choices.some(choice => ["pending", "reading", "waiting"].includes(choice.state))) return unavailable("pending_command");
      if (choices.some(choice => choice.messageId === messageId && choice.kind === "refuse")) return unavailable("human_refusal");
      if (choices.some(choice => choice.messageId === messageId && ["finance", "cancellation"].includes(decryptSavPayload<HumanEventPayload>(choice.payloadCiphertext).classification ?? ""))) return unavailable("sensitive");
      const [pendingOperator] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, OPERATOR_COMMAND_ACTION), eq(auditLogs.entityType, "sav_intake_operator_command"), eq(auditLogs.entityId, threadId),
        sql`${auditLogs.technicalMetadata}->>'messageId'=${messageId} and ${auditLogs.technicalMetadata}->>'state' in ('queued','running')`)).limit(1);
      if (pendingOperator) return unavailable("pending_command");
      const effects = executions.length ? await tx.select().from(savIntakeEffects).where(inArray(savIntakeEffects.executionId, executions.map(value => value.id))) : [];
      if (await hasUnsettledSavIntakeWork(threadId, tx) || executions.some(value => value.messageId === messageId && value.state === "confirmed") || effects.some(effect => executions.some(execution => execution.id === effect.executionId && execution.messageId === messageId) && effectEngaged(effect))) return unavailable("effects_engaged");
      const legacy = await tx.select().from(savActions).where(eq(savActions.threadId, threadId));
      if (legacy.some(action => ["pending", "running"].includes(action.status) || action.messageId === messageId && (action.payload.ticketCreateDispatchedAt || action.payload.ticketReturnDispatchedAt || action.payload.replySendDispatchedAt || action.payload.forwardDispatchedAt || action.payload.intakeOccupationDispatchedAt))) return unavailable("effects_engaged");
      const snapshot = await savIntakeSourceSnapshot(tx, message, new Date()), review = humanSourceReview(snapshot);
      if (review.reason) return unavailable(review.reason);
      return { reason: null, binding: bindingSchema.parse({ revision: MANUAL_OTHER_REVISION, threadId, messageId, expectedEpoch,
        runId: run.id, version: run.version, runSourceHash: run.sourceHash, sourceHash: snapshot.sourceHash, attachmentCount: review.attachmentCount }) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch { return unavailable("read_failed"); }
}
export async function readManualOtherBinding(threadId: string, messageId: string, expectedEpoch: number): Promise<ManualOtherBinding | null> {
  return (await readManualOtherEligibility(threadId, messageId, expectedEpoch)).binding;
}
function effectEngaged(effect: typeof savIntakeEffects.$inferSelect) {
  return effect.state !== "planned" || Boolean(effect.dispatchedAt || effect.dispatchToken || effect.ackCiphertext || effect.verificationCiphertext || effect.confirmedAt);
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
      || run.messageId !== message.id || !["pending", "waiting", "observed", "uncertain"].includes(run.state)) return false;
    await tx.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, message.threadId), savNotAfterAnchor(message.id)))
      .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(51).for("update");
    const snapshot = await savIntakeSourceSnapshot(tx, message, new Date());
    const review = humanSourceReview(snapshot);
    if (review.reason || review.attachmentCount !== command.attachmentCount || snapshot.sourceHash !== command.sourceHash) return false;
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
    if (effects.some(effectEngaged)) return false;
    const legacy = await tx.select().from(savActions).where(eq(savActions.threadId, thread.id));
    if (legacy.some(action => ["pending", "running"].includes(action.status)
      || action.messageId === message.id && (action.payload.ticketCreateDispatchedAt || action.payload.ticketReturnDispatchedAt || action.payload.replySendDispatchedAt || action.payload.forwardDispatchedAt || action.payload.intakeOccupationDispatchedAt))) return false;
    const previous = await readSavExternalCompletion(message, tx);
    if (previous) return previous.technicalMetadata.batchId === command.requestKey && savExternalDisposition(previous).view === "other"
      && previous.technicalMetadata.manualOtherRevision === MANUAL_OTHER_REVISION && previous.technicalMetadata.manualOtherCommandHash === commandHash;
    const [projection] = await tx.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, thread.id)).for("update");
    if (!projection || projection.epoch !== command.expectedEpoch || !waiting(projection)) return false;
    return { manualOther: { revision: MANUAL_OTHER_REVISION, commandHash, sourceHash: snapshot.sourceHash,
      runId: command.runId, runVersion: command.version, reasonCiphertext: encryptSavPayload({ reason: command.reason, confirmed: true, sourceReview: { kind: "human_text_and_inventory", attachmentCount: review.attachmentCount, attachmentAnalysisRequired: false } }) } };
  });
}
