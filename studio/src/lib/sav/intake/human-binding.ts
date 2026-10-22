import "server-only";
import { intakeLaunchMatches } from "./launch-boundary";
import { and, eq, inArray } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeHumanEvents, savIntakeRuns, savIntakeJournal } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { intakeRuntimeHash, type IntakeRuntimeConfig } from "./runtime-contract";
import { intakeConsoleInstalled } from "./console-capability";
export type HumanEventPayload = {
  revision: "sav-intake-human.v1"; actor: { id: string; email: string };
  mailboxId: string; policyHash: string; resourcesHash: string; candidatesHash: string;
  candidateContactIds: string[]; contactId?: string; ticketId?: string;
  classification?: import("./engine-types").MessageAnalysis["requests"][number]["kind"];
  reason: string; parentPayloadHash: string;
  reinvestigate?: true;
};
export const humanRevisionConfigHash = (baseConfigHash: string, choiceId: string) =>
  intakeRuntimeHash({ revision: "sav-intake-human-binding.v1", baseConfigHash, choiceId });
export async function intakeHumanRefused(messageId: string, db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) {
  if (!await intakeConsoleInstalled(db)) return false;
  return Boolean((await db.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents)
    .where(and(eq(savIntakeHumanEvents.messageId, messageId), eq(savIntakeHumanEvents.kind, "refuse"))).limit(1))[0]);
}
export async function intakeHasHumanDecision(messageId: string, db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) {
  if (!await intakeConsoleInstalled(db)) return false;
  return Boolean((await db.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents)
    .where(eq(savIntakeHumanEvents.messageId, messageId)).limit(1))[0]);
}
/** This is the sole authority binding for automatic and derived runs. A derived
 * hash is accepted only with the immutable server event and its exact parent. */
export async function intakeRunConfigurationBound(run: typeof savIntakeRuns.$inferSelect, config: IntakeRuntimeConfig,
  db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb(), pendingEventId?: string) {
  if (Date.parse(config.expiresAt) <= Date.now() || !await intakeLaunchMatches(config, db)) return false;
  if (await intakeHumanRefused(run.messageId, db)) return false;
  if (await intakeConsoleInstalled(db)) {
    const [pending] = await db.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents)
      .where(and(eq(savIntakeHumanEvents.parentRunId, run.id), inArray(savIntakeHumanEvents.state, ["pending", "reading"]))).limit(1);
    if (pending && pending.id !== pendingEventId) return false;
  }
  if (run.configHash === config.configHash) {
    if (run.humanChoiceCiphertext !== null) return false;
    if (!await intakeHasHumanDecision(run.messageId, db)) return true;
    if (!pendingEventId) return false;
    const [child] = await db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id, pendingEventId));
    return Boolean(child && child.parentRunId === run.id && child.messageId === run.messageId && child.threadId === run.threadId
      && child.baseConfigHash === config.configHash && child.kind !== "refuse");
  }
  if (!run.humanChoiceCiphertext || !await intakeConsoleInstalled(db)) return false;
  const choice = decryptSavPayload<{ eventId?: string }>(run.humanChoiceCiphertext);
  if (!choice.eventId) return false;
  const [event] = await db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id, choice.eventId));
  if (!event || event.revisionRunId !== run.id || event.state !== "consumed" || event.kind === "refuse"
    || event.messageId !== run.messageId || event.threadId !== run.threadId || event.baseConfigHash !== config.configHash
    || event.sourceHash !== run.sourceHash || run.configHash !== humanRevisionConfigHash(config.configHash, event.id)) return false;
  const [parent] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, event.parentRunId));
  const value = decryptSavPayload<HumanEventPayload>(event.payloadCiphertext);
  if (parent && parent.configHash !== config.configHash && !await intakeRunConfigurationBound(parent, config, db, event.id)) return false;
  return Boolean(parent && parent.messageId === run.messageId && parent.threadId === run.threadId
    && parent.version === event.parentVersion && parent.version < run.version
    && value.revision === "sav-intake-human.v1" && value.mailboxId === config.mailboxId
    && value.policyHash === config.policyHash && value.resourcesHash === config.resourcesHash
    && run.policyHash === config.policyHash && intakeRuntimeHash(decryptSavPayload(parent.payloadCiphertext)) === value.parentPayloadHash
    && value.candidatesHash === intakeRuntimeHash(value.candidateContactIds)
    && (!value.contactId || value.candidateContactIds.includes(value.contactId)));
}

/** Candidate authority survives a decision branch that needs no CRM lookup
 * (human Other). It comes from the immutable consumed event, not a permissive
 * empty-plan fallback. The next worker still revalidates every real candidate. */
export async function intakeRunCandidateContactIds(run:typeof savIntakeRuns.$inferSelect,payload:import("./runtime-contract").IntakeRuntimePayload,db:Pick<ReturnType<typeof requireDb>,"select">=requireDb()):Promise<string[]|null> {
  if(!run.humanChoiceCiphertext)return [...(payload.plan?.candidateContactIds??[])].sort();
  if(!await intakeConsoleInstalled(db))return null;
  const choice=decryptSavPayload<{eventId?:string}>(run.humanChoiceCiphertext);
  if(!choice.eventId)return null;
  const [event]=await db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id,choice.eventId));
  if(!event||event.state!=="consumed"||event.kind==="refuse"||event.revisionRunId!==run.id||event.messageId!==run.messageId||event.threadId!==run.threadId
    ||event.sourceHash!==run.sourceHash||event.baseConfigHash!==payload.configuration?.configHash||run.configHash!==humanRevisionConfigHash(event.baseConfigHash,event.id))return null;
  const value=decryptSavPayload<HumanEventPayload>(event.payloadCiphertext);
  const [parent]=await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,event.parentRunId));
  if(!parent||parent.version!==event.parentVersion||parent.version>=run.version||parent.messageId!==run.messageId||parent.threadId!==run.threadId
    ||value.parentPayloadHash!==intakeRuntimeHash(decryptSavPayload(parent.payloadCiphertext))||value.policyHash!==run.policyHash||value.resourcesHash!==payload.configuration?.resourcesHash
    ||value.candidatesHash!==intakeRuntimeHash(value.candidateContactIds)||new Set(value.candidateContactIds).size!==value.candidateContactIds.length)return null;
  const records=await db.select().from(savIntakeJournal).where(and(eq(savIntakeJournal.runId,run.id),eq(savIntakeJournal.kind,"human_reanalysis")));
  if(records.length) {
    if(records.length!==1||!payload.plan||!payload.input||!payload.semantics)return null;
    const record=decryptSavPayload<{eventId:string;parentRunId:string;sourceHash:string;inputHash:string;planHash:string;semanticsHash:string;candidateContactIds:string[]}>(records[0].payloadCiphertext);
    const candidates=[...(payload.plan.candidateContactIds??[])].sort();
    if(record.eventId!==event.id||record.parentRunId!==parent.id||record.sourceHash!==run.sourceHash
      ||record.inputHash!==intakeRuntimeHash(payload.input)||record.planHash!==intakeRuntimeHash(payload.plan)
      ||record.semanticsHash!==intakeRuntimeHash(payload.semantics)||intakeRuntimeHash(record.candidateContactIds)!==intakeRuntimeHash(candidates))return null;
    return candidates;
  }
  return [...value.candidateContactIds].sort();
}
