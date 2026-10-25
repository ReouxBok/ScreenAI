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
export const operatorRecoveryConfigHash = (baseConfigHash:string,eventId:string) =>
  intakeRuntimeHash({revision:"sav-intake-operator-recovery-parent.v1",baseConfigHash,eventId});
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
  if(pendingEventId&&run.configHash===operatorRecoveryConfigHash(config.configHash,pendingEventId)&&run.humanChoiceCiphertext===null){
    const [event]=await db.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id,pendingEventId));
    if(!event||event.parentRunId!==run.id||event.parentVersion!==run.version||event.messageId!==run.messageId||event.threadId!==run.threadId
      ||event.baseConfigHash!==config.configHash||event.sourceHash!==run.sourceHash||event.kind!=="classify"||!["pending","reading","consumed"].includes(event.state))return false;
    const value=decryptSavPayload<HumanEventPayload>(event.payloadCiphertext),payload=decryptSavPayload<import("./runtime-contract").IntakeRuntimePayload>(run.payloadCiphertext);
    const ancestor=await intakeReanalysisParent(run,payload,config,db);
    const candidates=ancestor?await intakeRunCandidateContactIds(ancestor,decryptSavPayload(ancestor.payloadCiphertext),db):[];
    return candidates!==null&&value.reinvestigate===true&&value.revision==="sav-intake-human.v1"&&value.mailboxId===config.mailboxId
      &&run.policyHash===config.policyHash&&value.policyHash===config.policyHash&&value.resourcesHash===config.resourcesHash
      &&payload.configuration?.configHash===config.configHash&&payload.configuration.resourcesHash===config.resourcesHash
      &&payload.configuration.codeRevision===config.codeRevision&&value.parentPayloadHash===intakeRuntimeHash(payload)
      &&value.candidatesHash===intakeRuntimeHash(value.candidateContactIds)&&intakeRuntimeHash(candidates)===value.candidatesHash&&!value.contactId&&!value.ticketId;
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

/** Historical configuration is evidence provenance only. It cannot claim a
 * worker, reuse accepted semantics or grant an old plan current authority. */
function reanalysisEvidenceConfiguration(payload:import("./runtime-contract").IntakeRuntimePayload,config:IntakeRuntimeConfig,run:Pick<typeof savIntakeRuns.$inferSelect,"configHash"|"policyHash"|"humanChoiceCiphertext">){
 const old=payload.configuration;
 // The persisted contract permits omitted metadata. Only an exact current
 // automatic binding can supply it; absence never proves an older revision.
 if(old===undefined&&run.configHash===config.configHash&&run.policyHash===config.policyHash&&run.humanChoiceCiphertext===null)return config;
 if(!old||old.policyHash!==config.policyHash||old.resourcesHash!==config.resourcesHash||old.model!==config.model
   ||!/^[a-f0-9]{64}$/.test(old.configHash)||!/^[a-f0-9]{40}$/.test(old.codeRevision))return null;
 return {...config,configHash:old.configHash,codeRevision:old.codeRevision};
}
export async function intakeRunReanalysisConfiguration(run:typeof savIntakeRuns.$inferSelect,config:IntakeRuntimeConfig,
 db:Pick<ReturnType<typeof requireDb>,"select">=requireDb()){
 if(run.policyHash!==config.policyHash)return null;
 const historical=reanalysisEvidenceConfiguration(decryptSavPayload(run.payloadCiphertext),config,run);
 return historical&&await intakeRunConfigurationBound(run,historical,db)?historical:null;
}

/** A server-created bridge is immutable in the new parent payload. It keeps
 * an old choice chain applicable only across an operator-context revision of
 * the same exchanged message; the recording transaction checks raw sources. */
export async function intakeReanalysisParent(run:typeof savIntakeRuns.$inferSelect,payload:import("./runtime-contract").IntakeRuntimePayload,
 config:IntakeRuntimeConfig,db:Pick<ReturnType<typeof requireDb>,"select">=requireDb()) {
 const bridge=payload.reanalysisParent;if(!bridge)return null;
 const [parent]=await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id,bridge.runId));
 if(!parent||parent.version>=run.version||parent.threadId!==run.threadId||parent.messageId!==run.messageId||parent.sourceHash!==bridge.sourceHash
   ||intakeRuntimeHash(decryptSavPayload(parent.payloadCiphertext))!==bridge.payloadHash||parent.policyHash!==config.policyHash)throw Error("SAV_INTAKE_HUMAN_REVALIDATION_REQUIRED");
 const original=decryptSavPayload<import("./runtime-contract").IntakeRuntimePayload>(parent.payloadCiphertext);
 const historical=reanalysisEvidenceConfiguration(original,config,parent);
 if(!historical)throw Error("SAV_INTAKE_HUMAN_REVALIDATION_REQUIRED");
 if(parent.configHash===historical.configHash&&!parent.humanChoiceCiphertext){
  // The recording transaction validated this base before the new event existed.
  // Its immutable bridge cannot make the old run current or executable again.
 }else if(!await intakeRunConfigurationBound(parent,historical,db))throw Error("SAV_INTAKE_HUMAN_REVALIDATION_REQUIRED");
 return parent;
}
