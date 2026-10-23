import { readSavExternalCompletion } from "../external-completion";
import "server-only";
import { intakeInputWithAttachments, prepareIntakeAttachments, finishIntakeAttachmentRead } from "./attachments";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savThreads, savMessages, savIntakeRuns, savIntakeJournal, savIntakeHumanEvents,
  savIntakeExecutions, savIntakeEffects, savIntakeEffectRevisions } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { intakeRuntimeHash, savIntakeRuntimeConfig, type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { intakeConsoleInstalled } from "./console-capability";
import { humanRevisionConfigHash, intakeRunConfigurationBound, type HumanEventPayload } from "./human-binding";
import { createIntakeModelDispatcher } from "./model-dispatch";
import { createSavIntakeSemanticReaders, SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { withSavAiBudget } from "../gemini-transport";
import { acceptedIntakeResult, recordAcceptedIntakeSemantics, SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "./semantic-records";
import { savIntakeDecisionSchema } from "./contract";
import { collectExecutionCrm, assertExecutionCrmUnchanged } from "./execution-context";
import { planSavIntake, savIntakePlanFingerprint, savIntakeEvidenceContentHash } from "./engine";
import { savIntakeSourceSnapshot, assertIntakeHumanAnalysis, reserveIntakeHumanCall, intakeSourceMatches } from "./runtime-store";
import { admissionLock, executionJournal, occupyKeys, releaseKeys, assertNoLegacyConflict, executionMessageHash } from "./execution-store";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import type { EngineInput, IntakeAdapters, IntakePlan } from "./engine-types";
import type { ExecutionPayload, EffectAck } from "./execution-types";
/** Reconstruct compatible overrides from authenticated immutable events, never
 * from client fields or an arbitrary input snapshot. Every ancestor is already
 * bound by intakeRunConfigurationBound and is checked again while traversing. */
async function mergedHumanResolution(event:typeof savIntakeHumanEvents.$inferSelect,parent:typeof savIntakeRuns.$inferSelect,value:HumanEventPayload,config:IntakeRuntimeConfig) {
  const resolution:NonNullable<EngineInput["humanResolution"]>={choiceId:event.id,at:event.createdAt.toISOString(),equivalentContactIds:value.candidateContactIds,inheritedChoiceIds:[],fieldSources:{}};
  if(value.reinvestigate) resolution.suppressOutbound=true;
  const apply=(source:typeof event,body:HumanEventPayload)=>{
    if(body.reinvestigate)resolution.suppressOutbound=true;
    if(body.policyHash!==config.policyHash||body.resourcesHash!==config.resourcesHash||source.sourceHash!==event.sourceHash) return conflict();
    if(body.candidatesHash!==value.candidatesHash) {
      // A fresh server reanalysis can introduce candidates after an automatic
      // Other decision. Never carry a contact/ticket choice across that scope.
      if(body.contactId||body.ticketId)return conflict();
    }
    for(const field of ["contactId","ticketId","classification"] as const) {
      if(resolution[field]===undefined&&body[field]!==undefined) {
        Object.assign(resolution,{[field]:body[field]});
        resolution.fieldSources![field]=source.id;
      }
    }
  };
  apply(event,value);
  let run=parent;
  for(let depth=0;run.humanChoiceCiphertext;depth++) {
    if(depth>=200)return conflict();
    const choice=decryptSavPayload<{eventId:string}>(run.humanChoiceCiphertext);
    const [ancestor]=await requireDb().select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id,choice.eventId));
    if(!ancestor||ancestor.state!=="consumed"||ancestor.kind==="refuse"||ancestor.revisionRunId!==run.id||ancestor.baseConfigHash!==config.configHash||ancestor.messageId!==event.messageId||ancestor.threadId!==event.threadId)return conflict();
    const body=decryptSavPayload<HumanEventPayload>(ancestor.payloadCiphertext);
    apply(ancestor,body);resolution.inheritedChoiceIds!.push(ancestor.id);
    const [previous]=await requireDb().select().from(savIntakeRuns).where(eq(savIntakeRuns.id,ancestor.parentRunId));
    if(!previous||previous.version>=run.version||body.parentPayloadHash!==intakeRuntimeHash(decryptSavPayload(previous.payloadCiphertext)))return conflict();
    run=previous;
  }
  return resolution;
}
async function confirmedCreationRevision(original: IntakeRuntimePayload, input: EngineInput, ticketId: string,
  config: IntakeRuntimeConfig, readers: Parameters<typeof consumeIntakeHumanEvent>[2]): Promise<IntakePlan | null> {
  const [execution] = await requireDb().select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId,input.message.id));
  if (!execution) return null;
  const payload=decryptSavPayload<ExecutionPayload>(execution.payloadCiphertext), old=original.plan;
  const effects=await requireDb().select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId,execution.id));
  const created=effects.find(e=>e.kind==="ticket_create"&&e.state==="confirmed"&&e.ackCiphertext&&decryptSavPayload<EffectAck>(e.ackCiphertext).id===ticketId);
  if (!created) return null;
  if (!old || old.decision.disposition.kind!=="ticket" || old.decision.disposition.target.operation!=="create" || !payload.baseline
    || effects.some(e=>!["planned","confirmed"].includes(e.state)) || input.humanResolution?.classification && input.humanResolution.classification!==old.decision.classification) return conflict();
  acceptedIntakeResult(original.semantics,"analyseMessage",{message:input.message,conversation:input.conversation.data});
  const current=await collectExecutionCrm(old,original.input,config,readers,AbortSignal.timeout(30000));
  assertExecutionCrmUnchanged(payload.baseline,current,effects);
  const actual=Object.values(current.tickets).flat().find(t=>t.id===ticketId);
  if (!actual || actual.stage!=="new" || !actual.contactIds.includes(old.decision.disposition.target.contactId)) return conflict();
  const choice=input.humanResolution!,humanId=`human-resume-${input.humanResolution!.choiceId}`,at=new Date().toISOString(),contactId=old.decision.disposition.target.contactId;
  const plan=structuredClone(old),disposition=plan.decision.disposition;
  if (disposition.kind!=="ticket") return conflict();
  const ticketEvidenceId=`human-ticket-${ticketId}`,membership=`human-membership-${ticketId}-${contactId}`,history=`human-history-${ticketId}`;
  plan.decision.evidence.push({id:humanId,source:"human_override",sourceId:choice.choiceId,observedAt:choice.at,contentHash:savIntakeEvidenceContentHash(choice)},
    {id:ticketEvidenceId,source:"crm_ticket",sourceId:ticketId,observedAt:at,contentHash:savIntakeEvidenceContentHash(actual)},
    {id:history,source:"crm_event",sourceId:ticketId,observedAt:at,contentHash:savIntakeEvidenceContentHash(current.histories[ticketId])},
    {id:membership,source:"ticket_contact_association",sourceId:membership,ticketId,contactId,direction:"ticket_to_contact",observedAt:at,contentHash:savIntakeEvidenceContentHash({ticketId,contactId})});
  disposition.target={operation:"link",ticketId,contactId,alreadyNew:true,ticketEvidenceId,contactAssociationEvidenceId:membership};
  disposition.sameIssueEvidenceIds=[...new Set([...disposition.sameIssueEvidenceIds,ticketEvidenceId,history,humanId])];
  disposition.multiTicketNote.openTicketIdsOnTargetContact=[...new Set(Object.values(current.tickets).flat().filter(t=>t.contactIds.includes(contactId)&&t.stage!=="closed").map(t=>t.id))].sort();
  disposition.requiredPermissions=disposition.requiredPermissions.map(p=>p==="create_ticket"?"link_ticket":p);
  delete plan.newTicket;
  plan.decision=savIntakeDecisionSchema.parse(plan.decision);
  plan.fingerprint=savIntakePlanFingerprint(plan);
  plan.steps=disposition.requiredPermissions.map(mutation=>({id:`${input.message.id}:${mutation}:${plan.fingerprint}`,mutation,requiresPermission:mutation,ticketId,status:"not_dispatched"}));
  return plan;
}
const conflict = (): never => { throw Error("SAV_INTAKE_HUMAN_REVALIDATION_REQUIRED"); };
/** Atomic amendment of the same execution. Removed planned effects remain
 * tombstones; their complete previous bytes remain in the encrypted journal. */
async function amendExecution(tx: Parameters<typeof admissionLock>[0], event: typeof savIntakeHumanEvents.$inferSelect,
  run: typeof savIntakeRuns.$inferSelect, plan: IntakePlan, input: EngineInput) {
  const [execution] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, run.messageId)).for("update");
  if (!execution) return;
  if (execution.state === "confirmed") return conflict();
  const effects = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, execution.id)).for("update");
  if (effects.some(e => !["planned", "confirmed"].includes(e.state)
    || e.state === "planned" && (e.dispatchedAt || e.dispatchToken || e.ackCiphertext || e.confirmedAt))) return conflict();
  const old = decryptSavPayload<ExecutionPayload>(execution.payloadCiphertext), confirmed = effects.filter(e => e.state === "confirmed");
  const disposition = plan.decision.disposition;
  if (confirmed.length) {
    const prior = old.plan.decision.disposition, created = confirmed.find(e => e.kind === "ticket_create");
    const target = prior.kind === "ticket" ? prior.target.operation === "create"
      ? created?.ackCiphertext ? decryptSavPayload<EffectAck>(created.ackCiphertext).id : null : prior.target.ticketId : null;
    if (prior.kind !== "ticket" || disposition.kind !== "ticket" || disposition.target.operation === "create" || disposition.target.ticketId !== target
      || intakeRuntimeHash(prior.contactScope) !== intakeRuntimeHash(disposition.contactScope) || old.plan.noteText !== plan.noteText
      || old.plan.decision.classification !== plan.decision.classification) return conflict();
  }
  const choice = decryptSavPayload<HumanEventPayload>(event.payloadCiphertext);
  const keys = [...old.keys.filter(k => k.startsWith("email:")), ...choice.candidateContactIds.map(id => `contact:${id}`), `thread:${run.threadId}`, ...(plan.candidateContactIds ?? []).map(id => `contact:${id}`),
    ...(disposition.kind === "ticket" ? disposition.contactScope.contacts.map(c => `contact:${c.contactId}`) : []),
    ...(disposition.kind === "ticket" && disposition.target.operation !== "create" ? [`ticket:${disposition.target.ticketId}`] : [])];
  await assertNoLegacyConflict(tx, keys);
  await occupyKeys(tx, execution.id, "intake", keys);
  for (const effect of effects.filter(e => e.state === "planned")) {
    await executionJournal(tx, execution.id, "human_intent_retired", { eventId: event.id, priorRunId: execution.runId,
      intent: decryptSavPayload(effect.intentCiphertext), intentHash: effect.intentHash, businessKey: effect.businessKey }, effect.id);
    await tx.insert(savIntakeEffectRevisions).values({ effectId: effect.id, eventId: event.id, active: false, revisionRunId: run.id })
      .onConflictDoUpdate({ target: savIntakeEffectRevisions.effectId, set: { eventId: event.id, active: false, revisionRunId: run.id } });
  }
  const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, run.messageId));
  const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, run.threadId));
  if (!message || !thread) return conflict();
  const payload: ExecutionPayload = { ...old, plan: confirmed.length ? old.plan : plan, input,
    lastRunId: run.id, acceptedFingerprint: plan.fingerprint, keys: [...new Set([...old.keys, ...keys])].sort(),
    local: { ...old.local, sourceHash: run.sourceHash, humanChoice: run.humanChoiceCiphertext,
      messageHash: executionMessageHash(message), ticketId: thread.hubspotTicketId } };
  if (!confirmed.length) delete payload.baseline;
  await tx.update(savIntakeExecutions).set({ state: disposition.kind === "ticket" || disposition.kind === "request_identification" ? "pending" : "refused", runId: run.id, runVersion: run.version, leaseToken: null, leaseUntil: null,
    payloadCiphertext: encryptSavPayload(payload), updatedAt: new Date() }).where(eq(savIntakeExecutions.id, execution.id));
  await executionJournal(tx, execution.id, "human_revision_adopted", { eventId: event.id, previousRunId: execution.runId, runId: run.id,
    retainedReceipts: confirmed.map(e => e.id), admissionCountUnchanged: true });
  // No uncertain departure exists. Release only the old scope, then retain the
  // exact current scope, within this same admission transaction.
  await releaseKeys(tx, execution.id);
  await occupyKeys(tx, execution.id, "intake", keys);
  payload.keys = [...new Set(keys)].sort();
  await tx.update(savIntakeExecutions).set({ payloadCiphertext: encryptSavPayload(payload) }).where(eq(savIntakeExecutions.id, execution.id));
}
export async function consumeIntakeHumanEvent(id: string, config: IntakeRuntimeConfig,
  readers: Pick<IntakeAdapters, "findContactsByEmail" | "directAssociations" | "getContact" | "ticketsForContact" | "ticketHistory">) {
  const token = randomUUID(), now = new Date(), db = requireDb();
  const claim = await db.transaction(async tx => {
    await admissionLock(tx);
    const [event] = await tx.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id, id)).for("update");
    if (!event || !["pending", "reading"].includes(event.state) || event.readAttempts >= 2 || event.leaseUntil && event.leaseUntil > now) return null;
    const [parent] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, event.parentRunId));
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, event.threadId)).for("update");
    const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, event.messageId));
    if (!parent?.isCurrent || thread?.aiPaused || !message || await readSavExternalCompletion(message, tx) || !await intakeRunConfigurationBound(parent, config, tx, event.id)
      || parent.sourceHash !== event.sourceHash || !intakeSourceMatches(await savIntakeSourceSnapshot(tx, message, now), event.sourceHash)) {
      await tx.update(savIntakeHumanEvents).set({state:"waiting",leaseToken:null,leaseUntil:null}).where(eq(savIntakeHumanEvents.id,id));
      return null;
    }
    const [updated] = await tx.update(savIntakeHumanEvents).set({ state: "reading", leaseToken: token,
      leaseUntil: new Date(now.getTime() + 60000), readAttempts: event.readAttempts + 1 }).where(eq(savIntakeHumanEvents.id, id)).returning();
    return { event: updated, parent, snapshot: await savIntakeSourceSnapshot(tx, message, now) };
  });
  if (!claim) return { skipped: "not_claimed" };
  try {
    const { event, parent, snapshot } = claim, value = decryptSavPayload<HumanEventPayload>(event.payloadCiphertext);
    const original = decryptSavPayload<IntakeRuntimePayload>(parent.payloadCiphertext);
    if (value.parentPayloadHash !== intakeRuntimeHash(original) || original.configuration?.configHash !== config.configHash
      || value.mailboxId !== config.mailboxId || value.policyHash !== config.policyHash || value.resourcesHash !== config.resourcesHash) return conflict();
    let input: EngineInput = { ...intakeInputWithAttachments(snapshot.input, event.sourceHash, original.attachments), humanResolution: await mergedHumanResolution(event,parent,value,config) };
    let reason: string | undefined;
    const accepted = <T>(method: "analyseMessage" | "assessIdentity" | "assessIssues", data: unknown): T => {
      try { return acceptedIntakeResult<T>(original.semantics, method, data); }
      catch (error) { reason = error instanceof Error ? error.message : "SAV_INTAKE_SEMANTIC_PROVENANCE_MISSING"; throw error; }
    };
    const deadline = AbortSignal.timeout(45000);
    let reusableAnalysis: import("./engine-types").MessageAnalysis | null = null;
    try { reusableAnalysis=acceptedIntakeResult(original.semantics,"analyseMessage",{message:input.message,conversation:input.conversation.data}); } catch { /* Missing accepted semantics require a real continuation below. */ }
    const needsAnalysis=Boolean(value.reinvestigate || original.plan?.progress.kind==="qualified_other" && input.humanResolution?.classification!==undefined && input.humanResolution.classification!=="other"
      && (!reusableAnalysis?.ticketSummary || reusableAnalysis.requests.some(r=>r.kind==="other"||r.kind==="unknown")));
    const authority={eventId:id,parentRunId:parent.id,token};
    const live=async()=>{if(savIntakeRuntimeConfig()?.configHash!==config.configHash||deadline.aborted)return conflict();await assertIntakeHumanAnalysis(authority,config);};
    const dispatcher=needsAnalysis?createIntakeModelDispatcher({config,signal:deadline,live,reserve:hash=>reserveIntakeHumanCall(authority,config,hash)}):null;
    const semantics: IntakeRuntimePayload["semantics"]=needsAnalysis?{revision:SAV_INTAKE_SEMANTIC_RECORD_REVISION,validatorRevision:SAV_INTAKE_MODEL_REVISION,records:[]}:original.semantics;
    const attachments=value.reinvestigate ? await prepareIntakeAttachments({run:parent,token,...snapshot},config.model,live) : null;
    if(attachments?.complete) input={...intakeInputWithAttachments(input,event.sourceHash,attachments.state,attachments.prepared),humanResolution:input.humanResolution};
    const fresh=dispatcher&&semantics?recordAcceptedIntakeSemantics(createSavIntakeSemanticReaders({model:config.model,call:dispatcher.call,
      ...(attachments?.complete ? {attachments:{prepared:attachments.prepared,onRead:observations=>{
        attachments.state.read={...attachments.state.read,observations,state:"complete",completedAt:new Date().toISOString()};
      }}} : {}),
      provenance:snapshot.provenance,humanClassification:input.humanResolution?.classification}),semantics,()=>{}):null;
    const boundedReaders = Object.fromEntries(Object.entries(readers).map(([name, fn]) => [name, async (argument: string, signal: AbortSignal) => {
      if (deadline.aborted) throw Error("SAV_INTAKE_HUMAN_REVALIDATION_REQUIRED");
      return fn(argument, AbortSignal.any([signal, deadline]));
    }])) as typeof readers;
    const confirmedPlan=input.humanResolution?.ticketId ? await confirmedCreationRevision(original,input,input.humanResolution.ticketId,config,boundedReaders) : null;
    const plan = confirmedPlan ?? await withSavAiBudget(()=>planSavIntake(input, { ...boundedReaders,
      ...(fresh??{analyseMessage: async (data:Parameters<IntakeAdapters["analyseMessage"]>[0]) => accepted<Awaited<ReturnType<IntakeAdapters["analyseMessage"]>>>("analyseMessage", data),
      assessIdentity: async (data:Parameters<NonNullable<IntakeAdapters["assessIdentity"]>>[0]) => accepted<Awaited<ReturnType<NonNullable<IntakeAdapters["assessIdentity"]>>>>("assessIdentity", data),
      assessIssues: async (data:Parameters<IntakeAdapters["assessIssues"]>[0]) => data.tickets.length ? accepted<Awaited<ReturnType<IntakeAdapters["assessIssues"]>>>("assessIssues", data) : { investigationComplete: true, tickets: [] }}),
    }, input.humanResolution?.classification === "other" ? { ...config.policy, qualifiedOther: { evidenceSource: "human_override",
      resource: { resourceId: id, revisionId: "sav-intake-human.v1", sha256: intakeRuntimeHash(input.humanResolution) } } } : config.policy, { timeoutMs: 10_000 }, () => new Date()));
    finishIntakeAttachmentRead(attachments?.state,"context_incomplete");
    if(dispatcher){
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([Promise.allSettled(dispatcher.pending),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("SAV_INTAKE_RUNTIME_SETTLEMENT_UNCERTAIN")),15000);})]);}finally{if(timer)clearTimeout(timer);}
      if(dispatcher.uncertain)throw Error("SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN");
      await live(); reason=dispatcher.failureReason;
    }
    const result = await db.transaction(async tx => {
      await admissionLock(tx);
      const [execution] = await tx.select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, event.messageId)).for("update");
      const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, event.threadId)).for("update");
      const [current] = await tx.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, parent.id)).for("update");
      const [guard] = await tx.select().from(savIntakeHumanEvents).where(eq(savIntakeHumanEvents.id, id)).for("update");
      const [latest] = await tx.select().from(savMessages).where(and(eq(savMessages.threadId, event.threadId), eq(savMessages.direction, "inbound")))
        .orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
      if (!guard || guard.leaseToken !== token || !guard.leaseUntil || guard.leaseUntil <= new Date() || !current?.isCurrent || thread?.aiPaused
        || latest?.id !== event.messageId || await readSavExternalCompletion(latest, tx) || !intakeSourceMatches(await savIntakeSourceSnapshot(tx, latest, new Date()), event.sourceHash)
        || !await intakeRunConfigurationBound(current, config, tx, event.id)) return conflict();
      const [last] = await tx.select({ version: savIntakeRuns.version }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, event.threadId)).orderBy(desc(savIntakeRuns.version)).limit(1);
      await tx.update(savIntakeRuns).set({ isCurrent: false, state: "superseded", freshUntil: null, leaseToken: null, leaseUntil: null }).where(eq(savIntakeRuns.id, parent.id));
      const payload: IntakeRuntimePayload = { ...original, input, plan, reason, semantics, ...(attachments ? {attachments:attachments.state}:{}), other:undefined, traces: [...(original.traces ?? []), { humanEventId: id,
        semanticReuse: needsAnalysis?"new_budgeted_analysis":"accepted_results_exact_inputs", modelCalled: needsAnalysis, automaticAttemptsUnchanged: true }] };
      const [run] = await tx.insert(savIntakeRuns).values({ threadId: event.threadId, messageId: event.messageId, version: last.version + 1,
        configHash: humanRevisionConfigHash(config.configHash, id), policyHash: config.policyHash, sourceHash: event.sourceHash,
        state: plan.decision.disposition.kind === "collect_context" ? "waiting" : "observed", payloadCiphertext: encryptSavPayload(payload),
        humanChoiceCiphertext: encryptSavPayload({ eventId: id }), freshUntil: new Date(Math.min(Date.parse(input.now), ...plan.decision.evidence.map(e => Date.parse(e.observedAt))) + 300000) }).returning();
      if(needsAnalysis) await tx.insert(savIntakeJournal).values({runId:run.id,kind:"human_reanalysis",payloadCiphertext:encryptSavPayload({
        eventId:id,parentRunId:parent.id,sourceHash:event.sourceHash,inputHash:intakeRuntimeHash(input),planHash:intakeRuntimeHash(plan),
        semanticsHash:intakeRuntimeHash(semantics),candidateContactIds:[...(plan.candidateContactIds??[])].sort(),
      })});
      if (execution) await amendExecution(tx, event, run, plan, input);
      await tx.update(savIntakeHumanEvents).set({ state: "consumed", revisionRunId: run.id, leaseToken: null, leaseUntil: null }).where(eq(savIntakeHumanEvents.id, id));
      await tx.update(savMessages).set({ analysisStatus: run.state === "observed" ? "intake_observed" : "intake_waiting" }).where(eq(savMessages.id, event.messageId));
      await tx.insert(savIntakeJournal).values({ runId: run.id, kind: "human_revision", payloadCiphertext: encryptSavPayload({ eventId: id, parentRunId: parent.id,
        automaticAttemptsUnchanged: true, callsUnchanged: !needsAnalysis, reason: reason ?? null }) });
      return { runId: run.id, state: run.state };
    });
    return result;
  } catch (error) {
    const reason = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_INTAKE_HUMAN_REVALIDATION_REQUIRED";
    await db.update(savIntakeHumanEvents).set({ state: claim.event.readAttempts >= 2 ? "waiting" : "pending", leaseToken: null, leaseUntil: null })
      .where(and(eq(savIntakeHumanEvents.id, id), eq(savIntakeHumanEvents.leaseToken, token)));
    await db.insert(savIntakeJournal).values({ runId: claim.parent.id, kind: "human_revalidation_waiting", payloadCiphertext: encryptSavPayload({ eventId: id, reason }) });
    return { waiting: reason };
  }
}
export async function reconcileIntakeHumanChoices() {
  const config = savIntakeRuntimeConfig();
  if (!config || !await intakeConsoleInstalled()) return { skipped: "off" };
  const expired = await requireDb().select({id:savIntakeHumanEvents.id}).from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.state,"reading"),eq(savIntakeHumanEvents.readAttempts,2),lt(savIntakeHumanEvents.leaseUntil,new Date()))).limit(4);
  for (const row of expired) await requireDb().update(savIntakeHumanEvents).set({state:"waiting",leaseToken:null,leaseUntil:null}).where(and(eq(savIntakeHumanEvents.id,row.id),lt(savIntakeHumanEvents.leaseUntil,new Date())));
  const [event] = await requireDb().select().from(savIntakeHumanEvents).where(and(inArray(savIntakeHumanEvents.state, ["pending", "reading"]),
    lt(savIntakeHumanEvents.readAttempts, 2), or(sql`${savIntakeHumanEvents.leaseUntil} is null`, lt(savIntakeHumanEvents.leaseUntil, new Date()))))
    .orderBy(savIntakeHumanEvents.createdAt, savIntakeHumanEvents.id).limit(1);
  return event ? consumeIntakeHumanEvent(event.id, config, createSavIntakeHubspotReaders({ network: async (url, init) => {
    const current = savIntakeRuntimeConfig();
    if (!current || current.configHash !== config.configHash) return conflict();
    return fetch(url, { ...init, redirect: "error", headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}` } });
  } })) : { skipped: "empty" };
}
