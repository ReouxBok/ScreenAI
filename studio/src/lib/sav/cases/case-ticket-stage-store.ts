// V2 ticket states (local, OFF): admission, driver and pass of the `ticket_stage` effect, on the EXISTING executor and ledger.
// There is one executor (`intake/executor.ts::executeIntakePass`) and one ledger (`sav.intake_effects` + its journal); this file only says what is different for a stage:
//   admission  `case-ticket-stage-queue.ts` (kept apart: the reply driver calls it inside the receipt transaction).
//   driver     what is checked before every plan, marker and send: A's gate (`decideCaseTicketStage`) on facts read just now (mode, pauses, the CRM owner, the case, a customer
//              mail recorded since the reply), the permission, the lease. A stage already engaged (marker, ack, uncertain) is only verified.
//   pass       `runCaseTicketStagePass`: the open stages, oldest first.
// Nothing here is called by a route, a cron or an action. OFF until `SAV_V2_TICKET_STAGES=on` AND the execution policy grants `set_case_ticket_stage`.
import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, like, lt, lte, notExists, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savIntakeEffectJournal, savIntakeEffects } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { readSavAgentPause, SAV_AGENT_PAUSE_CODES, savAgentPauseCode, type SavAgentPauseState } from "../intake/agent-pause";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import { deferExecutionEffect, executionJournal, type ExecutionLease, type ExecutionTx } from "../intake/execution-store";
import { executeIntakePass, type PassDriver } from "../intake/executor";
import type { Effect, EffectIntent, Execution, ExecutionOptions, ExecutionPayload, ExecutorAdapters } from "../intake/execution-types";
import { savIntakeRuntimeConfig } from "../intake/runtime-contract";
import { ownedExecution, settleVerification } from "./case-effect-driver";
import { caseEffectSchemaInstalled } from "./case-effect-recovery";
import { buildTicketStageIntent, TICKET_STAGE_KEY_PREFIX, type TicketStagePayload } from "./case-ticket-stage";
import { lastCustomerInboundAt } from "./case-ticket-stage-queue";
import { createCaseTicketStageAdapters, TICKET_STAGE_NOT_APPLIED_PREFIX } from "./case-ticket-stage-hubspot";
import { v2HubspotOwnerId } from "./intake-boundary";
import { lockCaseForWrite } from "./case-store";
import { readCaseTicketId, type CaseTicketOwnerPort } from "./case-ticket-owner";
import { decideCaseTicketStage, planCaseTicketStage, readCaseTicketStageConfig, type CustomerReturnOwnerNow } from "./customer-return";

const LEASE_MS = 80_000;
/** After this many refusals by HubSpot itself (nothing written) the effect is no longer taken back: it is verified and left to a person. */
export const TICKET_STAGE_NOT_APPLIED_RETRIES = 3;
const fault = (code: string): never => { throw Error(`SAV_TICKET_STAGE_${code}`); };
const code = (error: unknown) => (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160);
const payloadOf = (row: typeof savCaseEffectExecutions.$inferSelect) => decryptSavPayload<TicketStagePayload>(row.payloadCiphertext);
const effectIntent = (effect: Effect) => decryptSavPayload<EffectIntent>(effect.intentCiphertext);
const level = (state: SavAgentPauseState) => state.invalid ? "invalid" as const : state.level;

// ---------------------------------------------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------------------------------------------

export type TicketStageDriverDeps = Readonly<{
  env: () => Record<string, string | undefined>;
  /** The CRM owner of the ticket, read now (A's `ticketOwnerPort` fits). Absent or failing = `unknown`: new work is held, a stage already engaged is only verified. */
  readTicketOwner?: CaseTicketOwnerPort | undefined;
}>;

async function ownerNowOf(port: CaseTicketOwnerPort | undefined, ticketId: string | null): Promise<CustomerReturnOwnerNow> {
  if (typeof port !== "function" || ticketId === null || !/^[0-9]{1,30}$/.test(ticketId)) return "unknown";
  try {
    const reading = await port({ ticketId });
    return reading === "v2" || reading === "human" || reading === "none" ? reading : "unknown";
  } catch { return "unknown"; }
}

export function createTicketStageDriver(deps: TicketStageDriverDeps): PassDriver {
  const payloads = new WeakMap<ExecutionLease, TicketStagePayload>();
  const caseIds = new WeakMap<ExecutionLease, string>();
  /** Set by the guard once the CURRENT owner was read for the ledger write that follows; consumed by the lease's check of that write. A ledger write with no reading is held. */
  const ownerRead = new WeakMap<ExecutionLease, CustomerReturnOwnerNow>();

  /**
   * Under the execution lock and the case lock (the order of the reply driver), in the transaction that writes a plan or a marker: pole A's gate on the facts read now. A person
   * who took the case or the ticket, a customer mail recorded after the reply (for « waiting »), a case that moved on (resolved, reopened, sensitive) cancels it for good; the
   * mode, a pause or an unreadable owner only hold it.
   */
  async function fence(tx: ExecutionTx, lease: ExecutionLease, ownerNow: CustomerReturnOwnerNow) {
    if (!await ownedExecution(tx, lease)) return fault("LEASE_LOST");
    const payload = payloads.get(lease)!, caseId = caseIds.get(lease)!;
    const config = readCaseTicketStageConfig(deps.env());
    const pause = { intake: level(await readSavAgentPause(tx, "intake")), v2: level(await readSavAgentPause(tx, "v2")) };
    const snapshot = await lockCaseForWrite(tx, caseId);
    const { intent } = payload;
    // What the execution was sealed for must still be what A's rule plans now (same ticket, same key, same stage): otherwise the case or the configuration moved.
    let still = false;
    try {
      const planned = planCaseTicketStage({
        config, caseId, ticketId: snapshot.ticketId, case: { owner: snapshot.owner, phase: snapshot.phase, sensitivity: snapshot.sensitivity, cycle: snapshot.body.cycle },
        trigger: payload.trigger, lastCustomerInboundAt: null,
      });
      still = planned.plan && planned.intent.key === intent.key && planned.intent.stageId === intent.stageId && planned.intent.ticketId === intent.ticketId;
    } catch { still = false; }
    const lastInbound = await lastCustomerInboundAt(tx, caseId);
    const repliedSince = payload.trigger.kind === "reply_confirmed" && lastInbound !== null && Date.parse(lastInbound) > Date.parse(payload.trigger.sentAt);
    const decision = decideCaseTicketStage("planned", intent.target, { config, pause, ownerNow, caseStillTarget: still, customerRepliedSince: repliedSince });
    if (decision.action === "hold") return fault(`HOLD_${decision.code.toUpperCase()}`);
    if (decision.action === "cancel") return fault(`CANCELLED_${decision.code.toUpperCase()}`);
    // The lock waits above can cross the lease expiry: judged again against a clock read after the last of them.
    if (!await ownedExecution(tx, lease)) return fault("LEASE_LOST");
  }

  async function withdraw(lease: ExecutionLease, effect: Effect, reason: string) {
    return requireDb().transaction(async tx => {
      const owned = await ownedExecution(tx, lease);
      if (!owned) return false;
      const [back] = await tx.update(savIntakeEffects).set({ state: "planned", dispatchToken: null, dispatchedAt: null })
        .where(and(eq(savIntakeEffects.id, effect.id), eq(savIntakeEffects.state, "dispatched"), eq(savIntakeEffects.dispatchToken, lease.token),
          eq(savIntakeEffects.attemptId, effect.attemptId), isNull(savIntakeEffects.ackCiphertext))).returning();
      if (back) await executionJournal(tx, lease.row.id, "dispatch_withdrawn", { attemptId: back.attemptId, reason, dispatch: false }, back.id);
      return Boolean(back);
    });
  }
  /** After the marker and before the provider call, a refusal takes the effect back to `planned` (the proven no-send transition); otherwise it only refuses. */
  async function refuseNewWork(lease: ExecutionLease, refusal: string): Promise<never> {
    const [marked] = await requireDb().select().from(savIntakeEffects)
      .where(and(eq(savIntakeEffects.executionId, lease.row.id), eq(savIntakeEffects.state, "dispatched"), eq(savIntakeEffects.dispatchToken, lease.token), isNull(savIntakeEffects.ackCiphertext)));
    if (marked) await withdraw(lease, marked, `SAV_TICKET_STAGE_${refusal}`);
    return fault(refusal);
  }

  /** The guard of every plan, marker and the last look before HubSpot. */
  async function newWorkGuard(lease: ExecutionLease, options: Parameters<PassDriver["live"]>[1], permission: string) {
    for (const agent of ["intake", "v2"] as const) {
      const state = await readSavAgentPause(requireDb(), agent);
      if (savAgentPauseCode(state)) throw Error(SAV_AGENT_PAUSE_CODES[state.invalid ? "invalid" : state.level as "actions_paused" | "fully_paused"]);
    }
    if (options.signal.aborted) return fault("ABORTED");
    const { policy } = await readIntakeExecutionAuthority(options.config);
    if (!policy.mutations.includes(permission as typeof policy.mutations[number])) return fault("MUTATION_NOT_GRANTED");
    // The CRM owner NOW, outside any transaction; the local facts are judged right after it.
    const ownerNow = await ownerNowOf(deps.readTicketOwner, await readCaseTicketId(caseIds.get(lease)!));
    try {
      await requireDb().transaction(tx => fence(tx, lease, ownerNow));
    } catch (error) {
      const refusal = /^SAV_TICKET_STAGE_((?:CANCELLED|HOLD)_[A-Z0-9_]+)$/.exec(error instanceof Error ? error.message : "");
      if (refusal) return refuseNewWork(lease, refusal[1]!);
      throw error;
    }
    ownerRead.set(lease, ownerNow);
  }

  const driver: PassDriver = {
    async claim(executionId) {
      return requireDb().transaction(async (tx): Promise<{ lease: ExecutionLease } | { blocked: "occupied" }> => {
        const now = new Date();
        const [row] = await tx.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, executionId)).for("update");
        // Only a stage is claimed here: a reply or a notice has its own driver and a payload this one cannot read.
        if (!row || !row.replyKey.startsWith(TICKET_STAGE_KEY_PREFIX) || row.state === "confirmed" || row.state === "refused" || row.leaseUntil && row.leaseUntil > now) return { blocked: "occupied" };
        const token = randomUUID();
        const [claimed] = await tx.update(savCaseEffectExecutions).set({ leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), state: "running", updatedAt: now })
          .where(eq(savCaseEffectExecutions.id, executionId)).returning();
        const payload = payloadOf(claimed);
        const lease: ExecutionLease = {
          row: { id: claimed.id, threadId: claimed.threadId, messageId: claimed.caseId, policyId: claimed.policyId, policyHash: claimed.policyHash } as unknown as Execution,
          token, payload: { keys: [] } as unknown as ExecutionPayload,
          caseEffect: {
            assertLocal: async t => {
              const ownerNow = ownerRead.get(lease);
              ownerRead.delete(lease);
              if (ownerNow === undefined) return fault("HOLD_OWNER_UNCHECKED");
              await fence(t, lease, ownerNow);
            },
            withdraw: (effect, reason) => withdraw(lease, effect, reason),
          },
        };
        payloads.set(lease, payload); caseIds.set(lease, claimed.caseId);
        return { lease };
      });
    },
    async adopt() { /* a stage is never re-planned against a newer run */ },
    async nextIntent(lease, effects) {
      const payload = payloads.get(lease)!;
      const existing = effects.find(effect => effect.businessKey === payload.intent.key);
      // A ledger row that exists is what was planned: its stored intent is returned, never a rebuilt one.
      if (existing) return existing.state === "confirmed" ? null : effectIntent(existing);
      if (readCaseTicketStageConfig(deps.env()).mode !== "on") return fault("HOLD_STAGES_OFF");
      const owner = v2HubspotOwnerId(deps.env());
      if (!owner) return fault("HOLD_OWNER_ID_MISSING");
      return buildTicketStageIntent(payload.intent, owner);
    },
    async preflight(lease, options, intent) {
      if (!intent) return;
      await newWorkGuard(lease, options, intent.permission);
    },
    async live(lease, options, permission) {
      // After a confirmation nothing is checked: a confirmed receipt does not depend on the world as it is now. A verification never comes here with a permission.
      if (!permission) return;
      await newWorkGuard(lease, options, permission);
    },
    applyVerification: settleVerification,
    /**
     * An error past the marker. HubSpot's own rejection (nothing written) takes the effect back to `planned`, a bounded number of times; anything else (a lost answer, a timeout,
     * an unclear answer) leaves it uncertain: it is only verified from then on, whoever owns the ticket.
     */
    async deferEffect(lease, seen, reason) {
      if (reason.startsWith(TICKET_STAGE_NOT_APPLIED_PREFIX)) {
        const [{ n }] = await requireDb().select({ n: sql<number>`count(*)::int` }).from(savIntakeEffectJournal)
          .where(and(eq(savIntakeEffectJournal.executionId, lease.row.id), eq(savIntakeEffectJournal.kind, "dispatch_withdrawn"))) as [{ n: number }];
        if (n < TICKET_STAGE_NOT_APPLIED_RETRIES && await withdraw(lease, seen, reason)) return;
      }
      await requireDb().transaction(async tx => {
        const owned = await ownedExecution(tx, lease);
        if (!owned) return;
        const [fresh] = await tx.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.id, seen.id), eq(savIntakeEffects.executionId, lease.row.id))).for("update");
        if (!fresh || owned.leaseUntil <= new Date() || fresh.attemptId !== seen.attemptId || fresh.dispatchToken !== lease.token || fresh.state === "planned" || fresh.state === "confirmed") return;
        await deferExecutionEffect(fresh, reason, tx);
      });
    },
    async finish(lease, effects) {
      const payload = payloads.get(lease)!;
      await requireDb().transaction(async tx => {
        const owned = await ownedExecution(tx, lease);
        if (!owned) return fault("LEASE_LOST");
        const stage = effects.find(effect => effect.businessKey === payload.intent.key);
        const [fresh] = stage ? await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, stage.id)).for("share") : [];
        if (!fresh || fresh.state !== "confirmed") return fault("RECEIPT_MISSING");
        await tx.update(savCaseEffectExecutions).set({ state: "confirmed", leaseToken: null, leaseUntil: null, reason: null, updatedAt: new Date() })
          .where(and(eq(savCaseEffectExecutions.id, lease.row.id), eq(savCaseEffectExecutions.leaseToken, lease.token)));
        await executionJournal(tx, lease.row.id, "execution_confirmed", { stageEffectId: fresh.id });
      });
    },
    async end(lease, state, reason) {
      await requireDb().transaction(async tx => {
        // A cancellation is final (the key is never reused); a hold, a pause or an uncertainty keeps the execution open.
        const cancelled = reason.startsWith("SAV_TICKET_STAGE_CANCELLED_");
        const [row] = await tx.update(savCaseEffectExecutions).set({
          state: cancelled ? "refused" : state, reason: reason.slice(0, 200), leaseToken: null, leaseUntil: null, updatedAt: new Date(),
        }).where(and(eq(savCaseEffectExecutions.id, lease.row.id), eq(savCaseEffectExecutions.leaseToken, lease.token))).returning({ id: savCaseEffectExecutions.id });
        await executionJournal(tx, lease.row.id, row ? (cancelled ? "ticket_stage_cancelled" : "pass_waiting") : "obsolete_pass", { state, reason });
      });
    },
  };
  return driver;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Pass
// ---------------------------------------------------------------------------------------------------------------------------------

const OPEN = ["pending", "running", "waiting", "uncertain"] as const;
const ENGAGED = ["dispatched", "acked", "uncertain"] as const;

/**
 * Open stages a pass may take now, oldest first: the lease is free, and either nothing is engaged yet (a plan, a marker and a send are due) or an engaged effect is due for its
 * read-only verification (fewer than five reads, its schedule reached). An engaged effect that used its five reads is not listed: nothing resets it, a person looks.
 */
export async function pendingTicketStageExecutions(limit = 5, now = new Date()) {
  const e = savCaseEffectExecutions, db = requireDb();
  const engaged = db.select({ one: sql`1` }).from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, e.id), inArray(savIntakeEffects.state, [...ENGAGED])));
  const engagedDue = db.select({ one: sql`1` }).from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, e.id), inArray(savIntakeEffects.state, [...ENGAGED]),
    lt(savIntakeEffects.reconcileAttempts, 5), or(isNull(savIntakeEffects.nextReconcileAt), lte(savIntakeEffects.nextReconcileAt, now))));
  return db.select({ id: e.id }).from(e).where(and(
    like(e.replyKey, `${TICKET_STAGE_KEY_PREFIX}%`), inArray(e.state, [...OPEN]), or(isNull(e.leaseUntil), lte(e.leaseUntil, now)),
    or(notExists(engaged), sql`exists ${engagedDue}`),
  )).orderBy(asc(e.updatedAt), asc(e.id)).limit(Math.min(Math.max(Math.trunc(limit), 1), 20));
}

export type TicketStageRuntimeDeps = Readonly<{
  env: () => Record<string, string | undefined>;
  network: typeof fetch;
  deadlineMs: number;
  limit?: number;
  readTicketOwner?: CaseTicketOwnerPort | undefined;
  /** Tests inject the runtime pins / policy the V1 environment would provide; by default they are read exactly like the case effects pass. */
  context?: Pick<ExecutionOptions, "runtime" | "policy">;
  adapters?: Pick<ExecutorAdapters, "dispatch" | "verify">;
  schemaInstalled?: () => Promise<boolean>;
}>;
export type TicketStagePassResult =
  | Readonly<{ skipped: "stages_off" | "execution_off" | "schema_absent" | "observation_required" | "nothing_due" | (string & {}) }>
  | Readonly<{ skipped: null; processed: ReadonlyArray<Readonly<{ executionId: string; state: string; reason: string | null }>> }>;

/** One bounded pass: the due stages, each on the existing executor with the stage driver. The HubSpot stage adapter is the only port of the executor that is ever called. */
export async function runCaseTicketStagePass(deps: TicketStageRuntimeDeps): Promise<TicketStagePassResult> {
  const env = deps.env();
  if (readCaseTicketStageConfig(env).mode !== "on") return { skipped: "stages_off" };
  let config: ReturnType<typeof intakeExecutionConfig>;
  try { config = intakeExecutionConfig(env); } catch (error) { return { skipped: code(error) }; }
  if (!config) return { skipped: "execution_off" };
  if (!await (deps.schemaInstalled ?? caseEffectSchemaInstalled)()) return { skipped: "schema_absent" };
  const db = requireDb();
  for (const agent of ["intake", "v2"] as const) {
    const pause = savAgentPauseCode(await readSavAgentPause(db, agent));
    if (pause) return { skipped: pause };
  }
  let context = deps.context;
  if (!context) {
    let runtime: ReturnType<typeof savIntakeRuntimeConfig>;
    try { runtime = savIntakeRuntimeConfig(env); } catch (error) { return { skipped: code(error) }; }
    if (!runtime) return { skipped: "observation_required" };
    try { context = { runtime, policy: (await readIntakeExecutionAuthority(config)).policy }; } catch (error) { return { skipped: code(error) }; }
  }
  const hubspot = deps.adapters ?? createCaseTicketStageAdapters({ network: deps.network, env: deps.env });
  const forbidden = (port: string) => async () => { throw Error(`SAV_TICKET_STAGE_FORBIDDEN_PORT_${port.toUpperCase()}`); };
  const adapters: ExecutorAdapters = {
    dispatch: hubspot.dispatch, verify: hubspot.verify, readCrm: forbidden("readCrm"), gmailCurrent: forbidden("gmailCurrent"), gmailPermissions: forbidden("gmailPermissions"),
    scope: (() => { throw Error("SAV_TICKET_STAGE_FORBIDDEN_PORT_SCOPE"); }) as ExecutorAdapters["scope"],
  };
  const due = await pendingTicketStageExecutions(Math.min(Math.max(Math.trunc(deps.limit ?? 3), 1), 5));
  if (!due.length) return { skipped: "nothing_due" };
  const processed: Array<{ executionId: string; state: string; reason: string | null }> = [];
  for (const { id } of due) {
    // The budget is spent: no new execution is started (each one is re-listed by the next pass; an engaged one is only verified then).
    if (Date.now() >= deps.deadlineMs) break;
    const options: ExecutionOptions = { config, ...context, env: deps.env, adapters, signal: AbortSignal.timeout(Math.max(1, deps.deadlineMs - Date.now())) };
    await executeIntakePass(id, options, {}, createTicketStageDriver({ env: deps.env, readTicketOwner: deps.readTicketOwner }));
    const [row] = await db.select({ state: savCaseEffectExecutions.state, reason: savCaseEffectExecutions.reason }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, id));
    processed.push({ executionId: id, state: row?.state ?? "unknown", reason: row?.reason ?? null });
  }
  return { skipped: null, processed };
}
