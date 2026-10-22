import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeExecutions, savIntakeRuns, savIntakeObservationBindings, savResolutionObservations,
  savMessages, savThreads, savAgentRuns, savObservationCycles, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload, savContentHash } from "../crypto";
import { intakeConsoleInstalled } from "./console-capability";
import { activeExecutionEffects, admissionLock, executionMessageHash } from "./execution-store";
import { requiredExecutionKinds } from "./executor";
import { intakeRuntimeHash, type IntakeRuntimePayload } from "./runtime-contract";
import { savIntakeSourceSnapshot } from "./runtime-store";
import type { ExecutionPayload, EffectIntent, EffectAck } from "./execution-types";
import type { IntakePlan } from "./engine-types";
import type { ObservationEvent } from "../observation-source";
export type IntakeObservationBaseline = {
  revision: "sav-intake-observation.v1"; origin: "intake"; executionId: string; runId: string; version: number;
  messageId: string; threadId: string; ticketId: string; plan: IntakePlan; acceptedFingerprint: string;
  confirmedAt: string; localSourceHash: string; effects: Array<{ id: string; kind: string; intent: EffectIntent; ack: EffectAck | null; proof: unknown }>;
  resolutionDraft: null;
};
type Db = Pick<ReturnType<typeof requireDb>, "select">;
/** Reads every retained decision of this dossier and other threads explicitly
 * bound to its ticket. A later support label cannot erase sensitive history. */
export async function intakeDossierSensitive(threadId: string, ticketId: string | null, db: Db = requireDb()) {
  const siblings = ticketId ? await db.select({ threadId: savThreads.id }).from(savThreads).where(eq(savThreads.hubspotTicketId, ticketId)) : [];
  const executions = ticketId ? await db.select({threadId:savIntakeExecutions.threadId}).from(savIntakeExecutions).where(eq(savIntakeExecutions.ticketId,ticketId)) : [];
  const ids = [...new Set([threadId, ...siblings.map(row => row.threadId), ...executions.map(row=>row.threadId)])];
  const runs = await db.select({ payload: savIntakeRuns.payloadCiphertext }).from(savIntakeRuns).where(inArray(savIntakeRuns.threadId, ids));
  for (const row of runs) {
    const plan = decryptSavPayload<IntakeRuntimePayload>(row.payload).plan;
    if (plan && (plan.decision.requests.some(r => ["finance", "cancellation"].includes(r.kind)) || ["finance", "cancellation"].includes(plan.decision.classification))) return true;
  }
  const legacy = await db.select({ ciphertext: savAgentRuns.proposalCiphertext }).from(savAgentRuns)
    .innerJoin(savMessages, eq(savMessages.id, savAgentRuns.messageId)).where(inArray(savMessages.threadId, ids));
  return legacy.some(row => {
    if (!row.ciphertext) return false;
    const proposal = decryptSavPayload<import("../proposal").SavStructuredProposal>(row.ciphertext);
    return proposal.category === "billing" || /cancellation|refund|legal|security/.test(proposal.decision.reasonCode);
  });
}
export async function ensureIntakeObservations(limit = 4) {
  if (!await intakeConsoleInstalled()) return { skipped: "migration_absent" };
  const db = requireDb(), key = "sav-intake-tracking-scan-v1";
  const [storedCursor] = await db.select().from(savSyncState).where(eq(savSyncState.key,key));
  const cursor = storedCursor?.cursor ? JSON.parse(storedCursor.cursor) as {at:string;id:string} : null;
  const base = and(eq(savIntakeExecutions.state,"confirmed"), sql`${savIntakeExecutions.ticketId} is not null`,
    sql`not exists(select 1 from sav.intake_observation_bindings b where b.execution_id=${savIntakeExecutions.id})`);
  let rows = await db.select({ id: savIntakeExecutions.id, at:savIntakeExecutions.updatedAt }).from(savIntakeExecutions)
    .where(and(base,cursor ? sql`(${savIntakeExecutions.updatedAt},${savIntakeExecutions.id}) > (${cursor.at}::timestamptz,${cursor.id}::uuid)` : undefined))
    .orderBy(savIntakeExecutions.updatedAt, savIntakeExecutions.id).limit(Math.min(10, Math.max(1,limit)));
  if (!rows.length && cursor) rows = await db.select({id:savIntakeExecutions.id,at:savIntakeExecutions.updatedAt}).from(savIntakeExecutions)
    .where(base).orderBy(savIntakeExecutions.updatedAt,savIntakeExecutions.id).limit(Math.min(10,Math.max(1,limit)));
  let created = 0;
  for (const candidate of rows) {
   await requireDb().transaction(async tx => {
    await admissionLock(tx);
    const [execution] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, candidate.id)).for("update");
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, execution.threadId)).for("update");
    const [run] = execution.runId ? await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, execution.runId)) : [];
    const [latest] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, execution.threadId), eq(savMessages.direction, "inbound")))
      .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
    const payload = decryptSavPayload<ExecutionPayload>(execution.payloadCiphertext), plan = payload.plan;
    const effects = await activeExecutionEffects(execution.id, tx), required = requiredExecutionKinds(payload);
    if (execution.state !== "confirmed" || !execution.ticketId || thread?.hubspotTicketId !== execution.ticketId || !run?.isCurrent
      || latest?.id !== execution.messageId || run.id !== payload.lastRunId || run.version !== execution.runVersion
      || payload.acceptedFingerprint !== decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext).plan?.fingerprint
      || plan.decision.disposition.kind !== "ticket" || !required.length || required.some(kind => !effects.some(e => e.kind === kind && e.state === "confirmed"))
      || effects.some(e => e.state !== "confirmed")) return;
    if (!payload.completion || payload.completion.messageHash !== executionMessageHash(latest)
      || payload.completion.sourceHash !== (await savIntakeSourceSnapshot(tx, latest, new Date())).sourceHash) return;
    const [existing] = await tx.select().from(savIntakeObservationBindings).where(eq(savIntakeObservationBindings.executionId, execution.id));
    if (existing) return;
    const baseline: IntakeObservationBaseline = { revision: "sav-intake-observation.v1", origin: "intake", executionId: execution.id,
      runId: run.id, version: run.version, messageId: execution.messageId, threadId: execution.threadId, ticketId: execution.ticketId,
      plan, acceptedFingerprint: payload.acceptedFingerprint, confirmedAt: execution.updatedAt.toISOString(), resolutionDraft: null,
      localSourceHash: (await savIntakeSourceSnapshot(tx, latest, new Date())).sourceHash,
      effects: effects.map(e => ({ id: e.id, kind: e.kind, intent: decryptSavPayload<EffectIntent>(e.intentCiphertext),
        ack: e.ackCiphertext ? decryptSavPayload<EffectAck>(e.ackCiphertext) : null, proof: e.verificationCiphertext ? decryptSavPayload(e.verificationCiphertext) : null })) };
    const sensitive = await intakeDossierSensitive(execution.threadId, execution.ticketId, tx);
    const [observation] = await tx.insert(savResolutionObservations).values({ threadId: execution.threadId, messageId: execution.messageId,
      trackingOrigin: "intake", hubspotTicketId: execution.ticketId, state: "pending_first_sync" }).returning();
    await tx.insert(savIntakeObservationBindings).values({ observationId: observation.id, executionId: execution.id, runId: run.id,
      threadId: execution.threadId, messageId: execution.messageId, sensitive, baselineCiphertext: encryptSavPayload(baseline), baselineHash: intakeRuntimeHash(baseline) });
    created++;
   });
   await db.insert(savSyncState).values({key,cursor:JSON.stringify({at:candidate.at.toISOString(),id:candidate.id})})
     .onConflictDoUpdate({target:savSyncState.key,set:{cursor:JSON.stringify({at:candidate.at.toISOString(),id:candidate.id}),updatedAt:new Date()}});
  }
  return { created };
}
export async function readIntakeObservationBinding(observationId: string, db: Db = requireDb()) {
  if (!await intakeConsoleInstalled(db)) return null;
  const [binding] = await db.select().from(savIntakeObservationBindings).where(eq(savIntakeObservationBindings.observationId, observationId));
  if (!binding) return null;
  const baseline = decryptSavPayload<IntakeObservationBaseline>(binding.baselineCiphertext);
  if (baseline.revision !== "sav-intake-observation.v1" || baseline.origin !== "intake" || intakeRuntimeHash(baseline) !== binding.baselineHash) throw Error("SAV_INTAKE_OBSERVATION_BINDING_INVALID");
  return { ...binding, baseline };
}
export async function readIntakeLearningQualification(threadId: string, db: Db = requireDb()) {
  const [observation] = await db.select().from(savResolutionObservations).where(and(eq(savResolutionObservations.threadId, threadId), eq(savResolutionObservations.trackingOrigin, "intake")))
    .orderBy(desc(savResolutionObservations.createdAt), desc(savResolutionObservations.id)).limit(1);
  if (!observation) return null;
  const binding = await readIntakeObservationBinding(observation.id, db);
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, threadId));
  const [latest] = await db.select().from(savMessages).where(and(eq(savMessages.threadId, threadId), eq(savMessages.direction, "inbound")))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  if (!binding || !thread || thread.aiPaused || latest?.id !== binding.messageId || thread.hubspotTicketId !== binding.baseline.ticketId
    || binding.sensitive || await intakeDossierSensitive(threadId, thread.hubspotTicketId, db)) return { allowed: false, fingerprint: null };
  const [run] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, binding.runId));
  const [execution] = await db.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.id, binding.executionId));
  const source = await savIntakeSourceSnapshot(db, latest, new Date());
  if (!run?.isCurrent || execution?.state !== "confirmed" || execution.runId !== run.id || source.sourceHash !== binding.baseline.localSourceHash
    || decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext).plan?.fingerprint !== binding.baseline.acceptedFingerprint
    || decryptSavPayload<ExecutionPayload>(execution.payloadCiphertext).acceptedFingerprint !== binding.baseline.acceptedFingerprint)
    return { allowed: false, fingerprint: null };
  return { allowed: true, fingerprint: savContentHash({ origin: "intake", bindingHash: binding.baselineHash,
    messageId: latest.id, runId: run.id, version: run.version, sourceHash: source.sourceHash, cycle: observation.cycle }) };
}
/** Attribute receipts by provider IDs AND exact content fingerprints. A copied
 * intake note/template is still AI evidence, never an independent human fix. */
export function attributeIntakeObservationEvents(events: ObservationEvent[], baseline: IntakeObservationBaseline) {
  const fingerprints = new Set(baseline.effects.flatMap(e => [e.intent.text, e.intent.properties?.hs_note_body, e.intent.properties?.hs_email_text]
    .filter((v): v is string => typeof v === "string").map(v => savContentHash(v))));
  const refs = new Set(baseline.effects.flatMap(e => !e.ack?.id ? [] : e.kind === "note_create" ? [`hubspot:notes:${e.ack.id}`]
    : e.kind === "email_create" ? [`hubspot:emails:${e.ack.id}`] : e.kind === "identity_send" ? [`gmail:${e.ack.id}`] : []));
  return events.map(event => {
    const own = refs.has(event.sourceRef) || fingerprints.has(savContentHash(event.text))
      || Boolean(event.fullContentHash && fingerprints.has(event.fullContentHash));
    return own ? { ...event, kind: "ai_intake_effect", provenance: "Studio / effet IA intake confirmé, non preuve de résolution humaine" } : event;
  });
}
/** Gate at reservation, provider dispatch, settlement and candidate promotion. */
export async function intakeComparisonSourceCurrent(input: import("../learning-pipeline").SavLearningResolutionInput, db: Db = requireDb()) {
  if (!input.observationId) return input.caseContext?.origin !== "intake";
  const [observation] = await db.select().from(savResolutionObservations).where(eq(savResolutionObservations.id, input.observationId));
  if (observation?.trackingOrigin !== "intake") return input.caseContext?.origin !== "intake";
  const binding = await readIntakeObservationBinding(observation.id, db);
  const qualification = await readIntakeLearningQualification(observation.threadId, db);
  const [cycle] = input.cycleId ? await db.select().from(savObservationCycles).where(eq(savObservationCycles.id,input.cycleId)) : [];
  const summary = cycle ? decryptSavPayload<{events:ObservationEvent[]}>(cycle.summaryCiphertext) : null;
  const event = summary?.events.find(e => e.sourceRef === input.evidenceRef);
  if (!observation.closed || observation.sourceErrors.length || !cycle || cycle.cycle !== observation.cycle || cycle.observationId !== observation.id
    || cycle.sourceHash !== input.cycleSourceHash || !["resolved","evidence_observed"].includes(cycle.qualification ?? "")
    || !event || !["note","human_reply"].includes(event.kind) || !event.author || event.truncated || event.text.trim().length < 20
    || !input.evidenceExcerpt || !event.text.includes(input.evidenceExcerpt)
    || intakeRuntimeHash(input.caseContext?.events) !== intakeRuntimeHash(summary?.events)) return false;
  return Boolean(binding && qualification?.allowed && input.threadId === observation.threadId && input.ticketId === binding.baseline.ticketId
    && input.caseContext?.origin === "intake" && input.caseContext.baseline === null
    && intakeRuntimeHash(input.caseContext.intakeBaseline) === binding.baselineHash
    && input.caseContext.currentQualificationHash === qualification.fingerprint);
}
