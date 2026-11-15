// SAV-92 (audit Fable n°8): a Studio administrator approves, corrects or declines a V2 reply that waits for a person (draft block, automatic reply off, ...).
// Nothing new sends anything: the decision is pole C's `decideCaseReply`, the queue its `queueValidatedCaseReply`, the send its ONE executor (immediate pass on that
// execution only, or the catch-up). So the guarantees are the registry's: one reply per mail (`trigger_already_approved`, one execution per reply key), an approval
// bound to the exact payload / version / recipient, an uncertain effect verified and never resent. What this file adds:
//   - a version token: what the screen showed (validation, payload hash, CASE version). Anything that moved since refuses, nothing is written or sent;
//   - the guards a person's send must pass on top of the registry's: sensitive case, pauses, block switch, case owner (local and CRM), execution policy;
//   - a corrected text goes through the automatic path's text rules (`caseReplyTextSafetyProblems`) and the store's contract (AI mention) before any row exists;
//   - a decline records the refusal and hands the case to the team (owner transition `handoff`), with the reason in the audit log only;
//   - an audit row per decision (who, when, what) and console logs with identifiers only.
import "server-only";
import { eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { readSavAgentPause, savAgentPauseCode } from "../intake/agent-pause";
import { intakeExecutionConfig } from "../intake/execution-policy";
import { readSavBlockSwitch, savBlockReplyGate } from "./block-switch";
import { caseReplyPayloadHash, readCaseEffectsMode, type CaseReplyProposal } from "./case-effects";
import { finalizeCaseReplyProposal, readCaseReplyDisclosure } from "./case-reply-outbound";
import { decideCaseReply, submitCaseReplyProposal, type CaseReplyStoreDeps } from "./case-reply-store";
import { savCaseReplyValidations } from "./case-reply-validation-table";
import { CASE_REPLY_STUDIO_APPROVAL_BASIS, CASE_REPLY_STUDIO_CORRECTION_BASIS, type CaseReplyAuthorizer, type CaseReplyDecisionAction } from "./case-reply-validation";
import { queueValidatedCaseReply } from "./case-runtime-effects";
import { listCaseEvents, readCase, transitionCaseOwner } from "./case-store";
import { judgeCurrentTicketOwner } from "./case-ticket-owner";
import { CASE_REPLY_REVIEW_TEXT_MAX, caseReplyReviewSensitive, parseCaseReplyReviewToken } from "./case-reply-review-token";
import { caseReplyTextSafetyProblems, type CaseReplyTextSafetyProblem } from "./decision-validator";
import type { ImmediateCaseReplySend } from "./immediate-send-budget";
import { caseStampBlockId } from "./investigation-access-scope";
import { readCaseInvestigationProgress } from "./investigation-record";
import { latestInvestigationInput } from "./investigation-runner";

export const CASE_REPLY_REVIEW_REVISION = "sav-v2-reply-review.v1";
export { encodeCaseReplyReviewToken, parseCaseReplyReviewToken, caseReplyReviewSensitive, CASE_REPLY_REVIEW_TEXT_MAX } from "./case-reply-review-token";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The authorizer of ONE Studio decision: this administrator, this action, this exact payload, one basis. Anything else is refused (C's port then refuses). */
export function studioReviewAuthorizer(expected: Readonly<{ staffUserId: string; action: Exclude<CaseReplyDecisionAction, "revoke">; payloadHash: string; basis: string }>): CaseReplyAuthorizer {
  return request => request.approverId === expected.staffUserId && request.action === expected.action && request.payloadHash === expected.payloadHash
    ? { allowed: true, basis: expected.basis } : { allowed: false, reason: "studio_review_mismatch" };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------------------------------------------

export type CaseReplyReviewAction = "approve" | "correct" | "decline";
export type CaseReplyReviewInput = Readonly<{ action: CaseReplyReviewAction; token: string; text?: string; reason?: string }>;
/** The administrator, as the route's server-side checks resolved them (staff row id, a UUID). Never taken from the request body. */
export type CaseReplyReviewer = Readonly<{ staffUserId: string; email: string }>;
export type CaseReplyReviewDeps = Readonly<{
  env: () => Record<string, string | undefined>;
  /** C's store ports, the CRM owner and the pilot provenance included (the same as the catch-up's). */
  store: CaseReplyStoreDeps;
  /** The immediate send of a NEW queue entry (`sendQueuedCaseReplyNow`); null: the catch-up sends it. */
  sendNow: ImmediateCaseReplySend | null;
  /** When the caller (the route) must be done; the immediate send only starts with a full budget left. */
  callerDeadlineMs: number;
}>;
export type CaseReplyReviewResult =
  | Readonly<{
    ok: true; action: CaseReplyReviewAction; caseId: string; validationId: string;
    /** approve / correct: the execution of the reply (one per mail); `send`: whether this request started the pass on it. */
    executionId?: string; send?: "attempted" | "catch_up";
    /** decline: whether the case was handed to the team. */
    handoff?: "done" | "failed";
  }>
  | Readonly<{
    ok: false; code: string; detail?: string;
    /** correct: the text rules the corrected text broke (nothing was stored). */
    problems?: readonly CaseReplyTextSafetyProblem[];
    /** approve / correct: the decision was recorded but the reply could not be queued (nothing left). */
    approvedValidationId?: string;
  }>;

const no = (code: string, extra: Omit<Extract<CaseReplyReviewResult, { ok: false }>, "ok" | "code"> = {}): CaseReplyReviewResult => ({ ok: false, code, ...extra });
const errorCode = (error: unknown) => (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/[^A-Z0-9_.:-]/gi, "_").slice(0, 120);
const log = (event: Record<string, string | number | boolean | undefined>) => console.info("sav_v2_reply_review", event);

/** The block of the case's latest recorded decision (Access when its stamp names none), as the reply passage reads it. */
async function caseBlockId(caseId: string) {
  const events = await listCaseEvents(caseId), inputKey = latestInvestigationInput(events);
  const read = inputKey ? readCaseInvestigationProgress(events, inputKey) : null;
  return caseStampBlockId(read?.state === "found" ? read.record.decision?.accessScope : undefined);
}

async function audit(reviewer: CaseReplyReviewer, entityId: string, metadata: Record<string, string | number | boolean | null>) {
  await requireDb().insert(auditLogs).values({ actorEmail: reviewer.email, action: "sav_case_reply_review", entityType: "sav_case_reply_validation", entityId, technicalMetadata: { revision: CASE_REPLY_REVIEW_REVISION, ...metadata } });
}

/**
 * One Studio decision on one proposed reply. Every check runs before anything is written; then C's registry decides, queues and sends, re-checking under its locks.
 * A double click or two administrators at once: the second finds the reply decided (`already_decided`) or C's store returns the same approval and execution
 * (`changed: false`, `created: false`), and only a NEW execution starts an immediate pass, so one mail at most.
 */
export async function reviewCaseReply(input: CaseReplyReviewInput, reviewer: CaseReplyReviewer, deps: CaseReplyReviewDeps): Promise<CaseReplyReviewResult> {
  const token = parseCaseReplyReviewToken(input.token);
  if (!token) return no("token_invalid");
  if (!UUID.test(reviewer.staffUserId)) return no("reviewer_invalid");
  if (!["approve", "correct", "decline"].includes(input.action)) return no("action_invalid");
  const env = deps.env();
  if (readCaseEffectsMode(env).mode !== "supervised") return no("effects_off");
  const db = requireDb();
  const [row] = await db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, token.validationId));
  if (!row) return no("unknown");
  const snapshot = await readCase(row.caseId);
  if (!snapshot) return no("unknown");
  const refuse = (code: string, extra: Parameters<typeof no>[1] = {}) => {
    log({ action: input.action, validationId: row.id, caseId: row.caseId, staffUserId: reviewer.staffUserId, outcome: "refused", code });
    return no(code, extra);
  };
  // The token first: a new proposal (superseded), a decision taken elsewhere, a new mail or a takeover since the screen was built.
  if (row.payloadHash !== token.payloadHash) return refuse("payload_changed");
  if (row.state !== "proposed") return refuse("already_decided", { detail: row.state });
  if (snapshot.version !== token.caseVersion) return refuse("case_version_changed");
  if (snapshot.owner !== "agent") return refuse("owner_changed");

  if (input.action === "decline") {
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason.length < 3 || reason.length > 500) return refuse("reason_invalid");
    const decided = await decideCaseReply({ action: "decline", validationId: row.id, approverId: reviewer.staffUserId, expectedCaseVersion: token.caseVersion,
      seen: { payloadHash: row.payloadHash, caseVersion: row.caseVersion, recipient: row.recipient }, deps: deps.store,
      authorizer: studioReviewAuthorizer({ staffUserId: reviewer.staffUserId, action: "decline", payloadHash: row.payloadHash, basis: CASE_REPLY_STUDIO_APPROVAL_BASIS }) });
    if (!decided.ok) return refuse(decided.code, decided.detail ? { detail: decided.detail } : {});
    // The team takes the case. Same version as the decision (a decline writes no case row); a replay of the same command is a no-op.
    let handoff: "done" | "failed" = "done", handoffCode: string | null = null;
    try {
      await transitionCaseOwner({ caseId: row.caseId, expectedVersion: token.caseVersion, transition: "handoff", actor: { type: "human", staffUserId: reviewer.staffUserId },
        commandKey: `studio-reply-decline.${row.id}`, reason: "studio_reply_declined" });
    } catch (error) { handoff = "failed"; handoffCode = errorCode(error); }
    await audit(reviewer, row.id, { decision: "decline", caseId: row.caseId, ticketId: snapshot.ticketId, validationId: row.id, changed: decided.changed, handoff, handoffCode, reason });
    log({ action: "decline", validationId: row.id, caseId: row.caseId, staffUserId: reviewer.staffUserId, outcome: "declined", handoff, ...(handoffCode ? { code: handoffCode } : {}) });
    return { ok: true, action: "decline", caseId: row.caseId, validationId: row.id, handoff };
  }

  // approve / correct: a send. The case must still be the agent's, not sensitive, not paused, its block not off, the CRM ticket still V2's, an execution policy in force.
  if (caseReplyReviewSensitive(snapshot)) return refuse("sensitive");
  for (const agent of ["intake", "v2"] as const) {
    const pause = savAgentPauseCode(await readSavAgentPause(db, agent));
    if (pause) return refuse("paused", { detail: `${agent}:${pause}`.slice(0, 120) });
  }
  let config: ReturnType<typeof intakeExecutionConfig>;
  try { config = intakeExecutionConfig(env); } catch { config = null; }
  if (!config) return refuse("execution_off");
  const blockId = await caseBlockId(row.caseId);
  const gate = savBlockReplyGate(await readSavBlockSwitch(db, blockId));
  if (gate.send === "never") return refuse(gate.code, { detail: blockId });
  const owner = await judgeCurrentTicketOwner(deps.store.readTicketOwner, snapshot.ticketId);
  if (!owner.ok) return refuse(owner.code);

  let validationId = row.id, payloadHash = row.payloadHash, basis = CASE_REPLY_STUDIO_APPROVAL_BASIS, seen = { payloadHash: row.payloadHash, caseVersion: row.caseVersion, recipient: row.recipient };
  if (input.action === "correct") {
    const text = typeof input.text === "string" ? input.text.replace(/\r\n?/g, "\n").trim() : "";
    if (!text) return refuse("text_empty");
    if (text.length > CASE_REPLY_REVIEW_TEXT_MAX) return refuse("text_too_long");
    const original = decryptSavPayload<CaseReplyProposal>(row.proposalCiphertext);
    // The same preparation as the agent's (help line, signature, the "validated by our team" mention, in the original mention's language), before any check or hash.
    let corrected: CaseReplyProposal;
    try { corrected = finalizeCaseReplyProposal({ ...original, text }, { language: readCaseReplyDisclosure(original.text)?.language ?? "unknown", validation: "human" }); }
    catch { return refuse("text_empty"); }
    const accessOpen = snapshot.body.openRequests.some(request => request.status === "open" && request.family === "access");
    const problems = caseReplyTextSafetyProblems(corrected.text, { accessOpen, answersOrAsks: corrected.purpose === "answer" || corrected.purpose === "question" });
    if (problems.length) return refuse("text_refused", { problems });
    if (caseReplyPayloadHash(corrected) !== row.payloadHash) {
      const submitted = await submitCaseReplyProposal(corrected, deps.store, { supersedes: { validationId: row.id, payloadHash: row.payloadHash } });
      if (!submitted.ok) return refuse(submitted.code, submitted.detail ? { detail: submitted.detail } : {});
      const [stored] = await db.select().from(savCaseReplyValidations).where(eq(savCaseReplyValidations.id, submitted.id));
      if (!stored) return refuse("unknown");
      validationId = stored.id; payloadHash = stored.payloadHash; basis = CASE_REPLY_STUDIO_CORRECTION_BASIS;
      seen = { payloadHash: stored.payloadHash, caseVersion: stored.caseVersion, recipient: stored.recipient };
    }
  }
  const decided = await decideCaseReply({ action: "approve", validationId, approverId: reviewer.staffUserId, seen, deps: deps.store, expectedCaseVersion: token.caseVersion,
    authorizer: studioReviewAuthorizer({ staffUserId: reviewer.staffUserId, action: "approve", payloadHash, basis }) });
  if (!decided.ok) return refuse(decided.code, decided.detail ? { detail: decided.detail } : {});
  const queued = await queueValidatedCaseReply({ validationId, policy: { id: config.policyId, hash: config.policyHash }, deps: deps.store });
  await audit(reviewer, row.id, { decision: input.action, caseId: row.caseId, ticketId: snapshot.ticketId, validationId, basis, changed: decided.changed,
    executionId: queued.ok ? queued.executionId : null, queued: queued.ok, queueCode: queued.ok ? null : queued.code });
  if (!queued.ok) return refuse(queued.code, { approvedValidationId: validationId, ...("detail" in queued && queued.detail ? { detail: queued.detail } : {}) });
  // Only the request that CREATED the execution starts the pass on it; a replay leaves it to the pass already running or to the catch-up (never a second send).
  let send: "attempted" | "catch_up" = "catch_up";
  if (queued.created && deps.sendNow) {
    const outcome = await deps.sendNow({ env, executionId: queued.executionId, callerDeadlineMs: deps.callerDeadlineMs }).catch(() => ({ failed: "SAV_V2_IMMEDIATE_SEND_THREW" }));
    send = "pass" in outcome ? "attempted" : "catch_up";
  }
  log({ action: input.action, validationId, originalValidationId: row.id, caseId: row.caseId, staffUserId: reviewer.staffUserId, outcome: "approved", executionId: queued.executionId, created: queued.created, send });
  return { ok: true, action: input.action, caseId: row.caseId, validationId, executionId: queued.executionId, send };
}
