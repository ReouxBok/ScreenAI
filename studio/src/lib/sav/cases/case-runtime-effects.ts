// SAV-10 (pole C): the INJECTABLE entrypoints that join the pieces already written — a stored draft, the shared AI-mention finalizer, the durable validation, the ONE
// executor and its recovery — without adding a route, a cron, an approval or a second executor. LOCAL / OFF: nothing here is called by production code, every provider
// port is handed in by the caller (there is no default transport), and every refusal is the default.
//   proposeCaseReplyFromDraft   stored thread + B's draft + a stated language  -> final text (mention BEFORE the hash) -> `submitCaseReplyProposal`
//   queueValidatedCaseReply     only a validation that carries a real decision (state, decider, date, authorization basis) -> `enqueueApprovedCaseReply`
//   runCaseEffectsPass          verification-only recovery first, then the supervised `executeIntakePass` over what is left; pauses and mode checked before any read
//   listCaseEffectsNeedingPerson  read-only: effects that reached the 5-read ceiling (nothing resets them, nothing replays them)
//   describeCaseReplyForReview  the UX read model, behind an access check that runs BEFORE anything is decrypted
// This file never writes a validation, never decides, never sends, never marks, never resets a counter.
import "server-only";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, notExists, notInArray, notLike, or, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savCases, savIntakeEffects, savMessages } from "@/db/schema";
import { readSavAgentPause, savAgentPauseCode, type SavAgentPauseState } from "../intake/agent-pause";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import type { ExecutionOptions, ExecutorAdapters } from "../intake/execution-types";
import { executeIntakePass } from "../intake/executor";
import { savIntakeRuntimeConfig } from "../intake/runtime-contract";
import { HANDOFF_NOTICE_KEY_PREFIX } from "./case-handoff-notice";
import { TICKET_STAGE_KEY_PREFIX } from "./case-ticket-stage";
import { createCaseEffectDriver, ownerBeforeClaim, type CaseEffectDriverDeps } from "./case-effect-driver";
import { caseEffectSchemaInstalled, recoverCaseEffects, type CaseEffectRecoveryResult } from "./case-effect-recovery";
import { caseReplyPayloadHash, readCaseEffectsMode, type CaseReplyProposal } from "./case-effects";
import { CASE_VERIFICATION_READ_LIMIT, classifyEffectVerification } from "./case-effect-verification";
import { finalizeCaseReplyProposal, prepareCaseReplyText, readCaseReplyDisclosure, type CaseReplyLanguage } from "./case-reply-outbound";
import { getCaseReplyEffect, type CaseReplyView } from "./case-reply-registry";
import { enqueueApprovedCaseReply, submitCaseReplyProposal, type CaseEffectNote, type CaseReplyStoreDeps, type EnqueueCaseReplyResult } from "./case-reply-store";
import { savCaseReplyValidations } from "./case-reply-validation-table";
import type { CaseDecisionReplyDraft } from "./investigation-intent";

export const CASE_RUNTIME_EFFECTS_CONTRACT = "sav-v2-runtime-effects.v1";

const lower = (value: string) => value.trim().toLowerCase();
const code = (error: unknown) => (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 160);

// ---------------------------------------------------------------------------------------------------------------------------------
// Draft -> final proposal -> durable validation (stored, never approved here)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The language of the customer's mail, as the CALLER states it. Nothing here guesses it from the text (no keyword heuristic): `fr` / `en` count only when `proven`
 * (a source the caller can name); `unknown`, or `fr` / `en` that is not proven, take the existing fallback of the shared format (the footer reads French); any other
 * language needs a person to write the reply (`language_human_required`, like the V1 manual path).
 */
export type CaseReplyLanguageInput = Readonly<{ code: string; proven: boolean }>;
export type CaseReplyLanguageUsed = Readonly<{ language: CaseReplyLanguage | "unknown"; proof: "proven" | "fallback" }>;

export function resolveCaseReplyLanguage(input: CaseReplyLanguageInput | null | undefined): CaseReplyLanguageUsed | null {
  if (!input || typeof input.code !== "string") return { language: "unknown", proof: "fallback" };
  if (input.code === "fr" || input.code === "en") return input.proven === true ? { language: input.code, proof: "proven" } : { language: "unknown", proof: "fallback" };
  if (input.code === "unknown") return { language: "unknown", proof: "fallback" };
  return null;
}

export type CaseReplyDraftInput = Readonly<{
  caseId: string;
  /** `CaseDecisionDraft.triggerEventId`: canonical `inbound:<Gmail id>` of the STORED customer mail the reply answers; null when none. */
  triggerEventId: string | null;
  /** `CaseDecisionDraft.decidedOn`: the case version the decision was recorded on. */
  decidedOn: number;
  /** `CaseDecisionDraft.reply`: purpose, text and question are all B decides; null when the decision has no reply C can send. */
  reply: CaseDecisionReplyDraft | null;
  language: CaseReplyLanguageInput | null;
  /**
   * The FORMAT of the mention, never a right. `human` (default, the old behaviour) prepares the "validated by our team" mention; `automated` prepares the "sent automatically"
   * mention. The right to send under either is the persisted authorization basis written by `decideCaseReply` (`case-reply-mode.ts`); this field grants nothing and the
   * proposal stays `proposed`. Any other value is refused (`validation_invalid`): there is one word for it, `automated`.
   */
  validation?: "human" | "automated";
}>;

export type ProposeCaseReplyRefusal =
  | "no_reply" | "inbound_unknown" | "trigger_not_inbound" | "language_human_required" | "inbound_not_in_case" | "case_unknown" | "recipient_unreadable"
  | (string & {}); // the store's own refusal codes (effects_off, not_admitted, new_input, proposal_invalid, situation_already_answered, ...)
export type ProposeCaseReplyResult =
  | Readonly<{
    ok: true; validationId: string; created: boolean; state: string; payloadHash: string; caseVersion: number; recipient: string;
    /** What the language of the mention rests on, for the person who validates; it is returned, not stored (no column for it). */
    language: CaseReplyLanguageUsed;
  }>
  | Readonly<{ ok: false; code: ProposeCaseReplyRefusal; detail?: string }>;

const no = (refusal: ProposeCaseReplyRefusal, detail?: string): ProposeCaseReplyResult => ({ ok: false, code: refusal, ...(detail ? { detail } : {}) });

/**
 * Completes B's draft from the STORED thread (never from the model): the recipient is the stored sender of the answered mail, the subject is its stored subject, the
 * message is the stored one. The text is finalized (AI mention, once) BEFORE it is hashed, then submitted. The result is a `proposed` validation: this function
 * cannot approve, and the default store authorizer refuses every approval.
 */
export async function proposeCaseReplyFromDraft(input: CaseReplyDraftInput, deps: CaseReplyStoreDeps): Promise<ProposeCaseReplyResult> {
  if (!input.reply) return no("no_reply");
  if (!input.triggerEventId) return no("inbound_unknown");
  if (!input.triggerEventId.startsWith("inbound:")) return no("trigger_not_inbound");
  if (input.validation !== undefined && input.validation !== "human" && input.validation !== "automated") return no("validation_invalid", String(input.validation).slice(0, 20));
  const language = resolveCaseReplyLanguage(input.language);
  if (!language) return no("language_human_required", String(input.language?.code).slice(0, 20));
  const gmailMessageId = input.triggerEventId.slice("inbound:".length);
  const db = requireDb();
  const [owner] = await db.select({ threadIds: savCases.threadIds }).from(savCases).where(eq(savCases.id, input.caseId));
  if (!owner) return no("case_unknown");
  // The mail is looked up INSIDE the case's threads: the same Gmail id in another mailbox can never be taken for it.
  if (!owner.threadIds.length) return no("inbound_not_in_case");
  const [message] = await db.select({ id: savMessages.id, threadId: savMessages.threadId, direction: savMessages.direction, fromEmail: savMessages.fromEmail, subject: savMessages.subject })
    .from(savMessages).where(and(eq(savMessages.gmailMessageId, gmailMessageId), inArray(savMessages.threadId, owner.threadIds), eq(savMessages.direction, "inbound")));
  if (!message) return no("inbound_not_in_case");
  if (!message.fromEmail?.trim()) return no("recipient_unreadable");
  const draft: Omit<CaseReplyProposal, "text"> & { text: string } = {
    caseId: input.caseId, caseVersion: input.decidedOn, triggerEventId: input.triggerEventId, inboundMessageId: message.id, purpose: input.reply.purpose,
    recipient: lower(message.fromEmail), subject: message.subject ?? "", text: input.reply.text,
    ...(input.reply.question ? { question: { id: input.reply.question.id, text: input.reply.question.text, factKeys: [...input.reply.question.factKeys] } } : {}),
    ...(input.reply.procedures?.length ? { procedures: input.reply.procedures } : {}),
  };
  // `automated` is formatting only: the shared preparer is called with the mode (UX's guidance), not the human-only finalizer. No right comes out of it.
  const proposal = input.validation === "automated" ? { ...draft, text: prepareCaseReplyText(draft.text, language.language, "automated") } : finalizeCaseReplyProposal(draft, { language: language.language, validation: "human" });
  const submitted = await submitCaseReplyProposal(proposal, deps);
  if (!submitted.ok) return no(submitted.code, submitted.detail);
  return { ok: true, validationId: submitted.id, created: submitted.created, state: submitted.state, payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient, language };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Queue: only a validation that carries a real decision
// ---------------------------------------------------------------------------------------------------------------------------------

export type QueueValidatedCaseReplyResult = EnqueueCaseReplyResult | Readonly<{ ok: false; code: "not_validated" | "unknown"; detail?: string }>;

/**
 * The execution is created from a validation row that a person's decision wrote: `approved`, with the decider, the decision date and the authorization basis the
 * injected authorizer returned. A row without them (written by hand, or by an older path) is never queued, whatever its state says. The columns are read WITHOUT
 * decrypting anything; `enqueueApprovedCaseReply` then re-reads the stored proposal under its own locks.
 */
export async function queueValidatedCaseReply(input: Readonly<{
  validationId: string; policy: Readonly<{ id: string; hash: string }>; note?: CaseEffectNote; deps: CaseReplyStoreDeps;
}>): Promise<QueueValidatedCaseReplyResult> {
  const t = savCaseReplyValidations;
  const [row] = await requireDb().select({ state: t.state, decidedBy: t.decidedBy, decidedAt: t.decidedAt, basis: t.authorizationBasis }).from(t).where(eq(t.id, input.validationId));
  if (!row) return { ok: false, code: "unknown" };
  if (row.state !== "approved" || !row.decidedBy || !row.decidedAt || !row.basis?.trim()) return { ok: false, code: "not_validated", detail: row.state };
  return enqueueApprovedCaseReply({ validationId: input.validationId, policy: input.policy, ...(input.note ? { note: input.note } : {}), deps: input.deps });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------------------------------------------------------------

export type CaseRuntimeDeps = CaseEffectDriverDeps & Readonly<{
  /** The provider ports. REQUIRED: there is no default transport here, so nothing can reach a real provider by omission. Verification-only work receives `verify` alone. */
  adapters: ExecutorAdapters;
  deadlineMs: number;
  /** Tests inject the runtime pins / policy the V1 environment would provide; by default they are read like the ledger's own recovery. */
  context?: Pick<ExecutionOptions, "runtime" | "policy">;
  schemaInstalled?: () => Promise<boolean>;
  /** Executions handled per list per call. Default 3, at most 5. */
  limit?: number;
}>;

export type CaseEffectNeedingPerson = Readonly<{
  executionId: string; caseId: string; replyKey: string; effectKey: string; effectState: string; reconcileAttempts: number; dispatchedAt: string | null;
}>;
export type CaseRuntimePassResult = Readonly<{
  /** Set when nothing was read or written because a guard refused (mode, config, schema, pause). */
  skipped: string | null;
  /** Verification-only passes (an engaged effect that is due, or a confirmed reply whose finish never ran). */
  recovery: readonly CaseEffectRecoveryResult[];
  /** Supervised passes over executions with no engaged effect. The state is read back from the ledger, never from the executor's return value. */
  supervised: readonly Readonly<{ executionId: string; state: string; reason: string | null }>[];
  /** Set when the supervised part did not run at all: no owner port was provided (verification-only work above still ran). */
  supervisedSkipped?: string;
  /** Effects that reached the 5-read ceiling. Informational: no code resets, releases or replays them. */
  needsPerson: readonly CaseEffectNeedingPerson[];
}>;

const ENGAGED = ["dispatched", "acked", "uncertain"] as const;
const TERMINAL = ["confirmed", "refused"] as const;
const NONE: CaseRuntimePassResult = { skipped: null, recovery: [], supervised: [], needsPerson: [] };
const skip = (reason: string): CaseRuntimePassResult => ({ ...NONE, skipped: reason });
const notRunning = (state: SavAgentPauseState) => state.invalid || state.level !== "running";
const fullyPaused = (state: SavAgentPauseState) => state.invalid || state.level === "fully_paused";

/** Executions an engaged effect of which reached the 5-read ceiling. Nothing here changes a row. */
export async function listCaseEffectsNeedingPerson(limit = 20): Promise<CaseEffectNeedingPerson[]> {
  const rows = await requireDb().select({
    executionId: savCaseEffectExecutions.id, caseId: savCaseEffectExecutions.caseId, replyKey: savCaseEffectExecutions.replyKey, effectKey: savIntakeEffects.businessKey,
    effectState: savIntakeEffects.state, reconcileAttempts: savIntakeEffects.reconcileAttempts, dispatchedAt: savIntakeEffects.dispatchedAt,
  }).from(savCaseEffectExecutions).innerJoin(savIntakeEffects, eq(savIntakeEffects.executionId, savCaseEffectExecutions.id))
    .where(and(notInArray(savCaseEffectExecutions.state, [...TERMINAL]), inArray(savIntakeEffects.state, [...ENGAGED]), isNotNull(savIntakeEffects.dispatchedAt), gte(savIntakeEffects.reconcileAttempts, CASE_VERIFICATION_READ_LIMIT)))
    .orderBy(asc(savCaseEffectExecutions.updatedAt), asc(savCaseEffectExecutions.id)).limit(Math.min(Math.max(Math.trunc(limit), 1), 50));
  return rows.map(row => ({ ...row, dispatchedAt: row.dispatchedAt ? row.dispatchedAt.toISOString() : null }));
}

/**
 * Supervised work: open executions with NO engaged effect (an engaged one is verification-only, or waits for a person at the ceiling), lease free or expired, oldest
 * first. The "no engaged effect" test is part of the query, not a filter on a short list: executions stuck at the ceiling can never fill the window and starve new work.
 */
async function pendingSupervisedExecutions(limit: number, skipIds: ReadonlySet<string>, now = new Date()): Promise<string[]> {
  const db = requireDb(), e = savCaseEffectExecutions;
  const rows = await db.select({ id: e.id }).from(e).where(and(
    inArray(e.state, ["pending", "running", "waiting", "uncertain"]), or(isNull(e.leaseUntil), lte(e.leaseUntil, now)),
    notLike(e.replyKey, `${HANDOFF_NOTICE_KEY_PREFIX}%`), // a handoff notice has its own pass (`case-handoff-notice-store.ts`)
    notLike(e.replyKey, `${TICKET_STAGE_KEY_PREFIX}%`), // so has a ticket stage (`case-ticket-stage-store.ts`)
    notExists(db.select({ one: sql`1` }).from(savIntakeEffects).where(and(eq(savIntakeEffects.executionId, e.id), inArray(savIntakeEffects.state, [...ENGAGED])))),
  )).orderBy(asc(e.updatedAt), asc(e.id)).limit(Math.min(limit + skipIds.size, 25));
  return rows.map(row => row.id).filter(id => !skipIds.has(id)).slice(0, limit);
}

/**
 * ONE pass over the case effects, on the ONE executor. Order: guards, then verification-only work, then the supervised pass.
 *  - guards, before any table of the ledger is read: `SAV_CASE_EFFECTS=supervised`; the V1 execution config; the schema; the intake agent running (any other level, or an
 *    unreadable state, skips the whole pass: no provider is called, not even to read); the V2 agent not fully paused (an actions pause still lets a mail that left be
 *    verified and recorded; it holds every planned send at the gate);
 *  - verification-only (`recoverCaseEffects`): receives `verify` and nothing else; it also finishes a reply that is already confirmed (event / question / J2) without
 *    any send; an effect at the 5-read ceiling is not touched and is reported in `needsPerson`;
 *  - supervised (`executeIntakePass` + `createCaseEffectDriver`): every gate of the driver applies at each marker; an uncertain result is verified, never resent.
 * Nothing is approved here, nothing is reset, no marker is written outside the executor.
 */
export async function runCaseEffectsPass(deps: CaseRuntimeDeps): Promise<CaseRuntimePassResult> {
  const env = deps.env();
  if (readCaseEffectsMode(env).mode !== "supervised") return skip("effects_off");
  let config: ReturnType<typeof intakeExecutionConfig>;
  try { config = intakeExecutionConfig(env); } catch (error) { return skip(code(error)); }
  if (!config) return skip("execution_off");
  if (!await (deps.schemaInstalled ?? caseEffectSchemaInstalled)()) return skip("schema_absent");
  const db = requireDb();
  const [intake, v2] = [await readSavAgentPause(db, "intake"), await readSavAgentPause(db, "v2")];
  if (notRunning(intake)) return skip(savAgentPauseCode(intake) ?? "intake_paused");
  if (fullyPaused(v2)) return skip(savAgentPauseCode(v2) ?? "v2_paused");
  let context = deps.context;
  if (!context) {
    let runtime: ReturnType<typeof savIntakeRuntimeConfig>;
    try { runtime = savIntakeRuntimeConfig(env); } catch (error) { return skip(code(error)); }
    if (!runtime) return skip("observation_required");
    try { context = { runtime, policy: (await readIntakeExecutionAuthority(config)).policy }; } catch (error) { return skip(code(error)); }
  }
  const limit = Math.min(Math.max(Math.trunc(deps.limit ?? 3), 1), 5);

  const recovery: CaseEffectRecoveryResult[] = [], touched = new Set<string>();
  for (let n = 0; n < limit; n++) {
    if (n > 0 && Date.now() >= deps.deadlineMs) break; // the budget is spent: the next pass continues, each execution keeps its own schedule
    const result = await recoverCaseEffects({ ...deps, adapters: { verify: deps.adapters.verify }, context });
    // "nothing due" is reported once, when it is the whole answer; after a processed execution it is only the end of the loop.
    if (!("executionId" in result)) { if (!recovery.length) recovery.push(result); break; }
    recovery.push(result);
    if (touched.has(result.executionId)) break; // the same execution came back: it waits for its schedule
    touched.add(result.executionId);
  }

  const supervised: { executionId: string; state: string; reason: string | null }[] = [];
  // NEW work needs the current CRM owner: without the port nothing new starts (the verification above does not need it and has already run).
  if (typeof deps.readTicketOwner !== "function") return { skipped: null, recovery, supervised, supervisedSkipped: "owner_port_absent", needsPerson: await listCaseEffectsNeedingPerson() };
  for (const executionId of await pendingSupervisedExecutions(limit, touched)) {
    if (Date.now() >= deps.deadlineMs) break; // no NEW send is started past the budget; a marker already written is only verified by the next pass
    // Before the claim (which decrypts the sealed payload): the ticket's current owner, from minimal identifiers. A refusal skips this execution; a person owning the ticket ends it.
    const owner = await ownerBeforeClaim(executionId, deps.readTicketOwner);
    if (!owner.ok) { supervised.push({ executionId, state: owner.ended ? "refused" : "skipped", reason: owner.ended ? "SAV_CASE_EFFECT_CANCELLED_OWNER_HUMAN" : `SAV_CASE_EFFECT_HOLD_${owner.code.toUpperCase()}` }); continue; }
    const options: ExecutionOptions = { config, ...context, env: deps.env, adapters: deps.adapters, signal: AbortSignal.timeout(Math.max(1, deps.deadlineMs - Date.now())) };
    await executeIntakePass(executionId, options, {}, createCaseEffectDriver(deps));
    const [row] = await db.select({ state: savCaseEffectExecutions.state, reason: savCaseEffectExecutions.reason }).from(savCaseEffectExecutions).where(eq(savCaseEffectExecutions.id, executionId));
    supervised.push({ executionId, state: row?.state ?? "unknown", reason: row?.reason ?? null });
  }
  return { skipped: null, recovery, supervised, needsPerson: await listCaseEffectsNeedingPerson() };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Review read model (UX): access first, then the existing registry read
// ---------------------------------------------------------------------------------------------------------------------------------

export type CaseReplyReviewView = CaseReplyView & Readonly<{
  /** What the stored text itself declares (mode and language of the mention), `null` for a text that does not carry the contract. */
  disclosure: ReturnType<typeof readCaseReplyDisclosure>;
  /** An engaged effect reached the 5-read ceiling: a person must look; no action of this system resets it. */
  needsPerson: boolean;
}>;

/**
 * `access` is the server-side check of the CALLER'S context (the route's staff check, injected); it is awaited BEFORE the registry is asked for the reply, so nothing is
 * decrypted for a caller it refuses. Absent, it denies. It is never a value taken from a request.
 */
export async function describeCaseReplyForReview(input: Readonly<{
  validationId: string; caseId?: string; access?: (() => Promise<boolean> | boolean) | undefined;
  env: () => Record<string, string | undefined>; read?: typeof getCaseReplyEffect;
}>): Promise<Readonly<{ ok: true; view: CaseReplyReviewView }> | Readonly<{ ok: false; code: "access_denied" | "unknown" }>> {
  let allowed = false;
  try { allowed = input.access ? await input.access() === true : false; } catch { allowed = false; }
  if (!allowed) return { ok: false, code: "access_denied" };
  const view = await (input.read ?? getCaseReplyEffect)({ validationId: input.validationId, ...(input.caseId ? { caseId: input.caseId } : {}) }, { env: input.env });
  if (!view) return { ok: false, code: "unknown" };
  const reply = view.effect?.reply;
  return { ok: true, view: { ...view, disclosure: readCaseReplyDisclosure(view.proposal.text),
    // The scheduler's own rule (`case-effect-verification.ts`): open parent, engaged effect, marker present, limit reached.
    needsPerson: Boolean(reply && view.effect && classifyEffectVerification({ executionState: view.effect.executionState, effectState: reply.state, dispatchedAt: reply.dispatchedAt, reconcileAttempts: reply.reconcileAttempts }) === "needs_person") } };
}
