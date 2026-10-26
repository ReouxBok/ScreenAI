import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { buildSavInboundContext, splitSavMessageText } from "../message-context";
import { prepareSavIntakeMessage } from "./message";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall } from "./model-readers";
import { normalizeSavEvidenceText } from "../evidence-text";

const input = { id: "10000000-0000-4000-8000-000000000001", threadId: "20000000-0000-4000-8000-000000000001",
    fromEmail: "sender@example.invalid", toEmails: ["support@example.invalid"], direction: "inbound" as const,
    receivedAt: "2026-10-23T12:00:00.000Z", subject: "Re: Synthetic previous subject", bodyComplete: true, unresolvedAttachments: false };
const current = "Synthetic current request. ".repeat(510) + "CURRENT FINAL REQUEST";
const signature = "--\n" + "Synthetic signature contact. ".repeat(100) + "SIGNATURE END";
const quoted = "On Tuesday, Synthetic Support wrote:\n" + "Historical billing request. ".repeat(250) + "QUOTE END";
const completeBody = current + "\n" + signature + "\n" + quoted;
const signal = () => AbortSignal.timeout(1000);
type Payload = { citationCatalogue: { id: string; sourceId: string; text: string }[]; provenance: unknown[] };
const payload = (arg: Parameters<IntakeGeminiCall>[0]) => JSON.parse(arg.body.contents[0].parts[0].text) as Payload;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

it("retains all long sections and exact part boundaries without depending on the display snapshot", () => {
    const source = { ...input, body: completeBody }, before = structuredClone(source), sourceHash = hash(source);
    const display = buildSavInboundContext(source), split = splitSavMessageText(completeBody), prepared = prepareSavIntakeMessage(source);
    expect(display.truncated).toBe(true);
    expect(display.currentText).toHaveLength(12000);
    expect(display.quotedText).toHaveLength(4000);
    expect(display.signatureText).toHaveLength(2000);
    expect(prepared.message).toMatchObject({ currentText: current, contentComplete: true });
    expect(prepared.provenance).toMatchObject({ currentText: current, quotedText: quoted, signatureText: signature,
        parts: split.parts, subject: input.subject, subjectInherited: true, truncated: false, textComplete: true });
    expect(source).toEqual(before);
    expect(hash(source)).toBe(sourceHash);
});
it("retains more than 100 interleaved provenance parts without promoting quoted requests", () => {
    const body = Array.from({ length: 65 }, (_, i) => `> Historical refund ${i}\nCurrent answer ${i}`).join("\n");
    const prepared = prepareSavIntakeMessage({ ...input, body });
    expect(prepared.provenance.parts).toHaveLength(130);
    expect(prepared.provenance.parts).toEqual(splitSavMessageText(body).parts);
    expect(prepared.message.contentComplete).toBe(true);
    expect(prepared.message.currentText).toContain("Current answer 64");
    expect(prepared.message.currentText).not.toContain("refund");
    expect(prepared.provenance.quotedText).toContain("Historical refund 64");
});
it.each(["Re:", "Rép:", "AW:", "SV:", "FW:", "Fwd:", "TR:"])("preserves inherited subject provenance for %s", prefix => {
    const subject = `${prefix} Historical cancellation`, prepared = prepareSavIntakeMessage({ ...input, subject, body: "Current acknowledgement." });
    expect(prepared.message.currentText).toBe("Current acknowledgement.");
    expect(prepared.provenance).toMatchObject({ subject, subjectInherited: true });
});
it("keeps an original subject attached to the complete authored body", () => {
    const prepared = prepareSavIntakeMessage({ ...input, subject: "Synthetic new question", body: current });
    expect(prepared.message.currentText).toBe("Synthetic new question\n\n" + current);
    expect(prepared.provenance.currentText).toBe(current);
    expect(prepared.provenance.subjectInherited).toBe(false);
});
it.each(["body-incomplete", "html-incomplete", "quoted-html", "subject-truncated", "body-at-limit", "body-over-limit", "combined-over-limit", "unread-attachment"])("never labels an incomplete source complete: %s", failure => {
    let body = completeBody, subject = input.subject, bodyComplete = true, unresolvedAttachments = false;
    if (failure === "body-incomplete") bodyComplete = false;
    if (failure === "html-incomplete") body = "<html><body>Unclosed";
    if (failure === "quoted-html") body = "<html><body>Current acknowledgement.<blockquote>Historical cancellation.</blockquote></body></html>";
    if (failure === "subject-truncated") subject = "s".repeat(2001);
    if (failure === "body-at-limit") body = "x".repeat(100000);
    if (failure === "body-over-limit") body = "x".repeat(100001);
    if (failure === "combined-over-limit") { body = "x".repeat(99999); subject = "Original subject"; }
    if (failure === "unread-attachment") unresolvedAttachments = true;
    const prepared = prepareSavIntakeMessage({ ...input, subject, body, bodyComplete, unresolvedAttachments });
    expect(prepared.message.contentComplete).toBe(false);
    expect(prepared.message.currentText.length).toBeLessThanOrEqual(100000);
    if (failure.includes("limit") || failure === "subject-truncated") expect(prepared.provenance.truncated).toBe(true);
    if (failure !== "unread-attachment") expect(prepared.provenance.textComplete).toBe(false);
    else expect(prepared.provenance).toMatchObject({ textComplete: true, unresolvedAttachments: true });
});
it("keeps full current evidence anchorable while long quotation and signature remain context only", async () => {
    const prepared = prepareSavIntakeMessage({ ...input, body: completeBody });
    const call = vi.fn<IntakeGeminiCall>(async arg => {
        const data = payload(arg), anchors = data.citationCatalogue.filter(a => a.sourceId === "current");
        expect(normalizeSavEvidenceText(anchors.map(a => a.text).join(" "))).toBe(normalizeSavEvidenceText(current));
        expect(anchors.at(-1)!.text).toContain("CURRENT FINAL REQUEST");
        expect(data.citationCatalogue.some(a => a.text.includes("QUOTE END") || a.text.includes("SIGNATURE END"))).toBe(false);
        expect(data.provenance).toEqual([prepared.provenance]);
        return { json: { messageId: input.id, requests: [{ id: "request", kind: "commercial", currentMessageId: input.id, quoteId: anchors.at(-1)!.id }] }, metadata: {} };
    });
    const readers = createSavIntakeSemanticReaders({ model: "gemini-synthetic", call, provenance: new Map([[input.id, prepared.provenance]]) });
    expect(await readers.analyseMessage({ message: prepared.message, conversation: [] }, signal())).toMatchObject({ requests: [{ kind: "commercial" }] });
    expect(call).toHaveBeenCalledOnce();
});
it("rejects a historical quotation as a current request after retaining its complete provenance", async () => {
    const prepared = prepareSavIntakeMessage({ ...input, body: completeBody });
    const readers = createSavIntakeSemanticReaders({ model: "gemini-synthetic", provenance: new Map([[input.id, prepared.provenance]]), call: async () => ({
        json: { messageId: input.id, requests: [{ id: "request", kind: "finance", currentMessageId: input.id, quote: "Historical billing request." }] }, metadata: {} }) });
    await expect(readers.analyseMessage({ message: prepared.message, conversation: [] }, signal())).rejects.toThrow("CITATION_REJECTED");
});
it("reads a long complete mail in one call with its full provenance, never slicing it", async () => {
    const body = "Current question.\nOn Tuesday, Synthetic Support wrote:\n" + "quoted ".repeat(14130);
    expect(body.length).toBeLessThan(100000);
    const prepared = prepareSavIntakeMessage({ ...input, body });
    expect(prepared.message.contentComplete).toBe(true);
    expect(prepared.provenance.quotedText).toBe(splitSavMessageText(body).quotedText);
    const call = vi.fn<IntakeGeminiCall>(async arg => {
      const data = JSON.parse(arg.body.contents[0].parts[0].text), quoteId = data.citationCatalogue.find((e: { sourceId: string }) => e.sourceId === "current").id;
      return { json: { messageId: input.id, requests: [{ id: "request", kind: "support", currentMessageId: input.id, quoteId }],
        ticketSummary: { title: "Question", description: "Question du client.", requestIds: ["request"] } }, metadata: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 } };
    });
    const readers = createSavIntakeSemanticReaders({ model: "gemini-synthetic", call, provenance: new Map([[input.id, prepared.provenance]]) });
    await expect(readers.analyseMessage({ message: prepared.message, conversation: [] }, signal())).resolves.toMatchObject({ requests: [{ id: "request" }] });
    expect(call).toHaveBeenCalledTimes(1);
    // The whole quoted history travels to the model: provenance was not sliced to fit.
    const sent = call.mock.calls[0][0].body.contents[0].parts[0].text;
    expect(sent.split("quoted").length - 1).toBeGreaterThanOrEqual(14130);
});
