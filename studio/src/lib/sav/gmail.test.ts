import { describe, expect, it } from "vitest";
import { decodeGmailPubSubEnvelope, matchesGmailIntakeRecipient, normalizeRecipientHeader, normalizeReferencesHeader, parseGmailMessage } from "./gmail";

function base64url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

describe("Gmail SAV ingestion", () => {
  it("decodes Pub/Sub envelopes", () => {
    const payload = { emailAddress: "sav@limova.ai", historyId: "12345" };
    expect(decodeGmailPubSubEnvelope({ message: { messageId: "pubsub-1", data: Buffer.from(JSON.stringify(payload)).toString("base64") } })).toMatchObject({
      notification: payload,
      envelope: { message: { messageId: "pubsub-1" } },
    });
  });

  it("decodes Pub/Sub envelopes using snake_case metadata", () => {
    const payload = { emailAddress: "contact@limova.ai", historyId: "12346" };
    expect(decodeGmailPubSubEnvelope({
      message: {
        message_id: "pubsub-2",
        publish_time: "2026-08-31T18:00:00Z",
        data: Buffer.from(JSON.stringify(payload)).toString("base64url"),
      },
    })).toMatchObject({
      envelope: { message: { messageId: "pubsub-2", publishTime: "2026-08-31T18:00:00Z" } },
      notification: payload,
    });
  });

  it("decodes unwrapped Pub/Sub notifications", () => {
    expect(decodeGmailPubSubEnvelope({
      emailAddress: "contact@limova.ai",
      historyId: 12347,
    })).toMatchObject({
      envelope: { message: { messageId: "gmail-history:contact@limova.ai:12347" } },
      notification: { emailAddress: "contact@limova.ai", historyId: "12347" },
    });
  });

  it("extracts headers and text from a Gmail MIME message", () => {
    const parsed = parseGmailMessage("sav@limova.ai", {
      id: "gmail-1",
      threadId: "thread-1",
      internalDate: "1788170400000",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "Client <client@example.com>" },
          { name: "To", value: "sav@limova.ai" },
          { name: "Subject", value: "Connexion impossible" },
        ],
        parts: [{ mimeType: "text/plain", body: { data: base64url("Je ne peux plus me connecter.") } }],
      },
    });
    expect(parsed).toMatchObject({
      mailboxEmail: "sav@limova.ai",
      gmailMessageId: "gmail-1",
      gmailThreadId: "thread-1",
      subject: "Connexion impossible",
      bodyText: "Je ne peux plus me connecter.",
    });
  });

  it("ingests only recipients explicitly assigned to the SAV", () => {
    const supportMessage = parseGmailMessage("reouven@limova.ai", {
      id: "gmail-support",
      threadId: "thread-support",
      payload: { headers: [
        { name: "From", value: "Client <client@example.com>" },
        { name: "To", value: "contact@limova.ai" },
        { name: "Delivered-To", value: "reouven@limova.ai" },
      ] },
    });
    const personalMessage = parseGmailMessage("reouven@limova.ai", {
      id: "gmail-personal",
      threadId: "thread-personal",
      payload: { headers: [
        { name: "From", value: "Partenaire <partner@example.com>" },
        { name: "To", value: "reouven@limova.ai" },
      ] },
    });
    expect(matchesGmailIntakeRecipient(supportMessage, "contact@limova.ai")).toBe(true);
    expect(matchesGmailIntakeRecipient(personalMessage, "contact@limova.ai")).toBe(false);
  });

  it("plafonne les listes massives en conservant le destinataire SAV", () => {
    const recipients = Array.from({ length: 60 }, (_, index) => `person-${index}@example.com`);
    recipients.push("Contact Limova <contact@limova.ai>");
    const normalized = normalizeRecipientHeader(recipients.join(", "), ["contact@limova.ai"]);
    expect(normalized).toHaveLength(50);
    expect(normalized[0]).toBe("contact@limova.ai");
  });

  it("conserve les identifiants References les plus récents sous la limite", () => {
    const references = Array.from({ length: 120 }, (_, index) => `<message-${index}-${"x".repeat(30)}@example.com>`).join(" ");
    const normalized = normalizeReferencesHeader(references, 300);
    expect(normalized.length).toBeLessThanOrEqual(300);
    expect(normalized).toContain("message-119");
    expect(normalized).not.toContain("message-0-");
  });

  it("normalise le HTML et tronque les en-têtes non critiques", () => {
    const parsed = parseGmailMessage("contact@limova.ai", {
      id: "gmail-html",
      threadId: "thread-html",
      payload: {
        headers: [
          { name: "From", value: `Client <client@example.com>${"x".repeat(800)}` },
          { name: "To", value: "contact@limova.ai" },
          { name: "Subject", value: "Sujet" },
          { name: "Auto-Submitted", value: `auto-replied${"x".repeat(500)}` },
        ],
        mimeType: "text/html",
        body: { data: base64url("<p>Bonjour &amp; merci</p><script>secret()</script>") },
      },
    });
    expect(parsed.from.length).toBeLessThanOrEqual(500);
    expect(parsed.autoSubmitted?.length).toBeLessThanOrEqual(200);
    expect(parsed.bodyText).toContain("Bonjour & merci");
    expect(parsed.bodyText).not.toContain("secret()");
  });
});
