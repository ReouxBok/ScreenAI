import { describe, expect, it } from "vitest";
import { renderSavOutboundReply, savReplyFooter } from "../reply-format";
import { caseReplyPayloadHash, type CaseReplyApproval, type CaseReplyProposal } from "./case-effects";
import { buildReplySendIntent, type CaseReplyContext } from "./case-effect-intents";

// UX (V2 outbound format): the reply a person approved is sent only if it already carries the AI mention of that approval, exactly once, in the shared
// format; the builder never appends a footer after the hash. Imports only the shared format and the intent builder, so the same file run on the base
// shows what the old builder did with each text (counter-proof). Pure: no Gmail, no model, no database.
const CASE = "10000000-0000-4000-8000-000000000001";
const context: CaseReplyContext = { mailboxEmail: "support@example.invalid", gmailThreadId: "gmail-thread", priorRfcMessageId: "<incoming@example.invalid>", inboundFromEmail: "customer@example.invalid" };
const proposalOf = (text: string): CaseReplyProposal => ({
  caseId: CASE, caseVersion: 3, triggerEventId: "inbound:gmail-1", inboundMessageId: "20000000-0000-4000-8000-000000000002", purpose: "answer",
  recipient: "customer@example.invalid", subject: "Synthetic access", text,
});
// What a person approves: the hash of the exact proposal, as `decideCaseReply` stores it.
const approved = (proposal: CaseReplyProposal): CaseReplyApproval => ({
  payloadHash: caseReplyPayloadHash(proposal), caseVersion: proposal.caseVersion, recipient: proposal.recipient, approvedBy: "staff@example.invalid", approvedAt: "2026-10-31T09:00:00.000Z",
});
const send = (text: string) => { const proposal = proposalOf(text); return buildReplySendIntent(proposal, approved(proposal), context); };
const mimeBody = (raw: string) => Buffer.from(raw.split("\r\n\r\n")[1]!, "base64").toString("utf8");
const BODY = "Bonjour,\n\nVoici la marche à suivre synthétique.";

describe("V2 reply_send: the AI mention is part of the approved text, checked, never appended", () => {
  it("a text approved WITHOUT any mention is refused (the old builder encoded it as is)", () => {
    expect(() => send(BODY)).toThrow("SAV_CASE_EFFECT_AI_NOTICE_MISSING");
    expect(() => send("Hello,\n\nSynthetic steps.")).toThrow("SAV_CASE_EFFECT_AI_NOTICE_MISSING");
  });

  it("a text that only carries the human team signature (a reply a person wrote) is refused: a V2 proposal is always AI-prepared", () => {
    for (const language of ["fr", "en"] as const) expect(() => send(renderSavOutboundReply(BODY, language, "manual_authored"))).toThrow("SAV_CASE_EFFECT_AI_NOTICE_MISSING");
  });

  it("under a person's approval, a text saying 'sent automatically' is refused: the mention must say prepared with AI and validated by the team", () => {
    for (const language of ["fr", "en"] as const) expect(() => send(renderSavOutboundReply(BODY, language, "automated"))).toThrow("SAV_CASE_EFFECT_AI_NOTICE_MODE");
  });

  it("a mention that is stacked, contradictory, legacy only, cut, or followed by extra text is refused", () => {
    const reviewed = savReplyFooter("fr", "manual_reviewed");
    for (const text of [
      `${BODY}\n\n${reviewed}\n\n${reviewed}`,
      `${BODY}\n\n${savReplyFooter("en", "manual_reviewed")}\n\n${reviewed}`,
      `${BODY}\n\n${savReplyFooter("fr", "automated")}\n\n${reviewed}`,
      `${BODY}\n\nCharly, assistant IA SAV\nCette réponse a été préparée avec une IA, qui peut se tromper. Si nécessaire, demandez une vérification à l’équipe Limova.`,
      `${BODY}\n\n${reviewed.split("\n")[0]}`,
      `${BODY}\n\n${reviewed}\nPS: synthetic.`,
      `${BODY}  \n\n${reviewed}`,
      `\n\n${reviewed}`,
    ]) expect(() => send(text), text).toThrow(/SAV_CASE_EFFECT_AI_NOTICE_MISSING/);
  });

  it("FR and EN: the approved text, the hashed text, the intent text and the MIME body are byte for byte the same; the recipient is the one approved", () => {
    for (const language of ["fr", "en"] as const) {
      const text = renderSavOutboundReply(BODY, language, "manual_reviewed");
      const proposal = proposalOf(text), approval = approved(proposal);
      const intent = buildReplySendIntent(proposal, approval, context);
      expect(intent.text).toBe(text);
      expect(mimeBody(intent.raw)).toBe(text);
      expect(intent.caseEffect.payloadHash).toBe(caseReplyPayloadHash(proposalOf(mimeBody(intent.raw))));
      expect(intent.recipient).toBe(approval.recipient);
      expect(text.endsWith(language === "en" ? "This reply was written with help from our AI agent. AI can make mistakes. If something doesn’t work or you have a question, feel free to reply to this message." : "Cette réponse a été rédigée avec l’aide de notre agent IA. L’IA peut se tromper. Si quelque chose ne fonctionne pas ou si vous avez une question, n’hésitez pas à répondre à ce message.")).toBe(true);
      expect(text.split(savReplyFooter(language, "manual_reviewed"))).toHaveLength(2);
    }
  });

  it("an edit after the approval invalidates it, including an edit that only removes or changes the mention", () => {
    const text = renderSavOutboundReply(BODY, "fr", "manual_reviewed"), approval = approved(proposalOf(text));
    for (const edited of [`${text} `, text.replace("synthétique", "modifiée"), BODY, renderSavOutboundReply(BODY, "en", "manual_reviewed")]) {
      expect(() => buildReplySendIntent(proposalOf(edited), approval, context)).toThrow("SAV_CASE_EFFECT_PAYLOAD_CHANGED");
    }
    // Re-approving the edited text does not help when the edit removed the mention.
    expect(() => send(BODY)).toThrow("SAV_CASE_EFFECT_AI_NOTICE_MISSING");
  });
});
