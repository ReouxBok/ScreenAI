/** SAV-42 B: a complete text with durable unread files reaches the readers with an
 * explicit unread list; requirements are source-bound, never file content. */
import { describe, expect, it, vi } from "vitest";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall } from "./model-readers";

const at = "2026-10-21T10:00:00.000Z", mid = "10000000-0000-4000-8000-000000000001", tid = "20000000-0000-4000-8000-000000000001";
const pdf = { sourceId: "attachment:pdf-1", reason: "unsupported_type" as const };
const message = { id: mid, threadId: tid, receivedAt: at, fromEmail: "sender@example.test", toEmails: ["support@example.test"],
  direction: "inbound" as const, contentComplete: true, currentText: "Je souhaite mettre fin au contrat et ne pas le renouveler.", unreadAttachments: [pdf] };
const signal = () => new AbortController().signal;
type Data = { citationCatalogue: { id: string; sourceId: string; text: string }[]; unreadAttachments?: unknown; unreadAttachmentInstructions?: string };
const data = (arg: Parameters<IntakeGeminiCall>[0]) => JSON.parse(arg.body.contents[0].parts[0].text) as Data;
const anchor = (arg: Parameters<IntakeGeminiCall>[0]) => data(arg).citationCatalogue.find(a => a.sourceId === "current")!.id;
const result = (json: unknown) => ({ json, metadata: { inputTokens: 10, outputTokens: 10, thoughtTokens: 0, totalTokens: 20 } });
const analysis = (arg: Parameters<IntakeGeminiCall>[0], over: Record<string, unknown> = {}) => ({ messageId: mid,
  requests: [{ id: "r0", kind: "cancellation", currentMessageId: mid, quoteId: anchor(arg) }],
  ticketSummary: { title: "Fin de contrat", description: "Le client demande la fin du contrat sans renouvellement.", requestIds: ["r0"] }, ...over });

describe("current reader: unread attachments of a complete text", () => {
  it("lists unread files without content and decodes a source-bound accessory requirement", async () => {
    let sent: Data | undefined;
    const call = vi.fn<IntakeGeminiCall>(async arg => { sent = data(arg); return result(analysis(arg, {
      unreadAttachmentRequirements: [{ sourceId: pdf.sourceId, role: "accessory", textQuoteId: anchor(arg) }] })); });
    const out = await createSavIntakeSemanticReaders({ model: "gemini-fixture", call }).analyseMessage({ message, conversation: [] }, signal());
    expect(sent?.unreadAttachments).toEqual([pdf]);
    expect(sent?.unreadAttachmentInstructions).toContain("Never infer");
    expect(out.unreadAttachmentRequirements).toEqual([{ sourceId: pdf.sourceId, role: "accessory", textQuote: message.currentText }]);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("refuses requirements when no file was left unread", async () => {
    const call = vi.fn<IntakeGeminiCall>(async arg => result(analysis(arg, { unreadAttachmentRequirements: [{ sourceId: pdf.sourceId, role: "accessory" }] })));
    const { unreadAttachments, ...plain } = message; void unreadAttachments;
    await expect(createSavIntakeSemanticReaders({ model: "gemini-fixture", call }).analyseMessage({ message: plain, conversation: [] }, signal())).rejects.toThrow();
  });
  it("refuses a requirement quote that does not come from the current text", async () => {
    const outbound = { ...message, id: tid, direction: "outbound" as const, currentText: "Merci pour votre facture.", unreadAttachments: undefined };
    const call = vi.fn<IntakeGeminiCall>(async arg => result(analysis(arg, {
      unreadAttachmentRequirements: [{ sourceId: pdf.sourceId, role: "accessory", textQuoteId: data(arg).citationCatalogue.find(a => a.sourceId === `message-${tid}`)!.id }] })));
    await expect(createSavIntakeSemanticReaders({ model: "gemini-fixture", call }).analyseMessage({ message, conversation: [outbound] }, signal())).rejects.toThrow("CITATION_REJECTED");
  });
});
