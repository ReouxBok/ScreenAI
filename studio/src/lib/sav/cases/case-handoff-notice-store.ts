// V2 human handoff notice (local, OFF): admission, driver and pass of the Slack notice, on the EXISTING executor and ledger.
// There is one executor (`intake/executor.ts::executeIntakePass`) and one ledger (`sav.intake_effects` + its journal); this file only says what is different for a notice:
//   admission  `enqueueHandoffNotice`: ONE case execution per final handoff decision (unique key = case + input), sealed with the decision's report and nothing else.
//              Idempotent: a second call, a concurrent call, a replay after a crash all return the same execution.
//   driver     what is checked before every plan, marker and send (mode, pauses, the execution's permission, the lease, and under the case lock that the decision is still
//              the final word); the CRM is read just before the plan so the links are verified; what is recorded once the post is confirmed.
//   pass       `runHandoffNoticePass`: the open notices, oldest first. A Slack answer that is lost or unclear is verified by reading the channel, never posted again.
//   note       SAV-92 (Ugo 14/11): once the post is confirmed, the same execution writes ONE HubSpot note on the case's ticket with the synthesis of the stored case,
//              through the EXISTING V2 case note effect (`buildCaseNoteIntent` / `buildCaseNoteAssociateIntent`: key `note:<caseId>:handoff:<hash of input>`,
//              marker before the call, an uncertain result only verified, never written again). Only when the policy grants `append_case_note`; otherwise
//              the notice ends as before and the journal says the note was not granted.
// Nothing here is called by a route, a cron or an action: the caller injects the clock, the network and the policy. OFF until `SAV_HANDOFF_NOTICE=on` AND the execution
// policy grants `notify_case_handoff`; `SAV_CASE_EFFECTS` (reply and note effects) is neither read nor needed.
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, like, lt, lte, notExists, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savCaseEvents, savIntakeEffectJournal, savIntakeEffects, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { readSavAgentPause, SAV_AGENT_PAUSE_CODES, savAgentPauseCode } from "../intake/agent-pause";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import { deferExecutionEffect, executionJournal, type ExecutionLease, type ExecutionTx } from "../intake/execution-store";
import type { PassDriver } from "../intake/executor";
import { executeIntakePass } from "../intake/executor";
import type { Effect, EffectIntent, Execution, ExecutionOptions, ExecutionPayload, ExecutorAdapters } from "../intake/execution-types";
import { savIntakeRuntimeConfig } from "../intake/runtime-contract";
import { ownedExecution, settleVerification } from "./case-effect-driver";
import { caseEffectSchemaInstalled } from "./case-effect-recovery";
import { createHandoffCrmReader, type HandoffCrmReader } from "./case-handoff-crm";
import { nextSweepPage } from "./case-sweep-cursor";
import {
  buildHandoffNoticeIntent, HANDOFF_NOTICE_CONTRACT, HANDOFF_REASON_LABELS, HANDOFF_NOTICE_KEY_PREFIX, awaitingHandoff, staleHandoffEventKinds, handoffNoticeFacts, handoffNoticeKey, handoffNoticeTrigger,
  judgeHandoffCrm, readHandoffNoticeConfig, renderHandoffNotice, type HandoffNoticeFacts,
} from "./case-handoff-notice";
import { createHandoffSlackAdapters, SLACK_NOT_POSTED_PREFIX } from "./case-handoff-slack";
import { caseHandoffSummaryLines } from "./case-handoff-summary";
import { buildCaseNoteAssociateIntent, buildCaseNoteIntent, type CaseNoteCreateIntent } from "./case-effect-intents";
import { caseNoteAssociationKey, caseNoteKey, SAV_CASE_EFFECT_PERMISSIONS } from "./case-effects";
import { createIntakeExecutorAdapters } from "../intake/execution-adapters";
import { investigationHandoffCommand } from "./investigation-record";
import { lockCaseForWrite, listCaseEvents, readCase } from "./case-store";

const LEASE_MS = 80_000;
/** After this many refusals by Slack itself (nothing posted) the effect is no longer taken back: it is verified and left to a person. */
export const HANDOFF_NOT_POSTED_RETRIES = 3;
const fault = (code: string): never => { throw Error(`SAV_HANDOFF_NOTICE_${code}`); };
const code = (error: unknown) => (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160);

/** The sealed payload of a notice execution: what the decision said, already made safe. The channel, the portal and the links are never in it (read when the notice is planned). */
export type HandoffNoticePayload = Readonly<{ contract: typeof HANDOFF_NOTICE_CONTRACT; key: string; facts: HandoffNoticeFacts; teamOwnerId: string | null;
  /** SAV-92: the HubSpot handoff note, sealed at admission (text and time never rebuilt). Absent from notices admitted before it existed. */
  note?: Readonly<{ interactionId: string; text: string; at: string }> }>;
const ackOf = (effect: Effect) => effect.ackCiphertext ? decryptSavPayload<{ id?: string }>(effect.ackCiphertext) : null;
const NOTE_KINDS = new Set(["note_create", "note_associate"]);

/** The HubSpot note of a handoff: team-facing, from the sealed synthesis of the stored case (already masked). Null without a synthesis. */
export function handoffNoteOf(facts: HandoffNoticeFacts, at: string): HandoffNoticePayload["note"] | undefined {
  if (!facts.summary) return undefined;
  const interactionId = `handoff:${createHash("sha256").update(facts.inputKey).digest("hex").slice(0, 32)}`;
  const text = ["Transfert à l'équipe SAV (agent V2)", `Demande : ${facts.need || "non précisée"}`,
    ...caseHandoffSummaryLines(facts.summary, HANDOFF_REASON_LABELS[facts.reason]),
    `Prochaine action proposée : ${facts.expectedIntervention || "à définir par l'équipe"}`].join("\n");
  return { interactionId, text, at };
}
const payloadOf = (row: typeof savCaseEffectExecutions.$inferSelect) => decryptSavPayload<HandoffNoticePayload>(row.payloadCiphertext);
const effectIntent = (effect: Effect) => decryptSavPayload<EffectIntent>(effect.intentCiphertext);

// ---------------------------------------------------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------------------------------------------------

export type EnqueueHandoffNoticeResult =
  | Readonly<{ ok: true; executionId: string; created: boolean; key: string }>
  | Readonly<{ ok: false; code: "notice_off" | "case_unknown" | "no_trigger" | "no_thread"; why?: string }>;

async function readJournal(caseId: string) {
  const events = [];
  for (let page = await listCaseEvents(caseId, { limit: 500 }); page.length; page = await listCaseEvents(caseId, { afterVersion: page.at(-1)!.caseVersion, limit: 500 })) {
    events.push(...page);
    if (page.length < 500) break;
  }
  return events;
}

/**
 * The trigger, read from the STORED case: the latest investigation record holds an accepted decision to hand the case to the team and nothing happened since. Nothing comes
 * from a caller except the policy the execution is queued under (as for a reply). Idempotent on (case, input): the unique reply key makes any second call, concurrent or
 * replayed, the same execution; a cancelled execution stays cancelled (its key is never reused).
 */
export async function enqueueHandoffNotice(input: Readonly<{ caseId: string; policy: Readonly<{ id: string; hash: string }>; env: () => Record<string, string | undefined> }>): Promise<EnqueueHandoffNoticeResult> {
  const config = readHandoffNoticeConfig(input.env());
  if (config.mode !== "on") return { ok: false, code: "notice_off", why: config.why };
  const snapshot = await readCase(input.caseId);
  if (!snapshot) return { ok: false, code: "case_unknown" };
  const trigger = handoffNoticeTrigger(snapshot, await readJournal(snapshot.caseId));
  if (!trigger.ok) return { ok: false, code: "no_trigger", why: trigger.why };
  const threadId = snapshot.threadIds.at(-1);
  if (!threadId) return { ok: false, code: "no_thread" };
  const key = handoffNoticeKey(trigger.caseId, trigger.inputKey);
  const facts = handoffNoticeFacts(trigger, snapshot.body), note = handoffNoteOf(facts, new Date().toISOString());
  const payload: HandoffNoticePayload = { contract: HANDOFF_NOTICE_CONTRACT, key, facts, teamOwnerId: config.teamOwnerId, ...(note ? { note } : {}) };
  return requireDb().transaction(async (tx): Promise<EnqueueHandoffNoticeResult> => {
    const [created] = await tx.insert(savCaseEffectExecutions).values({
      caseId: snapshot.caseId, replyKey: key, threadId, policyId: input.policy.id, policyHash: input.policy.hash, payloadCiphertext: encryptSavPayload(payload),
    }).onConflictDoNothing().returning({ id: savCaseEffectExecutions.id });
    if (created) {
      await executionJournal(tx, created.id, "handoff_notice_admitted", { key, reason: trigger.reason, recordedAtVersion: trigger.recordedAtVersion });
      return { ok: true, executionId: created.id, created: true, key };
    }
    const [existing] = await tx.select({ id: savCaseEffectExecutions.id }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.replyKey, key));
    return existing ? { ok: true, executionId: existing.id, created: false, key } : { ok: false, code: "no_trigger", why: "key_conflict" };
  });
}

export type HandoffNoticeSweepResult = Readonly<{ examined: number; created: number; existing: number; refused: Readonly<Record<string, number>>; windowEnded: boolean; stoppedByDeadline: boolean }>;
/**
 * The safety net of the hook: the cases touched since `since` are read again, at most `limit` per call, walking the window from a durable cursor (`case-sweep-cursor.ts`),
 * so a decision persisted just before a crash still reaches the team and no case is starved by the ones before it. The same idempotent admission (one unique key per
 * notice): a case read twice, by two sweeps or two laps, queues nothing twice. A case without a final handoff decision is counted as refused for its reason, nothing is written.
 */
export async function enqueueHandoffNotices(input: Readonly<{ policy: Readonly<{ id: string; hash: string }>; env: () => Record<string, string | undefined>; since: Date; limit?: number;
  /** Epoch ms after which no new case is started (the caller's budget). The cases already handled keep their effect; the cursor stops after them. */ deadlineMs?: number;
  /** The clock the deadline is judged on, in ms (tests inject one). */ now?: () => number }>): Promise<HandoffNoticeSweepResult> {
  const page = await nextSweepPage({ name: "handoff", since: input.since, limit: input.limit ?? 50 });
  let created = 0, existing = 0;
  const refused: Record<string, number> = {};
  let handled = 0;
  for (const id of page.ids) {
    if (input.deadlineMs !== undefined && (input.now ?? Date.now)() >= input.deadlineMs) break;
    const result = await enqueueHandoffNotice({ caseId: id, policy: input.policy, env: input.env });
    if (result.ok) { if (result.created) created++; else existing++; }
    else refused[result.why ?? result.code] = (refused[result.why ?? result.code] ?? 0) + 1;
    handled++;
  }
  await page.commit(handled);
  return { examined: handled, created, existing, refused, windowEnded: page.windowEnded && handled === page.ids.length, stoppedByDeadline: handled < page.ids.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------------------------------------------

export type HandoffNoticeDriverDeps = Readonly<{
  env: () => Record<string, string | undefined>;
  /** The read-only CRM reading that verifies the links; a failed reading holds the pass (it is read again), it never becomes « no contact ». */
  crm: HandoffCrmReader;
}>;

export function createHandoffNoticeDriver(deps: HandoffNoticeDriverDeps): PassDriver {
  const payloads = new WeakMap<ExecutionLease, HandoffNoticePayload>();
  const caseIds = new WeakMap<ExecutionLease, string>();

  /**
   * Under the execution lock and the case lock (the order of the reply driver), in the transaction that writes a plan or a marker: the mode, the pauses, the lease and that the
   * decision is still the final word. A newer mail, a newer investigation, a person's command or an owner change after the decision cancels the notice for good (the key is
   * never reused: a new decision is a new input and a new key); a person who took the case before it left cancels it too.
   */
  async function fence(tx: ExecutionTx, lease: ExecutionLease) {
    if (!await ownedExecution(tx, lease)) return fault("LEASE_LOST");
    if (readHandoffNoticeConfig(deps.env()).mode !== "on") return fault("HOLD_NOTICE_OFF");
    for (const agent of ["intake", "v2"] as const) {
      const pause = savAgentPauseCode(await readSavAgentPause(tx, agent));
      if (pause) return fault(`HOLD_PAUSED_${agent.toUpperCase()}`);
    }
    const payload = payloads.get(lease)!, caseId = caseIds.get(lease)!;
    const locked = await lockCaseForWrite(tx, caseId);
    if (locked.body.handoff?.humanSince) return fault("CANCELLED_TAKEN_BY_PERSON");
    const recordedVersion = payload.facts.recordedAtVersion;
    // Verify the transfer from the journal under the case lock. This also fences
    // sealed executions created before durable transfers existed.
    const transfer = awaitingHandoff(locked, payload.facts.reason) && (await tx.select({ id: savCaseEvents.id }).from(savCaseEvents)
      .where(and(eq(savCaseEvents.caseId, caseId), eq(savCaseEvents.caseVersion, recordedVersion), eq(savCaseEvents.kind, "owner_changed"),
        eq(savCaseEvents.dedupeKey, "cmd:" + investigationHandoffCommand(recordedVersion - 1)))).limit(1))[0];
    const [later] = await tx.select({ kind: savCaseEvents.kind }).from(savCaseEvents)
      .where(and(eq(savCaseEvents.caseId, caseId), gt(savCaseEvents.caseVersion, payload.facts.recordedAtVersion), inArray(savCaseEvents.kind, staleHandoffEventKinds(Boolean(transfer))))).limit(1);
    if (later) return fault("CANCELLED_STALE_INPUT");
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
    if (marked) await withdraw(lease, marked, `SAV_HANDOFF_NOTICE_${refusal}`);
    return fault(refusal);
  }

  /** The guard of every plan, marker and the last look before Slack. */
  async function newWorkGuard(lease: ExecutionLease, options: Parameters<PassDriver["live"]>[1], permission: string) {
    for (const agent of ["intake", "v2"] as const) {
      const state = await readSavAgentPause(requireDb(), agent);
      if (savAgentPauseCode(state)) throw Error(SAV_AGENT_PAUSE_CODES[state.invalid ? "invalid" : state.level as "actions_paused" | "fully_paused"]);
    }
    if (options.signal.aborted) return fault("ABORTED");
    const { policy } = await readIntakeExecutionAuthority(options.config);
    if (!policy.mutations.includes(permission as typeof policy.mutations[number])) return fault("MUTATION_NOT_GRANTED");
    try {
      await requireDb().transaction(tx => fence(tx, lease));
    } catch (error) {
      const refusal = /^SAV_HANDOFF_NOTICE_((?:CANCELLED|HOLD)_[A-Z0-9_]+)$/.exec(error instanceof Error ? error.message : "");
      if (refusal) return refuseNewWork(lease, refusal[1]!);
      throw error;
    }
  }

  /**
   * After the confirmed post: the HubSpot note, on the existing case note effect. A planned row is returned as stored (never rebuilt); a new note is planned only
   * when the policy grants `append_case_note`. Create first, then associate from the CONFIRMED creation's object id, as for every case note.
   */
  async function nextNoteIntent(lease: ExecutionLease, effects: readonly Effect[], options: Parameters<PassDriver["nextIntent"]>[2]): Promise<EffectIntent | null> {
    const payload = payloads.get(lease)!, note = payload.note;
    if (!note) return null;
    const caseId = payload.facts.caseId;
    const created = effects.find(effect => effect.businessKey === caseNoteKey(caseId, note.interactionId));
    const associated = effects.find(effect => effect.businessKey === caseNoteAssociationKey(caseId, note.interactionId));
    if (created && created.state !== "confirmed") return effectIntent(created);
    if (!created) {
      const { policy } = await readIntakeExecutionAuthority(options.config);
      if (!policy.mutations.includes(SAV_CASE_EFFECT_PERMISSIONS.note)) return null;
      return buildCaseNoteIntent({ caseId, interactionId: note.interactionId, ticketId: payload.facts.ticketId, sourceMessageId: caseId, text: note.text, at: note.at }) as unknown as EffectIntent;
    }
    if (associated) return associated.state === "confirmed" ? null : effectIntent(associated);
    const objectId = ackOf(created)?.id;
    if (!objectId) return fault("NOTE_ACK_MISSING");
    return buildCaseNoteAssociateIntent({ caseId, interactionId: note.interactionId, created: effectIntent(created) as unknown as CaseNoteCreateIntent, createEffectId: created.id, objectId }) as unknown as EffectIntent;
  }

  const driver: PassDriver = {
    async claim(executionId) {
      return requireDb().transaction(async (tx): Promise<{ lease: ExecutionLease } | { blocked: "occupied" }> => {
        const now = new Date();
        const [row] = await tx.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, executionId)).for("update");
        // Only a notice is claimed here: a reply execution has its own driver and a payload this one cannot read.
        if (!row || !row.replyKey.startsWith(HANDOFF_NOTICE_KEY_PREFIX) || row.state === "confirmed" || row.state === "refused" || row.leaseUntil && row.leaseUntil > now) return { blocked: "occupied" };
        const token = randomUUID();
        const [claimed] = await tx.update(savCaseEffectExecutions).set({ leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), state: "running", updatedAt: now })
          .where(eq(savCaseEffectExecutions.id, executionId)).returning();
        const payload = payloadOf(claimed);
        const lease: ExecutionLease = {
          row: { id: claimed.id, threadId: claimed.threadId, messageId: claimed.caseId, policyId: claimed.policyId, policyHash: claimed.policyHash } as unknown as Execution,
          token, payload: { keys: [] } as unknown as ExecutionPayload,
          caseEffect: { assertLocal: t => fence(t, lease), withdraw: (effect, reason) => withdraw(lease, effect, reason) },
        };
        payloads.set(lease, payload); caseIds.set(lease, claimed.caseId);
        return { lease };
      });
    },
    async adopt() { /* a notice is never re-planned against a newer run */ },
    async nextIntent(lease, effects, options) {
      const payload = payloads.get(lease)!;
      const existing = effects.find(effect => effect.businessKey === payload.key);
      // A ledger row that exists is what was planned: its stored intent is returned, never a rebuilt one.
      if (existing && existing.state !== "confirmed") return effectIntent(existing);
      if (existing) return nextNoteIntent(lease, effects, options);
      const config = readHandoffNoticeConfig(deps.env());
      if (config.mode !== "on") return fault("HOLD_NOTICE_OFF");
      const [thread] = await requireDb().select({ customerEmail: savThreads.customerEmail }).from(savThreads).where(eq(savThreads.id, lease.row.threadId));
      // The CRM reading happens outside any transaction and BEFORE the plan: a failed reading holds the pass (read again later), it never plans an unverified link.
      const reading = await deps.crm({ ticketId: payload.facts.ticketId }, AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]));
      const render = renderHandoffNotice(payload.facts, judgeHandoffCrm(reading, { ticketId: payload.facts.ticketId, customerEmail: thread?.customerEmail ?? null }), config.portalId);
      return buildHandoffNoticeIntent({ render, caseId: payload.facts.caseId, ticketId: payload.facts.ticketId, channel: config.channel });
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
     * An error past the marker. Slack's own refusal (nothing posted) takes the effect back to `planned`, a bounded number of times; anything else (a lost answer, a timeout,
     * an unclear answer) leaves it uncertain: it is only verified from then on, whoever owns the case.
     */
    async deferEffect(lease, seen, reason) {
      if (reason.startsWith(SLACK_NOT_POSTED_PREFIX)) {
        const [{ n }] = await requireDb().select({ n: sql<number>`count(*)::int` }).from(savIntakeEffectJournal)
          .where(and(eq(savIntakeEffectJournal.executionId, lease.row.id), eq(savIntakeEffectJournal.kind, "dispatch_withdrawn"))) as [{ n: number }];
        if (n < HANDOFF_NOT_POSTED_RETRIES && await withdraw(lease, seen, reason)) return;
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
        const notice = effects.find(effect => effect.businessKey === payload.key);
        const [fresh] = notice ? await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.id, notice.id)).for("share") : [];
        if (!fresh || fresh.state !== "confirmed") return fault("RECEIPT_MISSING");
        const note = payload.note, noteRows = note ? effects.filter(effect => effect.businessKey === caseNoteKey(payload.facts.caseId, note.interactionId)
          || effect.businessKey === caseNoteAssociationKey(payload.facts.caseId, note.interactionId)) : [];
        // A planned note is never left half done: both steps confirmed, or the execution stays open (verified, never written again).
        if (noteRows.some(effect => effect.state !== "confirmed") || noteRows.length === 1) return fault("NOTE_RECEIPT_MISSING");
        await tx.update(savCaseEffectExecutions).set({ state: "confirmed", leaseToken: null, leaseUntil: null, reason: null, updatedAt: new Date() })
          .where(and(eq(savCaseEffectExecutions.id, lease.row.id), eq(savCaseEffectExecutions.leaseToken, lease.token)));
        await executionJournal(tx, lease.row.id, "execution_confirmed", { noticeEffectId: fresh.id,
          note: !note ? "none" : noteRows.length ? "confirmed" : "not_granted", ...(noteRows.length ? { noteEffectIds: noteRows.map(effect => effect.id) } : {}) });
      });
    },
    async end(lease, state, reason) {
      await requireDb().transaction(async tx => {
        // A cancellation is final (the key is never reused); a hold, a pause or an uncertainty keeps the execution open.
        const cancelled = reason.startsWith("SAV_HANDOFF_NOTICE_CANCELLED_");
        const [row] = await tx.update(savCaseEffectExecutions).set({
          state: cancelled ? "refused" : state, reason: reason.slice(0, 200), leaseToken: null, leaseUntil: null, updatedAt: new Date(),
        }).where(and(eq(savCaseEffectExecutions.id, lease.row.id), eq(savCaseEffectExecutions.leaseToken, lease.token))).returning({ id: savCaseEffectExecutions.id });
        await executionJournal(tx, lease.row.id, row ? (cancelled ? "handoff_notice_cancelled" : "pass_waiting") : "obsolete_pass", { state, reason });
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
 * Open notices a pass may take now, oldest first: the lease is free, and either nothing is engaged yet (a plan, a marker and a send are due) or an engaged effect is due for
 * its read-only verification (fewer than five reads, its schedule reached). An engaged effect that used its five reads is not listed: nothing resets it, a person looks.
 */
export async function pendingHandoffNoticeExecutions(limit = 5, now = new Date()) {
  const e = savCaseEffectExecutions, db = requireDb();
  const engaged = db.select({ one: sql`1` }).from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, e.id), inArray(savIntakeEffects.state, [...ENGAGED])));
  const engagedDue = db.select({ one: sql`1` }).from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, e.id), inArray(savIntakeEffects.state, [...ENGAGED]),
    lt(savIntakeEffects.reconcileAttempts, 5), or(isNull(savIntakeEffects.nextReconcileAt), lte(savIntakeEffects.nextReconcileAt, now))));
  return db.select({ id: e.id }).from(e).where(and(
    like(e.replyKey, `${HANDOFF_NOTICE_KEY_PREFIX}%`), inArray(e.state, [...OPEN]), or(isNull(e.leaseUntil), lte(e.leaseUntil, now)),
    or(notExists(engaged), sql`exists ${engagedDue}`),
  )).orderBy(asc(e.updatedAt), asc(e.id)).limit(Math.min(Math.max(Math.trunc(limit), 1), 20));
}

export type HandoffNoticeRuntimeDeps = Readonly<{
  env: () => Record<string, string | undefined>;
  network: typeof fetch;
  deadlineMs: number;
  limit?: number;
  /** Tests inject the runtime pins / policy the V1 environment would provide; by default they are read exactly like the case effects pass. */
  context?: Pick<ExecutionOptions, "runtime" | "policy">;
  crm?: HandoffCrmReader;
  adapters?: Pick<ExecutorAdapters, "dispatch" | "verify">;
  /** SAV-92: the HubSpot note's adapters (tests inject them); by default the existing executor adapters, built only when a note is dispatched or verified. */
  hubspot?: Pick<ExecutorAdapters, "dispatch" | "verify">;
  schemaInstalled?: () => Promise<boolean>;
}>;
export type HandoffNoticePassResult =
  | Readonly<{ skipped: "notice_off" | "execution_off" | "schema_absent" | "observation_required" | "nothing_due" | (string & {}) }>
  | Readonly<{ skipped: null; processed: ReadonlyArray<Readonly<{ executionId: string; state: string; reason: string | null }>> }>;

/** One bounded pass: the due notices, each on the existing executor with the notice driver. Only two ports are ever called: Slack for the post and, for the
 * granted HubSpot handoff note (SAV-92), the existing executor's HubSpot dispatch/verify. No CRM read, no Gmail. */
export async function runHandoffNoticePass(deps: HandoffNoticeRuntimeDeps): Promise<HandoffNoticePassResult> {
  const env = deps.env();
  if (readHandoffNoticeConfig(env).mode !== "on") return { skipped: "notice_off" };
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
  const slack = deps.adapters ?? createHandoffSlackAdapters({ network: deps.network, env: deps.env });
  const forbidden = (port: string) => async () => { throw Error(`SAV_HANDOFF_NOTICE_FORBIDDEN_PORT_${port.toUpperCase()}`); };
  let hub = deps.hubspot;
  const hubspot = () => hub ??= createIntakeExecutorAdapters({ network: deps.network, env: deps.env });
  const adapters: ExecutorAdapters = {
    // The HubSpot note goes to the existing executor adapters; everything else (the post) to Slack only.
    dispatch: (intent, signal) => NOTE_KINDS.has(intent.kind) ? hubspot().dispatch(intent, signal) : slack.dispatch(intent, signal),
    verify: (intent, ack, at, signal) => NOTE_KINDS.has(intent.kind) ? hubspot().verify(intent, ack, at, signal) : slack.verify(intent, ack, at, signal), readCrm: forbidden("readCrm"), gmailCurrent: forbidden("gmailCurrent"), gmailPermissions: forbidden("gmailPermissions"),
    scope: (() => { throw Error("SAV_HANDOFF_NOTICE_FORBIDDEN_PORT_SCOPE"); }) as ExecutorAdapters["scope"],
  };
  const crm = deps.crm ?? createHandoffCrmReader({ network: deps.network, env: deps.env });
  const due = await pendingHandoffNoticeExecutions(Math.min(Math.max(Math.trunc(deps.limit ?? 3), 1), 5));
  if (!due.length) return { skipped: "nothing_due" };
  const processed: Array<{ executionId: string; state: string; reason: string | null }> = [];
  for (const { id } of due) {
    // The budget is spent: no new notice is started (the next pass lists it again; an engaged post is only verified then).
    if (Date.now() >= deps.deadlineMs) break;
    const options: ExecutionOptions = { config, ...context, env: deps.env, adapters, signal: AbortSignal.timeout(Math.max(1, deps.deadlineMs - Date.now())) };
    await executeIntakePass(id, options, {}, createHandoffNoticeDriver({ env: deps.env, crm }));
    const [row] = await db.select({ state: savCaseEffectExecutions.state, reason: savCaseEffectExecutions.reason }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, id));
    processed.push({ executionId: id, state: row?.state ?? "unknown", reason: row?.reason ?? null });
  }
  return { skipped: null, processed };
}
