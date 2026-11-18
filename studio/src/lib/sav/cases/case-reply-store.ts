import { caseReplyEditableBody, prepareCaseReplyText, readCaseReplyDisclosure } from "./case-reply-outbound";
// SAV-10 (pole C): the DURABLE human validation of a prepared reply, and its idempotent hand-off to the executor's queue.
//   submit  -> `proposed`   what the agent prepared, stored exactly as the person will read it (B produces the proposal, this stores it, it never sends it)
//   decide  -> `approved` | `declined`   a person, authorized by an INJECTED port that refuses by default, for THIS payload, case version and recipient
//   revoke  -> `revoked`    a person withdraws an approval until the send starts (a marker exists = too late: only verification remains)
//   enqueue -> one `case_effect_executions` row built from the stored validation, never from a parameter
// There is no function that accepts an approval as input: the approval is the stored row. Nothing here sends, marks, acknowledges or verifies;
// the executor's gate re-reads the validation row under a lock in the same transaction as the marker. OFF unless `SAV_CASE_EFFECTS=supervised`
// (a revocation is a safety action and works in every mode). No validity duration is imposed: a stale reply is cancelled by what changed, not by a clock.
import "server-only";
import { CLOSING_REPLY, HANDOFF_REPLY, isTerminalReply, closingHandoffReplyEnabled } from "./case-terminal-reply";
import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savCases, savIntakeEffects, savMailboxes, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { executionJournal, type ExecutionTx } from "../intake/execution-store";
import { assertSavOutboundRecipientAllowed } from "../policy";
import type { CaseReplyContext } from "./case-effect-intents";
import { caseReplyKey, caseReplyPayloadHash, caseReplyQuestions, readCaseEffectsMode, type CaseReplyProposal } from "./case-effects";
import { readCaseReplyFacts } from "./case-reply-facts";
import { caseReplyStoredTextProblem, caseReplyTextProblemForBasis } from "./case-reply-mode";
import { findCaseReplySituationTaker } from "./case-reply-situation";
import { resolveCaseReplyTrigger } from "./case-reply-trigger";
import { judgeCurrentTicketOwner, readCaseTicketId, type CaseTicketOwnerPort } from "./case-ticket-owner";
import { savCaseReplyValidations, type CaseReplyValidationRow } from "./case-reply-validation-table";
import {
  authorizeCaseReplyDecision, CASE_REPLY_STUDIO_CORRECTION_BASIS, checkCaseReplySeen, type CaseReplyAuthorizer, type CaseReplyDecisionAction, type CaseReplySeen, type CaseReplyValidationState,
} from "./case-reply-validation";

export type CaseReplyDecideDeps = Readonly<{
  env: () => Record<string, string | undefined>;
  /** The admission policy revision in force now (null when it cannot be read: nothing is approved on a policy that cannot be read). */
  currentPolicyRevision: () => Promise<string | null>;
  /** Pilot (lot C, 4/11): why this reply's provenance is not proven now, or null (`pilot-passage-provenance.ts`). Injected only by a pilot consumer; absent, unchanged.
   * `basis` is the PERSISTED (or, at the approval, the authorizer's) authorization basis: only the Studio correction basis lets a text differ from the decision's (SAV-92). */
  pilotProvenance?: (proposal: CaseReplyProposal, context?: Readonly<{ basis?: string | null }>) => Promise<string | null>;
}>;
/** What NEW reply work (a proposal, a queue entry) needs. The owner port is REQUIRED: there is no default and no way to leave it out and continue (see `case-ticket-owner.ts`). */
export type CaseReplyStoreDeps = CaseReplyDecideDeps & Readonly<{ readTicketOwner: CaseTicketOwnerPort }>;

/** The internal note of an interaction (text supplied by the caller, never invented here). One note per `interactionId`. */
export type CaseEffectNote = Readonly<{ interactionId: string; text: string; at: string }>;
/** Everything the executor needs, sealed in the parent row. The approval is NOT in it: the executor reads the validation row. */
export type CaseEffectPayload = Readonly<{ validationId: string; proposal: CaseReplyProposal; context: CaseReplyContext; note?: CaseEffectNote }>;

export type CaseReplyRefusal = Readonly<{ ok: false; code: string; detail?: string }>;
const refuse = (code: string, detail?: string): CaseReplyRefusal => ({ ok: false, code, ...(detail ? { detail } : {}) });
const lower = (value: string) => value.trim().toLowerCase();
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isSupervised = (deps: Pick<CaseReplyDecideDeps, "env">) => readCaseEffectsMode(deps.env()).mode === "supervised";
const proposalOf = (row: CaseReplyValidationRow) => decryptSavPayload<CaseReplyProposal>(row.proposalCiphertext);
const uniqueViolation = (error: unknown) => { for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) if ((e as { code?: string }).code === "23505") return true; return false; };
const guardViolation = (error: unknown) => { for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) if ((e as { code?: string }).code === "23514") return true; return false; };

/**
 * LOCK ORDER, one for every function of this file and for the executor's gate: EXECUTION -> CASE -> VALIDATION. Every path that takes a validation row
 * takes the case row first (`FOR UPDATE`); the executor's gate takes its execution row, then the case, then the validation `FOR SHARE`. A path that took the
 * validation first and the case second (an approval against a new proposal that supersedes the same row) could wait on the other in a cycle, which Postgres
 * resolves by aborting one of them. A test records the lock statements of each function and fails if the order changes (`case-reply-lock-order.test.ts`).
 */
/** Locks the case row and returns its version (null when the case row is missing). */
async function lockCase(tx: ExecutionTx, caseId: string): Promise<number | null> {
  const [row] = await tx.select({ id: savCases.id, version: savCases.version }).from(savCases).where(eq(savCases.id, caseId)).for("update");
  return row ? row.version : null;
}

const PURPOSES = new Set(["question", "answer", "reminder", "closing", "handoff"]);
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
/** Bounded and unique: at most the 6 requests × 8 steps a decision may carry, each with the exact card version the case contract stores. */
const caseReplyProceduresValid = (procedures: NonNullable<CaseReplyProposal["procedures"]>) => {
  const filled = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
  const keys = procedures.map(row => `${row?.requestId}\u0000${row?.procedure?.knowledgeId}\u0000${row?.procedure?.contentVersionId}`);
  return procedures.length <= 48 && new Set(keys).size === keys.length && procedures.every(row => filled(row?.requestId) && filled(row?.procedure?.knowledgeId) && filled(row?.procedure?.contentVersionId));
};
/** A proposal that cannot be sent as written is refused when it is stored, not when it is approved. */
function proposalProblem(proposal: CaseReplyProposal): string | null {
  try {
    caseReplyPayloadHash(proposal);
    if (!Number.isInteger(proposal.caseVersion) || proposal.caseVersion < 1) return "case_version";
    if (!PURPOSES.has(proposal.purpose)) return "purpose";
    if (typeof proposal.text !== "string" || !proposal.text.trim()) return "text";
    // Contract sav-v2-reply-outbound.v1: what is stored, shown, hashed, approved and sent is ONE final text, AI mention included, prepared by the producer BEFORE this call. The
    // store never adds or fixes anything (a footer added here or later would not be the text that was hashed and approved); a raw text, a human-only signature and a stacked or
    // contradictory mention are refused before any row or hash exists. Which of the two mentions (reviewed / automated) may be SENT is not decided here: it is the persisted
    // authorization basis of the approval (`case-reply-mode.ts`), checked at the approval, the queue and every marker.
    const notFinal = caseReplyStoredTextProblem(proposal.text);
    if (notFinal) return notFinal;
    if (isTerminalReply(proposal.purpose) && caseReplyEditableBody(proposal.text) !== (proposal.purpose === "closing" ? CLOSING_REPLY : HANDOFF_REPLY)) return "terminal_text";
    if (typeof proposal.subject !== "string" || !proposal.subject.trim() || /[\r\n]/.test(proposal.subject)) return "subject";
    if (typeof proposal.recipient !== "string" || !ADDRESS.test(proposal.recipient.trim())) return "recipient";
    if (typeof proposal.inboundMessageId !== "string" || !proposal.inboundMessageId) return "inbound";
    const questions = caseReplyQuestions(proposal);
    if (proposal.question && proposal.questions !== undefined) return "question";
    if (proposal.questions !== undefined && (!Array.isArray(proposal.questions) || proposal.questions.length < 2 || proposal.questions.length > 5)) return "question";
    if (proposal.purpose === "question" && (!questions.length || new Set(questions.map(q => q.id)).size !== questions.length || questions.some(q => !q.id || !q.text.trim() || !/^[A-Za-z0-9._:-]{1,80}$/.test(q.id) || !Array.isArray(q.factKeys) || q.factKeys.some(key => typeof key !== "string") || new Set(q.factKeys).size !== q.factKeys.length))) return "question";
    if (proposal.purpose !== "question" && (proposal.question || proposal.questions !== undefined)) return "question";
    if (proposal.procedures !== undefined && (proposal.purpose !== "answer" || !Array.isArray(proposal.procedures) || !caseReplyProceduresValid(proposal.procedures))) return "procedures";
    assertSavOutboundRecipientAllowed(lower(proposal.recipient));
    return null;
  } catch { return "invalid"; }
}

export type SubmitCaseReplyResult = Readonly<{ ok: true; id: string; created: boolean; state: CaseReplyValidationState;
  /** SAV-94: set only when the row found is one stored before the layout pass (its text kept as stored): the hash of THAT row, which the caller must use. */
  storedPayloadHash?: string }> | CaseReplyRefusal;

/**
 * SAV-94: a proposal stored (and maybe approved, hashed, queued) BEFORE the layout pass, that the same decision prepared again now would only lay out
 * (blank lines, "1)" -> "1.", Markdown markers). That row is the reply: its text is kept and sent exactly as stored, never re-formatted, so a resumed
 * decision finds its approval instead of being refused as a second text (`trigger_already_approved`). Same trigger, same fields, same mention: only the
 * layout of the stored text may differ. Approved rows first, like the exact lookup otherwise returns the one row with that hash.
 */
async function findCaseReplyStoredBeforeLayout(tx: Pick<ExecutionTx, "select">, replyKey: string, payloadHash: string) {
  const t = savCaseReplyValidations;
  const rows = await tx.select({ id: t.id, state: t.state, payloadHash: t.payloadHash, proposalCiphertext: t.proposalCiphertext }).from(t).where(eq(t.replyKey, replyKey));
  for (const row of [...rows].sort((a, b) => Number(b.state === "approved") - Number(a.state === "approved"))) {
    let stored: CaseReplyProposal;
    try { stored = decryptSavPayload<CaseReplyProposal>(row.proposalCiphertext); } catch { continue; }
    const disclosure = readCaseReplyDisclosure(stored.text);
    if (!disclosure) continue;
    let relaid: string;
    try { relaid = prepareCaseReplyText(stored.text, disclosure.language, disclosure.mode, stored.purpose); } catch { continue; }
    if (relaid !== stored.text && caseReplyPayloadHash({ ...stored, text: relaid }) === payloadHash) return row;
  }
  return null;
}

/**
 * Stores what the agent prepared. Idempotent on (trigger, payload): the same proposal is the same row. A new proposal for the case replaces the proposals
 * nobody decided yet (`superseded`). Refused (nothing written) when the mode is not `supervised`, when the case is not the agent's and admitted now, when a
 * customer message arrived after the version the proposal is built on, when the recipient is not the stored sender of the message it answers, or when
 * the trigger already holds an approved reply with another content, or when another name of the same situation (B-7, `case-reply-situation.ts`) is already answered.
 */
export async function submitCaseReplyProposal(requested: CaseReplyProposal, deps: CaseReplyStoreDeps, options: Readonly<{
  /** SAV-92 (Studio correction): the proposal a person corrected. Under the case lock it must still be `proposed`, for the same trigger and with the hash they read;
   * otherwise nothing is stored (`not_proposed` / `supersedes_invalid`). A replay of the same corrected text still finds its own row first (idempotent). */
  supersedes?: Readonly<{ validationId: string; payloadHash: string }>;
}> = {}): Promise<SubmitCaseReplyResult> {
  if (!isSupervised(deps)) return refuse("effects_off");
  if (isTerminalReply(requested.purpose) && !closingHandoffReplyEnabled(deps.env())) return refuse("effects_off");
  const problem = proposalProblem(requested);
  if (problem) return refuse("proposal_invalid", problem);
  // The CRM owner NOW, before anything is stored: asked outside the transaction, about the ticket of this very case (minimal read, nothing decrypted). The local facts are judged under the case lock afterwards.
  const ticketId = await readCaseTicketId(requested.caseId);
  if (ticketId === null) return refuse("case_unknown");
  const owner = await judgeCurrentTicketOwner(deps.readTicketOwner, ticketId);
  if (!owner.ok) return refuse(owner.code);
  const revision = await deps.currentPolicyRevision();
  return requireDb().transaction(async (tx): Promise<SubmitCaseReplyResult> => {
    const facts = await readCaseReplyFacts(tx, requested, revision, { lockCase: true });
    if (facts.caseVersion === null) return refuse("case_unknown");
    if (requested.caseVersion > facts.caseVersion) return refuse("version_unknown");
    const [inbound] = await tx.select({ threadId: savMessages.threadId }).from(savMessages).where(eq(savMessages.id, requested.inboundMessageId));
    if (!inbound) return refuse("inbound_unknown");
    const [owner] = await tx.select({ threadIds: savCases.threadIds }).from(savCases).where(eq(savCases.id, requested.caseId));
    if (!owner?.threadIds.includes(inbound.threadId)) return refuse("inbound_not_in_case");
    // The trigger is the stored fact the reply answers, under ONE canonical name; the proposal is stored (and hashed, and approved) under that name.
    const trigger = await resolveCaseReplyTrigger(tx, requested);
    if (!trigger.ok) return refuse(trigger.code, trigger.detail);
    const proposal: CaseReplyProposal = { ...requested, triggerEventId: trigger.triggerEventId };
    const replyKey = caseReplyKey(proposal.caseId, proposal.triggerEventId), payloadHash = caseReplyPayloadHash(proposal);
    const [existing] = await tx.select().from(savCaseReplyValidations).where(and(eq(savCaseReplyValidations.replyKey, replyKey), eq(savCaseReplyValidations.payloadHash, payloadHash)));
    if (existing) return { ok: true, id: existing.id, created: false, state: existing.state as CaseReplyValidationState };
    // SAV-94: the same reply stored before the layout pass is found as it is (a Studio correction is a new text and keeps its own path).
    const kept = options.supersedes ? null : await findCaseReplyStoredBeforeLayout(tx, replyKey, payloadHash);
    if (kept) return { ok: true, id: kept.id, created: false, state: kept.state as CaseReplyValidationState, storedPayloadHash: kept.payloadHash };
    if (options.supersedes) {
      // Case first (above), validation second: the lock order of this file.
      const [prior] = await tx.select({ caseId: savCaseReplyValidations.caseId, replyKey: savCaseReplyValidations.replyKey, payloadHash: savCaseReplyValidations.payloadHash, state: savCaseReplyValidations.state })
        .from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, options.supersedes.validationId)).for("update");
      if (!prior || prior.caseId !== proposal.caseId || prior.replyKey !== replyKey || prior.payloadHash !== options.supersedes.payloadHash) return refuse("supersedes_invalid");
      if (prior.state !== "proposed") return refuse("not_proposed", prior.state);
    }
    if (!facts.admission.admitted) return refuse(facts.admission.reason === "input_newer" ? "new_input" : "not_admitted", facts.admission.reason);
    if (facts.storedSender === null || lower(facts.storedSender) !== lower(proposal.recipient)) return refuse("recipient_changed");
    const [approved] = await tx.select({ id: savCaseReplyValidations.id }).from(savCaseReplyValidations)
      .where(and(eq(savCaseReplyValidations.replyKey, replyKey), eq(savCaseReplyValidations.state, "approved")));
    if (approved) return refuse("trigger_already_approved");
    // B-7: another name for the SAME situation (the mail, or the hand back that returns to it) already holds an approved reply that may still go out or has gone out.
    if (await findCaseReplySituationTaker(tx, { caseId: proposal.caseId, replyKey, triggerEventId: proposal.triggerEventId, scope: "approval" })) return refuse("situation_already_answered");
    await tx.update(savCaseReplyValidations).set({ state: "superseded", decidedAt: new Date() })
      .where(and(eq(savCaseReplyValidations.caseId, proposal.caseId), eq(savCaseReplyValidations.state, "proposed")));
    const [created] = await tx.insert(savCaseReplyValidations).values({
      caseId: proposal.caseId, replyKey, payloadHash, caseVersion: proposal.caseVersion, recipient: lower(proposal.recipient), proposalCiphertext: encryptSavPayload(proposal),
    }).returning({ id: savCaseReplyValidations.id });
    return { ok: true, id: created!.id, created: true, state: "proposed" };
  });
}

export type DecideCaseReplyResult = Readonly<{ ok: true; id: string; state: CaseReplyValidationState; changed: boolean }> | CaseReplyRefusal;

/**
 * A person approves or declines THE payload they read. `seen` is what their screen showed (hash of the exact payload, case version, recipient): any difference
 * with the stored row refuses. The injected authorizer decides WHO; absent, failing, or silent, it refuses. Deciding twice the same way is a no-op.
 * An approval also re-reads the facts under the case lock: a customer message, a human owner or a changed recipient since the proposal refuses it.
 */
export async function decideCaseReply(input: Readonly<{
  action: Exclude<CaseReplyDecisionAction, "revoke">; validationId: string; approverId: string; seen: CaseReplySeen; authorizer: CaseReplyAuthorizer | null | undefined; deps: CaseReplyDecideDeps;
  /** SAV-92: the CASE version the person's screen showed. Given, any other version under the case lock refuses (`case_version_changed`): a new mail, a pause
   * recorded on the case, a takeover or any other write since the screen was built. Absent: unchanged behaviour. */
  expectedCaseVersion?: number;
}>): Promise<DecideCaseReplyResult> {
  const { action, validationId, approverId, seen, authorizer, deps, expectedCaseVersion } = input;
  if (!isSupervised(deps)) return refuse("effects_off");
  const target = action === "approve" ? "approved" : "declined";
  const [row] = await requireDb().select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId));
  if (!row) return refuse("unknown");
  if (row.state === target) return { ok: true, id: row.id, state: target, changed: false };
  if (row.state !== "proposed") return refuse("not_proposed", row.state);
  const seenCheck = checkCaseReplySeen({ payloadHash: row.payloadHash, caseVersion: row.caseVersion, recipient: row.recipient }, seen);
  if (seenCheck !== "ok") return refuse(seenCheck);
  const proposal = proposalOf(row);
  if (action === "approve" && isTerminalReply(proposal.purpose) && !closingHandoffReplyEnabled(deps.env())) return refuse("effects_off");
  // A row stored before the contract can still be declined, never approved: nobody validates a text that cannot be sent as written.
  if (action === "approve") { const notFinal = caseReplyStoredTextProblem(proposal.text); if (notFinal) return refuse("proposal_invalid", notFinal); }
  // Pilot: no proof of where this reply comes from, no validation. It can still be declined.
  const request = { action, approverId, caseId: row.caseId, replyKey: row.replyKey, payloadHash: row.payloadHash, purpose: proposal.purpose } as const;
  let early: Awaited<ReturnType<typeof authorizeCaseReplyDecision>> | null = null;
  if (action === "approve" && deps.pilotProvenance) {
    const unproven = await deps.pilotProvenance(proposal);
    if (unproven) {
      // SAV-92: a text a person corrected in the Studio differs from the decision's by design. Only the authorizer's explicit correction basis (never a caller's flag)
      // lets the provenance be judged again without the text comparison; every other proof (latest decision, trigger, purpose, scope, sources) still applies.
      early = await authorizeCaseReplyDecision(authorizer, request);
      if (!early.allowed || early.basis !== CASE_REPLY_STUDIO_CORRECTION_BASIS) return refuse("provenance_unproven", unproven);
      const still = await deps.pilotProvenance(proposal, { basis: early.basis });
      if (still) return refuse("provenance_unproven", still);
    }
  }
  const authorization = early ?? await authorizeCaseReplyDecision(authorizer, request);
  if (!authorization.allowed) return refuse(authorization.code);
  // The mention the text carries must be the one THIS authority allows: the automated mention only under the automatic rule's basis, the reviewed one only under a human's.
  if (action === "approve") { const wrongMode = caseReplyTextProblemForBasis(proposal.text, authorization.basis); if (wrongMode) return refuse("proposal_invalid", wrongMode); }
  const revision = action === "approve" ? await deps.currentPolicyRevision() : null;
  try {
    return await requireDb().transaction(async (tx): Promise<DecideCaseReplyResult> => {
      // Case first, validation second (see the lock order above). An approval reads the facts under that same case lock.
      const facts = action === "approve" ? await readCaseReplyFacts(tx, proposal, revision, { lockCase: true }) : null;
      const lockedVersion = facts ? facts.caseVersion : await lockCase(tx, row.caseId);
      const [locked] = await tx.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId)).for("update");
      if (!locked) return refuse("unknown");
      if (locked.state === target) return { ok: true, id: locked.id, state: target, changed: false };
      if (locked.state !== "proposed") return refuse("not_proposed", locked.state);
      if (expectedCaseVersion !== undefined && lockedVersion !== expectedCaseVersion) return refuse("case_version_changed");
      if (facts) {
        if (!facts.admission.admitted) return refuse(facts.admission.reason === "input_newer" ? "new_input" : "not_admitted", facts.admission.reason);
        if (facts.storedSender === null || lower(facts.storedSender) !== locked.recipient) return refuse("recipient_changed");
        // B-7: under the case lock every approval of this case is serialized, so the second name of a situation sees the first one's approval here.
        if (await findCaseReplySituationTaker(tx, { caseId: locked.caseId, replyKey: locked.replyKey, triggerEventId: proposal.triggerEventId, scope: "approval" })) return refuse("situation_already_answered");
      }
      await tx.update(savCaseReplyValidations).set({ state: target, decidedBy: approverId, decidedAt: new Date(), authorizationBasis: authorization.basis })
        .where(and(eq(savCaseReplyValidations.id, validationId), eq(savCaseReplyValidations.state, "proposed")));
      return { ok: true, id: validationId, state: target, changed: true };
    });
  } catch (error) {
    // Two approvals of two payloads of the same trigger: the partial unique index lets exactly one through.
    if (uniqueViolation(error)) return refuse("trigger_already_approved");
    throw error;
  }
}

/**
 * Withdraws an approval. Works in every mode (it only removes a permission). Refused once the reply's effect has left `planned` — a marker exists, the send may
 * have started, verification only — which the row lock, the explicit check and the table's guard trigger all enforce. After a revocation the executor cancels
 * the execution at its next gate (`approval_revoked`) and nothing is sent.
 */
export async function revokeCaseReply(input: Readonly<{ validationId: string; approverId: string; authorizer: CaseReplyAuthorizer | null | undefined }>): Promise<DecideCaseReplyResult> {
  const { validationId, approverId, authorizer } = input;
  const [row] = await requireDb().select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId));
  if (!row) return refuse("unknown");
  if (row.state === "revoked") return { ok: true, id: row.id, state: "revoked", changed: false };
  if (row.state !== "approved") return refuse("not_approved", row.state);
  const proposal = proposalOf(row);
  const authorization = await authorizeCaseReplyDecision(authorizer, { action: "revoke", approverId, caseId: row.caseId, replyKey: row.replyKey, payloadHash: row.payloadHash, purpose: proposal.purpose });
  if (!authorization.allowed) return refuse(authorization.code);
  try {
    return await requireDb().transaction(async (tx): Promise<DecideCaseReplyResult> => {
      await lockCase(tx, row.caseId);
      const [locked] = await tx.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId)).for("update");
      if (!locked) return refuse("unknown");
      if (locked.state === "revoked") return { ok: true, id: locked.id, state: "revoked", changed: false };
      if (locked.state !== "approved") return refuse("not_approved", locked.state);
      const [engaged] = await tx.select({ id: savIntakeEffects.id }).from(savIntakeEffects).where(and(eq(savIntakeEffects.businessKey, locked.replyKey), ne(savIntakeEffects.state, "planned")));
      if (engaged) return refuse("too_late");
      await tx.update(savCaseReplyValidations).set({ state: "revoked", revokedBy: approverId, revokedAt: new Date(), revocationBasis: authorization.basis })
        .where(and(eq(savCaseReplyValidations.id, validationId), eq(savCaseReplyValidations.state, "approved")));
      return { ok: true, id: validationId, state: "revoked", changed: true };
    });
  } catch (error) {
    if (guardViolation(error)) return refuse("too_late");
    throw error;
  }
}

export type EnqueueCaseReplyResult = Readonly<{ ok: true; executionId: string; created: boolean }> | CaseReplyRefusal;

/**
 * Queues the approved reply for the executor: ONE `case_effect_executions` row per trigger, built from the stored validation (the proposal, and the mailbox /
 * thread / Message-ID read from the stored inbound message — nothing about the approval or the route comes from the caller). Idempotent: a second call returns the
 * same execution. Nothing is sent here; the executor re-checks everything under lock before its marker.
 */
export async function enqueueApprovedCaseReply(input: Readonly<{
  validationId: string; policy: Readonly<{ id: string; hash: string }>; note?: CaseEffectNote; deps: CaseReplyStoreDeps;
  /** SAV-92 (16/11): the note is the reply's summary, derived from the case by the caller. An execution that already exists is returned as it is (sealed with
   * or without a note, e.g. queued before the summary existed): the note never makes a replay refuse, and a sealed payload is never rewritten. */
  derivedNote?: boolean;
}>): Promise<EnqueueCaseReplyResult> {
  const { validationId, policy, note, deps } = input;
  if (!isSupervised(deps)) return refuse("effects_off");
  if (note && (!/^[A-Za-z0-9._@<>=+:-]{1,200}$/.test(note.interactionId) || !note.text.trim() || !Number.isFinite(Date.parse(note.at)))) return refuse("note_invalid");
  // The CRM owner NOW, before an execution exists (outside the transaction; the case of a validation never changes, so it is read unlocked and minimal, nothing decrypted).
  const [named] = await requireDb().select({ caseId: savCaseReplyValidations.caseId }).from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId));
  if (!named) return refuse("unknown");
  const owner = await judgeCurrentTicketOwner(deps.readTicketOwner, await readCaseTicketId(named.caseId));
  if (!owner.ok) return refuse(owner.code);
  // Pilot: the provenance is judged again, outside the transaction: an approved reply whose scope or source changed since is not queued.
  if (deps.pilotProvenance) {
    const [stored] = await requireDb().select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId));
    const unproven = stored ? await deps.pilotProvenance(proposalOf(stored), { basis: stored.authorizationBasis }) : null;
    if (unproven) return refuse("provenance_unproven", unproven);
  }
  return requireDb().transaction(async (tx): Promise<EnqueueCaseReplyResult> => {
    // The case of a validation never changes (the table's guard): read it unlocked, lock the case, then the validation (see the lock order above).
    const [known] = await tx.select({ caseId: savCaseReplyValidations.caseId }).from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId));
    if (!known) return refuse("unknown");
    await lockCase(tx, known.caseId);
    const [row] = await tx.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, validationId)).for("update");
    if (!row) return refuse("unknown");
    if (row.state !== "approved") return refuse("not_approved", row.state);
    if (row.executionId) {
      const [execution] = await tx.select().from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, row.executionId));
      const sealed = execution ? decryptSavPayload<CaseEffectPayload>(execution.payloadCiphertext) : null;
      if (!execution || (!input.derivedNote && sha(sealed?.note ?? null) !== sha(note ?? null))) return refuse("trigger_already_planned");
      return { ok: true, executionId: row.executionId, created: false };
    }
    const proposal = proposalOf(row);
    if (isTerminalReply(proposal.purpose) && !closingHandoffReplyEnabled(deps.env())) return refuse("effects_off");
    // The last fence before an execution exists also re-reads the text: an approval stored before the contract is never queued (nothing is planned, hashed or sent for it).
    { const notFinal = caseReplyTextProblemForBasis(proposal.text, row.authorizationBasis); if (notFinal) return refuse("proposal_invalid", notFinal); }
    // B-7: the last fence before an execution exists. A situation that another approved reply already queued (or sent) is never queued a second time, even if a database
    // written before the guard holds two approvals for it.
    if (await findCaseReplySituationTaker(tx, { caseId: row.caseId, replyKey: row.replyKey, triggerEventId: proposal.triggerEventId, scope: "queue" })) return refuse("situation_already_answered");
    const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, proposal.inboundMessageId));
    const [thread] = message ? await tx.select().from(savThreads).where(eq(savThreads.id, message.threadId)) : [undefined];
    const [mailbox] = thread ? await tx.select({ email: savMailboxes.email }).from(savMailboxes).where(eq(savMailboxes.id, thread.mailboxId)) : [undefined];
    if (!message || !thread || !mailbox) return refuse("inbound_unknown");
    const headers = (decryptSavPayload<{ headers?: Record<string, string> }>(message.bodyCiphertext).headers) ?? {};
    const priorRfcMessageId = headers["message-id"];
    if (!priorRfcMessageId) return refuse("context_unreadable");
    const context: CaseReplyContext = {
      mailboxEmail: mailbox.email, gmailThreadId: thread.gmailThreadId, priorRfcMessageId, ...(headers.references ? { priorReferences: headers.references } : {}), inboundFromEmail: message.fromEmail,
    };
    const payload: CaseEffectPayload = { validationId, proposal, context, ...(note ? { note } : {}) };
    const [created] = await tx.insert(savCaseEffectExecutions).values({
      caseId: row.caseId, replyKey: row.replyKey, threadId: thread.id, policyId: policy.id, policyHash: policy.hash, payloadCiphertext: encryptSavPayload(payload),
    }).onConflictDoNothing().returning({ id: savCaseEffectExecutions.id });
    // Another validation of the same trigger already holds the key: a key whose ledger row may exist is never reused.
    if (!created) return refuse("trigger_already_planned");
    await tx.update(savCaseReplyValidations).set({ executionId: created.id }).where(eq(savCaseReplyValidations.id, validationId));
    await executionJournal(tx, created.id, "case_effect_admitted", { replyKey: row.replyKey, validationId, payloadHash: row.payloadHash, approvedBy: row.decidedBy, caseVersion: row.caseVersion });
    return { ok: true, executionId: created.id, created: true };
  });
}
