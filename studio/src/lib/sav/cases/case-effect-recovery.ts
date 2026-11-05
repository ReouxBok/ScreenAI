// SAV-10 (pole C): read-only recovery of the case effects whose send may have left (marker written, receipt lost or not yet verified).
// There is still ONE executor and ONE ledger: this file only lists what is due, builds the options the executor needs and runs
// `executeIntakePass(id, options, {}, createCaseEffectRecoveryDriver(deps))` for one execution. It sends nothing, plans nothing and writes no marker.
// Not called by any route, cron or action: wiring it is a separate, explicit decision. Guards, in this order and BEFORE any table is read:
//   1. `SAV_INTAKE_EXECUTION_MODE=execute` and a configured policy (`intakeExecutionConfig`; its kill switches turn this into `skipped`);
//   2. the case-effect tables exist; 3. the intake agent is not paused (the executor checks it again); 4. the V1 runtime pins and the approved,
//   unexpired policy (`readIntakeExecutionAuthority`) — the same prerequisites as the supervised pass, no new flag, no new right.
import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, notInArray, notLike, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savIntakeEffects } from "@/db/schema";
import { readSavAgentPause, savAgentPauseCode } from "../intake/agent-pause";
import { createIntakeExecutorAdapters } from "../intake/execution-adapters";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import type { ExecutionOptions, ExecutorAdapters } from "../intake/execution-types";
import { executeIntakePass } from "../intake/executor";
import { savIntakeRuntimeConfig } from "../intake/runtime-contract";
import { HANDOFF_NOTICE_KEY_PREFIX } from "./case-handoff-notice";
import { TICKET_STAGE_KEY_PREFIX } from "./case-ticket-stage";
import { CASE_RECOVERY_NOTE_PENDING, createCaseEffectRecoveryDriver, type CaseEffectRecoveryDriverDeps } from "./case-effect-driver";

/** Reads at most this many executions per listing (the same bound as the pending scan); a call processes ONE of them, like the ledger's own recovery. */
export const CASE_RECOVERY_LIST_LIMIT = 20;
const code = (error: unknown) => (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160);

/** A catalogue lookup, not a read of the tables: both tables of the case-effect ledger must exist (migration 0051 and the 0050 parent triggers). */
export async function caseEffectSchemaInstalled() {
  const result = await requireDb().execute(sql`select (to_regclass('sav.case_effect_executions') is not null and to_regclass('sav.intake_effects') is not null) as installed`) as unknown;
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as { installed?: unknown }[];
  return rows[0]?.installed === true;
}

/**
 * Executions a verification-only pass has something to do for, free lease, not confirmed / refused, oldest `updated_at` first, then id (a pass ends by touching
 * `updated_at`, and a verification that finds nothing also pushes the effect's `next_reconcile_at` forward by 60 s, so a just-visited execution leaves the listing
 * until that time and the others get their turn). Two kinds of work, never a send:
 *  - an engaged effect (dispatched / acked / uncertain, marker written) that is due: fewer than 5 reads and its schedule reached. An effect that reached 5 reads is
 *    NOT listed (nothing resets the count: `listCaseEffectsNeedingPerson` shows it to a person). Never an execution that is only `pending`, nor an effect that is only
 *    `planned` (that would be a send);
 *  - a `reply_send` row already CONFIRMED whose execution never reached its end (a crash between the confirmation and the mail event / question / J2 / execution
 *    state): the finish is idempotent and sends nothing. An execution already left as `RECOVERY_NOTE_PENDING` is not listed again (its remaining work is a write that
 *    only a supervised pass may plan), so this never loops.
 */
export async function pendingCaseEffectRecoveries(limit = CASE_RECOVERY_LIST_LIMIT, now = new Date()) {
  const engagedDue = and(
    inArray(savIntakeEffects.state, ["dispatched", "acked", "uncertain"]), isNotNull(savIntakeEffects.dispatchedAt),
    lt(savIntakeEffects.reconcileAttempts, 5), or(isNull(savIntakeEffects.nextReconcileAt), lte(savIntakeEffects.nextReconcileAt, now)),
  );
  const finishPending = and(
    eq(savIntakeEffects.kind, "reply_send"), eq(savIntakeEffects.state, "confirmed"),
    // not an execution already left waiting on its note, nor one a person's takeover ended (its mail stays unrecorded for good: a cancellation is final)
    or(isNull(savCaseEffectExecutions.reason), and(ne(savCaseEffectExecutions.reason, CASE_RECOVERY_NOTE_PENDING), notLike(savCaseEffectExecutions.reason, "SAV_CASE_EFFECT_CANCELLED_%"))),
  );
  return requireDb().selectDistinct({ id: savCaseEffectExecutions.id, updatedAt: savCaseEffectExecutions.updatedAt })
    .from(savCaseEffectExecutions).innerJoin(savIntakeEffects, eq(savIntakeEffects.executionId, savCaseEffectExecutions.id))
    .where(and(
      notInArray(savCaseEffectExecutions.state, ["confirmed", "refused"]),
      // A handoff notice is verified by its own pass (`case-handoff-notice-store.ts`): this recovery reads a reply proposal in every sealed payload.
      notLike(savCaseEffectExecutions.replyKey, `${HANDOFF_NOTICE_KEY_PREFIX}%`), notLike(savCaseEffectExecutions.replyKey, `${TICKET_STAGE_KEY_PREFIX}%`), // a ticket stage has its own pass
      or(isNull(savCaseEffectExecutions.leaseUntil), lte(savCaseEffectExecutions.leaseUntil, now)),
      or(engagedDue, finishPending),
    ))
    .orderBy(asc(savCaseEffectExecutions.updatedAt), asc(savCaseEffectExecutions.id)).limit(Math.min(Math.max(limit, 1), CASE_RECOVERY_LIST_LIMIT));
}

export type CaseEffectRecoveryDeps = CaseEffectRecoveryDriverDeps & Readonly<{
  deadlineMs: number;
  /** Only `verify` is taken; every other port handed to the executor is a sentinel that throws and is reported through `onForbiddenPort`. Defaults to the real adapters. */
  adapters?: Pick<ExecutorAdapters, "verify">;
  onForbiddenPort?: (port: string) => void;
  /** Tests inject the runtime pins / policy the V1 environment would provide; by default they are read exactly like the ledger's own recovery. */
  context?: Pick<ExecutionOptions, "runtime" | "policy">;
  schemaInstalled?: () => Promise<boolean>;
}>;
export type CaseEffectRecoveryResult =
  | Readonly<{ skipped: "off" | "schema_absent" | "observation_required" | "nothing_due" | (string & {}) }>
  | Readonly<{ executionId: string; listed: number; skipped: string }>
  | Readonly<{ executionId: string; listed: number; state: string; reason: string | null; effects: readonly { key: string; state: string; reconcileAttempts: number }[] }>;

/** One verification-only pass over the oldest due execution. The result is read back from the ledger: the executor's own return value is never reported. */
export async function recoverCaseEffects(deps: CaseEffectRecoveryDeps): Promise<CaseEffectRecoveryResult> {
  const env = deps.env();
  let config: ReturnType<typeof intakeExecutionConfig>;
  try { config = intakeExecutionConfig(env); } catch (error) { return { skipped: code(error) }; }
  if (!config) return { skipped: "off" };
  if (!await (deps.schemaInstalled ?? caseEffectSchemaInstalled)()) return { skipped: "schema_absent" };
  const paused = savAgentPauseCode(await readSavAgentPause(requireDb()));
  if (paused) return { skipped: paused };
  let context = deps.context;
  if (!context) {
    let runtime: ReturnType<typeof savIntakeRuntimeConfig>;
    try { runtime = savIntakeRuntimeConfig(env); } catch (error) { return { skipped: code(error) }; }
    if (!runtime) return { skipped: "observation_required" };
    try { context = { runtime, policy: (await readIntakeExecutionAuthority(config)).policy }; } catch (error) { return { skipped: code(error) }; }
  }
  const listed = await pendingCaseEffectRecoveries(CASE_RECOVERY_LIST_LIMIT);
  const [next] = listed;
  if (!next) return { skipped: "nothing_due" };
  const real = deps.adapters ?? createIntakeExecutorAdapters({ env: deps.env });
  const forbidden = (port: string) => async () => { deps.onForbiddenPort?.(port); throw Error(`SAV_CASE_EFFECT_RECOVERY_FORBIDDEN_PORT_${port.toUpperCase()}`); };
  const adapters: ExecutorAdapters = {
    verify: real.verify, dispatch: forbidden("dispatch"), readCrm: forbidden("readCrm"), gmailCurrent: forbidden("gmailCurrent"), gmailPermissions: forbidden("gmailPermissions"),
    scope: (() => { deps.onForbiddenPort?.("scope"); throw Error("SAV_CASE_EFFECT_RECOVERY_FORBIDDEN_PORT_SCOPE"); }) as ExecutorAdapters["scope"],
  };
  const options: ExecutionOptions = { config, ...context, env: deps.env, adapters, signal: AbortSignal.timeout(Math.max(1, deps.deadlineMs - Date.now())) };
  const pass = await executeIntakePass(next.id, options, {}, createCaseEffectRecoveryDriver(deps)) as { skipped?: string };
  if (pass.skipped) return { executionId: next.id, listed: listed.length, skipped: pass.skipped };
  const [row] = await requireDb().select({ state: savCaseEffectExecutions.state, reason: savCaseEffectExecutions.reason }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, next.id));
  const effects = await requireDb().select({ key: savIntakeEffects.businessKey, state: savIntakeEffects.state, reconcileAttempts: savIntakeEffects.reconcileAttempts })
    .from(savIntakeEffects).where(eq(savIntakeEffects.executionId, next.id)).orderBy(asc(savIntakeEffects.createdAt));
  return { executionId: next.id, listed: listed.length, state: row?.state ?? "unknown", reason: row?.reason ?? null, effects };
}
