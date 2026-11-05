import { describe, expect, it } from "vitest";
import { buildReplySendIntent, type CaseReplyContext } from "./case-effect-intents";
import { caseReplyPayloadHash, type CaseReplyProposal } from "./case-effects";
import { prepareCaseReplyText } from "./case-reply-outbound";

// 5/11 (SYN, no network): the bytes Gmail would receive for a V2 reply, from the real builder, read back as a mail client reads them. The HTML side does not apply: a V2 reply is one
// text/plain part and nothing else, which the executor's read-back requires too (`exactMimeText`); the test keeps it so.
const context: CaseReplyContext = { mailboxEmail: "support@example.invalid", gmailThreadId: "thread-syn", priorRfcMessageId: "<in-syn@example.invalid>", inboundFromEmail: "client@example.invalid" };
const DRAFT = `Bonjour,

Merci pour votre retour. Vous avez déjà utilisé le bon lien (https://new.limova.ai) avec votre adresse d’inscription.

Si le code n’arrive pas dans votre boîte de réception, vérifiez le dossier « Spams » ou « Courriers indésirables » de cette même adresse. Élément déjà reçu : ça, où, être, naïf, cœur.

Si vous ne trouvez pas le code dans les spams non plus, quel message s’affiche à l’écran après la saisie de votre adresse e-mail ?`;
const NOTICE = "Cette réponse a été rédigée avec l’aide de notre agent IA.";
function intentOf(draft: string, subject = "Connexion impossible à l’espace") {
  const text = prepareCaseReplyText(draft, "fr", "manual_reviewed");
  const proposal: CaseReplyProposal = { caseId: "00000000-0000-4000-8000-000000000005", caseVersion: 4, triggerEventId: "inbound:gm-syn", inboundMessageId: "m-syn", recipient: "client@example.invalid", subject, purpose: "question", text };
  const intent = buildReplySendIntent(proposal, { payloadHash: caseReplyPayloadHash(proposal), caseVersion: 4, recipient: proposal.recipient, approvedBy: "staff-syn", approvedAt: "2026-11-05T08:00:00.000Z" }, context);
  return { text, intent };
}
/** As a client would: the headers, then the single body decoded strictly (invalid UTF-8 throws). */
function readMail(raw: string) {
  const split = raw.indexOf("\r\n\r\n"), head = raw.slice(0, split), body = raw.slice(split + 4);
  const headers = Object.fromEntries(head.split("\r\n").map(line => { const at = line.indexOf(": "); return [line.slice(0, at).toLowerCase(), line.slice(at + 2)]; }));
  return { headers, body, decoded: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(body, "base64")) };
}

describe("V2 reply: the real MIME, without network", () => {
  it("one text/plain part in UTF-8 base64; no HTML part and no boundary", () => {
    const { headers, body } = readMail(intentOf(DRAFT).intent.raw);
    expect(headers["content-type"]).toBe('text/plain; charset="UTF-8"');
    expect(headers["content-transfer-encoding"]).toBe("base64");
    expect(headers["mime-version"]).toBe("1.0");
    expect(intentOf(DRAFT).intent.raw).not.toMatch(/text\/html|multipart|boundary=/i);
    expect(body).toMatch(/^[A-Za-z0-9+/=\r\n]+$/);
  });
  it("accents, typographic quotes and paragraphs arrive byte for byte, and the raw mail itself stays ASCII", () => {
    const { text, intent } = intentOf(DRAFT), { decoded } = readMail(intent.raw);
    expect(decoded).toBe(text);
    expect(decoded).toContain("Élément déjà reçu : ça, où, être, naïf, cœur.");
    expect(decoded).toContain("« Spams »");
    expect(decoded.split("\n\n").length).toBe(DRAFT.split("\n\n").length + 2); // the help line and the footer are their own paragraphs
    expect(decoded).not.toMatch(/\\n|&#|&nbsp;|<br|Ã|Â|â€/);
    expect(intent.raw).toMatch(/^[\x20-\x7e\r\n]+$/);
  });
  it("the body respects the MIME line length: a whole reply on one base64 line would not be valid", () => {
    const { body } = readMail(intentOf(DRAFT).intent.raw), lines = body.split("\r\n");
    expect(lines.length).toBeGreaterThan(5);
    expect(Math.max(...lines.map(line => line.length))).toBeLessThanOrEqual(76);
  });
  it("one AI mention, one signature, after the help line, and preparing twice stacks nothing", () => {
    const { decoded } = readMail(intentOf(DRAFT).intent.raw);
    expect(decoded.split(NOTICE).length - 1).toBe(1);
    expect(decoded.split("L’équipe Limova").length - 1).toBe(1);
    expect(decoded.split("Pour nous aider à vous répondre").length - 1).toBe(1);
    expect(decoded.indexOf("Pour nous aider à vous répondre")).toBeLessThan(decoded.indexOf("L’équipe Limova"));
    expect(decoded.trimEnd().endsWith("n’hésitez pas à répondre à ce message.")).toBe(true);
    expect(prepareCaseReplyText(prepareCaseReplyText(DRAFT, "fr", "manual_reviewed"), "fr", "manual_reviewed")).toBe(prepareCaseReplyText(DRAFT, "fr", "manual_reviewed"));
  });
  it("the subject's accents are encoded, the thread headers are kept", () => {
    const { headers } = readMail(intentOf(DRAFT).intent.raw);
    expect(Buffer.from(headers.subject!.replace(/^=\?UTF-8\?B\?|\?=$/g, ""), "base64").toString("utf8")).toBe("Re: Connexion impossible à l’espace");
    expect(headers["in-reply-to"]).toBe("<in-syn@example.invalid>");
    expect(headers.references).toBe("<in-syn@example.invalid>");
  });
});
