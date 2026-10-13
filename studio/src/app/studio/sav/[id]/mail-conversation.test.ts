import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { getSavThreadDetail } from "@/lib/sav/service";
import { MailConversation } from "./mail-conversation";

type Message = NonNullable<Awaited<ReturnType<typeof getSavThreadDetail>>>["messages"][number];
function message(id: string, direction: "inbound" | "outbound", text: string): Message {
  return { id, mailboxId: "mailbox", threadId: "thread", gmailMessageId: id, hubspotEmailId: null, direction,
    fromEmail: direction === "inbound" ? "client@example.invalid" : "contact@limova.ai", toEmails: [], subject: "Factures",
    preview: text, bodyCiphertext: undefined, body: { text }, receivedAt: new Date("2026-10-02T12:00:00Z"),
    processedAt: null, analysisStatus: "pending", analysisAttempts: 0, analysisStartedAt: null, analysisErrorCode: null, createdAt: new Date(),
  };
}
const render = (messages: Message[]) => renderToStaticMarkup(createElement(MailConversation, { messages }));

describe("Customer mail before SAV proposal", () => {
  it("shows a single inbound mail without a useless conversation toggle", () => {
    const html = render([message("one", "inbound", "Je cherche mes factures")]);
    expect(html).toContain("Dernier email reçu");
    expect(html).toContain("Je cherche mes factures");
    expect(html).not.toContain("Afficher toute la conversation");
  });

  it("shows only the latest inbound and hides older messages", () => {
    const old = message("old", "inbound", "PREMIER_MAIL");
    const latest = message("latest", "inbound", "DERNIER_MAIL");
    latest.receivedAt = new Date("2026-10-03T12:00:00Z");
    const outbound = message("support", "outbound", "REPONSE_SUPPORT");
    outbound.receivedAt = new Date("2026-10-04T12:00:00Z");
    const html = render([latest, outbound, old]);
    expect(html).toContain("DERNIER_MAIL");
    expect(html).not.toContain("PREMIER_MAIL");
    expect(html).not.toContain("REPONSE_SUPPORT");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Afficher toute la conversation");
  });

  it("breaks a receivedAt tie by createdAt before the id, like the action context", () => {
    const first = message("z", "inbound", "FIRST_SAME_DATE");
    const latest = message("a", "inbound", "LATEST_SAME_DATE");
    first.createdAt = new Date("2026-10-02T12:01:00Z");
    latest.createdAt = new Date("2026-10-02T12:02:00Z");
    const html = render([latest, first]);
    expect(html).toContain("LATEST_SAME_DATE");
    expect(html).not.toContain("FIRST_SAME_DATE");
  });

  it.each([
    "Le 12 octobre, Support a écrit :\nANCIEN_MESSAGE",
    "De : Support\nEnvoyé : 12 octobre\nÀ : Client\nObjet : Test\nANCIEN_MESSAGE",
    "> ANCIEN_MESSAGE",
  ])("collapses quoted history even with only one synchronized email", quote => {
    const html = render([message("one", "inbound", `DEMANDE_ACTUELLE\n${quote}`)]);
    expect(html).toContain("DEMANDE_ACTUELLE");
    expect(html).not.toContain("ANCIEN_MESSAGE");
    expect(html).toContain("Afficher toute la conversation");
  });

  it("does not mistake a quote-only email for a fresh request", () => {
    const html = render([message("one", "inbound", "> ANCIEN_MESSAGE")]);
    expect(html).toContain("uniquement un historique cité");
    expect(html).not.toContain("ANCIEN_MESSAGE");
    expect(html).toContain("Afficher toute la conversation");
  });

  it("offers the full source when its size exceeds the display parser limit", () => {
    const html = render([message("one", "inbound", "x".repeat(100_001) + "FIN_INTEGRALE")]);
    expect(html).toContain("Afficher toute la conversation");
    expect(html).not.toContain("FIN_INTEGRALE");
  });

  it("escapes customer content and warns about unanalysed attachments", () => {
    const item = message("one", "inbound", "<script>alert('x')</script>");
    item.body.attachments = [{ filename: "capture.png", mimeType: "image/png", size: 100 }];
    const html = render([item]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("non analysée(s)");
    expect(html).toContain("capture.png");
  });

  it("does not mistake an outbound mail for the customer's latest demand", () => {
    const html = render([message("one", "outbound", "REPONSE_SUPPORT")]);
    expect(html).toContain("Aucun email entrant");
    expect(html).not.toContain("REPONSE_SUPPORT");
    expect(html).toContain("Afficher toute la conversation");
  });
});
