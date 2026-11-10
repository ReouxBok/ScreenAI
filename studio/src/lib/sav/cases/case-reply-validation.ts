// SAV-10 (pole C): the durable human validation of a prepared reply — the pure part (no database, no clock, no network).
// A reply is `proposed` (what the agent prepared, exactly as a person will read it), then `approved` or `declined` by a person, or `superseded` by a newer
// proposal. Approving is not sending: it only records, once, that THIS payload, for THIS case version and THIS recipient, was validated by someone who was
// allowed to. Who is allowed is not decided here: it is a port that DENIES unless it answers an explicit yes (no role is implied by anything else).
import type { CaseApprovalCheck, CaseReplyPurpose } from "./case-effects";

export const SAV_CASE_REPLY_VALIDATION_STATES = ["proposed", "approved", "declined", "superseded", "revoked"] as const;
export type CaseReplyValidationState = typeof SAV_CASE_REPLY_VALIDATION_STATES[number];

/**
 * Only a proposal can be decided; a decision is final (a declined reply is never re-approved, a new proposal is a new row). The one exception is the
 * approval itself, which a person may withdraw until the send has started (the store refuses it once a marker exists).
 */
const NEXT: Readonly<Record<CaseReplyValidationState, readonly CaseReplyValidationState[]>> = {
  proposed: ["approved", "declined", "superseded"], approved: ["revoked"], declined: [], superseded: [], revoked: [],
};
export const canTransitionCaseReplyValidation = (from: CaseReplyValidationState, to: CaseReplyValidationState) => NEXT[from].includes(to);

/** What the person saw when they decided: the hash of the exact payload, the case version and the recipient. All three must still be the stored ones. */
export type CaseReplySeen = Readonly<{ payloadHash: string; caseVersion: number; recipient: string }>;
export function checkCaseReplySeen(stored: CaseReplySeen, seen: CaseReplySeen): CaseApprovalCheck {
  if (!/^[a-f0-9]{64}$/.test(seen.payloadHash) || !Number.isInteger(seen.caseVersion) || typeof seen.recipient !== "string" || !seen.recipient.trim()) return "approval_invalid";
  if (stored.payloadHash !== seen.payloadHash) return "payload_changed";
  if (stored.caseVersion !== seen.caseVersion) return "version_changed";
  if (stored.recipient.trim().toLowerCase() !== seen.recipient.trim().toLowerCase()) return "recipient_changed";
  return "ok";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The authorization port. Default: deny. Nothing here names a role, a mailbox or an environment variable.
// ---------------------------------------------------------------------------------------------------------------------------------

export type CaseReplyDecisionAction = "approve" | "decline" | "revoke";
export type CaseReplyAuthorizationRequest = Readonly<{
  action: CaseReplyDecisionAction;
  /** The staff user id (a UUID), never an email address. */
  approverId: string;
  caseId: string;
  replyKey: string;
  payloadHash: string;
  purpose: CaseReplyPurpose;
}>;
/** The only accepted yes: `allowed` is exactly `true` and `basis` is a short machine tag (what the decision rests on), never a name or an address. */
export type CaseReplyAuthorization = Readonly<{ allowed: true; basis: string }> | Readonly<{ allowed: false; reason?: string }>;
export type CaseReplyAuthorizer = (request: CaseReplyAuthorizationRequest) => Promise<CaseReplyAuthorization> | CaseReplyAuthorization;

export const SAV_CASE_REPLY_REFUSAL_CODES = ["approver_invalid", "authorizer_missing", "authorizer_failed", "decision_absent", "not_authorized"] as const;
export type CaseReplyAuthorizationOutcome = Readonly<{ allowed: true; basis: string }> | Readonly<{ allowed: false; code: typeof SAV_CASE_REPLY_REFUSAL_CODES[number] }>;

/** The port that exists when nobody wired one. */
export const denyAllCaseReplyAuthorizer: CaseReplyAuthorizer = () => ({ allowed: false, reason: "no_authorizer_wired" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASIS = /^[a-z0-9][a-z0-9_.:-]{0,79}$/i;
const AUTHORIZER_TIMEOUT_MS = 5_000;

/**
 * Fails closed on everything that is not an explicit, well-formed yes: no port, a port that throws or hangs, an answer that is missing, malformed,
 * `allowed: "true"`, `allowed: 1`, a `basis` that is empty or not a plain tag, an approver that is not a UUID.
 */
export async function authorizeCaseReplyDecision(authorizer: CaseReplyAuthorizer | null | undefined, request: CaseReplyAuthorizationRequest): Promise<CaseReplyAuthorizationOutcome> {
  if (typeof request.approverId !== "string" || !UUID.test(request.approverId)) return { allowed: false, code: "approver_invalid" };
  if (typeof authorizer !== "function") return { allowed: false, code: "authorizer_missing" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: unknown;
  try {
    answer = await Promise.race([
      Promise.resolve().then(() => authorizer(request)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("SAV_CASE_REPLY_AUTHORIZER_TIMEOUT")), AUTHORIZER_TIMEOUT_MS); }),
    ]);
  } catch { return { allowed: false, code: "authorizer_failed" }; } finally { if (timer) clearTimeout(timer); }
  if (!answer || typeof answer !== "object") return { allowed: false, code: "decision_absent" };
  const decision = answer as { allowed?: unknown; basis?: unknown };
  if (decision.allowed === false) return { allowed: false, code: "not_authorized" };
  if (decision.allowed !== true || typeof decision.basis !== "string" || !BASIS.test(decision.basis)) return { allowed: false, code: "decision_absent" };
  return { allowed: true, basis: decision.basis };
}

/** Whether a person can approve NOW, from the facts the Studio can read; the authorizer still decides WHO, server side, at the moment of the decision. */
export type CaseReplyApprovability = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: "effects_off" | "already_decided" }>;
export function caseReplyApprovability(mode: "off" | "supervised", state: CaseReplyValidationState): CaseReplyApprovability {
  if (mode !== "supervised") return { ok: false, reason: "effects_off" };
  return state === "proposed" ? { ok: true } : { ok: false, reason: "already_decided" };
}
