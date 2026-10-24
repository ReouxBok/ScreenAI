import "server-only";
import { eq } from "drizzle-orm";
import { readSavExternalCompletion } from "../external-completion";
import { requireDb } from "@/db";
import { savIntakeExecutions, savIntakeRuns, savMessages } from "@/db/schema";
import { savIntakeRuntimeConfig, type IntakeRuntimeConfig } from "./runtime-contract";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "./execution-policy";
import { createIntakeExecutorAdapters } from "./execution-adapters";
import { admitIntakeExecution, getExecutionEffects, occupationSchemaInstalled } from "./execution-store";
import { executeIntakePass, readIntakeExecutionProgress } from "./executor";
import { projectIntakeThread } from "./console-store";
import { markSavIntakeWake, readSavIntakeWake, savIntakeEventDispatchEnabled, savIntakeWakeStage } from "./event-dispatch";
import type { ExecutionOptions, ExecutorAdapters } from "./execution-types";

type Env = Record<string, string | undefined>;
type Message = { id: string; threadId: string; receivedAt: Date };
export type SavExternalCompletionReader = (message: Message) => Promise<unknown>;
export type SavIntakeWakeDeps = {
  env?: () => Env;
  /** Test seam: provider fetch for the real runtime (model + CRM reads). */
  network?: typeof fetch;
  adapters?: ExecutorAdapters;
  readExternalCompletion?: SavExternalCompletionReader;
};
const code = (e: unknown) => e instanceof Error && /^SAV_[A-Z_]+$/.test(e.message) ? e.message : "SAV_INTAKE_WAKE_INTERRUPTED";
// Same tolerated admission refusals as the cron scanner: the dossier stays durable.
const ADMISSION_WAITING = ["SAV_INTAKE_EXECUTION_SCOPE_OCCUPIED", "SAV_INTAKE_EXECUTION_LEGACY_SCOPE_OCCUPIED", "SAV_INTAKE_EXECUTION_LEGACY_SCOPE_UNKNOWN", "SAV_INTAKE_EXECUTION_ADMISSION_LIMIT", "SAV_INTAKE_EXECUTION_NOT_ADMITTED"];

function runtimeConfig(env: Env): IntakeRuntimeConfig | string {
  try { return savIntakeRuntimeConfig(env) ?? "off"; } catch (error) { return code(error); }
}
async function currentRun(runId: string, config: IntakeRuntimeConfig) {
  const [run] = await requireDb().select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
  return run?.isCurrent && run.configHash === config.configHash ? run : null;
}

async function externalFence(messageId: string, deps: SavIntakeWakeDeps) {
  const read = deps.readExternalCompletion ?? readSavExternalCompletion;
  const [message] = await requireDb().select({ id: savMessages.id, threadId: savMessages.threadId, receivedAt: savMessages.receivedAt }).from(savMessages).where(eq(savMessages.id, messageId));
  return !message ? "message_missing" : await read(message) ? "external_completion" : null;
}

/** Step 1: first analysis of exactly this run with the real runtime (claim,
 * lease, ledger reservation/settlement). Skipped when it is no longer needed. */
export async function analyseSavIntakeWake(runId: string, deps: SavIntakeWakeDeps = {}) {
  const env = deps.env ?? (() => process.env);
  if (!savIntakeEventDispatchEnabled(env())) return { stage: "analysis", state: "skipped", reason: "event_dispatch_off" };
  const config = runtimeConfig(env());
  if (typeof config === "string") return { stage: "analysis", state: "skipped", reason: config };
  const run = await currentRun(runId, config);
  if (!run) { await markSavIntakeWake(runId, "completed", { outcome: "not_current" }); return { stage: "analysis", state: "skipped", reason: "not_current" }; }
  const fence = await externalFence(run.messageId, deps);
  if (fence) { await markSavIntakeWake(runId, "completed", { outcome: fence }); return { stage: "analysis", state: "skipped", reason: fence }; }
  const stage = await savIntakeWakeStage(runId);
  // Already analysed (observed/admitted): continue without the model.
  if (stage !== "analysis") return { stage: "analysis", state: stage ? "done" : "skipped", reason: stage ?? "no_durable_work" };
  await markSavIntakeWake(runId, "running", { startedAt: new Date().toISOString() });
  try { await (await import("./runtime")).analyseSavIntakeRuntime(runId, config, { env, ...(deps.network ? { network: deps.network } : {}) }); }
  catch (error) { console.error("sav_intake_wake_step", { runId, stage: "analysis", errorCode: code(error) }); }
  const after = await currentRun(runId, config), state = after?.state ?? "superseded";
  await markSavIntakeWake(runId, state === "observed" ? "running" : state === "superseded" ? "completed" : "waiting", { outcome: state, analysedAt: new Date().toISOString() });
  return { stage: "analysis", state };
}

async function executionOptions(deps: SavIntakeWakeDeps, runtime: IntakeRuntimeConfig): Promise<ExecutionOptions | string> {
  const environment = deps.env ?? (() => process.env), env = environment();
  let config: ReturnType<typeof intakeExecutionConfig>;
  try { config = intakeExecutionConfig(env); } catch (error) { return code(error); }
  if (!config) return "execution_off";
  if (!await occupationSchemaInstalled()) return "schema_absent";
  const { policy } = await readIntakeExecutionAuthority(config);
  const adapters = deps.adapters ?? createIntakeExecutorAdapters({ env: environment });
  return { config, runtime, policy, adapters, env: environment, signal: AbortSignal.timeout(55_000) };
}

/** Step 2: never calls the model. Observed: admission then one executor pass.
 * Already admitted: resume that same execution through the executor's own
 * claim/lease; uncertain effects are only verified there, never re-sent. */
export async function executeSavIntakeWake(runId: string, deps: SavIntakeWakeDeps = {}) {
  const env = deps.env ?? (() => process.env);
  if (!savIntakeEventDispatchEnabled(env())) return { stage: "execution", state: "skipped", reason: "event_dispatch_off" };
  const runtime = runtimeConfig(env());
  if (typeof runtime === "string") return { stage: "execution", state: "skipped", reason: runtime };
  const run = await currentRun(runId, runtime), stage = run ? await savIntakeWakeStage(runId) : null;
  if (!run || (stage !== "admission" && stage !== "execution")) return { stage: "execution", state: "skipped", reason: stage ?? "no_durable_work" };
  const fence = await externalFence(run.messageId, deps);
  if (fence) { await markSavIntakeWake(runId, "completed", { outcome: fence }); return { stage: "execution", state: "skipped", reason: fence }; }
  let result: { state: string; reason?: string } = { state: "waiting" };
  try {
    const options = await executionOptions(deps, runtime);
    if (typeof options === "string") result = { state: "skipped", reason: options };
    else {
      let executionId: string | null = null;
      if (stage === "admission") {
        const admitted = await admitIntakeExecution(runId, options).catch(error => {
          if (ADMISSION_WAITING.includes(code(error))) return code(error);
          throw error;
        });
        if (typeof admitted === "string") result = { state: "waiting", reason: admitted };
        else if (!admitted) result = { state: "skipped", reason: "not_admissible" };
        else executionId = admitted.id;
      } else {
        const [existing] = await requireDb().select().from(savIntakeExecutions).where(eq(savIntakeExecutions.messageId, run.messageId));
        // Another authority's execution is rebound only by the audited operator recovery.
        if (existing.policyId !== options.config.policyId) result = { state: "waiting", reason: "execution_policy_mismatch" };
        else executionId = existing.id;
      }
      if (executionId) {
        const pass = await executeIntakePass(executionId, options) as { state?: string; skipped?: string; reason?: string };
        result = pass.skipped ? { state: "waiting", reason: pass.skipped } : { state: pass.state ?? "waiting", ...(pass.reason ? { reason: pass.reason } : {}) };
      }
    }
  } catch (error) { result = { state: "waiting", reason: code(error) }; }
  // Waiting/uncertain executions stay resumable (wake recovery, then cron executor).
  await markSavIntakeWake(runId, await savIntakeWakeStage(runId) ? "waiting" : "completed", { outcome: result.reason ?? result.state, executedAt: new Date().toISOString() });
  return { stage: "execution", ...result };
}

/** Step 3: targeted console projection and stage timings, ids only.
 * analysedToConfirmedMs exists only for a fully confirmed execution. */
export async function finishSavIntakeWake(runId: string) {
  const [run] = await requireDb().select().from(savIntakeRuns).where(eq(savIntakeRuns.id, runId));
  if (!run) return { projected: false, timings: null };
  const projected = await projectIntakeThread(run.threadId).catch(() => false);
  // Read receipt failure never replays a confirmed CRM action.
  await (await import("./gmail-read")).syncHandledIntakeGmailRead(run.messageId).catch(() => {
    console.error("sav_intake_gmail_read", { runId, errorCode: "SAV_INTAKE_GMAIL_READ_RETRY_REQUIRED" });
  });
  const [message] = await requireDb().select({ receivedAt: savMessages.receivedAt, createdAt: savMessages.createdAt }).from(savMessages).where(eq(savMessages.id, run.messageId));
  const progress = await readIntakeExecutionProgress(run.messageId);
  const confirmedAt = progress?.confirmed ? Math.max(...(await getExecutionEffects(progress.executionId)).map(e => e.confirmedAt?.getTime() ?? 0)) : null;
  const meta = (await readSavIntakeWake(runId))?.technicalMetadata ?? {};
  const at = (v: unknown) => typeof v === "string" ? Date.parse(v) : null;
  const span = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null ? Math.max(0, b - a) : null;
  const received = message?.receivedAt.getTime(), stored = message?.createdAt.getTime(), woke = at(meta.firstDispatchedAt), started = at(meta.startedAt), analysed = at(meta.analysedAt);
  const timings = { receivedToStoredMs: span(received, stored), storedToWakeMs: span(stored, woke), wakeToStartMs: span(woke, started), startToAnalysedMs: span(started, analysed),
    analysedToConfirmedMs: confirmedAt ? span(analysed, confirmedAt) : null };
  console.info("sav_intake_wake_timing", { runId, state: run.state, execution: progress?.state ?? null, fullyConfirmed: Boolean(progress?.confirmed),
    outcome: typeof meta.outcome === "string" ? meta.outcome : null, ...timings });
  return { projected, timings };
}

/** Whole targeted chain, as the Workflow runs it step by step. */
export async function processSavIntakeWake(runId: string, deps: SavIntakeWakeDeps = {}) {
  const analysis = await analyseSavIntakeWake(runId, deps);
  const execution = analysis.state === "observed" || analysis.state === "done" ? await executeSavIntakeWake(runId, deps) : null;
  const finish = await finishSavIntakeWake(runId);
  return { analysis, execution, ...finish };
}
