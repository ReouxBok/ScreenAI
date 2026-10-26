import "server-only";
import { decryptSavPayload } from "../crypto";
import { releaseLegacyAiPauses } from "./legacy-pause";
import { intakeOtherQualificationFresh } from "./other-routing";
import { qualifyRuntimeOther } from "./other-routing-runtime";
import { assertSavIntakeCallPlan } from "./runtime-store";
import { createIntakeModelDispatcher } from "./model-dispatch";
import { prepareIntakeAttachments, intakeInputWithAttachments, finishIntakeAttachmentRead } from "./attachments";
import { intakeMessageHistorical, intakeLaunchMatches, parkLaunchedIntakeMessage } from "./launch-boundary";
import { recordAcceptedIntakeSemantics,reuseAcceptedIntakeSemantics,SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "./semantic-records";
import { newReadRecovery, recoverableIntakeReads, intakeReadRetryable, DEFAULT_INTAKE_READ_RECOVERY } from "./read-recovery";
import { publicIntakeSchemaIssues } from "./schema-diagnostics";
import type { EngineInput, EnginePolicy, MessageAnalysis } from "./engine-types";
import { runSavIntakeShadow, type SavIntakeShadowJob } from "./shadow";
import { savIntakeShadowConfig } from "./shadow-ledger";
import type { IntakeReadTrace } from "./hubspot-readers";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { planSavIntake } from "./engine";
import { intakeTransientFailure, SAV_INTAKE_DETERMINISTIC_ERRORS } from "./attempt-policy";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { createSavIntakeSemanticReaders } from "./model-readers";
import { createSavIntakeSimpleReaders, memoizeIntakeCrmReaders, SAV_INTAKE_SIMPLE_REVISION } from "./simple-readers";
import { withSavAiBudget } from "../gemini-transport";
import { observeSavOther, readSavOtherConfiguration } from "../other-observation";
import { assertSavIntakeObservation, savIntakeRuntimeConfig, SAV_INTAKE_RUNTIME_REVISION,
  type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { assertSavIntakeLease, catchupSavIntake, checkpointSavIntakeRun, claimSavIntakeRun, enqueueSavIntakeMessage, failSavIntakeRun,
  pendingSavIntakeRuns, readSavIntakeBudget, reconcileConfinedIntakeUsage, reserveSavIntakeCall, saveSavIntakeResult, intakeTransientRetries, scheduleSavIntakeTransientRetry } from "./runtime-store";

/** Enqueue only: ingestion never invokes CRM/model or marks a mail processed. */
export async function enqueueConfiguredSavIntake(messageId: string) {
  const launch=await parkLaunchedIntakeMessage(messageId);
  if (launch && "archived" in launch) return launch;
  const config = savIntakeRuntimeConfig();
  if (!config) return launch ?? { skipped: "off" as const };
  if (await intakeMessageHistorical(messageId)) return { archived: true as const };
  if (!await intakeLaunchMatches(config)) throw Error("SAV_INTAKE_LAUNCH_MISMATCH");
  const runId=await enqueueSavIntakeMessage(messageId, config);
  // The run is committed; the wake is a non-throwing hint, cron stays the fallback.
  if (runId) await (await import("./event-dispatch")).requestSavIntakeWake(runId);
  return !runId && launch ? launch : {runId};
}
async function analyseSavIntakeRuntimeWithinBudget(runId: string, config: IntakeRuntimeConfig,
  deps: { env?: () => Record<string, string | undefined>; network?: typeof fetch; downloadAttachments?: Parameters<typeof prepareIntakeAttachments>[3]; authenticateOther?: Parameters<typeof qualifyRuntimeOther>[3]; startReadRecovery?: (runId:string)=>Promise<unknown>; deadlineMs?: number;
    /** Receives the comparison job of this analysis (current pipeline only); run after the live budget. */
    shadowJob?: (job: SavIntakeShadowJob) => void } = {}) {
  const env = deps.env ?? (() => process.env), network = deps.network ?? fetch;
  const lease = await claimSavIntakeRun(runId, config); if (!lease) return { skipped: "not_claimed" };
  const previous = decryptSavPayload<IntakeRuntimePayload>(lease.run.payloadCiphertext);
  if (lease.recoveringRead && previous.input) lease.input = structuredClone(previous.input) as EngineInput;
  const repairMalformedOutput = lease.run.attempts > 1 && ["SAV_INTAKE_MODEL_OUTPUT_REJECTED", "SAV_INTAKE_RUNTIME_CALL_ALREADY_CONSUMED"].includes(previous.reason ?? "");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45_000);
  const traces: unknown[] = [];
  let semanticFailureReason: string | undefined;
  let readFailure: IntakeReadTrace | undefined;
  let dispatcher: ReturnType<typeof createIntakeModelDispatcher> | undefined;
  const payload: IntakeRuntimePayload = {configuration: { configHash: config.configHash, resourcesHash: config.resourcesHash, policyHash: config.policyHash, codeRevision: config.codeRevision, model: config.model }, semantics:{revision:SAV_INTAKE_SEMANTIC_RECORD_REVISION,validatorRevision:SAV_INTAKE_MODEL_REVISION,records:[]},provenance:[...lease.provenance], revision: SAV_INTAKE_RUNTIME_REVISION, input: lease.input, traces, effects: "not_connected" };
  // Fixed at run creation: a switch flip never changes an analysis, repair or resume in flight.
  const pipeline = previous.pipeline === "simple" ? "simple" as const : "current" as const;
  if (pipeline === "simple") payload.pipeline = "simple";
  if (pipeline === "simple") payload.semantics!.validatorRevision = SAV_INTAKE_SIMPLE_REVISION;
  payload.readRecovery = lease.recoveringRead ? structuredClone(previous.readRecovery!) : newReadRecovery(config,lease.sourceHash);
  if (lease.recoveringRead) { payload.semantics=structuredClone(previous.semantics!);payload.attachments=structuredClone(previous.attachments); }
  const live = async () => {
    const current = savIntakeRuntimeConfig(env());
    if (!current || current.configHash !== config.configHash || controller.signal.aborted) throw Error("SAV_INTAKE_RUNTIME_CONTEXT_CHANGED");
    await assertSavIntakeLease(lease, current);
    if(payload.other&&!intakeOtherQualificationFresh(payload.other,env().SAV_INTAKE_OTHER_RULES_JSON))throw Error("SAV_INTAKE_OTHER_AUTHORITY_EXPIRED");
  };
  // Callback checkpoints are serialized and drained before terminal persistence.
  let checkpoints = Promise.resolve();
  const writeCheckpoint = () => { const snapshot=structuredClone(payload);if(!lease.recoveringRead)delete snapshot.readRecovery;return checkpointSavIntakeRun(lease,snapshot); };
  const checkpoint = () => { checkpoints = checkpoints.then(writeCheckpoint); checkpoints.catch(() => {}); };
  try {
    await live();
    const other = observeSavOther({ mailboxId: config.mailboxId, fromEmail: lease.input.message.fromEmail,
      subject: lease.provenance.get(lease.run.messageId)!.subject, gmailMessageId: "stored", body: lease.body,
      protectedContext: lease.input.conversation.data.length > 1 }, readSavOtherConfiguration(env().SAV_OTHER_OBSERVATION_RULES_JSON).registry);
    // This is a candidate only. It grants no routing permission or qualifiedOther.
    if (other) traces.push({ otherCandidate: other, qualified: false });
    let qualifiedOther: Awaited<ReturnType<typeof qualifyRuntimeOther>> = null;
    if(other || env().SAV_INTAKE_OTHER_RULES_JSON) {
      try { qualifiedOther=await qualifyRuntimeOther(lease,live,env(),deps.authenticateOther); }
      catch { traces.push({otherQualification:"unavailable",qualified:false}); await live(); }
    }
    if(qualifiedOther) payload.other=qualifiedOther;
    await writeCheckpoint();
    const retryOrdinal = await intakeTransientRetries(lease.run.messageId);
    dispatcher = createIntakeModelDispatcher({ config, live, retryOrdinal, reserve: hash => reserveSavIntakeCall(lease, config, hash), preflight: hashes => assertSavIntakeCallPlan(lease.run.messageId, config, hashes), signal: controller.signal, env, network });
    const { call, pending } = dispatcher;
    const attachments = lease.recoveringRead ? null : await prepareIntakeAttachments(lease, config.model, live, deps.downloadAttachments);
    if (attachments) {
      payload.attachments = attachments.state;
      if (attachments.complete) {
        lease.input = intakeInputWithAttachments(lease.input, lease.sourceHash, attachments.state, attachments.prepared);
        payload.input = lease.input;
      }
      await writeCheckpoint();
    }
    const crm = createSavIntakeHubspotReaders({ onRead: trace => { if(trace.status!=="complete")readFailure=trace;traces.push(trace); checkpoint(); }, network: async (url, init) => {
      await live();
      const signal = AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]);
      return network(url, { ...init, signal, redirect: "error", headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${env().HUBSPOT_ACCESS_TOKEN}` } });
    } });
    const readPending:Promise<unknown>[]=[];
    const recoverable=recoverableIntakeReads(crm,payload.readRecovery!,{reuse:Boolean(lease.recoveringRead),checkpoint,pending:readPending});
    // The simple reader reads the CRM before its single call; the engine then sees the very same answers.
    // The comparison must see the very CRM answers of this analysis: one memoized snapshot.
    const shadowing = pipeline === "current" && Boolean(deps.shadowJob) && Boolean(savIntakeShadowConfig(env())) && !lease.recoveringRead;
    const reads = pipeline === "simple" || shadowing ? memoizeIntakeCrmReaders(recoverable) : recoverable;
    const priorAnalysis=lease.recoveringRead?payload.semantics!.records.find(r=>r.method==="analyseMessage")?.result as MessageAnalysis|undefined:undefined;
    // The single-call reader may show the model CRM context later than receipt: never used for at_receipt analyses.
    const simple = pipeline === "simple" && lease.input.mode !== "at_receipt";
    if (pipeline === "simple" && !simple) {
      traces.push({ pipeline: "simple", reader: "current", cause: "at_receipt_not_supported" });
      if (!lease.recoveringRead) payload.semantics!.validatorRevision = SAV_INTAKE_MODEL_REVISION;
    }
    const semanticReader = simple ? createSavIntakeSimpleReaders({ model: config.model, call, crm: reads, policy: config.policy, provenance: lease.provenance,
      ...(attachments?.complete ? { attachments: { prepared: attachments.prepared, onRead: observations => {
        attachments.state.read = { ...attachments.state.read, observations, state: "complete", completedAt: new Date().toISOString() };
        payload.attachments = attachments.state; checkpoint();
      } } } : {}),
      onTrace: trace => { semanticFailureReason = trace.errorCode ?? undefined; traces.push(trace); checkpoint(); },
      onJudgement: judgement => { traces.push({ phase: "simple_judgement", ...judgement }); checkpoint(); } })
      : createSavIntakeSemanticReaders({ planCalls: dispatcher.plan, repairMalformedOutput,
      repairIssues:publicIntakeSchemaIssues((previous.traces?.findLast(t=>(t as {validationFailure?:unknown})?.validationFailure) as {validationFailure?:{issues?:unknown}}|undefined)?.validationFailure?.issues),
      ...(priorAnalysis?.attachmentObservations?{acceptedImages:priorAnalysis.attachmentObservations}:{}), ...(attachments?.complete ? { attachments: { prepared: attachments.prepared, onRead: observations => {
      attachments.state.read = { ...attachments.state.read, observations, state: "complete", completedAt: new Date().toISOString() };
      payload.attachments = attachments.state;
      checkpoint();
    } } } : {}), model: config.model, call, provenance: lease.provenance, onTrace: trace => {
      semanticFailureReason = trace.errorCode ?? undefined;
      traces.push(trace); checkpoint();
    } });
    const reuse=lease.recoveringRead?reuseAcceptedIntakeSemantics(semanticReader,payload.semantics!,method=>{traces.push({method,phase:"accepted_semantics",accepted:true,cached:true});checkpoint();}):semanticReader;
    const semantic=recordAcceptedIntakeSemantics(reuse,payload.semantics!,checkpoint, failure => {
      semanticFailureReason = failure.errorCode;
      traces.push({ ...failure, phase: "accepted_semantics", accepted: false }); checkpoint();
    });
    const enginePolicy: EnginePolicy = qualifiedOther ? {...config.policy,qualifiedOther:{...(qualifiedOther.family==="authenticated_newsletter"?{family:"authenticated_newsletter" as const}:{}),resource:qualifiedOther.resource,evidenceSource:"private_rule"}} : config.policy;
    const shadowInput = structuredClone(lease.input);
    payload.plan = await withSavAiBudget(() => planSavIntake(lease.input, { ...reads, ...semantic }, enginePolicy, { timeoutMs: 10_000 }, () => new Date()));
    assertSavIntakeObservation(payload.plan);
    // Cancellation may finish after the pure planner's per-call timeout.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled([...pending,...readPending]), new Promise<never>((_, reject) => { drainTimer = setTimeout(() => reject(Error("SAV_INTAKE_RUNTIME_SETTLEMENT_UNCERTAIN")), 15_000); })]); }
    finally { if (drainTimer) clearTimeout(drainTimer); }
    await checkpoints;
    if (dispatcher.uncertain) throw Error("SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN");
    await live();
    payload.reason = readFailure?.reason ?? dispatcher.failureReason ?? semanticFailureReason;
    finishIntakeAttachmentRead(payload.attachments,attachmentFailureReason(payload.reason,dispatcher.uncertain));
    const state = payload.plan.decision.disposition.kind === "collect_context" && payload.plan.progress.kind !== "human_choice" ? "waiting" : "observed";
    if (state==="waiting" && readFailure && intakeReadRetryable(readFailure.reason) && payload.semantics?.records.some(r=>r.method==="analyseMessage")) {
      const recovery=payload.readRecovery!, limits=config.readRecovery??DEFAULT_INTAKE_READ_RECOVERY;
      recovery.operation=readFailure.operation;recovery.code=readFailure.reason!;
      recovery.retryAt=new Date(Date.now()+limits.delayMs*2**recovery.attempts).toISOString();
      recovery.state=recovery.attempts<limits.maxAttempts&&Date.parse(recovery.retryAt)<Date.parse(recovery.expiresAt)?"scheduled":"exhausted";
    } else if(lease.recoveringRead) {payload.readRecovery!.state=state==="waiting"?"invalidated":"complete";payload.readRecovery!.cache=[];}
    else delete payload.readRecovery;
    await saveSavIntakeResult(lease, config, payload, state);
    // The comparison reads the same cached CRM answers; anything else it needs goes to a separate,
    // trace-free reader that can never checkpoint or otherwise touch this run.
    const shadowReads = shadowing ? (reads as ReturnType<typeof memoizeIntakeCrmReaders>).beside(createSavIntakeHubspotReaders({ network: async (url, init) => network(url, { ...init, redirect: "error",
      headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${env().HUBSPOT_ACCESS_TOKEN}` } }) })) : reads;
    if (shadowing && !dispatcher.uncertain) deps.shadowJob!({ runId, messageId: lease.run.messageId, sourceHash: lease.sourceHash, input: shadowInput, reads: shadowReads, policy: enginePolicy,
      provenance: lease.provenance, ...(attachments?.complete ? { attachments: attachments.prepared } : {}), livePlan: payload.plan, config, env, network });
    // A provider outage is retried automatically at a durable due time, not left to wait.
    const transientRetry = state === "waiting" && !dispatcher.uncertain && payload.readRecovery?.state !== "scheduled" && intakeTransientFailure(payload.reason)
      ? await scheduleSavIntakeTransientRetry(runId, payload.reason!) : null;
    if(payload.readRecovery?.state==="scheduled")await (await import("./read-recovery-wake")).requestReadRecoveryWake(runId,{env:env(),start:deps.startReadRecovery});
    const retryFormat = state === "waiting" && lease.run.attempts === 1 && attachments?.complete
      && attachments.prepared.uniqueImages.length > 0 && payload.reason === "SAV_INTAKE_MODEL_OUTPUT_REJECTED";
    return { runId, state, ...(retryFormat ? { retryFormat: true as const } : {}), retryAt: transientRetry?.retryAt.toISOString() };
  } catch (error) {
    controller.abort();
    // An expired routing authority must never leave a publishable Other plan.
    if(payload.other&&!intakeOtherQualificationFresh(payload.other,env().SAV_INTAKE_OTHER_RULES_JSON)){delete payload.plan;delete payload.other;}
    payload.reason = error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_INTERRUPTED";
    if(lease.recoveringRead)payload.readRecovery!.state="invalidated";else delete payload.readRecovery;
    finishIntakeAttachmentRead(payload.attachments,attachmentFailureReason(payload.reason,Boolean(dispatcher?.uncertain)));
    await failSavIntakeRun(lease, payload, Boolean(dispatcher?.uncertain) || payload.reason === "SAV_INTAKE_RUNTIME_SETTLEMENT_UNCERTAIN",
      { deterministic: SAV_INTAKE_DETERMINISTIC_ERRORS.has(payload.reason ?? "") });
    const uncertain = Boolean(dispatcher?.uncertain) || payload.reason === "SAV_INTAKE_RUNTIME_SETTLEMENT_UNCERTAIN";
    const transientRetry = !uncertain && intakeTransientFailure(payload.reason) ? await scheduleSavIntakeTransientRetry(runId, payload.reason!).catch(() => null) : null;
    return { runId, state: dispatcher?.uncertain ? "uncertain" : "waiting", reason: payload.reason, retryAt: transientRetry?.retryAt.toISOString() };
  } finally { controller.abort(); clearTimeout(timer); }
}
export async function analyseSavIntakeRuntime(...args: Parameters<typeof analyseSavIntakeRuntimeWithinBudget>) {
  let job: SavIntakeShadowJob | undefined;
  const withShadow: Parameters<typeof analyseSavIntakeRuntimeWithinBudget> = [args[0], args[1], { ...args[2], shadowJob: value => { job = value; } }];
  const result = await analyseSavIntakeRuntimeAttempts(...withShadow);
  // The comparison runs after, outside the live AI budget; it can never change the live result.
  const shadow = job && savIntakeShadowConfig((args[2]?.env ?? (() => process.env))());
  const deadline = args[2]?.deadlineMs;
  if (job && shadow && (deadline === undefined || deadline - Date.now() >= 65_000))
    await runSavIntakeShadow(job, shadow).catch(error => console.warn("sav_intake_shadow", { error: error instanceof Error ? error.message : "unknown" }));
  return result;
}
async function analyseSavIntakeRuntimeAttempts(...args: Parameters<typeof analyseSavIntakeRuntimeWithinBudget>) {
  const first = await withSavAiBudget(() => analyseSavIntakeRuntimeWithinBudget(...args));
  if (!("retryFormat" in first) || !first.retryFormat) return first;
  const deadline = args[2]?.deadlineMs;
  if (deadline !== undefined && (!Number.isFinite(deadline) || deadline - Date.now() < 65_000)) return first;
  // A new lease increments the unchanged two-attempt bound, rechecks pause,
  // latest message and uncertain usage, and retains the same durable ledger.
  const second = await withSavAiBudget(() => analyseSavIntakeRuntimeWithinBudget(...args));
  return "skipped" in second ? first : second;
}
/** Cron reconciliation is bounded to four queued messages and one analysis/pass.
 * It runs alongside V0 observation and never acquires action/send capabilities. */
export async function reconcileSavIntakeRuntime(options: { deadlineMs?: number } = {}) {
  const config = savIntakeRuntimeConfig(); if (!config) return { skipped: "off" as const };
  await (await import("./read-recovery-store")).expireIntakeReadRecoveries(config);
  await (await import("./read-recovery-wake")).dispatchPendingReadRecoveryWakes({env:process.env});
  if (options.deadlineMs && options.deadlineMs - Date.now() < 65_000) return { skipped: "deadline" as const };
  const operatorResume = await (await import("./operator-resume")).reconcileOperatorResumes();
  if (operatorResume) return { mode: "observe", operatorResume };
  await reconcileConfinedIntakeUsage(config);
  // Before catch-up, so a customer reply on a legacy-paused thread is analysed in this pass.
  const legacyPauses = await releaseLegacyAiPauses(config);
  const queued = await catchupSavIntake(config), runs = await pendingSavIntakeRuns(config);
  let result: Awaited<ReturnType<typeof analyseSavIntakeRuntime>> | null = null;
  for (const run of runs) {
    result = await analyseSavIntakeRuntime(run.id, config, { deadlineMs: options.deadlineMs });
    if (!("skipped" in result)) break;
  }
  return { mode: "observe", queued, legacyPauses, result, budget: await readSavIntakeBudget(config) };
}

function attachmentFailureReason(reason:string|undefined,uncertain:boolean):import("../attachment-contract").SavAttachmentObservation["reason"] {
  if(uncertain)return "outcome_uncertain";
  if(reason==="SAV_INTAKE_MODEL_OUTPUT_REJECTED")return "validation_failed";
  if(reason?.includes("BUDGET"))return "budget_exhausted";
  if(reason?.includes("TIMEOUT"))return "timeout";
  if(reason?.includes("CONTEXT")||reason?.includes("REVALIDATION"))return "context_changed";
  return reason?"provider_failed":"context_incomplete";
}
