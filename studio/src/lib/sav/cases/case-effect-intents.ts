// SAV-10 (pole C): the intents of `reply_send` and `case_note`, in the exact shape the EXISTING executor adapters already dispatch and verify.
// - reply_send has the same fields as `identity_send` (Gmail send in the original thread, byte-exact single text/plain part, verified in the
//   sent mail by Message-ID / thread / recipient / In-Reply-To / References), so `adapters.verify` recognises it unchanged.
// - case_note is the existing two-step HubSpot note (create, then associate to the ticket) under the key `note:<caseId>:<interactionId>`,
//   with its OWN permission: the marker and the rendering are the existing `renderIntakeNote`, so the existing verification applies.
// Pure builders: nothing is read or sent here. A text, a signature or a status that is not confirmed is passed in by the caller, never invented.
import { createHash } from "node:crypto";
import { renderIntakeNote } from "../intake/execution-adapters";
import { assertSavOutboundRecipientAllowed } from "../policy";
import {
  caseNoteAssociationKey, caseNoteKey, caseReplyKey, checkCaseReplyApproval, SAV_CASE_EFFECT_PERMISSIONS,
  type CaseReplyApproval, type CaseReplyProposal,
} from "./case-effects";
import { readCaseReplyDisclosure } from "./case-reply-outbound";
import { caseReplyModeForBasis } from "./case-reply-mode";

const fault = (code: string): never => { throw new Error(`SAV_CASE_EFFECT_${code}`); };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const safeHeader = (value: string) => /[\r\n]/.test(value) ? fault("HEADERS_INVALID") : value;

/** What is read from the stored thread at planning time (never from quoted text). */
export type CaseReplyContext = Readonly<{
  mailboxEmail: string;
  gmailThreadId: string;
  /** RFC Message-ID of the last qualified inbound, from its stored headers. */
  priorRfcMessageId: string;
  priorReferences?: string;
  /** `fromEmail` of that stored inbound message. */
  inboundFromEmail: string;
}>;

export type CaseEffectMeta = Readonly<{
  caseId: string; caseVersion: number; triggerEventId: string; purpose: CaseReplyProposal["purpose"];
  payloadHash: string; approvedBy: string; approvedAt: string; inboundMessageId: string;
}>;

export type CaseReplySendIntent = Readonly<{
  kind: "reply_send"; permission: typeof SAV_CASE_EFFECT_PERMISSIONS.reply; key: string; sourceMessageId: string;
  mailbox: string; threadId: string; recipient: string; text: string; rfcMessageId: string; raw: string; caseEffect: CaseEffectMeta;
}>;

/**
 * The reply, once a person validated THIS payload for THIS case version and recipient. Refuses (throws) on any mismatch, on an address the
 * outbound policy blocks, when the recipient is not the stored sender of the inbound the reply answers, and when the approved text does not carry the
 * AI mention of its approval (a person's validation: "prepared with AI and validated by our team"), exactly once, in the shared outbound format.
 */
export function buildReplySendIntent(proposal: CaseReplyProposal, approval: CaseReplyApproval, context: CaseReplyContext): CaseReplySendIntent {
  const checked = checkCaseReplyApproval(proposal, approval);
  if (checked !== "ok") fault(checked.toUpperCase());
  const recipient = proposal.recipient.trim().toLowerCase();
  if (recipient !== context.inboundFromEmail.trim().toLowerCase()) fault("RECIPIENT_CHANGED");
  assertSavOutboundRecipientAllowed(recipient);
  if (!proposal.text.trim() || !context.priorRfcMessageId || !context.gmailThreadId) fault("INTENT_INCOMPLETE");
  // The approved text is sent as is: it must already carry the AI mention its approval allows (`prepareCaseReplyText`); nothing is appended here.
  const disclosure = readCaseReplyDisclosure(proposal.text);
  if (!disclosure) fault("AI_NOTICE_MISSING");
  if (disclosure!.mode !== caseReplyModeForBasis(approval.basis)) fault("AI_NOTICE_MODE");
  const key = caseReplyKey(proposal.caseId, proposal.triggerEventId);
  const rfcMessageId = `<sav-case-${sha(key)}@studio.limova.ai>`;
  const subject = /^re\s*:/i.test(proposal.subject) ? proposal.subject : `Re: ${proposal.subject}`;
  const raw = [
    `From: ${safeHeader(context.mailboxEmail)}`, `To: ${safeHeader(recipient)}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`, `Message-ID: ${rfcMessageId}`,
    `In-Reply-To: ${safeHeader(context.priorRfcMessageId)}`, `References: ${safeHeader([context.priorReferences, context.priorRfcMessageId].filter(Boolean).join(" "))}`,
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    // RFC 2045 (76 characters per line) and RFC 5322 (998 at most): a whole reply on one base64 line is not valid MIME. The decoded bytes, hence the read-back of the sent text, do not change.
    Buffer.from(proposal.text).toString("base64").replace(/.{76}(?=.)/g, "$&\r\n"),
  ].join("\r\n");
  return {
    kind: "reply_send", permission: SAV_CASE_EFFECT_PERMISSIONS.reply, key, sourceMessageId: proposal.inboundMessageId, mailbox: context.mailboxEmail,
    threadId: context.gmailThreadId, recipient, text: proposal.text, rfcMessageId, raw,
    caseEffect: {
      caseId: proposal.caseId, caseVersion: proposal.caseVersion, triggerEventId: proposal.triggerEventId, purpose: proposal.purpose,
      payloadHash: approval.payloadHash, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, inboundMessageId: proposal.inboundMessageId,
    },
  };
}

export type CaseNoteCreateIntent = Readonly<{
  kind: "note_create"; permission: typeof SAV_CASE_EFFECT_PERMISSIONS.note; key: string; ticketId: string; sourceMessageId: string;
  text: string; marker: string; properties: Readonly<{ hs_note_body: string; hs_timestamp: string }>;
}>;
export type CaseNoteAssociateIntent = Readonly<{
  kind: "note_associate"; permission: typeof SAV_CASE_EFFECT_PERMISSIONS.note; key: string; ticketId: string; sourceMessageId: string; objectId: string;
  expectedProperties: Readonly<{ hs_note_body: string; hs_timestamp: string }>; confirmedNoteCreate: Readonly<{ effectId: string; objectId: string }>;
}>;

/**
 * The note of ONE interaction (an inbound mail, or an outbound reply once confirmed). The key is the interaction's, so a technical retry, a
 * second reveil or a recovery of the same event resolves to the same ledger row and never to a second HubSpot note.
 */
export function buildCaseNoteIntent(input: Readonly<{
  caseId: string; interactionId: string; ticketId: string; sourceMessageId: string; text: string; at: string;
}>): CaseNoteCreateIntent {
  if (!/^\d{1,30}$/.test(input.ticketId) || !input.text.trim() || !Number.isFinite(Date.parse(input.at))) fault("NOTE_INVALID");
  const key = caseNoteKey(input.caseId, input.interactionId), marker = sha(key);
  return {
    kind: "note_create", permission: SAV_CASE_EFFECT_PERMISSIONS.note, key, ticketId: input.ticketId, sourceMessageId: input.sourceMessageId, text: input.text, marker,
    properties: { hs_note_body: renderIntakeNote(input.text, marker), hs_timestamp: input.at },
  };
}

/** Second step, built from the CONFIRMED creation only (its object id and the exact properties that were verified). */
export function buildCaseNoteAssociateIntent(input: Readonly<{ caseId: string; interactionId: string; created: CaseNoteCreateIntent; createEffectId: string; objectId: string }>): CaseNoteAssociateIntent {
  if (!/^\d{1,30}$/.test(input.objectId)) fault("NOTE_ACK_INVALID");
  return {
    kind: "note_associate", permission: SAV_CASE_EFFECT_PERMISSIONS.note, key: caseNoteAssociationKey(input.caseId, input.interactionId), ticketId: input.created.ticketId,
    sourceMessageId: input.created.sourceMessageId, objectId: input.objectId, expectedProperties: input.created.properties,
    confirmedNoteCreate: { effectId: input.createEffectId, objectId: input.objectId },
  };
}
