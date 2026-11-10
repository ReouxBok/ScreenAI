import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntakeExecutorAdapters, renderIntakeNote, type GmailRequest } from "../intake/execution-adapters";
import type { EffectIntent } from "../intake/execution-types";
import { caseNoteAssociationKey, caseNoteKey, caseReplyKey, caseReplyPayloadHash, inboundInteractionId, replyInteractionId, type CaseReplyApproval, type CaseReplyProposal } from "./case-effects";
import { buildCaseNoteAssociateIntent, buildCaseNoteIntent, buildReplySendIntent, type CaseReplyContext } from "./case-effect-intents";
import { prepareCaseReplyText } from "./case-reply-outbound";

const CASE = "10000000-0000-4000-8000-000000000001";
const proposal: CaseReplyProposal = {
  caseId: CASE, caseVersion: 7, triggerEventId: "inbound:gmail-1", inboundMessageId: "20000000-0000-4000-8000-000000000002", purpose: "answer",
  recipient: "customer@example.invalid", subject: "Synthetic connection failure", text: prepareCaseReplyText("SYNTHETIC reply.\nSignature kept exactly.", "fr", "manual_reviewed"),
};
const approval: CaseReplyApproval = { payloadHash: caseReplyPayloadHash(proposal), caseVersion: 7, recipient: "customer@example.invalid", approvedBy: "staff@example.invalid", approvedAt: "2026-10-30T10:00:00.000Z" };
const context: CaseReplyContext = { mailboxEmail: "support@example.invalid", gmailThreadId: "gmail-thread", priorRfcMessageId: "<incoming@example.invalid>", priorReferences: "<older@example.invalid>", inboundFromEmail: "Customer@Example.invalid" };
afterEach(() => { vi.unstubAllEnvs(); });

describe("reply_send intent", () => {
  it("is keyed reply:<caseId>:<trigger>, carries its own permission and the approval it ran under", () => {
    const intent = buildReplySendIntent(proposal, approval, context);
    expect(intent).toMatchObject({
      kind: "reply_send", permission: "send_case_reply", key: caseReplyKey(CASE, "inbound:gmail-1"), sourceMessageId: proposal.inboundMessageId,
      mailbox: "support@example.invalid", threadId: "gmail-thread", recipient: "customer@example.invalid", text: proposal.text,
      caseEffect: { caseId: CASE, caseVersion: 7, triggerEventId: "inbound:gmail-1", purpose: "answer", payloadHash: approval.payloadHash, approvedBy: "staff@example.invalid" },
    });
    expect(intent.rfcMessageId).toMatch(/^<sav-case-[a-f0-9]{64}@studio\.limova\.ai>$/);
  });

  it("is deterministic: the same trigger is the same Message-ID and the same raw mail (a retry cannot differ)", () => {
    expect(buildReplySendIntent(proposal, approval, context)).toEqual(buildReplySendIntent(proposal, approval, context));
  });

  it("answers in the original thread: In-Reply-To and References from the stored inbound, text/plain base64 body", () => {
    const { raw } = buildReplySendIntent(proposal, approval, context);
    const [head, body] = raw.split("\r\n\r\n");
    expect(head).toContain("In-Reply-To: <incoming@example.invalid>");
    expect(head).toContain("References: <older@example.invalid> <incoming@example.invalid>");
    expect(head).toContain("To: customer@example.invalid");
    expect(head).toContain("From: support@example.invalid");
    expect(head).toContain("Subject: =?UTF-8?B?" + Buffer.from("Re: Synthetic connection failure").toString("base64") + "?=");
    expect(Buffer.from(body!, "base64").toString("utf8")).toBe(proposal.text);
  });

  it("refuses a reply that was not validated as it stands: text, version, recipient, or no approval", () => {
    expect(() => buildReplySendIntent({ ...proposal, text: `${proposal.text}!` }, approval, context)).toThrow("SAV_CASE_EFFECT_PAYLOAD_CHANGED");
    expect(() => buildReplySendIntent({ ...proposal, caseVersion: 8 }, { ...approval, payloadHash: caseReplyPayloadHash({ ...proposal, caseVersion: 8 }) }, context)).toThrow("SAV_CASE_EFFECT_VERSION_CHANGED");
    expect(() => buildReplySendIntent(proposal, { ...approval, recipient: "other@example.invalid" }, context)).toThrow("SAV_CASE_EFFECT_RECIPIENT_CHANGED");
    expect(() => buildReplySendIntent(proposal, null as never, context)).toThrow("SAV_CASE_EFFECT_APPROVAL_INVALID");
  });

  it("the recipient is the stored sender of the inbound, never an address that is only quoted or in the text", () => {
    expect(() => buildReplySendIntent(proposal, approval, { ...context, inboundFromEmail: "quoted@example.invalid" })).toThrow("SAV_CASE_EFFECT_RECIPIENT_CHANGED");
  });

  it("refuses header injection, a missing parent Message-ID, an empty text, and an address the outbound policy blocks", () => {
    expect(() => buildReplySendIntent(proposal, approval, { ...context, priorRfcMessageId: "<a@b>\r\nBcc: spy@example.invalid" })).toThrow("SAV_CASE_EFFECT_HEADERS_INVALID");
    expect(() => buildReplySendIntent(proposal, approval, { ...context, mailboxEmail: "x@y\nBcc: z" })).toThrow("SAV_CASE_EFFECT_HEADERS_INVALID");
    expect(() => buildReplySendIntent(proposal, approval, { ...context, priorRfcMessageId: "" })).toThrow("SAV_CASE_EFFECT_INTENT_INCOMPLETE");
    const empty = { ...proposal, text: "  " };
    expect(() => buildReplySendIntent(empty, { ...approval, payloadHash: caseReplyPayloadHash(empty) }, context)).toThrow("SAV_CASE_EFFECT_INTENT_INCOMPLETE");
    vi.stubEnv("SAV_TEST_MODE", "true"); vi.stubEnv("SAV_TEST_OUTBOUND_ALLOWLIST", "someone-else@example.invalid");
    expect(() => buildReplySendIntent(proposal, approval, context)).toThrow("SAV_TEST_OUTBOUND_RECIPIENT_BLOCKED");
  });

  // The existing verification is generic: the mail is found by Message-ID / thread / recipient / In-Reply-To / References and compared byte for byte.
  // Feeding the intent to the REAL adapter (kind presented as the Gmail-send kind it already knows) proves the shape is the one it verifies.
  it("is verified by the existing sent-mail verification, without any send, with or without an ACK", async () => {
    const intent = buildReplySendIntent(proposal, approval, context);
    const dispatchedAt = new Date("2026-10-30T12:00:00Z");
    const header = (name: string) => intent.raw.split("\r\n\r\n")[0]!.split("\r\n").find(line => line.startsWith(`${name}: `))!.slice(name.length + 2);
    const mail = {
      id: "sent-1", threadId: intent.threadId, internalDate: String(dispatchedAt.getTime() + 1000), labelIds: ["SENT"],
      payload: { mimeType: "text/plain", body: { data: Buffer.from(intent.text).toString("base64url") }, headers: [
        { name: "From", value: intent.mailbox }, { name: "To", value: intent.recipient }, { name: "Message-ID", value: "<rewritten@gmail.invalid>" },
        { name: "In-Reply-To", value: header("In-Reply-To") }, { name: "References", value: header("References") },
      ] },
    };
    let writes = 0;
    const gmail: GmailRequest = async <T>(_mailbox: string, path: string, init?: RequestInit) => {
      if (init?.method) { writes += 1; throw new Error("WRITES_FORBIDDEN"); }
      if (path.startsWith("messages?")) return { messages: [] } as T;
      if (path.startsWith("threads/")) return { id: intent.threadId, messages: [{ id: "sent-1", labelIds: ["SENT"] }] } as T;
      return mail as T;
    };
    const adapters = createIntakeExecutorAdapters({ gmailRequest: gmail });
    const asKnownKind = { ...intent, kind: "identity_send", permission: "send_identity_template" } as unknown as EffectIntent;
    for (const ack of [{ id: "sent-1", threadId: intent.threadId }, null]) {
      expect(await adapters.verify(asKnownKind, ack, dispatchedAt, AbortSignal.timeout(1000))).toMatchObject({ confirmed: true, attributed: true, ack: { id: "sent-1" } });
    }
    expect(writes).toBe(0);
    // A different body is not attributed even with an ACK: the intent text is compared byte for byte.
    mail.payload.body.data = Buffer.from("different").toString("base64url");
    expect(await adapters.verify(asKnownKind, { id: "sent-1" }, dispatchedAt, AbortSignal.timeout(1000))).toMatchObject({ confirmed: false, attributed: false });
  });
});

describe("case_note intents: one note per interaction", () => {
  const note = (interactionId: string) => buildCaseNoteIntent({ caseId: CASE, interactionId, ticketId: "12345", sourceMessageId: proposal.inboundMessageId, text: "Synthetic interaction note.", at: "2026-10-30T10:00:00.000Z" });

  it("the key is the interaction's: the same interaction is the same note whatever the retry, another interaction is another note", () => {
    const first = note(inboundInteractionId("gmail-1"));
    expect(first.key).toBe(caseNoteKey(CASE, "inbound:gmail-1"));
    expect(note(inboundInteractionId("gmail-1"))).toEqual(first);
    expect(note(inboundInteractionId("gmail-2")).key).not.toBe(first.key);
    expect(note(replyInteractionId("inbound:gmail-1")).key).not.toBe(first.key);
  });

  it("has its own permission and the exact body / marker the existing note verification compares", () => {
    const intent = note(inboundInteractionId("gmail-1"));
    expect(intent).toMatchObject({ kind: "note_create", permission: "append_case_note", ticketId: "12345" });
    expect(intent.marker).toMatch(/^[a-f0-9]{64}$/);
    expect(intent.properties.hs_note_body).toBe(renderIntakeNote(intent.text, intent.marker));
  });

  it("the association is built from the confirmed creation only and keeps its own key", () => {
    const created = note(inboundInteractionId("gmail-1"));
    const associate = buildCaseNoteAssociateIntent({ caseId: CASE, interactionId: inboundInteractionId("gmail-1"), created, createEffectId: "effect-1", objectId: "987654" });
    expect(associate).toMatchObject({ kind: "note_associate", permission: "append_case_note", key: caseNoteAssociationKey(CASE, "inbound:gmail-1"), objectId: "987654", ticketId: "12345", confirmedNoteCreate: { effectId: "effect-1", objectId: "987654" } });
    expect(associate.expectedProperties).toEqual(created.properties);
    expect(() => buildCaseNoteAssociateIntent({ caseId: CASE, interactionId: "inbound:x", created, createEffectId: "e", objectId: "not-a-number" })).toThrow("SAV_CASE_EFFECT_NOTE_ACK_INVALID");
  });

  it("refuses a note that cannot be verified: no ticket id, empty text, bad date", () => {
    expect(() => buildCaseNoteIntent({ caseId: CASE, interactionId: "inbound:x", ticketId: "ABC", sourceMessageId: "m", text: "t", at: "2026-10-30T10:00:00.000Z" })).toThrow("SAV_CASE_EFFECT_NOTE_INVALID");
    expect(() => buildCaseNoteIntent({ caseId: CASE, interactionId: "inbound:x", ticketId: "1", sourceMessageId: "m", text: " ", at: "2026-10-30T10:00:00.000Z" })).toThrow("SAV_CASE_EFFECT_NOTE_INVALID");
    expect(() => buildCaseNoteIntent({ caseId: CASE, interactionId: "inbound:x", ticketId: "1", sourceMessageId: "m", text: "t", at: "later" })).toThrow("SAV_CASE_EFFECT_NOTE_INVALID");
  });
});
