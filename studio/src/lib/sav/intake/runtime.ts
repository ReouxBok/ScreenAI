import "server-only";
import { intakeOtherQualificationFresh } from "./other-routing";
import { qualifyRuntimeOther } from "./other-routing-runtime";
import { createIntakeModelDispatcher } from "./model-dispatch";
import { prepareIntakeAttachments, intakeInputWithAttachments, finishIntakeAttachmentRead } from "./attachments";
import { intakeMessageHistorical, intakeLaunchMatches, parkLaunchedIntakeMessage } from "./launch-boundary";
import { recordAcceptedIntakeSemantics,SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "./semantic-records";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { planSavIntake } from "./engine";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { createSavIntakeSemanticReaders } from "./model-readers";
import { withSavAiBudget } from "../gemini-transport";
import { observeSavOther, readSavOtherConfiguration } from "../other-observation";
import { assertSavIntakeObservation, savIntakeRuntimeConfig, SAV_INTAKE_RUNTIME_REVISION,
  type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { assertSavIntakeLease, catchupSavIntake, checkpointSavIntakeRun, claimSavIntakeRun, enqueueSavIntakeMessage, failSavIntakeRun,
  pendingSavIntakeRuns, readSavIntakeBudget, reserveSavIntakeCall, saveSavIntakeResult } from "./runtime-store";

/** Enqueue only: ingestion never invokes CRM/model or marks a mail processed. */
export async function enqueueConfiguredSavIntake(messageId: string) {
  const launch=await parkLaunchedIntakeMessage(messageId);
  if (launch && "archived" in launch) return launch;
  const config = savIntakeRuntimeConfig();
  if (!config) return launch ?? { skipped: "off" as const };
  if (await intakeMessageHistorical(messageId)) return { archived: true as const };
  if (!await intakeLaunchMatches(config)) throw Error("SAV_INTAKE_LAUNCH_MISMATCH");
  const runId=await enqueueSavIntakeMessage(messageId, config);
  return !runId && launch ? launch : {runId};
}
async function analyseSavIntakeRuntimeWithinBudget(runId: string, config: IntakeRuntimeConfig,
  deps: { env?: () => Record<string, string | undefined>; network?: typeof fetch; downloadAttachments?: Parameters<typeof prepareIntakeAttachments>[3]; authenticateOther?: Parameters<typeof qualifyRuntimeOther>[3] } = {}) {
  const env = deps.env ?? (() => process.env), network = deps.network ?? fetch;
  const lease = await claimSavIntakeRun(runId, config); if (!lease) return { skipped: "not_claimed" };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45_000);
  const traces: unknown[] = [];
  let dispatcher: ReturnType<typeof createIntakeModelDispatcher> | undefined;
  const payload: IntakeRuntimePayload = {configuration: { configHash: config.configHash, resourcesHash: config.resourcesHash, policyHash: config.policyHash, codeRevision: config.codeRevision, model: config.model }, semantics:{revision:SAV_INTAKE_SEMANTIC_RECORD_REVISION,validatorRevision:SAV_INTAKE_MODEL_REVISION,records:[]},provenance:[...lease.provenance], revision: SAV_INTAKE_RUNTIME_REVISION, input: lease.input, traces, effects: "not_connected" };
  const live = async () => {
    const current = savIntakeRuntimeConfig(env());
    if (!current || current.configHash !== config.configHash || controller.signal.aborted) throw Error("SAV_INTAKE_RUNTIME_CONTEXT_CHANGED");
    await assertSavIntakeLease(lease, current);
    if(payload.other&&!intakeOtherQualificationFresh(payload.other,env().SAV_INTAKE_OTHER_RULES_JSON))throw Error("SAV_INTAKE_OTHER_AUTHORITY_EXPIRED");
  };
  // Callback checkpoints are serialized and drained before terminal persistence.
  let checkpoints = Promise.resolve();
  const checkpoint = () => { checkpoints = checkpoints.then(() => checkpointSavIntakeRun(lease, payload)); checkpoints.catch(() => {}); };
  try {
    await live();
    const other = observeSavOther({ mailboxId: config.mailboxId, fromEmail: lease.input.message.fromEmail,
      subject: lease.provenance.get(lease.run.messageId)!.subject, gmailMessageId: "stored", body: lease.body,
      protectedContext: lease.input.conversation.data.length > 1 }, readSavOtherConfiguration(env().SAV_OTHER_OBSERVATION_RULES_JSON).registry);
    // This is a candidate only. It grants no routing permission or qualifiedOther.
    if (other) traces.push({ otherCandidate: other, qualified: false });
    let qualifiedOther: Awaited<ReturnType<typeof qualifyRuntimeOther>> = null;
    if(other) {
      try { qualifiedOther=await qualifyRuntimeOther(lease,live,env(),deps.authenticateOther); }
      catch { traces.push({otherQualification:"unavailable",qualified:false}); await live(); }
    }
    if(qualifiedOther) payload.other=qualifiedOther;
    await checkpointSavIntakeRun(lease, payload);
    dispatcher = createIntakeModelDispatcher({ config, live, reserve: hash => reserveSavIntakeCall(lease, config, hash), signal: controller.signal, env, network });
    const { call, pending } = dispatcher;
    const attachments = await prepareIntakeAttachments(lease, config.model, live, deps.downloadAttachments);
    if (attachments) {
      payload.attachments = attachments.state;
      if (attachments.complete) {
        lease.input = intakeInputWithAttachments(lease.input, lease.sourceHash, attachments.state, attachments.prepared);
        payload.input = lease.input;
      }
      await checkpointSavIntakeRun(lease, payload);
    }
    const semanticReader = createSavIntakeSemanticReaders({ ...(attachments?.complete ? { attachments: { prepared: attachments.prepared, onRead: observations => {
      attachments.state.read = { ...attachments.state.read, observations, state: "complete", completedAt: new Date().toISOString() };
      payload.attachments = attachments.state;
      checkpoint();
    } } } : {}), model: config.model, call, provenance: lease.provenance, onTrace: trace => { traces.push(trace); checkpoint(); } });
    const semantic=recordAcceptedIntakeSemantics(semanticReader,payload.semantics!,checkpoint);
    const crm = createSavIntakeHubspotReaders({ onRead: trace => { traces.push(trace); checkpoint(); }, network: async (url, init) => {
      await live();
      const signal = AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]);
      return network(url, { ...init, signal, redirect: "error", headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${env().HUBSPOT_ACCESS_TOKEN}` } });
    } });
    payload.plan = await withSavAiBudget(() => planSavIntake(lease.input, { ...crm, ...semantic }, qualifiedOther ? {...config.policy,qualifiedOther:{resource:qualifiedOther.resource,evidenceSource:"private_rule"}} : config.policy, { timeoutMs: 10_000 }, () => new Date()));
    assertSavIntakeObservation(payload.plan);
    // Cancellation may finish after the pure planner's per-call timeout.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled(pending), new Promise<never>((_, reject) => { drainTimer = setTimeout(() => reject(Error("SAV_INTAKE_RUNTIME_SETTLEMENT_UNCERTAIN")), 15_000); })]); }
    finally { if (drainTimer) clearTimeout(drainTimer); }
    await checkpoints;
    if (dispatcher.uncertain) throw Error("SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN");
    await live();
    payload.reason = dispatcher.failureReason;
    finishIntakeAttachmentRead(payload.attachments,attachmentFailureReason(payload.reason,dispatcher.uncertain));
    await saveSavIntakeResult(lease, config, payload, payload.plan.decision.disposition.kind === "collect_context" ? "waiting" : "observed");
    return { runId, state: payload.plan.decision.disposition.kind === "collect_context" ? "waiting" : "observed" };
  } catch (error) {
    controller.abort();
    // An expired routing authority must never leave a publishable Other plan.
    if(payload.other&&!intakeOtherQualificationFresh(payload.other,env().SAV_INTAKE_OTHER_RULES_JSON)){delete payload.plan;delete payload.other;}
    payload.reason = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_INTERRUPTED";
    finishIntakeAttachmentRead(payload.attachments,attachmentFailureReason(payload.reason,Boolean(dispatcher?.uncertain)));
    await failSavIntakeRun(lease, payload, Boolean(dispatcher?.uncertain) || payload.reason === "SAV_INTAKE_RUNTIME_SETTLEMENT_UNCERTAIN");
    return { runId, state: dispatcher?.uncertain ? "uncertain" : "waiting", reason: payload.reason };
  } finally { controller.abort(); clearTimeout(timer); }
}
export function analyseSavIntakeRuntime(...args: Parameters<typeof analyseSavIntakeRuntimeWithinBudget>) {
  return withSavAiBudget(() => analyseSavIntakeRuntimeWithinBudget(...args));
}
/** Cron reconciliation is bounded to four queued messages and one analysis/pass.
 * It runs alongside V0 observation and never acquires action/send capabilities. */
export async function reconcileSavIntakeRuntime(options: { deadlineMs?: number } = {}) {
  const config = savIntakeRuntimeConfig(); if (!config) return { skipped: "off" as const };
  if (options.deadlineMs && options.deadlineMs - Date.now() < 65_000) return { skipped: "deadline" as const };
  const queued = await catchupSavIntake(config), runs = await pendingSavIntakeRuns(config);
  let result: Awaited<ReturnType<typeof analyseSavIntakeRuntime>> | null = null;
  for (const run of runs) {
    result = await analyseSavIntakeRuntime(run.id, config);
    if (!("skipped" in result)) break;
  }
  return { mode: "observe", queued, result, budget: await readSavIntakeBudget(config) };
}

function attachmentFailureReason(reason:string|undefined,uncertain:boolean):import("../attachment-contract").SavAttachmentObservation["reason"] {
  if(uncertain)return "outcome_uncertain";
  if(reason?.includes("BUDGET"))return "budget_exhausted";
  if(reason?.includes("TIMEOUT"))return "timeout";
  if(reason?.includes("CONTEXT")||reason?.includes("REVALIDATION"))return "context_changed";
  return reason?"provider_failed":"context_incomplete";
}
