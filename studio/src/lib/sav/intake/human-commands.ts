import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { staffUsers, savThreads, savMessages, savIntakeRuns, savIntakeHumanEvents, savIntakeExecutions, savIntakeEffects, auditLogs } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { canAccessSav } from "../access";
import { admissionLock, releaseKeys } from "./execution-store";
import { intakeRuntimeHash, type IntakeRuntimePayload } from "./runtime-contract";
import { intakeConsoleInstalled } from "./console-capability";
import { intakeHumanRefused, type HumanEventPayload } from "./human-binding";
import { requireIntakeConsoleStaff } from "./console-auth";
import { savIntakeSourceSnapshot } from "./runtime-store";
export const intakeHumanCommandSchema = z.object({
  commandKey: z.uuid(), threadId: z.uuid(), messageId: z.uuid(), runId: z.uuid(), version: z.number().int().positive(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), candidatesHash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["select", "classify", "refuse"]), contactId: z.string().regex(/^\d{1,30}$/).optional(),
  ticketId: z.string().regex(/^\d{1,30}$/).optional(),
  classification: z.enum(["support", "finance", "cancellation", "other", "partnership", "commercial", "investor"]).optional(),
  reason: z.string().trim().min(10).max(2000),
}).strict();
export type IntakeHumanCommand = z.infer<typeof intakeHumanCommandSchema>;
/** No model, CRM or Gmail capability exists in this module. The UI records a
 * conditional local choice. Only the worker can revalidate current CRM facts. */
export async function recordIntakeHumanCommand(raw: unknown) {
  const staff = await requireIntakeConsoleStaff(), command = intakeHumanCommandSchema.parse(raw);
  if (!await intakeConsoleInstalled()) throw Error("SAV_INTAKE_CONSOLE_MIGRATION_REQUIRED");
  return requireDb().transaction(async tx => {
    await admissionLock(tx);
    const [actor] = await tx.select().from(staffUsers).where(eq(staffUsers.id, staff.id)).for("update");
    if (!actor?.active || !canAccessSav(actor.email, actor.role)) throw Error("SAV_INTAKE_CONSOLE_UNAUTHORIZED");
    const [replayed] = await tx.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.commandKey, command.commandKey));
    if (replayed) {
      const body = decryptSavPayload<HumanEventPayload & { commandHash: string }>(replayed.payloadCiphertext);
      if (body.actor.id !== actor.id || body.commandHash !== intakeRuntimeHash(command)) throw Error("SAV_INTAKE_HUMAN_CONFLICT");
      return { eventId: replayed.id, status: "recorded" as const };
    }
    const [execution] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, command.messageId)).for("update");
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, command.threadId)).for("update");
    const [run] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, command.runId)).for("update");
    const [message] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, command.threadId), eq(savMessages.direction, "inbound")))
      .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    const pending = await tx.select().from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.parentRunId, command.runId), inArray(savIntakeHumanEvents.state, ["pending", "reading"])));
    if (!thread || thread.aiPaused || !run?.isCurrent || run.threadId !== thread.id || run.messageId !== command.messageId
      || message?.id !== command.messageId || run.version !== command.version || run.sourceHash !== command.sourceHash || pending.length
      || (await savIntakeSourceSnapshot(tx, message, new Date())).sourceHash !== run.sourceHash || await intakeHumanRefused(command.messageId, tx)) throw Error("SAV_INTAKE_HUMAN_CONFLICT");
    const payload = decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext), candidates = [...(payload.plan?.candidateContactIds ?? [])].sort();
    const receipts = execution ? await tx.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId,execution.id),eq(savIntakeEffects.kind,"ticket_create"),eq(savIntakeEffects.state,"confirmed"))) : [];
    const confirmedTicketIds = receipts.flatMap(e=>e.ackCiphertext && e.verificationCiphertext ? [decryptSavPayload<{id:string}>(e.ackCiphertext).id] : []);
    const candidateTickets = [...confirmedTicketIds,...(payload.plan?.decision.evidence.filter(e => e.source === "crm_ticket" && /^\d+$/.test(e.sourceId)).map(e => e.sourceId) ?? [])];
    if (command.ticketId && !candidateTickets.includes(command.ticketId)) throw Error("SAV_INTAKE_HUMAN_CONFLICT");
    if (!payload.plan || intakeRuntimeHash(candidates) !== command.candidatesHash
      || command.kind === "select" && (!command.contactId && !command.ticketId || command.contactId && !candidates.includes(command.contactId))
      || command.kind === "classify" && !command.classification) throw Error("SAV_INTAKE_HUMAN_CONFLICT");
    const previous = run.humanChoiceCiphertext ? decryptSavPayload<{ eventId: string }>(run.humanChoiceCiphertext) : null;
    const [parentEvent] = previous ? await tx.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id, previous.eventId)) : [];
    const baseConfigHash = previous ? parentEvent?.baseConfigHash : run.configHash;
    if (!baseConfigHash) throw Error("SAV_INTAKE_HUMAN_CONFLICT");
    const configuration = payload.configuration;
    if (!configuration || configuration.configHash !== baseConfigHash) throw Error("SAV_INTAKE_SEMANTIC_PROVENANCE_MISSING");
    const eventId = randomUUID();
    const value: HumanEventPayload & { commandHash: string } = {
      revision: "sav-intake-human.v1", actor: { id: actor.id, email: actor.email }, mailboxId: message.mailboxId,
      policyHash: run.policyHash, resourcesHash: configuration.resourcesHash, candidatesHash: command.candidatesHash,
      candidateContactIds: candidates, contactId: command.contactId, ticketId: command.ticketId, classification: command.classification,
      reason: command.reason, parentPayloadHash: intakeRuntimeHash(payload), commandHash: intakeRuntimeHash(command),
    };
    await tx.insert(savIntakeHumanEvents).values({ id: eventId, commandKey: command.commandKey, threadId: thread.id, messageId: message.id,
      parentRunId: run.id, parentVersion: run.version, baseConfigHash, sourceHash: run.sourceHash!, kind: command.kind,
      state: command.kind === "refuse" ? "refused" : "pending", payloadCiphertext: encryptSavPayload(value) });
    await tx.update(savIntakeRuns).set({ state: "waiting", freshUntil: null, leaseToken: null, leaseUntil: null }).where(eq(savIntakeRuns.id, run.id));
    if (execution && execution.state !== "confirmed") await tx.update(savIntakeExecutions).set({ leaseToken: null, leaseUntil: null, state: "waiting" }).where(eq(savIntakeExecutions.id, execution.id));
    if (execution && execution.state !== "confirmed") {
      const effects = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, execution.id));
      if (effects.every(e => e.state === "confirmed" || e.state === "planned" && !e.dispatchedAt && !e.dispatchToken && !e.ackCiphertext && !e.confirmedAt)) await releaseKeys(tx, execution.id);
    }
    await tx.update(savMessages).set({ analysisStatus: command.kind === "refuse" ? "intake_human_refused" : "intake_human_pending" }).where(eq(savMessages.id, message.id));
    await tx.insert(auditLogs).values({ actorEmail: actor.email, action: `sav_intake_human_${command.kind}`, entityType: "sav_intake_human_event", entityId: eventId,
      technicalMetadata: { runId: run.id, version: run.version, messageId: message.id, executionId: execution?.id ?? null } });
    return { eventId, status: "recorded" as const };
  });
}
