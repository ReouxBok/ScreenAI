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
    expect(html).toContain("Email du client");
    expect(html).toContain("Je cherche mes factures");
    expect(html).not.toContain("Voir la conversation entière");
  });

  it("shows the latest customer mail first and keeps the whole exchange behind native details", () => {
    const html = render([message("one", "inbound", "PREMIER_MAIL"), message("two", "outbound", "REPONSE_SUPPORT"), message("three", "inbound", "DERNIER_MAIL")]);
    const toggleAt = html.indexOf("Voir la conversation entière");
    expect(html.indexOf("DERNIER_MAIL")).toBeLessThan(toggleAt);
    expect(html.indexOf("PREMIER_MAIL")).toBeGreaterThan(toggleAt);
    expect(html.indexOf("REPONSE_SUPPORT")).toBeGreaterThan(html.indexOf("PREMIER_MAIL"));
    expect(html).toContain("(3 messages)");
    expect(html).not.toContain("<details open");
  });

  it("escapes customer content and warns about unanalysed attachments", () => {
    const item = message("one", "inbound", "<script>alert('x')</script>");
    item.body.attachments = [{ filename: "capture.png", mimeType: "image/png", size: 100 }];
    const html = render([item]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Pièces jointes non analysées");
    expect(html).toContain("capture.png");
  });

  it("does not mistake an outbound mail for the customer's latest demand", () => {
    const html = render([message("one", "outbound", "REPONSE_SUPPORT")]);
    expect(html).toContain("Aucun email entrant");
    expect(html).not.toContain("REPONSE_SUPPORT");
  });
});
