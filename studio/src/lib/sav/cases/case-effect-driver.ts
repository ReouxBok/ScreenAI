// SAV-10 (pole C), INTEGRATION PATCH: the driver that lets the EXISTING executor (`intake/executor.ts::executeIntakePass`) run the effects of a case.
// There is one executor and one ledger (`sav.intake_effects`): this file only says what is different for a case execution —
// where the parent row lives, what is checked before every marker, what is recorded once the reply is confirmed — and never sends, marks,
// acknowledges or verifies anything itself. Not wired to any route, cron or action: OFF until `SAV_CASE_EFFECTS=supervised` AND a person approved a payload.
import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, notLike, or } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savCases, savIntakeEffects } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { readSavAgentPause, SAV_AGENT_PAUSE_CODES, savAgentPauseCode, type SavAgentPauseState } from "../intake/agent-pause";
import { readIntakeExecutionAuthority } from "../intake/execution-policy";
import { confirmExecutionEffect, deferExecutionEffect, executionJournal, type ExecutionLease, type ExecutionTx } from "../intake/execution-store";
import type { PassDriver, VerificationSettlement } from "../intake/executor";
import type { Effect, EffectAck, EffectIntent, Execution, ExecutionPayload } from "../intake/execution-types";
import { savV2QualificationCaseAllowed } from "./qualification-scope";
import { HANDOFF_NOTICE_KEY_PREFIX } from "./case-handoff-notice";
import { buildCaseNoteAssociateIntent, buildCaseNoteIntent, buildReplySendIntent, type CaseNoteCreateIntent } from "./case-effect-intents";
import { recordConfirmedCaseReply } from "./case-effect-outcomes";
import { enqueueCaseTicketStage } from "./case-ticket-stage-queue";
import { TICKET_STAGE_KEY_PREFIX } from "./case-ticket-stage";
import { lockCaseForWrite } from "./case-store";
import {
  caseNoteAssociationKey, caseNoteKey, caseRecipientCheck, caseReplyKey, checkCaseReplyApproval, decideCaseEffect, readCaseEffectsMode,
  type CaseApprovalCheck, type CaseEffectLive, type CaseReplyApproval,
} from "./case-effects";
import { readCaseReplyFacts } from "./case-reply-facts";
import { caseReplyStoredTextProblem, caseReplyTextProblemForBasis } from "./case-reply-mode";
import { judgeCurrentTicketOwner, readCaseTicketId, type CaseOwnerRefusal, type CaseTicketOwnerPort } from "./case-ticket-owner";
import { findCaseReplySituationTakerForExecution } from "./case-reply-situation";
import { savCaseReplyValidations } from "./case-reply-validation-table";
import type { CaseEffectPayload } from "./case-reply-store";

export type { CaseEffectPayload };
const fault = (code: string): never => { throw Error(`SAV_CASE_EFFECT_${code}`); };
const LEASE_MS = 80_000;
/** A configuration that cannot be read now holds; a scope that excludes the case, or expired, cancels. */
const QUALIFICATION_HOLD = new Set(["qualification_scope_mode_missing", "qualification_scope_mode_invalid", "qualification_scope_missing", "qualification_scope_invalid", "qualification_scope_not_open", "qualification_binding_unreadable"]);

/** What a VERIFICATION-ONLY pass needs: no owner port (a send that already left is verified whoever owns the ticket now). */
export type CaseEffectRecoveryDriverDeps = Readonly<{
  env: () => Record<string, string | undefined>;
  /** The admission policy revision in force now (null when it cannot be read: the send is held, never cancelled). */
  currentPolicyRevision: () => Promise<string | null>;
}>;
/** What a pass that may do NEW work needs. The owner port is REQUIRED (see `case-ticket-owner.ts`): without it every new plan, marker and send is held. */
export type CaseEffectDriverDeps = CaseEffectRecoveryDriverDeps & Readonly<{
  readTicketOwner: CaseTicketOwnerPort;
  /** Pilot (lot C, 4/11): why this reply's provenance is not proven now, or null. Injected only by a pilot consumer; absent, unchanged. A send already engaged never passes here. */
  pilotProvenance?: (proposal: CaseEffectPayload["proposal"]) => Promise<string | null>;
}>;

const effectIntent = (effect: Effect) => decryptSavPayload<EffectIntent>(effect.intentCiphertext);
const ackOf = (effect: Effect) => effect.ackCiphertext ? decryptSavPayload<EffectAck>(effect.ackCiphertext) : null;
const payloadOf = (row: typeof savCaseEffectExecutions.$inferSelect) => decryptSavPayload<CaseEffectPayload>(row.payloadCiphertext);
const pauseLevel = (state: SavAgentPauseState) => state.invalid ? "invalid" as const : state.level;

type Phase = "reply" | "note_create" | "note_associate";

/** A person took the case: raised inside the receipt transaction (so everything it wrote is rolled back), then turned into the final cancellation OUTSIDE it. */
class ReceiptOwnerChanged extends Error {}

/** The V2 pause that stops the agent from writing to a case: fully paused or unreadable (the same predicate as the entrypoint pass); an actions pause only stops sends. */
const projectionBlockedByPause = (intake: SavAgentPauseState, v2: SavAgentPauseState) => Boolean(savAgentPauseCode(intake)) || v2.invalid || v2.level === "fully_paused";

/**
 * Records what a CONFIRMED reply changes in the case (mail in the journal, the question, the J2) AND the parent's conclusion (`conclude`) in ONE transaction. Nothing the
 * provider does is awaited inside it; the policy revision is resolved just before it opens (it is an injected value with no database copy: it cannot be re-read under the
 * lock, so what is judged against it is only what the case store judges against the revision it is handed).
 *
 * Lock order (the real graph): the EXECUTION row (`ownedExecution`) -> the case (`lockCaseForWrite`: ticket advisory lock, then the case row) -> the confirmed reply EFFECT
 * (`FOR SHARE`, as the case store reads an effect it holds a case lock for). After the LAST wait on a lock the lease, the receipt, the owner and the pauses are judged again
 * against the database and the clock; anything that moved THROWS, so the whole transaction (including a format rewrite `lockCaseForWrite` may have done) is rolled back: a
 * pass that lost its authority leaves no mail event, no question, no J2 and no conclusion. The confirmed ledger row stays, so the recovery completes it later with no resend.
 * A returned refusal is judged explicitly: a dedupe is nominal, a customer message that already crossed the question means no J2 is due, a person owning the case cancels,
 * and any other J2 refusal holds the whole receipt (it is retried; it is never committed half).
 */
async function commitReceipt(
  lease: ExecutionLease, proposal: CaseEffectPayload["proposal"], seen: Effect[], deps: CaseEffectRecoveryDriverDeps,
  conclude: (tx: ExecutionTx, reply: Effect) => Promise<void>,
): Promise<Effect> {
  const key = caseReplyKey(proposal.caseId, proposal.triggerEventId);
  const before = seen.find(effect => effect.businessKey === key);
  if (!before || before.state !== "confirmed" || !before.dispatchedAt || !ackOf(before)?.id) return fault("RECEIPT_MISSING");
  const currentPolicyRevision = await deps.currentPolicyRevision();
  const env = deps.env; // read inside the transaction by the stage queue, never through `deps` (the receipt transaction awaits nothing injected)
  try {
    return await requireDb().transaction(async tx => {
      const owned = await ownedExecution(tx, lease);
      if (!owned) return fault("LEASE_LOST");
      const locked = await lockCaseForWrite(tx, proposal.caseId);
      const [reply] = await tx.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.id, before.id), eq(savIntakeEffects.executionId, lease.row.id))).for("share");
      // Every wait is behind us: judge the clock, the receipt, the owner and the pauses ONCE MORE, against the database.
      if (owned.leaseUntil <= new Date()) return fault("LEASE_LOST");
      const ack = reply && ackOf(reply);
      if (!reply || reply.businessKey !== key || reply.state !== "confirmed" || reply.ackCiphertext !== before.ackCiphertext || !reply.dispatchedAt || !ack?.id || !ack.threadId) return fault("RECEIPT_CHANGED");
      if (locked.owner !== "agent") throw new ReceiptOwnerChanged();
      if (projectionBlockedByPause(await readSavAgentPause(tx, "intake"), await readSavAgentPause(tx, "v2"))) return fault("RECEIPT_HELD_BY_PAUSE");
      // The J2 counts from the mail's real send time (Gmail's own date, verified within a window of the marker); without it, from the marker.
      const verified = typeof ack.sentAt === "string" ? new Date(ack.sentAt) : null;
      const sentAt = verified && Number.isFinite(verified.getTime()) && verified.getTime() >= reply.dispatchedAt.getTime() - 60_000 && verified.getTime() <= reply.dispatchedAt.getTime() + 600_000 ? verified : reply.dispatchedAt;
      const outcome = await recordConfirmedCaseReply({ proposal, effectId: reply.id, gmailMessageId: ack.id, gmailThreadId: ack.threadId, sentAt, currentPolicyRevision }, { tx });
      if (typeof outcome.question === "object" || typeof outcome.trials === "object") throw new ReceiptOwnerChanged();
      if (typeof outcome.j2 === "object" && outcome.j2.refused !== "inbound_after_question") return fault(`RECEIPT_J2_${outcome.j2.refused.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`);
      if (owned.leaseUntil <= new Date()) return fault("LEASE_LOST");
      // « Waiting for the customer » (OFF unless `SAV_V2_TICKET_STAGES=on`): queued in THIS transaction, from the same locked case and the reply's own policy, so a confirmed reply
      // and its ticket state are born together and a replay or a recovery finds the same execution. Its own pass moves the ticket; nothing is sent from here.
      await enqueueCaseTicketStage(tx, { snapshot: locked, trigger: { kind: "reply_confirmed", replyKey: key, sentAt: sentAt.toISOString() }, policy: { id: owned.row.policyId, hash: owned.row.policyHash }, env, threadId: owned.row.threadId });
      await conclude(tx, reply);
      return reply;
    });
  } catch (error) {
    // A person owns the case now: the transaction is rolled back, the ledger still says confirmed, and the execution ends here for good (a cancellation is final).
    if (error instanceof ReceiptOwnerChanged) return fault("CANCELLED_OWNER_CHANGED");
    throw error;
  }
}

/** The reason a verification-only pass leaves on an execution whose reply is confirmed and recorded while its note still waits for a supervised pass. */
export const CASE_RECOVERY_NOTE_PENDING = "SAV_CASE_EFFECT_RECOVERY_NOTE_PENDING";

/**
 * The execution row, locked, if this pass still owns it: same token, lease not expired, running. Everything a pass writes starts here.
 * The lease is judged against the clock read AFTER the lock is held (`at`): waiting for a lock can last past the expiry with nothing else changed, and an instant
 * taken before the wait would still call the lease valid.
 */
export async function ownedExecution(tx: ExecutionTx, lease: ExecutionLease) {
  const [row] = await tx.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, lease.row.id)).for("update");
  const at = new Date();
  return row && row.leaseToken === lease.token && row.leaseUntil && row.leaseUntil > at && row.state === "running" ? { row, leaseUntil: row.leaseUntil, at } : null;
}

/**
 * Settles what a read-only provider verification found, for BOTH drivers (so the supervised pass has no weaker rule than the recovery). The read happens outside
 * any transaction, so the lease and the exact effect that was read are re-checked, locked (execution row, then that effect), in the SAME transaction that confirms or
 * defers: a read that outlived its lease, or whose effect changed (attempt, state, retry count, marker, schedule, intent, receipt), writes nothing and is discarded.
 * An old positive proof never confirms a later attempt; an old negative proof never consumes a later attempt's retry. Nothing is awaited from a provider here.
 */
export const settleVerification: NonNullable<PassDriver["applyVerification"]> = async (lease, observed, outcome): Promise<VerificationSettlement> =>
  requireDb().transaction(async tx => {
    // Lock order: the execution first, then the one effect (the same order as `nextIntent`).
    const owned = await ownedExecution(tx, lease);
    if (!owned) return "stale";
    const [fresh] = await tx.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.id, observed.id), eq(savIntakeEffects.executionId, lease.row.id))).for("update");
    // The wait for the effect's lock can also cross the expiry: the lease is judged again, and "due" is judged, against the clock read once BOTH locks are held.
    const now = new Date();
    if (!fresh || owned.leaseUntil <= now || !sameObservedEffect(fresh, observed, now)) return "stale";
    if ("proof" in outcome && outcome.proof.confirmed && outcome.proof.attributed) { await confirmExecutionEffect(fresh, outcome.proof, outcome.proof.ack, tx); return "confirmed"; }
    await deferExecutionEffect(fresh, "error" in outcome ? outcome.error : "SAV_INTAKE_EXECUTION_RECONCILIATION_REQUIRED", tx);
    return "deferred";
  });

/** The driver for `executeIntakePass(id, options, hooks, driver)`. */
export function createCaseEffectDriver(deps: CaseEffectDriverDeps): PassDriver {
  const phases = new WeakMap<ExecutionLease, Phase>();
  const payloads = new WeakMap<ExecutionLease, CaseEffectPayload>();
  /** Set by `preflight` once the CURRENT owner was read as "v2" for the ledger write that follows; consumed by the gate of that write. A ledger write with no reading is held. */
  const ownerRead = new WeakMap<ExecutionLease, true>();

  /**
   * The approval is the stored validation row, locked here (`FOR SHARE`: a concurrent revocation waits for this transaction, which also writes the marker).
   * The sealed payload only names it. A row that is missing, not approved, revoked, bound to another execution, or whose payload / version / recipient differ from
   * what would be sent, is never an approval — whatever a caller or the sealed payload claims.
   */
  async function durableApproval(tx: ExecutionTx, lease: ExecutionLease, payload: CaseEffectPayload): Promise<{ check: CaseApprovalCheck; approval: CaseReplyApproval | null }> {
    const [row] = await tx.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, payload.validationId)).for("share");
    if (!row) return { check: "approval_invalid", approval: null };
    if (row.state === "revoked") return { check: "approval_revoked", approval: null };
    if (row.state !== "approved" || row.executionId !== lease.row.id || !row.decidedBy || !row.decidedAt) return { check: "approval_invalid", approval: null };
    // The persisted basis travels with the approval: it, and nothing else, says which AI mention the text may carry (`case-reply-mode.ts`).
    const approval: CaseReplyApproval = { payloadHash: row.payloadHash, caseVersion: row.caseVersion, recipient: row.recipient, approvedBy: row.decidedBy, approvedAt: row.decidedAt.toISOString(),
      ...(row.authorizationBasis ? { basis: row.authorizationBasis } : {}) };
    return { check: checkCaseReplyApproval(payload.proposal, approval), approval };
  }

  /**
   * Judges, inside the caller's transaction, whether a NEW plan / marker / send is still eligible: mode, pauses, lease, approval, admission (the LOCAL owner, the version, the
   * policy), recipient, and, for a note (which has no admission of its own), the LOCAL owner. Throws the typed refusal, never returns a permissive value for something it could
   * not read. A customer message recorded after the version the person approved makes the prepared reply stale at EVERY look, the final one included (`new_input`): a technical
   * closure of its validity, not a new right. It does NOT judge the lease's clock: the caller does, AFTER this function's own waits (see `localFenceAfterRead`).
   */
  async function eligibility(tx: ExecutionTx, lease: ExecutionLease, phase: Phase, policyRevision: string | null, pauses: readonly [SavAgentPauseState, SavAgentPauseState]) {
    const payload = payloads.get(lease)!;
    const { proposal } = payload;
    const facts = await readCaseReplyFacts(tx, proposal, policyRevision, { lockCase: true });
    // SAV-80, under the case lock, at every look before a NEW plan, marker or send: outside the qualification scope or after it expired the
    // effect is cancelled; an unreadable scope or binding holds it. A verification of an engaged effect never comes here: it stays possible.
    const scoped = await savV2QualificationCaseAllowed(deps.env(), proposal.caseId, new Date(), tx);
    if (!scoped.allowed) return fault(QUALIFICATION_HOLD.has(scoped.reason) ? "HOLD_QUALIFICATION_SCOPE" : "CANCELLED_QUALIFICATION_SCOPE");
    const { check, approval } = await durableApproval(tx, lease, payload);
    // Under the same lock as the marker: the mention of the text must be the one the PERSISTED basis allows (a falsified or swapped basis, or a text under the wrong authority, never reaches a marker).
    if (phase === "reply" && check === "ok" && caseReplyTextProblemForBasis(proposal.text, approval?.basis)) return fault("CANCELLED_AI_NOTICE");
    // A note describes an interaction that already happened: it is held by the mode, the pauses and the lease, not by what came after (but never by a LOCAL human).
    const live: CaseEffectLive = {
      mode: readCaseEffectsMode(deps.env()).mode, pause: { intake: pauseLevel(pauses[0]), v2: pauseLevel(pauses[1]) }, leaseValid: true,
      admission: phase !== "reply" ? { admitted: true } : facts.admission,
      recipient: phase === "reply" ? caseRecipientCheck(proposal.recipient, facts.storedSender) : "match",
      approval: phase === "reply" ? check : "ok",
    };
    const decision = decideCaseEffect("planned", live);
    if (decision.action === "hold") return fault(`HOLD_${decision.code.toUpperCase()}`);
    if (decision.action === "cancel") return fault(`CANCELLED_${decision.code.toUpperCase()}`);
    if (phase !== "reply" && facts.owner !== "agent") return fault(facts.owner === null ? "CASE_MISSING" : "CANCELLED_OWNER_CHANGED");
    return facts;
  }

  /** Re-reads every fact in the SAME transaction that writes the marker: nothing can move between the decision and the marker. */
  async function gate(tx: ExecutionTx, lease: ExecutionLease, phase: Phase) {
    // No plan and no marker without the current owner read just before it (each ledger write consumes ONE reading): a path that skipped `preflight` is held, not trusted.
    if (!ownerRead.delete(lease)) return fault("HOLD_OWNER_UNCHECKED");
    const { proposal } = payloads.get(lease)!;
    const pauses = [await readSavAgentPause(tx, "intake"), await readSavAgentPause(tx, "v2")] as const;
    await eligibility(tx, lease, phase, await deps.currentPolicyRevision(), pauses);
    // B-7 at the last fence: the store refuses a second reply for a situation, but two executions that were ALREADY queued (an older database, a pass resumed long after) must not both
    // reach the provider either. Under the case lock taken above, in the transaction that writes the plan or the marker. A reply whose own ledger row is already past `planned` is
    // being verified, never resent: the gate does not judge it (and a verification never passes through here).
    if (phase === "reply") {
      const [own] = await tx.select({ state: savIntakeEffects.state }).from(savIntakeEffects).where(and(eq(savIntakeEffects.businessKey, caseReplyKey(proposal.caseId, proposal.triggerEventId)), eq(savIntakeEffects.kind, "reply_send")));
      if (!own || own.state === "planned") {
        const taken = await findCaseReplySituationTakerForExecution(tx, { caseId: proposal.caseId, replyKey: caseReplyKey(proposal.caseId, proposal.triggerEventId), triggerEventId: proposal.triggerEventId, executionId: lease.row.id });
        if (taken) return fault("CANCELLED_SITUATION_TAKEN");
      }
    }
  }

  async function assertLocal(tx: ExecutionTx, lease: ExecutionLease, now: Date) {
    const [row] = await tx.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, lease.row.id)).for("update");
    if (!row || row.leaseToken !== lease.token || !row.leaseUntil || row.leaseUntil <= now || row.state !== "running") return fault("LEASE_LOST");
    await gate(tx, lease, phases.get(lease) ?? "reply");
    // `now` was taken before the waits of the gate (case lock, validation lock): the lease is judged again against a clock read after the last of them.
    if (!await ownedExecution(tx, lease)) return fault("LEASE_LOST");
  }

  async function withdraw(lease: ExecutionLease, effect: Effect, reason: string) {
    return requireDb().transaction(async tx => {
      const [row] = await tx.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, lease.row.id)).for("update");
      if (row?.leaseToken !== lease.token || !row.leaseUntil || row.leaseUntil <= new Date()) return false;
      const [back] = await tx.update(savIntakeEffects).set({ state: "planned", dispatchToken: null, dispatchedAt: null })
        .where(and(eq(savIntakeEffects.id, effect.id), eq(savIntakeEffects.state, "dispatched"), eq(savIntakeEffects.dispatchToken, lease.token),
          eq(savIntakeEffects.attemptId, effect.attemptId), isNull(savIntakeEffects.ackCiphertext))).returning();
      if (back) await executionJournal(tx, lease.row.id, "dispatch_withdrawn", { attemptId: back.attemptId, reason, dispatch: false }, back.id);
      return Boolean(back);
    });
  }

  /** The effect this pass marked and that has not been sent yet (no ACK): the only kind that can be taken back without a trace of a send. */
  async function markedUnsent(lease: ExecutionLease) {
    const [row] = await requireDb().select().from(savIntakeEffects)
      .where(and(eq(savIntakeEffects.executionId, lease.row.id), eq(savIntakeEffects.state, "dispatched"), eq(savIntakeEffects.dispatchToken, lease.token), isNull(savIntakeEffects.ackCiphertext)));
    return row;
  }
  /** A refusal of new work. After the marker and before the SDK the effect goes back to `planned` through the ledger's proven no-send transition; nothing is reset or released otherwise. */
  async function refuseNewWork(lease: ExecutionLease, code: string): Promise<never> {
    const marked = await markedUnsent(lease);
    if (marked) await withdraw(lease, marked, `SAV_CASE_EFFECT_${code}`);
    return fault(code);
  }
  const ownerFault = (code: CaseOwnerRefusal) => code === "owner_human" ? "CANCELLED_OWNER_HUMAN" : `HOLD_${code.toUpperCase()}`;
  /**
   * NEW work only: the CRM owner of THIS case's ticket is read now (ticket id from the case row; the execution's case must be the sealed proposal's case), outside any
   * transaction, and the local fences are judged again AFTER that read (the pauses and the mutation grant by `newWorkGuard`, the lease by `localFenceAfterRead`).
   * A person owning the ticket cancels for good; an absent port, a failed or ambiguous read, "none" and "unknown" hold. CRM and Gmail are never one atomic step: a change
   * after this last read stays the residual limit, declared in the report.
   */
  async function currentOwnerRead(lease: ExecutionLease): Promise<void> {
    const proposal = payloads.get(lease)!.proposal;
    const [execution] = await requireDb().select({ caseId: savCaseEffectExecutions.caseId }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, lease.row.id));
    const verdict = !execution || execution.caseId !== proposal.caseId ? { ok: false as const, code: "owner_ticket_invalid" as const }
      : await judgeCurrentTicketOwner(deps.readTicketOwner, await readCaseTicketId(proposal.caseId));
    if (!verdict.ok) return refuseNewWork(lease, ownerFault(verdict.code));
  }
  /**
   * After the remote read and every other await: ONE short local transaction (no provider await in it; the policy revision is read before it) takes the execution lock, then the
   * case lock (the order of `gate`), judges the lease and `eligibility` again, and throws the typed refusal. A refusal after the marker takes the effect back to `planned` (the
   * proven no-send transition, only while this very pass has not called the provider); a lost lease stays the conservative engaged state. CRM and Gmail are never one atomic step:
   * a change after this last look is the residual limit, declared in the report.
   */
  async function localFenceAfterRead(lease: ExecutionLease): Promise<void> {
    const phase = phases.get(lease) ?? "reply";
    const policyRevision = await deps.currentPolicyRevision();
    try {
      await requireDb().transaction(async tx => {
        if (!await ownedExecution(tx, lease)) return fault("LEASE_LOST");
        await eligibility(tx, lease, phase, policyRevision, [await readSavAgentPause(tx, "intake"), await readSavAgentPause(tx, "v2")]);
        // The case and validation reads above can WAIT for a lock: the lease is judged once more against a clock read AFTER the last of them (never the instant read before),
        // on the execution row this transaction already holds (no new lock, no refresh, no extension of the lease).
        if (!await ownedExecution(tx, lease)) return fault("LEASE_LOST");
      });
    } catch (error) {
      const refusal = /^SAV_CASE_EFFECT_((?:CANCELLED|HOLD)_[A-Z0-9_]+)$/.exec(error instanceof Error ? error.message : "");
      if (refusal) return refuseNewWork(lease, refusal[1]!);
      throw error;
    }
  }
  /** The guard of every plan, every marker and the last look before the SDK. */
  async function newWorkGuard(lease: ExecutionLease, options: Parameters<PassDriver["live"]>[1], permission: string) {
    await currentOwnerRead(lease);
    // The last look before the provider call: a pause seen now proves nothing left, the effect goes back to planned.
    for (const agent of ["intake", "v2"] as const) {
      const state = await readSavAgentPause(requireDb(), agent);
      if (savAgentPauseCode(state)) throw Error(SAV_AGENT_PAUSE_CODES[state.invalid ? "invalid" : state.level as "actions_paused" | "fully_paused"]);
    }
    if (options.signal.aborted) return fault("ABORTED");
    const { policy } = await readIntakeExecutionAuthority(options.config);
    if (!policy.mutations.includes(permission as typeof policy.mutations[number])) return fault("MUTATION_NOT_GRANTED");
    if (deps.pilotProvenance && (phases.get(lease) ?? "reply") === "reply" && await deps.pilotProvenance(payloads.get(lease)!.proposal)) return refuseNewWork(lease, "HOLD_PROVENANCE_UNPROVEN");
    await localFenceAfterRead(lease);
  }

  const driver: PassDriver = {
    async claim(executionId) {
      return requireDb().transaction(async (tx): Promise<{ lease: ExecutionLease } | { blocked: "occupied" }> => {
        const now = new Date();
        const [row] = await tx.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, executionId)).for("update");
        if (!row || row.state === "confirmed" || row.state === "refused" || row.leaseUntil && row.leaseUntil > now) return { blocked: "occupied" };
        const token = randomUUID();
        const [claimed] = await tx.update(savCaseEffectExecutions).set({ leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), state: "running", updatedAt: now })
          .where(eq(savCaseEffectExecutions.id, executionId)).returning();
        const payload = payloadOf(claimed);
        // The ledger primitives only read `row.id` / `row.threadId` / `row.messageId` and `payload.keys`; the rest is not a V1 execution.
        const lease: ExecutionLease = {
          row: { id: claimed.id, threadId: claimed.threadId, messageId: payload.proposal.inboundMessageId, policyId: claimed.policyId, policyHash: claimed.policyHash } as unknown as Execution,
          token, payload: { keys: [] } as unknown as ExecutionPayload,
          caseEffect: { assertLocal: (t, at) => assertLocal(t, lease, at), withdraw: (effect, reason) => withdraw(lease, effect, reason) },
        };
        payloads.set(lease, payload);
        return { lease };
      });
    },
    async adopt() { /* a case effect is never re-planned against a newer run */ },
    async nextIntent(lease, effects) {
      const payload = payloads.get(lease)!;
      const { proposal, context, note } = payload;
      const reply = effects.find(effect => effect.businessKey === caseReplyKey(proposal.caseId, proposal.triggerEventId));
      // A ledger row that exists is what was planned and approved: its stored intent is returned, never a rebuilt one.
      if (!reply || reply.state !== "confirmed") {
        phases.set(lease, "reply");
        if (reply) {
          const stored = effectIntent(reply);
          // A planned reply (no marker yet) planned before the AI-mention contract is refused, never sent: the stored intent is not rebuilt, so the builder's check would be bypassed.
          // A reply already past `planned` is only verified, whatever its text: nothing is judged or resent.
          if (reply.state === "planned" && caseReplyStoredTextProblem((stored as { text?: string }).text ?? "")) return fault("CANCELLED_AI_NOTICE");
          return stored;
        }
        // Planning a reply that has no ledger row yet: the approval is read from the stored validation (the marker's own transaction re-reads it under lock).
        const { check, approval } = await requireDb().transaction(tx => durableApproval(tx, lease, payload));
        if (check !== "ok" || !approval) return fault(`CANCELLED_${check.toUpperCase()}`);
        return buildReplySendIntent(proposal, approval, context);
      }
      if (!note) return null;
      const createKey = caseNoteKey(proposal.caseId, note.interactionId), associateKey = caseNoteAssociationKey(proposal.caseId, note.interactionId);
      const created = effects.find(effect => effect.businessKey === createKey), associated = effects.find(effect => effect.businessKey === associateKey);
      if (!created || created.state !== "confirmed") {
        phases.set(lease, "note_create");
        if (created) return effectIntent(created);
        const [row] = await requireDb().select({ ticketId: savCases.ticketId }).from(savCases).where(eq(savCases.id, proposal.caseId));
        if (!row) return fault("CASE_MISSING");
        return buildCaseNoteIntent({ caseId: proposal.caseId, interactionId: note.interactionId, ticketId: row.ticketId, sourceMessageId: proposal.inboundMessageId, text: note.text, at: note.at });
      }
      if (associated?.state === "confirmed") return null;
      phases.set(lease, "note_associate");
      if (associated) return effectIntent(associated);
      const objectId = ackOf(created)?.id;
      if (!objectId) return fault("NOTE_ACK_MISSING");
      return buildCaseNoteAssociateIntent({ caseId: proposal.caseId, interactionId: note.interactionId, created: effectIntent(created) as unknown as CaseNoteCreateIntent, createEffectId: created.id, objectId });
    },
    // The facts were just re-read in the marker's own transaction (`gate`); nothing here needs a CRM snapshot.
    // Before a plan and before a marker (the executor calls it with the intent before each ledger write): the current owner is read, then the local fences, and one reading is granted to the write.
    async preflight(lease, options, intent) {
      if (!intent) return;
      await newWorkGuard(lease, options, intent.permission);
      ownerRead.set(lease, true);
    },
    async live(lease, options, permission) {
      // After a confirmation (no permission) nothing is checked: a confirmed receipt does not depend on the world as it is now. A verification never comes here with a permission.
      if (!permission) return;
      await newWorkGuard(lease, options, permission);
    },
    applyVerification: settleVerification,
    /** An error past the marker defers the effect only for the pass that still owns the execution AND marked this very attempt (`dispatchToken` is the pass's lease token). */
    async deferEffect(lease, seen, reason) {
      await requireDb().transaction(async tx => {
        const owned = await ownedExecution(tx, lease);
        if (!owned) return;
        const [fresh] = await tx.select().from(savIntakeEffects).where(and(eq(savIntakeEffects.id, seen.id), eq(savIntakeEffects.executionId, lease.row.id))).for("update");
        // The wait for the effect's lock can cross the expiry (same rule as `settleVerification`): the lease is judged again against a clock read once BOTH locks are held.
        if (!fresh || owned.leaseUntil <= new Date() || fresh.attemptId !== seen.attemptId || fresh.dispatchToken !== lease.token || fresh.state === "planned" || fresh.state === "confirmed") return;
        await deferExecutionEffect(fresh, reason, tx);
      });
    },
    async finish(lease, effects) {
      // One transaction (see `commitReceipt`): the mail event, the question, the J2 and the execution's confirmation commit together or not at all.
      await commitReceipt(lease, payloads.get(lease)!.proposal, effects, deps, async (tx, reply) => {
        await tx.update(savCaseEffectExecutions).set({ state: "confirmed", leaseToken: null, leaseUntil: null, reason: null, updatedAt: new Date() })
          .where(and(eq(savCaseEffectExecutions.id, lease.row.id), eq(savCaseEffectExecutions.leaseToken, lease.token)));
        await executionJournal(tx, lease.row.id, "execution_confirmed", { replyEffectId: reply.id });
      });
    },
    async end(lease, state, reason) {
      await requireDb().transaction(async tx => {
        // A cancellation is final (the key is never reused); a hold, a pause or an uncertainty keeps the execution open.
        const cancelled = reason.startsWith("SAV_CASE_EFFECT_CANCELLED_");
        const [row] = await tx.update(savCaseEffectExecutions).set({
          state: cancelled ? "refused" : state, reason: reason.slice(0, 200), leaseToken: null, leaseUntil: null, updatedAt: new Date(),
        }).where(and(eq(savCaseEffectExecutions.id, lease.row.id), eq(savCaseEffectExecutions.leaseToken, lease.token))).returning({ id: savCaseEffectExecutions.id });
        await executionJournal(tx, lease.row.id, row ? (cancelled ? "case_effect_cancelled" : "pass_waiting") : "obsolete_pass", { state, reason });
      });
    },
  };
  return driver;
}

/**
 * BEFORE a supervised pass claims an execution (a claim decrypts the sealed payload, the customer's text included): the ticket id comes from the execution's case row and
 * nothing else is read. A person owning the ticket ends an execution that has no claim holder and nothing in flight for good (`CANCELLED_OWNER_HUMAN`, a conditional write that
 * leaves a claimed or running execution alone); every other refusal only skips it for now. Nothing here sends, resets or releases anything.
 */
export async function ownerBeforeClaim(executionId: string, port: CaseTicketOwnerPort | null | undefined): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: CaseOwnerRefusal; ended: boolean }>> {
  const [execution] = await requireDb().select({ caseId: savCaseEffectExecutions.caseId }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, executionId));
  const verdict = execution ? await judgeCurrentTicketOwner(port, await readCaseTicketId(execution.caseId)) : { ok: false as const, code: "owner_ticket_invalid" as const };
  if (verdict.ok) return verdict;
  if (verdict.code !== "owner_human") return { ...verdict, ended: false };
  const ended = await requireDb().transaction(async tx => {
    // Execution row first (the lock order of this file), then the effects: an execution with a send in flight or past is never cancelled here, it is verified by the recovery.
    const [row] = await tx.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, executionId)).for("update");
    if (!row || !["pending", "waiting"].includes(row.state) || row.leaseUntil && row.leaseUntil > new Date()) return false;
    const engaged = await tx.select({ id: savIntakeEffects.id }).from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, executionId), inArray(savIntakeEffects.state, ["dispatched", "acked", "uncertain", "confirmed"])));
    if (engaged.length) return false;
    await tx.update(savCaseEffectExecutions).set({ state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_HUMAN", leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(eq(savCaseEffectExecutions.id, executionId));
    await executionJournal(tx, executionId, "case_effect_cancelled", { state: "refused", reason: "SAV_CASE_EFFECT_CANCELLED_OWNER_HUMAN", beforeClaim: true });
    return true;
  });
  return { ...verdict, ended };
}

const ENGAGED = ["dispatched", "acked", "uncertain"] as const;
/** The same due-test as the ledger's own read-only recovery: an engaged effect with a marker, fewer than 5 reads, and its schedule reached. */
export const dueForVerification = (effect: Effect, now: Date) =>
  (ENGAGED as readonly string[]).includes(effect.state) && Boolean(effect.dispatchedAt) && effect.reconcileAttempts < 5 && (!effect.nextReconcileAt || effect.nextReconcileAt <= now);

/** The effect a verification read is applied to must still be exactly the one that was read, and still due (an engaged effect, marker, <5 reads, schedule reached). */
const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
const sameObservedEffect = (fresh: Effect, seen: Effect, now: Date) =>
  fresh.id === seen.id && fresh.executionId === seen.executionId && fresh.kind === seen.kind && fresh.permission === seen.permission && fresh.businessKey === seen.businessKey
  && fresh.attemptId === seen.attemptId && fresh.state === seen.state && fresh.reconcileAttempts === seen.reconcileAttempts && fresh.intentHash === seen.intentHash
  && fresh.ackCiphertext === seen.ackCiphertext && fresh.dispatchToken === seen.dispatchToken && sameTime(fresh.dispatchedAt, seen.dispatchedAt)
  && sameTime(fresh.nextReconcileAt, seen.nextReconcileAt) && dueForVerification(fresh, now);

/**
 * VERIFICATION ONLY, isolated from the supervised driver above (which is unchanged). It runs on the same executor, lease/CAS and ledger primitives, and can
 * never reach a marker, a send or a plan:
 *  - `nextIntent` only returns the intent of an effect that is engaged (dispatched / acked / uncertain) and due, re-read under the execution lease with the
 *    effect rows locked, and identical (attempt, state, retry count) to what the pass saw before the lock; anything else (planned, confirmed, failed, not due,
 *    exhausted) yields nothing;
 *  - `preflight` / `live` refuse every call that carries an intent or a permission: the executor only passes one on the plan and marker paths;
 *  - the lease's local check refuses every ledger write that goes through it (plan, marker), and its withdrawal never withdraws;
 *  - `finish` never marks an execution confirmed on the executor's say-so: it records a confirmed reply (idempotent) and confirms the execution only when
 *    the reply and the note, if any, are confirmed in the ledger; otherwise the execution is released as it is;
 *  - `applyVerification` settles what the provider read found. The read happens outside any transaction, so the lease and the exact effect that was read are
 *    re-checked, locked (execution row, then that effect), in the SAME transaction that confirms or defers: a read that outlived its lease, or whose effect
 *    changed (attempt, state, retry count, marker, schedule, intent, receipt), writes nothing and is discarded;
 *  - `end` writes only while the pass still owns an unexpired lease: a lost lease leaves no trace of an old pass.
 * A pause, an owner change or a newer customer message is NOT consulted: after a marker the effect is verify-only whatever the world did (`decideCaseEffect`).
 */
export function createCaseEffectRecoveryDriver(deps: CaseEffectRecoveryDriverDeps): PassDriver {
  // Verification only: the owner port is never consulted here (it is replaced by one that cannot answer), so nothing about the current owner can block a verification.
  const base = createCaseEffectDriver({ ...deps, readTicketOwner: async () => { throw Error("SAV_CASE_EFFECT_RECOVERY_NO_OWNER_READ"); } });
  const payloads = new WeakMap<ExecutionLease, CaseEffectPayload>();
  const noWrite = (): never => fault("RECOVERY_NO_WRITE");
  const noDispatch = (): never => fault("RECOVERY_NO_DISPATCH");
  const confirmedKey = (effects: Effect[], key: string) => effects.some(effect => effect.businessKey === key && effect.state === "confirmed");
  const end: PassDriver["end"] = (lease, state, reason) => requireDb().transaction(async tx => {
    const owned = await ownedExecution(tx, lease);
    if (!owned) return;
    await tx.update(savCaseEffectExecutions).set({ state, reason: reason.slice(0, 200), leaseToken: null, leaseUntil: null, updatedAt: owned.at })
      .where(and(eq(savCaseEffectExecutions.id, lease.row.id), eq(savCaseEffectExecutions.leaseToken, lease.token)));
    await executionJournal(tx, lease.row.id, "pass_waiting", { state, reason });
  });
  return {
    async claim(executionId) {
      const claim = await base.claim(executionId);
      if ("blocked" in claim) return claim;
      const { lease } = claim;
      lease.caseEffect = { assertLocal: async () => noWrite(), withdraw: async () => false };
      const [row] = await requireDb().select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, executionId));
      payloads.set(lease, payloadOf(row!));
      return claim;
    },
    async adopt() { /* nothing is re-planned */ },
    nextIntent(lease, effects) {
      return requireDb().transaction(async tx => {
        const now = new Date();
        const [row] = await tx.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, lease.row.id)).for("update");
        if (!row || row.leaseToken !== lease.token || !row.leaseUntil || row.leaseUntil <= now || row.state !== "running") return fault("LEASE_LOST");
        const locked = await tx.select().from(savIntakeEffects).where(eq(savIntakeEffects.executionId, lease.row.id)).for("update");
        for (const seen of effects) {
          if (!dueForVerification(seen, now)) continue;
          const fresh = locked.find(effect => effect.id === seen.id);
          if (!fresh || fresh.attemptId !== seen.attemptId || fresh.state !== seen.state || fresh.reconcileAttempts !== seen.reconcileAttempts || !dueForVerification(fresh, now)) continue;
          return effectIntent(fresh);
        }
        return null;
      });
    },
    applyVerification: settleVerification,
    async preflight(_lease, _options, intent) { if (intent) noDispatch(); },
    async live(_lease, _options, permission) { if (permission) noDispatch(); },
    async finish(lease, effects) {
      const { proposal, note } = payloads.get(lease)!;
      const engaged = effects.some(effect => (ENGAGED as readonly string[]).includes(effect.state));
      if (!confirmedKey(effects, caseReplyKey(proposal.caseId, proposal.triggerEventId)))
        return end(lease, engaged ? "uncertain" : "waiting", engaged ? "SAV_CASE_EFFECT_RECOVERY_NOT_DUE" : "SAV_CASE_EFFECT_RECOVERY_NOTHING_TO_VERIFY");
      const noteDone = !note || confirmedKey(effects, caseNoteKey(proposal.caseId, note.interactionId)) && confirmedKey(effects, caseNoteAssociationKey(proposal.caseId, note.interactionId));
      if (noteDone) return base.finish(lease, effects);
      // The mail is confirmed and recorded; the note is a write that only a supervised pass, under every gate, may plan.
      const state = engaged ? "uncertain" : "waiting";
      await commitReceipt(lease, proposal, effects, deps, async (tx) => {
        await tx.update(savCaseEffectExecutions).set({ state, reason: CASE_RECOVERY_NOTE_PENDING, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
          .where(and(eq(savCaseEffectExecutions.id, lease.row.id), eq(savCaseEffectExecutions.leaseToken, lease.token)));
        await executionJournal(tx, lease.row.id, "pass_waiting", { state, reason: CASE_RECOVERY_NOTE_PENDING });
      });
      return;
    },
    end,
  };
}

/** Executions a pass may take now: never started, left waiting, or abandoned by a lease that expired. Oldest first, bounded. */
export async function pendingCaseEffectExecutions(limit = 5, now = new Date()) {
  return requireDb().select({ id: savCaseEffectExecutions.id }).from(savCaseEffectExecutions)
    // A handoff notice has its own driver and its own listing (`case-handoff-notice-store.ts`): this driver reads a reply proposal in every sealed payload.
    .where(and(inArray(savCaseEffectExecutions.state, ["pending", "running", "waiting", "uncertain"]), or(isNull(savCaseEffectExecutions.leaseUntil), lte(savCaseEffectExecutions.leaseUntil, now)),
      notLike(savCaseEffectExecutions.replyKey, `${HANDOFF_NOTICE_KEY_PREFIX}%`), notLike(savCaseEffectExecutions.replyKey, `${TICKET_STAGE_KEY_PREFIX}%`)))
    .orderBy(asc(savCaseEffectExecutions.updatedAt), asc(savCaseEffectExecutions.id)).limit(Math.min(Math.max(limit, 1), 20));
}
