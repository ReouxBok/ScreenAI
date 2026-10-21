import "server-only";
import { intakeMessageHistorical, intakeLaunchMatches } from "./launch-boundary";
import { recordAcceptedIntakeSemantics,SAV_INTAKE_SEMANTIC_RECORD_REVISION } from "./semantic-records";
import { SAV_INTAKE_MODEL_REVISION } from "./model-readers";
import { readSavGeminiResponse, type SavGeminiMetadata } from "../gemini-response";
import { planSavIntake } from "./engine";
import { createSavIntakeHubspotReaders } from "./hubspot-readers";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall } from "./model-readers";
import { evaluationProviderResponse } from "./server-runner";
import { requestSavGeminiJson, savAiErrorMetadata, savGeminiGenerationConfig, withSavAiBudget } from "../gemini-transport";
import { observeSavOther, readSavOtherConfiguration } from "../other-observation";
import { assertSavIntakeObservation, intakeRuntimeHash, savIntakeRuntimeConfig, SAV_INTAKE_RUNTIME_REVISION,
  type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";
import { assertSavIntakeLease, catchupSavIntake, checkpointSavIntakeRun, claimSavIntakeRun, enqueueSavIntakeMessage, failSavIntakeRun,
  pendingSavIntakeRuns, readSavIntakeBudget, reserveSavIntakeCall, saveSavIntakeResult, settleSavIntakeCall } from "./runtime-store";

/** Enqueue only: ingestion never invokes CRM/model or marks a mail processed. */
export async function enqueueConfiguredSavIntake(messageId: string) {
  const config = savIntakeRuntimeConfig();
  if (!config) return { skipped: "off" as const };
  if (await intakeMessageHistorical(messageId)) return { archived: true as const };
  if (!await intakeLaunchMatches(config)) throw Error("SAV_INTAKE_LAUNCH_MISMATCH");
  return { runId: await enqueueSavIntakeMessage(messageId, config) };
}
export async function analyseSavIntakeRuntime(runId: string, config: IntakeRuntimeConfig,
  deps: { env?: () => Record<string, string | undefined>; network?: typeof fetch } = {}) {
  const env = deps.env ?? (() => process.env), network = deps.network ?? fetch;
  const lease = await claimSavIntakeRun(runId, config); if (!lease) return { skipped: "not_claimed" };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 45_000);
  const pending: Promise<unknown>[] = [], traces: unknown[] = [];
  let uncertain = false, failureReason: string | undefined;
  const payload: IntakeRuntimePayload = {configuration: { configHash: config.configHash, resourcesHash: config.resourcesHash, policyHash: config.policyHash, codeRevision: config.codeRevision, model: config.model }, semantics:{revision:SAV_INTAKE_SEMANTIC_RECORD_REVISION,validatorRevision:SAV_INTAKE_MODEL_REVISION,records:[]},provenance:[...lease.provenance], revision: SAV_INTAKE_RUNTIME_REVISION, input: lease.input, traces, effects: "not_connected" };
  const live = async () => {
    const current = savIntakeRuntimeConfig(env());
    if (!current || current.configHash !== config.configHash || controller.signal.aborted) throw Error("SAV_INTAKE_RUNTIME_CONTEXT_CHANGED");
    await assertSavIntakeLease(lease, current);
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
    await checkpointSavIntakeRun(lease, payload);
    const execute: IntakeGeminiCall = async input => {
      await live();
      if (input.model !== config.model || input.allowRetry !== false || input.signal.aborted || uncertain) throw Error("SAV_INTAKE_RUNTIME_DISPATCH_REJECTED");
      const key = env().SAV_GEMINI_API_KEY!;
      const expectedBody = JSON.stringify({ ...input.body, generationConfig: savGeminiGenerationConfig(config.model, input.body.generationConfig) });
      if (Buffer.byteLength(expectedBody) > 65_536 || input.body.generationConfig.maxOutputTokens !== 8192) throw Error("SAV_INTAKE_RUNTIME_REQUEST_REJECTED");
      let sent = false;
      const reserved = await reserveSavIntakeCall(lease, config, intakeRuntimeHash(expectedBody));
      if (reserved.cached) return reserved.cached;
      const reservation = reserved.id;
      let providerUsage: SavGeminiMetadata | undefined;
      // The legacy transport sums absent counters as zero. Admission settlement
      // must instead retain the exact presence of all four provider counters,
      // including when the model text cannot be parsed as JSON.
      const exactUsage = (metadata?: SavGeminiMetadata): SavGeminiMetadata => ({ ...metadata,
        inputTokens: providerUsage?.inputTokens, outputTokens: providerUsage?.outputTokens,
        thoughtTokens: providerUsage?.thoughtTokens, totalTokens: providerUsage?.totalTokens });
      const guardedNetwork: typeof fetch = async (url, init) => {
        await live();
        if (sent || input.signal.aborted || String(url) !== `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`
          || init?.method !== "POST" || init.body !== expectedBody || new Headers(init.headers).get("x-goog-api-key") !== key) throw Error("SAV_INTAKE_RUNTIME_NETWORK_REJECTED");
        sent = true;
        await live();
        const signal = AbortSignal.any([controller.signal, input.signal, ...(init.signal ? [init.signal] : [])]);
        if (signal.aborted) throw Error("SAV_INTAKE_RUNTIME_CONTEXT_CHANGED");
        const response = await evaluationProviderResponse(await network(url, { ...init, signal, redirect: "error" }), signal);
        if (response.ok) {
          try { providerUsage = readSavGeminiResponse(await response.clone().json()).metadata; }
          catch { providerUsage = undefined; }
        }
        return response;
      };
      try {
        const generated = await requestSavGeminiJson({ ...input, apiKey: key, fetch: guardedNetwork, allowRetry: false });
        const result = { ...generated, metadata: exactUsage(generated.metadata) };
        if (!reservation) throw Error("SAV_INTAKE_RUNTIME_DISPATCH_REJECTED");
        uncertain = !await settleSavIntakeCall(reservation, result.metadata, result);
        return result;
      } catch (error) {
        if (reservation) uncertain = !await settleSavIntakeCall(reservation, exactUsage(savAiErrorMetadata(error)));
        failureReason = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_PROVIDER_UNAVAILABLE";
        throw error;
      }
    };
    const call: IntakeGeminiCall = input => { const work = execute(input).catch(error => {
      failureReason = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_PROVIDER_UNAVAILABLE";
      throw error;
    }); pending.push(work); return work; };
    const semanticReader = createSavIntakeSemanticReaders({ model: config.model, call, provenance: lease.provenance, onTrace: trace => { traces.push(trace); checkpoint(); } });
    const semantic=recordAcceptedIntakeSemantics(semanticReader,payload.semantics!,checkpoint);
    const crm = createSavIntakeHubspotReaders({ onRead: trace => { traces.push(trace); checkpoint(); }, network: async (url, init) => {
      await live();
      const signal = AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]);
      return network(url, { ...init, signal, redirect: "error", headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${env().HUBSPOT_ACCESS_TOKEN}` } });
    } });
    payload.plan = await withSavAiBudget(() => planSavIntake(lease.input, { ...crm, ...semantic }, config.policy, { timeoutMs: 10_000 }, () => new Date()));
    assertSavIntakeObservation(payload.plan);
    // Cancellation may finish after the pure planner's per-call timeout.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled(pending), new Promise<never>((_, reject) => { drainTimer = setTimeout(() => reject(Error("SAV_INTAKE_RUNTIME_SETTLEMENT_UNCERTAIN")), 15_000); })]); }
    finally { if (drainTimer) clearTimeout(drainTimer); }
    await checkpoints;
    if (uncertain) throw Error("SAV_INTAKE_RUNTIME_USAGE_UNCERTAIN");
    await live();
    payload.reason = failureReason;
    await saveSavIntakeResult(lease, config, payload, payload.plan.decision.disposition.kind === "collect_context" ? "waiting" : "observed");
    return { runId, state: payload.plan.decision.disposition.kind === "collect_context" ? "waiting" : "observed" };
  } catch (error) {
    controller.abort();
    payload.reason = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_INTAKE_RUNTIME_INTERRUPTED";
    await failSavIntakeRun(lease, payload, uncertain || payload.reason === "SAV_INTAKE_RUNTIME_SETTLEMENT_UNCERTAIN");
    return { runId, state: uncertain ? "uncertain" : "waiting", reason: payload.reason };
  } finally { controller.abort(); clearTimeout(timer); }
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
