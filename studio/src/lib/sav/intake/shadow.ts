import "server-only";
import type { SavPreparedAttachments } from "../attachment-reader";
import { withSavAiBudget } from "../gemini-transport";
import { planSavIntake } from "./engine";
import type { EngineInput, EnginePolicy, IntakePlan } from "./engine-types";
import type { SavIntakeCrmReaders } from "./hubspot-readers";
import type { prepareSavIntakeMessage } from "./message";
import { createIntakeModelDispatcher } from "./model-dispatch";
import type { IntakeModelTrace } from "./model-readers";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import { readSavIntakeShadowRecords, recordSavIntakeShadow, savIntakeShadowRecorded } from "./runtime-store";
import { reserveSavIntakeShadowCall, settleSavIntakeShadowCall, readSavIntakeShadowUsage, type SavIntakeShadowConfig } from "./shadow-ledger";
import { createSavIntakeSimpleReaders, SAV_INTAKE_SIMPLE_REVISION } from "./simple-readers";

export const SAV_INTAKE_SHADOW_REVISION = "sav-intake-shadow-2026-10-26.v1";
/** Everything the comparison needs, captured from the live analysis: the same mail input and
 * the same memoized CRM answers (read before any live write), the same engine policy. */
export type SavIntakeShadowJob = {
  runId: string; messageId: string; sourceHash: string; input: EngineInput; reads: SavIntakeCrmReaders; policy: EnginePolicy;
  provenance: ReadonlyMap<string, ReturnType<typeof prepareSavIntakeMessage>["provenance"]>; attachments?: SavPreparedAttachments;
  livePlan?: IntakePlan; config: IntakeRuntimeConfig; env: () => Record<string, string | undefined>; network: typeof fetch;
};

/** Decision fields compared between the active and the single-call reader, without any text. */
export function intakePlanSummary(plan?: IntakePlan) {
  if (!plan) return null;
  const d = plan.decision.disposition;
  return { classification: plan.decision.classification, disposition: d.kind,
    operation: d.kind === "ticket" ? d.target.operation : null,
    ticketId: d.kind === "ticket" && d.target.operation !== "create" ? d.target.ticketId : null,
    contactId: d.kind === "ticket" ? d.target.contactId : null,
    reasons: d.kind === "collect_context" ? [...d.reasons].sort() : [],
    mutations: plan.steps.map(s => s.mutation).sort(), progress: plan.progress.kind,
    newTicketTitle: plan.newTicket?.title ?? null };
}
export type IntakePlanSummary = NonNullable<ReturnType<typeof intakePlanSummary>>;
/** Same snapshot on both sides, so any difference is a difference of judgement. */
export function compareIntakePlans(live: IntakePlanSummary | null, shadow: IntakePlanSummary | null) {
  if (!live || !shadow) return { verdict: "incomplete" as const, differences: [live ? "shadow_missing" : "live_missing"] };
  const keys = ["classification", "disposition", "operation", "ticketId", "contactId", "reasons", "mutations", "progress"] as const;
  const differences: string[] = keys.filter(k => JSON.stringify(live[k]) !== JSON.stringify(shadow[k]));
  // A different ticket title alone is presentation, reported but not a decision divergence.
  const titleOnly = !differences.length && live.newTicketTitle !== shadow.newTicketTitle;
  return { verdict: differences.length ? "divergent" as const : "identical" as const, differences: titleOnly ? ["newTicketTitle"] : differences };
}

/** Runs the single-call reader beside the live decision. Read-only on CRM, no executor, its
 * own ledger and caps, recorded apart from the run's decision; any failure stays local. */
export async function runSavIntakeShadow(job: SavIntakeShadowJob, shadow: SavIntakeShadowConfig) {
  if (await savIntakeShadowRecorded(job.messageId, job.sourceHash)) return { skipped: "already_compared" as const };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
  const traces: IntakeModelTrace[] = [];
  let judgement: unknown, plan: IntakePlan | undefined, error: string | undefined;
  const dispatcher = createIntakeModelDispatcher({ config: job.config, live: async () => {}, signal: controller.signal, env: job.env, network: job.network,
    reserve: hash => reserveSavIntakeShadowCall(job.messageId, hash, shadow, job.config.model), settle: settleSavIntakeShadowCall });
  try {
    const semantic = createSavIntakeSimpleReaders({ model: job.config.model, call: dispatcher.call, crm: job.reads, policy: job.policy, provenance: job.provenance,
      ...(job.attachments ? { attachments: { prepared: job.attachments, onRead: () => {} } } : {}),
      onTrace: trace => traces.push(trace), onJudgement: value => { judgement = value; } });
    plan = await withSavAiBudget(() => planSavIntake(structuredClone(job.input), { ...job.reads, ...semantic }, job.policy, { timeoutMs: 10_000 }, () => new Date()));
  } catch (e) { error = e instanceof Error && /^SAV_[A-Z0-9_]+$/.test(e.message) ? e.message : "SAV_INTAKE_SHADOW_FAILED"; }
  finally { clearTimeout(timer); await Promise.allSettled(dispatcher.pending); }
  // A technical failure of the comparison (provider, budget, format) is not a judgement: it is reported as incomplete.
  error ??= dispatcher.failureReason ?? traces.find(t => !t.accepted && t.errorCode)?.errorCode ?? undefined;
  const live = intakePlanSummary(job.livePlan), simple = error ? null : intakePlanSummary(plan), comparison = compareIntakePlans(live, simple);
  await recordSavIntakeShadow(job.runId, { revision: SAV_INTAKE_SHADOW_REVISION, reader: SAV_INTAKE_SIMPLE_REVISION, sourceHash: job.sourceHash, messageId: job.messageId,
    live, shadow: simple, ...comparison, ...(error ? { error } : {}), uncertain: dispatcher.uncertain,
    calls: traces.filter(t => t.metadata).length, failures: traces.filter(t => !t.accepted).map(t => t.errorCode), judgement: judgement ?? null, at: new Date().toISOString() });
  return { recorded: true as const, verdict: comparison.verdict };
}

/** Operator report: counts, spend and one line per compared mail; identifiers and decision fields only. */
export async function readSavIntakeShadowReport(limit = 200) {
  const [records, usage] = await Promise.all([readSavIntakeShadowRecords(limit), readSavIntakeShadowUsage()]);
  const rows = records.map(r => ({ runId: r.runId, messageId: r.value.messageId, at: r.value.at, verdict: r.value.verdict, differences: r.value.differences,
    live: r.value.live, shadow: r.value.shadow, error: r.value.error ?? null, uncertain: r.value.uncertain }));
  const count = (verdict: string) => rows.filter(r => r.verdict === verdict).length;
  return { revision: SAV_INTAKE_SHADOW_REVISION, totals: { compared: rows.length, identical: count("identical"), divergent: count("divergent"), incomplete: count("incomplete"),
    titleOnly: rows.filter(r => r.verdict === "identical" && r.differences.includes("newTicketTitle")).length },
    spend: { nanoUsd: usage.spentNanoUsd, mails: usage.mails, calls: usage.calls }, rows };
}
