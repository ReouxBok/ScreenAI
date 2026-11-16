// SAV-92 (16/11, latency): two durable wakes on the EXISTING Vercel Workflow runtime (`workflow`, as `sav-intake-read-recovery`), each started at most once:
//   settle  a passage refused for `inbound_settling` (the 300 s window, unchanged) sleeps until `retryAt` + a margin and continues THAT case, instead of
//           waiting for the next webhook or heartbeat. One pending wake per case; a new one only for a strictly later `retryAt` (a new customer mail).
//   send    a validated reply queued by a caller that could not send it at once (no deadline, the sweep, too little time left) is sent in its OWN workflow
//           step, with its own budget. At most one dispatch per execution.
// Nothing here decides or sends. The settle wake calls `continueCaseAfterCommit` (qualification scope, pause, admission, owner and claim are re-read there);
// the send wake calls `sendQueuedCaseReplyNow` (configuration, signed grant, owner, preflight, claim + lease, read-back). Neither can send twice: the claim
// is a row lock plus a lease, an engaged effect is never selected, a confirmed execution is never claimed again. The effects catch-up stays the safety net.
// Production only (as the heartbeat): a preview or a local server never starts a workflow against shared data. `SAV_V2_WAKE_WORKFLOWS=off` stops both.
import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import type { CaseContinuationPoint } from "./v2-entry-binding";
import type { ImmediateCaseReplySend } from "./immediate-send-budget";

type Env = Record<string, string | undefined>;
type Meta = Record<string, string | number | boolean | null>;

export const CASE_SETTLE_WAKE_MARK = { action: "sav_v2_settle_wake", entityType: "sav_v2_case" } as const;
export const CASE_REPLY_SEND_MARK = { action: "sav_v2_reply_send_dispatch", entityType: "sav_v2_case_execution" } as const;
/** The wake fires this long after `retryAt`, so the store's own clock has passed it. */
export const CASE_SETTLE_WAKE_MARGIN_MS = 5_000;
/** A wake still not run this long after its date is taken as lost: a later refusal may start another one. */
export const CASE_SETTLE_WAKE_GRACE_MS = 120_000;
/** No sleep longer than this: a `retryAt` further away is not a settle window (the sweep keeps the case). */
const SETTLE_WAKE_MAX_AHEAD_MS = 60 * 60_000;
/** Budget a wake step gives its work, from the step's start (steps run with the platform maximum, at least 300 s; as `sav-intake/steps.ts`). */
export const CASE_WAKE_STEP_BUDGET_MS = 240_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;

export function savV2WakeWorkflowsEnabled(env: Env) {
  return env.VERCEL_ENV === "production" && (env.SAV_V2_WAKE_WORKFLOWS ?? "").trim().toLowerCase() !== "off";
}

export type CaseSettleWakeStart = (caseId: string, wakeAt: string) => Promise<unknown>;
export type CaseReplySendStart = (executionId: string) => Promise<unknown>;
export type CaseWakeRequest = { started: boolean; reason: string; wakeAt?: string };

const defaultSettleStart: CaseSettleWakeStart = async (caseId, wakeAt) => {
  const [{ start }, { processSavV2CaseSettleWakeWorkflow }] = await Promise.all([import("workflow/api"), import("@/workflows/sav-v2-case")]);
  return start(processSavV2CaseSettleWakeWorkflow, [caseId, wakeAt]);
};
const defaultSendStart: CaseReplySendStart = async executionId => {
  const [{ start }, { processSavV2ReplySendWorkflow }] = await Promise.all([import("workflow/api"), import("@/workflows/sav-v2-case")]);
  return start(processSavV2ReplySendWorkflow, [executionId]);
};

const markOf = (mark: { action: string; entityType: string }, entityId: string) =>
  and(eq(auditLogs.entityType, mark.entityType), eq(auditLogs.entityId, entityId), eq(auditLogs.action, mark.action));

/** One marker per entity, written under a transaction-scoped advisory lock: two concurrent requests are serialised, the second reads the first's row. */
async function reserve(mark: { action: string; entityType: string }, entityId: string, decide: (current: Meta | null) => Meta | null) {
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${mark.action}:${entityId}`}))`);
    const [existing] = await tx.select().from(auditLogs).where(markOf(mark, entityId)).for("update");
    const next = decide(existing ? existing.technicalMetadata : null);
    if (!next) return false;
    if (existing) await tx.update(auditLogs).set({ technicalMetadata: next }).where(eq(auditLogs.id, existing.id));
    else await tx.insert(auditLogs).values({ actorEmail: "system", ...mark, entityId, technicalMetadata: next });
    return true;
  });
}
async function setState(mark: { action: string; entityType: string }, entityId: string, state: string, when?: (current: Meta) => boolean) {
  await requireDb().transaction(async tx => {
    const [existing] = await tx.select().from(auditLogs).where(markOf(mark, entityId)).for("update");
    if (!existing || (when && !when(existing.technicalMetadata))) return;
    await tx.update(auditLogs).set({ technicalMetadata: { ...existing.technicalMetadata, state, lastAt: new Date().toISOString() } }).where(eq(auditLogs.id, existing.id));
  });
}

/**
 * Settle wake: called when a passage on `caseId` was refused for `inbound_settling` until `retryAt`. Starts ONE workflow that sleeps until
 * `retryAt + CASE_SETTLE_WAKE_MARGIN_MS` and continues the case. Refused (nothing started) when off, outside production, the date is not ahead, a wake is
 * already pending for this case, or the date is not strictly later than the one already woken for. Never throws.
 */
export async function requestCaseSettleWake(caseId: string, retryAt: string, options: { env: Env; start?: CaseSettleWakeStart; now?: Date }): Promise<CaseWakeRequest> {
  if (!savV2WakeWorkflowsEnabled(options.env)) return { started: false, reason: "off" };
  const now = (options.now ?? new Date()).getTime(), due = time(retryAt);
  if (!UUID.test(caseId) || !Number.isFinite(due)) return { started: false, reason: "invalid" };
  if (due <= now) return { started: false, reason: "not_ahead" };
  if (due - now > SETTLE_WAKE_MAX_AHEAD_MS) return { started: false, reason: "too_far" };
  const wakeAt = new Date(due + CASE_SETTLE_WAKE_MARGIN_MS).toISOString(), at = new Date(now).toISOString();
  try {
    const permitted = await reserve(CASE_SETTLE_WAKE_MARK, caseId, current => {
      if (current && current.state !== "start_failed") {
        const later = due > time(current.retryAt);
        const free = current.state === "done" || time(current.wakeUntil) <= now;
        if (!later || !free) return null;
      }
      return { state: "starting", retryAt: new Date(due).toISOString(), wakeAt, wakeUntil: new Date(due + CASE_SETTLE_WAKE_MARGIN_MS + CASE_SETTLE_WAKE_GRACE_MS).toISOString(),
        starts: Number(current?.starts ?? 0) + 1, lastAt: at };
    });
    if (!permitted) return { started: false, reason: "already_scheduled" };
  } catch { return { started: false, reason: "reserve_failed" }; }
  try {
    await (options.start ?? defaultSettleStart)(caseId, wakeAt);
  } catch {
    await setState(CASE_SETTLE_WAKE_MARK, caseId, "start_failed", current => current.wakeAt === wakeAt).catch(() => undefined);
    return { started: false, reason: "start_failed" };
  }
  await setState(CASE_SETTLE_WAKE_MARK, caseId, "scheduled", current => current.wakeAt === wakeAt).catch(() => undefined);
  return { started: true, reason: "scheduled", wakeAt };
}

/** The settle wake's step: the marker of THIS wake is closed first (so a new refusal can schedule the next one), then the case is continued like any trigger. */
export async function runCaseSettleWake(caseId: string, wakeAt: string, options: {
  env: Env; deadlineMs: number; /** Tests only. */ continuation?: CaseContinuationPoint | null; /** Tests only. */ settleWakeStart?: CaseSettleWakeStart;
}) {
  const { continueCaseAfterCommit, savV2EntryEnabled } = await import("./v2-entry");
  if (!savV2EntryEnabled(options.env)) return { status: "v2_off" };
  await setState(CASE_SETTLE_WAKE_MARK, caseId, "done", current => current.wakeAt === wakeAt).catch(() => undefined);
  const outcome = await continueCaseAfterCommit(caseId, "settle_wake", { env: options.env, immediateDeadlineMs: options.deadlineMs,
    ...(options.continuation === undefined ? {} : { continuation: options.continuation }), ...(options.settleWakeStart ? { settleWakeStart: options.settleWakeStart } : {}) });
  console.info("sav_v2_settle_wake_ran", { caseId, status: outcome.status });
  return { status: outcome.status };
}

/** Separate send: ONE workflow per execution, whose step sends it with its own budget. A failed start may be retried by a later passage. Never throws. */
export async function requestCaseReplySend(input: { env: Env; executionId: string }, options: { start?: CaseReplySendStart; now?: Date } = {}): Promise<CaseWakeRequest> {
  if (!savV2WakeWorkflowsEnabled(input.env)) return { started: false, reason: "off" };
  if (!UUID.test(input.executionId)) return { started: false, reason: "invalid" };
  const at = (options.now ?? new Date()).toISOString();
  try {
    const permitted = await reserve(CASE_REPLY_SEND_MARK, input.executionId, current =>
      current && current.state !== "start_failed" ? null : { state: "starting", starts: Number(current?.starts ?? 0) + 1, lastAt: at });
    if (!permitted) return { started: false, reason: "already_dispatched" };
  } catch { return { started: false, reason: "reserve_failed" }; }
  try {
    await (options.start ?? defaultSendStart)(input.executionId);
  } catch {
    await setState(CASE_REPLY_SEND_MARK, input.executionId, "start_failed").catch(() => undefined);
    return { started: false, reason: "start_failed" };
  }
  await setState(CASE_REPLY_SEND_MARK, input.executionId, "dispatched").catch(() => undefined);
  return { started: true, reason: "dispatched" };
}

/** The send wake's step: the production sender, inside this step's own budget. A closed summary only (never a payload). */
export async function runCaseReplySend(executionId: string, options: { env: Env; deadlineMs: number; sendNow?: ImmediateCaseReplySend }) {
  const sendNow = options.sendNow ?? (await import("./v2-effects-binding")).sendQueuedCaseReplyNow;
  const sent = await sendNow({ env: options.env, executionId, callerDeadlineMs: options.deadlineMs }).catch(() => ({ failed: "SAV_V2_SEPARATE_SEND_THREW" }));
  const summary = "pass" in sent ? { supervised: sent.pass.skipped ?? sent.pass.supervisedSkipped ?? (sent.pass.supervised.map(row => row.state).join(",") || "none") } : sent;
  await setState(CASE_REPLY_SEND_MARK, executionId, "ran").catch(() => undefined);
  console.info("sav_v2_reply_send_ran", { executionId, ...summary });
  return summary;
}
