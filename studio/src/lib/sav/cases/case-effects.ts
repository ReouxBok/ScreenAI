// SAV-10 (pole C): `reply_send` and `case_note` on the EXISTING executor protocol. This file is the pure part: no database, no clock, no network,
// no executor. It decides WHAT may be dispatched and WHEN it must only be verified or not dispatched at all; the protocol itself
// (planned -> dispatched -> acked -> verify -> confirmed, marker written before the send, no resend from dispatched/acked/uncertain, read-only
// reconciliation) stays in `intake/executor.ts` + `intake/execution-store.ts` and is NOT reimplemented here: there is one executor.
// OFF by default (`SAV_CASE_EFFECTS`). `supervised` only runs an effect that a person validated on its exact payload, case version and recipient.
// Nothing here sends: it names the keys, the permissions, the approval binding and the gate the executor consults before every marker.
import { createHash } from "node:crypto";

/** `auto` is a later phase (V2-8): it is refused, never read as `supervised`. */
export const SAV_CASE_EFFECTS_MODES = ["off", "supervised"] as const;
export type CaseEffectsMode = typeof SAV_CASE_EFFECTS_MODES[number];
export type CaseEffectsModeRead = Readonly<{ mode: CaseEffectsMode; requested: string | null; ignored: "auto_not_available" | "unknown_value" | null }>;

/** Fails closed: a missing, empty, unknown or `auto` value is `off`. Only the exact string `supervised` enables the supervised mode. */
export function readCaseEffectsMode(env: Readonly<Record<string, string | undefined>>): CaseEffectsModeRead {
  const raw = env.SAV_CASE_EFFECTS;
  if (raw === undefined || raw === "") return { mode: "off", requested: null, ignored: null };
  if (raw === "off") return { mode: "off", requested: raw, ignored: null };
  if (raw === "supervised") return { mode: "supervised", requested: raw, ignored: null };
  return { mode: "off", requested: raw.slice(0, 40), ignored: raw === "auto" ? "auto_not_available" : "unknown_value" };
}

/** Each new effect has its OWN permission in the execution policy. `SAV_AGENT_CANNOT_RESOLVE_TICKET` is not lifted by either. */
export const SAV_CASE_EFFECT_PERMISSIONS = { reply: "send_case_reply", note: "append_case_note", handoff: "notify_case_handoff", stage: "set_case_ticket_stage" } as const;
export type CaseEffectPermission = typeof SAV_CASE_EFFECT_PERMISSIONS[keyof typeof SAV_CASE_EFFECT_PERMISSIONS];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PART = /^[A-Za-z0-9._@<>=+:-]{1,200}$/;
const part = (value: string, what: string) => ID_PART.test(value) ? value : (() => { throw new Error(`SAV_CASE_EFFECT_KEY_INVALID:${what}`); })();
const caseIdPart = (value: string) => UUID.test(value) ? value.toLowerCase() : (() => { throw new Error("SAV_CASE_EFFECT_KEY_INVALID:caseId"); })();

/** One reply per (case, triggering event). The trigger of a J2 reminder is its timer (`timer:<timerId>`, the dedupe key of the `timer_fired` event). */
export const caseReplyKey = (caseId: string, triggerEventId: string) => `reply:${caseIdPart(caseId)}:${part(triggerEventId, "triggerEventId")}`;
/** One note per interaction, inbound or outbound. A technical retry of the same event is the same interaction, hence the same key. */
export const caseNoteKey = (caseId: string, interactionId: string) => `note:${caseIdPart(caseId)}:${part(interactionId, "interactionId")}`;
export const caseNoteAssociationKey = (caseId: string, interactionId: string) => `note-association:${caseIdPart(caseId)}:${part(interactionId, "interactionId")}`;
export const j2TriggerEventId = (timerId: string) => `timer:${part(timerId, "timerId")}`;
export const inboundInteractionId = (gmailMessageId: string) => `inbound:${part(gmailMessageId, "gmailMessageId")}`;
/** The interaction of an outbound reply is its own key suffix, so the note of a confirmed reply is derived from the reply, never from a clock. */
export const replyInteractionId = (triggerEventId: string) => `outbound:${part(triggerEventId, "triggerEventId")}`;

export type CaseReplyPurpose = "question" | "answer" | "reminder";
/**
 * What the agent prepared, as the person saw it. Every field that can change the message or its recipient is part of the hash below.
 * `inboundMessageId` is the stored message (not a quoted address) whose sender is the recipient: the last qualified inbound of the thread.
 */
export type CaseReplyProposal = Readonly<{
  caseId: string;
  caseVersion: number;
  triggerEventId: string;
  inboundMessageId: string;
  purpose: CaseReplyPurpose;
  recipient: string;
  subject: string;
  text: string;
  /** Only for `question`: what the question asked for, recorded on the case once the send is confirmed. */
  question?: Readonly<{ id: string; text: string; factKeys: readonly string[] }>;
  /** Only for `answer`: the procedures this reply asks the customer to try, recorded on the case as pending trials once the send is confirmed, and only then. */
  procedures?: readonly CaseReplyProcedure[];
}>;
export type CaseReplyProcedure = Readonly<{ requestId: string; procedure: Readonly<{ knowledgeId: string; contentVersionId: string }> }>;

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);
export const caseEffectHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

const lower = (address: string) => address.trim().toLowerCase();
export const caseReplyPayloadHash = (proposal: CaseReplyProposal) => caseEffectHash({
  caseId: caseIdPart(proposal.caseId), caseVersion: proposal.caseVersion, triggerEventId: proposal.triggerEventId, inboundMessageId: proposal.inboundMessageId,
  purpose: proposal.purpose, recipient: lower(proposal.recipient), subject: proposal.subject, text: proposal.text, question: proposal.question ?? null,
  // Absent from the hash when there is none: a reply sealed without procedures keeps the hash it was approved under.
  procedures: proposal.procedures?.length ? proposal.procedures : undefined,
});

/** What a person validated in the Studio: the exact payload (hash), the case version they saw and the recipient they read. */
export type CaseReplyApproval = Readonly<{
  payloadHash: string; caseVersion: number; recipient: string; approvedBy: string; approvedAt: string;
  /** The persisted authorization basis of the validation row (`case-reply-mode.ts` maps it to the AI mention the text may carry). Absent = the human one. */
  basis?: string;
}>;
export type CaseApprovalCheck = "ok" | "payload_changed" | "version_changed" | "recipient_changed" | "approval_invalid" | "approval_revoked";

/** Fails closed: any difference between what was validated and what would be sent refuses the send. */
export function checkCaseReplyApproval(proposal: CaseReplyProposal, approval: CaseReplyApproval | null | undefined): CaseApprovalCheck {
  if (!approval || !/^[a-f0-9]{64}$/.test(approval.payloadHash) || !Number.isInteger(approval.caseVersion) || !approval.approvedBy || !Number.isFinite(Date.parse(approval.approvedAt))) return "approval_invalid";
  if (approval.payloadHash !== caseReplyPayloadHash(proposal)) return "payload_changed";
  if (approval.caseVersion !== proposal.caseVersion) return "version_changed";
  if (lower(approval.recipient) !== lower(proposal.recipient)) return "recipient_changed";
  return "ok";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The gate the executor consults before writing a marker. It never reads anything: the caller passes the facts it just re-read.
// ---------------------------------------------------------------------------------------------------------------------------------

/** State of THIS effect's ledger row (`sav.intake_effects.state`), or `none` when it is not planned yet. */
export type CaseEffectLedgerState = "none" | "planned" | "dispatched" | "acked" | "uncertain" | "confirmed";

export type CaseEffectLive = Readonly<{
  mode: CaseEffectsMode;
  /** The V2 agent pause AND the intake agent pause: either one not `running` (or unreadable) holds the send. */
  pause: Readonly<{ intake: "running" | "actions_paused" | "fully_paused" | "invalid"; v2: "running" | "actions_paused" | "fully_paused" | "invalid" }>;
  /** The executor's own lease on this execution is still valid. */
  leaseValid: boolean;
  /** `caseAdmissionStatus` of the case re-read now (contract v6): a newer customer input is `input_newer`, a human owner `owner_not_agent`. */
  admission: Readonly<{ admitted: true } | { admitted: false; reason: string }>;
  /** The intent's recipient against the sender of the last qualified inbound of the thread NOW, from the stored message (`caseRecipientCheck`). */
  recipient: "match" | "changed" | "unreadable";
  approval: CaseApprovalCheck;
}>;

export type CaseEffectDecision =
  /** Nothing left to do: a confirmed receipt is never touched again. */
  | Readonly<{ action: "done" }>
  /** A marker or an ack exists: read-only verification, whatever the pause, the owner, the version or the lease say now. */
  | Readonly<{ action: "verify_only" }>
  /** May write the marker and send. */
  | Readonly<{ action: "dispatch" }>
  /** Not now: the effect stays `planned` and is decided again at the next pass (pause, expired lease, policy rotation, off). */
  | Readonly<{ action: "hold"; code: CaseEffectHoldCode }>
  /** Never to be sent: the execution ends refused with this code, the ledger row stays as proof (its key is never reused). */
  | Readonly<{ action: "cancel"; code: CaseEffectCancelCode }>;

export const SAV_CASE_EFFECT_HOLD_CODES = ["effects_off", "paused", "lease_expired", "policy_changed", "recipient_unreadable"] as const;
export type CaseEffectHoldCode = typeof SAV_CASE_EFFECT_HOLD_CODES[number];
export const SAV_CASE_EFFECT_CANCEL_CODES = [
  "approval_invalid", "approval_revoked", "payload_changed", "version_changed", "recipient_changed", "owner_changed", "new_input", "admission_withdrawn",
] as const;
export type CaseEffectCancelCode = typeof SAV_CASE_EFFECT_CANCEL_CODES[number];

/**
 * Order matters and is the contract:
 * 1. a confirmed effect is immutable; 2. any engaged effect (dispatched, acked, uncertain) is verify-only, before every other check
 * (a late pause, owner change, new mail or expired lease never turns a possibly sent mail into a resend or a cancellation);
 * 3. only a planned effect is judged: off/paused/lease HOLD it (nothing is lost), approval/owner/new input/recipient CANCEL it.
 */
export function decideCaseEffect(state: CaseEffectLedgerState, live: CaseEffectLive): CaseEffectDecision {
  if (state === "confirmed") return { action: "done" };
  if (state === "dispatched" || state === "acked" || state === "uncertain") return { action: "verify_only" };
  if (live.mode !== "supervised") return { action: "hold", code: "effects_off" };
  if (live.pause.intake !== "running" || live.pause.v2 !== "running") return { action: "hold", code: "paused" };
  if (!live.leaseValid) return { action: "hold", code: "lease_expired" };
  if (live.approval !== "ok") return { action: "cancel", code: live.approval };
  if (!live.admission.admitted) {
    switch (live.admission.reason) {
      case "owner_not_agent": return { action: "cancel", code: "owner_changed" };
      case "input_newer": return { action: "cancel", code: "new_input" };
      // A policy rotation postpones (a re-evaluation resolves it), like the J2 revalidation: a technical gap never manufactures a cancellation.
      case "policy_changed": return { action: "hold", code: "policy_changed" };
      default: return { action: "cancel", code: "admission_withdrawn" };
    }
  }
  if (live.recipient === "unreadable") return { action: "hold", code: "recipient_unreadable" };
  if (live.recipient === "changed") return { action: "cancel", code: "recipient_changed" };
  return { action: "dispatch" };
}

/** The recipient is the sender of the last qualified inbound as STORED, compared case-insensitively; a quoted or reply-to address is never used. */
export const caseRecipientCheck = (intentRecipient: string, currentSender: string | null): "match" | "changed" | "unreadable" =>
  currentSender === null ? "unreadable" : lower(intentRecipient) === lower(currentSender) ? "match" : "changed";
