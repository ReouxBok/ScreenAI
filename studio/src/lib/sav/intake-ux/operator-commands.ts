import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, staffUsers, savThreads, savMessages, savIntakeRuns, savIntakeHumanEvents, savIntakeExecutions, savIntakeEffects, savIntakeModelCalls } from "@/db/schema";
import { encryptSavPayload, decryptSavPayload } from "../crypto";
import { canAccessSav } from "../access";
import { readSavExternalCompletion } from "../external-completion";
import { executionAdministrator } from "../intake/execution-policy";
import { admissionLock } from "../intake/execution-store";
import { intakeHumanRefused, intakeRunConfigurationBound } from "../intake/human-binding";
import { savIntakeRuntimeConfig, intakeRuntimeHash, type IntakeRuntimePayload, type IntakeRuntimeConfig } from "../intake/runtime-contract";
import { savIntakeSourceSnapshot, intakeSourceMatches } from "../intake/runtime-store";
import { readRecoveryDue } from "../intake/read-recovery";
import { recordIntakeReinvestigation } from "../intake/operator-recovery";
import { readIntakeOperatorInformation } from "../intake/operator-information";
import { OPERATOR_COMMAND_ACTION, operatorInformationHash, type IntakeOperatorInformation } from "../intake/operator-information-contract";
import { operatorCommandSchema, type OperatorCommand, type OperatorReceipt, type OperatorStep } from "./operator-contract";
type Tx = Parameters<typeof admissionLock>[0];
type Body = { command: OperatorCommand; actorId: string; information?: IntakeOperatorInformation };
export const operatorCommandRow = (id: string) => and(eq(auditLogs.id, id), eq(auditLogs.action, OPERATOR_COMMAND_ACTION), eq(auditLogs.entityType, "sav_intake_operator_command"));
const conflict = (): never => { throw Error("SAV_INTAKE_OPERATOR_CONFLICT"); };
export const operatorBody = (row: typeof auditLogs.$inferSelect): Body => {
  const encrypted = row.technicalMetadata.payloadCiphertext;
  if (typeof encrypted !== "string") return conflict();
  const body = decryptSavPayload<Body>(encrypted);
  body.command = operatorCommandSchema.parse(body.command);
  if (body.command.requestKey !== row.id || body.command.threadId !== row.entityId || intakeRuntimeHash(body.command) !== row.technicalMetadata.commandHash) return conflict();
  return body;
};
/** Shared recording/worker guard: the client never selects a CRM operation. */
export async function guardOperatorCommand(tx: Tx, command: OperatorCommand, actorId: string, config: IntakeRuntimeConfig, now = new Date()) {
  const [actor] = await tx.select().from(staffUsers).where(eq(staffUsers.id, actorId)).for("update");
  const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, command.threadId)).for("update");
  const [run] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, command.runId)).for("update");
  const [message] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, command.threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  if (!actor?.active || !["admin", "owner"].includes(actor.role) || !canAccessSav(actor.email, actor.role)
    || !thread || thread.aiPaused || thread.mailboxId !== config.mailboxId || !run?.isCurrent || run.threadId !== thread.id
    || message?.id !== command.messageId || run.messageId !== message.id || run.version !== command.version || run.sourceHash !== command.sourceHash
    || message.receivedAt <= new Date(config.receivedAfter) || message.createdAt <= new Date(config.createdAfter)
    || run.leaseUntil && run.leaseUntil > now || await intakeHumanRefused(message.id, tx) || await readSavExternalCompletion(message, tx)
    || !await intakeRunConfigurationBound(run, config, tx)) return conflict();
  const snapshot = await savIntakeSourceSnapshot(tx, message, now);
  if (!intakeSourceMatches(snapshot, run.sourceHash)) return conflict();
  const pending = await tx.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.messageId, message.id), sql`${savIntakeHumanEvents.state} in ('pending','reading')`)).limit(1);
  const calls = await tx.select({ id: savIntakeModelCalls.id }).from(savIntakeModelCalls).where(and(eq(savIntakeModelCalls.messageKey, intakeRuntimeHash(message.id)), sql`${savIntakeModelCalls.state} in ('dispatched','uncertain')`)).limit(1);
  const [execution] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, message.id)).for("update");
  if (pending.length || calls.length || execution?.leaseUntil && execution.leaseUntil > now || execution && ["confirmed", "refused"].includes(execution.state)) return conflict();
  const effects = execution ? await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, execution.id)).for("update") : [];
  return { actor, run, message, snapshot, execution, effects, payload: decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext) };
}
export async function operatorResumeStep(guard: Awaited<ReturnType<typeof guardOperatorCommand>>, config: IntakeRuntimeConfig, now = new Date(), db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()): Promise<{ step: OperatorStep; nextAt?: string }> {
  const { run, execution, effects, payload } = guard;
  const uncertain = effects.filter(e => ["dispatched", "acked", "uncertain"].includes(e.state));
  if (uncertain.length) {
    const eligible = uncertain.filter(e => e.reconcileAttempts < 5);
    if (!eligible.length) return conflict();
    const next = Math.min(...eligible.map(e => e.nextReconcileAt?.getTime() ?? now.getTime()));
    return { step: "verify_only", nextAt: new Date(Math.max(now.getTime(), next)).toISOString() };
  }
  if (execution) return { step: "execution" };
  if (run.state === "observed" && payload.plan) return { step: "admission" };
  if (payload.readRecovery) {
    const retry = readRecoveryDue(payload.readRecovery, config, now, true);
    if (!retry || !payload.semantics?.records.some(r => r.method === "analyseMessage")) return conflict();
    return { step: "reads", nextAt: retry.retryAt };
  }
  const siblings = await db.select({ attempts: savIntakeRuns.attempts }).from(savIntakeRuns).where(eq(savIntakeRuns.messageId, run.messageId));
  if (!["pending", "waiting", "analysing"].includes(run.state) || siblings.reduce((sum, r) => sum + r.attempts, 0) >= 2 || run.humanChoiceCiphertext) return conflict();
  return { step: "analysis" };
}
export async function recordOperatorCommand(raw: unknown): Promise<OperatorReceipt> {
  const actor = await executionAdministrator(), command = operatorCommandSchema.parse(raw), config = savIntakeRuntimeConfig();
  if (!config) return conflict();
  await requireDb().transaction(async tx => {
    await admissionLock(tx);
    const [existing] = await tx.select().from(auditLogs).where(eq(auditLogs.id, command.requestKey));
    if (existing) {
      const body = operatorBody(existing);
      if (body.actorId !== actor.id || intakeRuntimeHash(body.command) !== intakeRuntimeHash(command)) return conflict();
      return;
    }
    const guarded = await guardOperatorCommand(tx, command, actor.id, config);
    const pending = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, OPERATOR_COMMAND_ACTION),eq(auditLogs.entityType,"sav_intake_operator_command"), eq(auditLogs.entityId, command.threadId),
      sql`${auditLogs.technicalMetadata}->>'messageId'=${command.messageId} and ${auditLogs.technicalMetadata}->>'state' in ('queued','running') and ${auditLogs.technicalMetadata}->>'runId'=${command.runId}`)).limit(1);
    if (pending.length) return conflict();
    const now = new Date(), body: Body = { command, actorId: actor.id };
    let selected: { step: OperatorStep; nextAt?: string } = { step: "reanalysis" };
    if (command.kind === "resume") selected = await operatorResumeStep(guarded, config, now, tx);
    else {
      if (guarded.effects.some(e => e.state !== "planned" || e.dispatchedAt || e.dispatchToken || e.ackCiphertext || e.confirmedAt || e.verificationCiphertext)) return conflict();
      if (command.kind === "information") {
        const prior = await readIntakeOperatorInformation(command.threadId, command.messageId, tx);
        if ((prior?.id ?? null) !== command.expectedInformationId) return conflict();
        if (prior?.text === command.information) return conflict();
        body.information = { id: command.requestKey, revision: (prior?.revision ?? 0) + 1, messageId: command.messageId, actorId: actor.id,
          at: now.toISOString(), text: command.information!, contentHash: operatorInformationHash(command.information!) };
      }
    }
    await tx.insert(auditLogs).values({ id: command.requestKey, actorEmail: actor.email, action: OPERATOR_COMMAND_ACTION, entityType: "sav_intake_operator_command", entityId: command.threadId, createdAt: now,
      technicalMetadata: { messageId: command.messageId, runId: command.runId, kind: command.kind, state: "queued", step: selected.step, nextAt: selected.nextAt ?? null,
        commandHash: intakeRuntimeHash(command), payloadCiphertext: encryptSavPayload(body) } });
    if (command.kind !== "resume") {
      const result = await recordIntakeReinvestigation(tx, actor, { threadId: command.threadId, messageId: command.messageId, reason: command.reason, commandKey: command.requestKey }, config, guarded.snapshot);
      const [row] = await tx.select().from(auditLogs).where(operatorCommandRow(command.requestKey));
      await tx.update(auditLogs).set({ technicalMetadata: { ...row.technicalMetadata, humanEventId: result.eventId, revisionRunId: result.runId } }).where(eq(auditLogs.id, row.id));
    }
  });
  return (await readOperatorReceipt({ requestKey: command.requestKey, threadId: command.threadId, messageId: command.messageId }))!;
}
export async function readOperatorReceipt(raw: { requestKey: string; threadId: string; messageId: string }): Promise<OperatorReceipt | null> {
  const actor = await executionAdministrator();
  const [row] = await requireDb().select().from(auditLogs).where(operatorCommandRow(raw.requestKey));
  if (!row) return null;
  const body = operatorBody(row), meta = row.technicalMetadata;
  if (body.actorId !== actor.id || body.command.threadId !== raw.threadId || body.command.messageId !== raw.messageId) return null;
  const receipt: OperatorReceipt = { id: row.id, step: meta.step as OperatorStep, state: String(meta.state), at: row.createdAt.toISOString(),
    ...(typeof meta.outcome === "string" ? { outcome: meta.outcome } : {}),
    ...(typeof meta.reason === "string" ? { reason: meta.reason } : {}), ...(typeof meta.nextAt === "string" ? { nextAt: meta.nextAt } : {}),
    ...(body.information ? { informationId: body.information.id } : {}) };
  if (typeof meta.humanEventId === "string") {
    const [event] = await requireDb().select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id, meta.humanEventId));
    receipt.state = event?.state ?? "waiting";
    if (event?.revisionRunId && event.state === "consumed") {
      const [run] = await requireDb().select().from(savIntakeRuns).where(eq(savIntakeRuns.id, event.revisionRunId));
      const payload = run ? decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext) : null;
      const accepted = payload?.semantics?.records.find(r => r.method === "analyseMessage" && (r.input as { message?: { operatorInformation?: { id: string } } })?.message?.operatorInformation?.id === body.information?.id);
      if (body.information) { if (accepted) receipt.consumedAt = accepted.acceptedAt; else receipt.state = "waiting"; }
    }
  }
  return receipt;
}

export async function readOperatorPanel(binding: Pick<OperatorCommand, "threadId" | "messageId" | "runId" | "version" | "sourceHash">) {
  const actor = await executionAdministrator();
  const information = await readIntakeOperatorInformation(binding.threadId, binding.messageId);
  const requests:Partial<Record<OperatorCommand["kind"],{command:OperatorCommand;receipt:OperatorReceipt}>>={};
  for(const kind of ["resume","reanalyse","information"] as const){
    const [row]=await requireDb().select().from(auditLogs).where(and(eq(auditLogs.action,OPERATOR_COMMAND_ACTION),eq(auditLogs.entityType,"sav_intake_operator_command"),eq(auditLogs.entityId,binding.threadId),eq(auditLogs.actorEmail,actor.email),
      sql`${auditLogs.technicalMetadata}->>'messageId'=${binding.messageId} and ${auditLogs.technicalMetadata}->>'kind'=${kind}`)).orderBy(desc(auditLogs.createdAt),desc(auditLogs.id)).limit(1);
    if(row){const body=operatorBody(row);const receipt=await readOperatorReceipt({requestKey:row.id,threadId:binding.threadId,messageId:binding.messageId});if(receipt)requests[kind]={command:body.command,receipt};}
  }
  let allowResume = false, allowInformation = false, allowReanalysis = false;
  let resume: { step: OperatorStep; nextAt?: string } | null = null;
  const unavailableReason = "Le dossier est protégé par sa version, une pause, un traitement en cours, des tentatives épuisées ou un résultat à vérifier. Rechargez ses preuves avant de poursuivre.";
  try {
    const config = savIntakeRuntimeConfig(); if (!config) throw Error();
    await requireDb().transaction(async tx => {
      await admissionLock(tx);
      const command: OperatorCommand = { ...binding, requestKey: binding.runId, kind: "resume", reason: "Lecture des possibilités de reprise." };
      const guard = await guardOperatorCommand(tx, command, actor.id, config);
      allowInformation = !guard.effects.some(e => e.state !== "planned" || e.dispatchedAt || e.dispatchToken || e.ackCiphertext || e.verificationCiphertext || e.confirmedAt);
      allowReanalysis = allowInformation;
      const events = await tx.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.messageId, binding.messageId));
      for (const event of events) {
        const body = decryptSavPayload<{ reinvestigate?: true }>(event.payloadCiphertext);
        if (!body.reinvestigate) continue;
        const [parent] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, event.parentRunId));
        const input = parent ? decryptSavPayload<IntakeRuntimePayload>(parent.payloadCiphertext).input as { message?: { operatorInformation?: { id: string } } } | undefined : undefined;
        if ((input?.message?.operatorInformation?.id ?? null) === (information?.id ?? null)) allowReanalysis = false;
      }
      try { resume = await operatorResumeStep(guard, config, new Date(), tx); allowResume = true; } catch { /* Unavailable is explicit. */ }
    });
  } catch { /* No permission or eligibility is inferred from a display. */ }
  return { information, requests, allowResume, allowInformation, allowReanalysis, resume, unavailableReason };
}
