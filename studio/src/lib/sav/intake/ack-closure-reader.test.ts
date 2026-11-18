// SAV-95: the guideline reaches the V1 understanding call only with the switch on and our reply before the mail; the model's structured decision is
// decoded with its citation of OUR reply, and a malformed or wrongly cited decision is dropped without failing the analysis. Model stubbed. Synthetic.
import { describe, expect, it } from "vitest";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall } from "./model-readers";
import type { IntakeMessage } from "./engine-types";

const THREAD = "40000000-0000-4000-8000-000000000001", OUT = "40000000-0000-4000-8000-000000000002", MID = "40000000-0000-4000-8000-000000000003";
const msg = (id: string, direction: "inbound" | "outbound", text: string, at: string): IntakeMessage => ({ id, threadId: THREAD, fromEmail: direction === "inbound" ? "client@example.test" : "support@example.test",
  toEmails: [direction === "inbound" ? "support@example.test" : "client@example.test"], currentText: text, contentComplete: true, direction, receivedAt: at });
const ours = msg(OUT, "outbound", "Bonjour, c'est corrigé de notre côté.", "2026-11-18T09:00:00.000Z");
const customer = msg(MID, "inbound", "Ok merci", "2026-11-18T10:00:00.000Z");

type Data = { citationCatalogue: { id: string; sourceId: string; text: string }[]; lastOutboundSourceId?: string };
function bench(ackClosure: boolean | undefined, answerAck: (data: Data) => unknown) {
  const bodies: Parameters<IntakeGeminiCall>[0]["body"][] = [];
  const call: IntakeGeminiCall = async request => {
    bodies.push(request.body);
    const data = JSON.parse(request.body.contents[0].parts[0].text) as Data;
    const current = data.citationCatalogue.find(e => e.sourceId === "current")!.id;
    const ack = answerAck(data);
    return { json: { messageId: MID, nature: "information", requests: [{ id: "r1", kind: "acknowledgement", currentMessageId: MID, quoteId: current }], ...(ack === undefined ? {} : { ackClosure: ack }) },
      metadata: { inputTokens: 10, outputTokens: 5, thoughtTokens: 0, totalTokens: 15 } };
  };
  const readers = createSavIntakeSemanticReaders({ model: "gemini-fixture", call, ...(ackClosure === undefined ? {} : { ackClosure }) });
  return { bodies, analyse: (conversation: IntakeMessage[] = [ours, customer]) => readers.analyseMessage({ message: customer, conversation }, new AbortController().signal) };
}
const ourQuote = (data: Data) => data.citationCatalogue.find(e => e.sourceId === `message-${OUT}`)!.id;
const decision = (data: Data) => ({ decision: "close", confidence: "high", lastOutboundMessageId: OUT, lastOutboundState: "conclusive", customerMessage: "pure_ack",
  justification: "Correction annoncée, simple remerciement.", evidenceQuoteId: ourQuote(data) });

describe("switch off: the understanding call is unchanged", () => {
  it("no guideline, no field, no lastOutboundSourceId; an unrequested ackClosure is dropped", async () => {
    const { bodies, analyse } = bench(undefined, decision);
    const result = await analyse();
    const instruction = bodies[0]!.systemInstruction.parts[0]!.text;
    expect(instruction).not.toContain("ACK CLOSURE GUIDELINE");
    expect(JSON.stringify(bodies[0]!.generationConfig)).not.toContain("ackClosure");
    expect(bodies[0]!.contents[0]!.parts[0]!.text).not.toContain("lastOutboundSourceId");
    expect(result.ackClosure).toBeUndefined();
    expect(result.requests).toEqual([{ id: "r1", kind: "acknowledgement", currentMessageId: MID }]);
  });
  it("off and « on without our reply before the mail » send the same request", async () => {
    const off = bench(false, () => undefined), alone = bench(true, () => undefined);
    await off.analyse([customer]); await alone.analyse([customer]);
    expect(alone.bodies[0]).toEqual(off.bodies[0]);
  });
});

describe("switch on: guideline injected, decision wired", () => {
  it("injects the guideline with our last reply and decodes the cited decision", async () => {
    const { bodies, analyse } = bench(true, decision);
    const result = await analyse();
    const instruction = bodies[0]!.systemInstruction.parts[0]!.text;
    expect(instruction).toContain("ACK CLOSURE GUIDELINE");
    expect(instruction).toContain("C'est transmis à l'équipe technique");
    expect(JSON.parse(bodies[0]!.contents[0]!.parts[0]!.text).lastOutboundSourceId).toBe(`message-${OUT}`);
    expect(JSON.stringify(bodies[0]!.generationConfig)).toContain("ackClosure");
    expect(result.ackClosure).toEqual({ decision: "close", confidence: "high", lastOutboundMessageId: OUT, lastOutboundState: "conclusive", customerMessage: "pure_ack",
      justification: "Correction annoncée, simple remerciement.", evidenceQuote: "Bonjour, c'est corrigé de notre côté." });
  });
  it("picks OUR latest reply before the mail, not an older one", async () => {
    const older = msg("40000000-0000-4000-8000-000000000009", "outbound", "Nous analysons.", "2026-11-17T09:00:00.000Z");
    const { bodies, analyse } = bench(true, decision);
    await analyse([older, ours, customer]);
    expect(JSON.parse(bodies[0]!.contents[0]!.parts[0]!.text).lastOutboundSourceId).toBe(`message-${OUT}`);
  });
  const broken: Array<[string, (data: Data) => unknown]> = [
    ["an unknown enum value", data => ({ ...decision(data), decision: "maybe" })],
    ["a quote of the customer's mail instead of our reply", data => ({ ...decision(data), evidenceQuoteId: data.citationCatalogue.find(e => e.sourceId === "current")!.id })],
    ["another outbound id", data => ({ ...decision(data), lastOutboundMessageId: MID })],
    ["an extra key", data => ({ ...decision(data), close: true })],
    ["null", () => null],
  ];
  it.each(broken)("drops %s without failing the analysis", async (_name, answer) => {
    const { analyse } = bench(true, answer);
    const result = await analyse();
    expect(result.ackClosure).toBeUndefined();
    expect(result.requests).toHaveLength(1);
  });
  it("an omitted decision is simply absent", async () => {
    const { analyse } = bench(true, () => undefined);
    expect((await analyse()).ackClosure).toBeUndefined();
  });
});
