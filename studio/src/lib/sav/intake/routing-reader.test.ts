// V1 routing (23/11): the guideline and the optional `routing` field reach V1's understanding call (both pipelines) only with the switch; a malformed class
// is dropped without failing the analysis. Model stubbed. Synthetic.
import { describe, expect, it } from "vitest";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall } from "./model-readers";
import { createSavIntakeSimpleReaders } from "./simple-readers";
import type { IntakeMessage } from "./engine-types";

const THREAD = "70000000-0000-4000-8000-000000000001", MID = "70000000-0000-4000-8000-000000000002";
const message: IntakeMessage = { id: MID, threadId: THREAD, fromEmail: "prospect@example.test", toEmails: ["contact@example.test"],
  currentText: "Bonjour, combien coûte votre offre pour 3 personnes ?", contentComplete: true, direction: "inbound", receivedAt: "2026-11-23T08:00:00.000Z" };
const routing = { class: "lead_commercial", confidence: "high", justification: "Demande de prix avant achat." };

function current(enabled: boolean | undefined, answer: unknown, extra: Record<string, unknown> = {}) {
  const bodies: Parameters<IntakeGeminiCall>[0]["body"][] = [];
  const call: IntakeGeminiCall = async request => {
    bodies.push(request.body);
    const data = JSON.parse(request.body.contents[0].parts[0].text) as { citationCatalogue: { id: string; sourceId: string }[] };
    const quote = data.citationCatalogue.find(e => e.sourceId === "current")!.id;
    return { json: { messageId: MID, nature: "request", requests: [{ id: "r1", kind: "commercial", currentMessageId: MID, quoteId: quote }], ...(answer === undefined ? {} : { routing: answer }), ...extra },
      metadata: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 } };
  };
  const readers = createSavIntakeSemanticReaders({ model: "gemini-fixture", call, ...(enabled === undefined ? {} : { routing: enabled }) });
  return { bodies, analyse: () => readers.analyseMessage({ message, conversation: [message] }, new AbortController().signal) };
}

describe("current pipeline", () => {
  it("off: no guideline, no field; an unrequested class is dropped", async () => {
    const { bodies, analyse } = current(undefined, routing);
    const result = await analyse();
    expect(bodies[0]!.systemInstruction.parts[0]!.text).not.toContain("ROUTING CLASS GUIDELINE");
    expect(JSON.stringify(bodies[0]!.generationConfig)).not.toContain("lead_commercial");
    expect(result.routing).toBeUndefined();
    expect(result.requests).toEqual([{ id: "r1", kind: "commercial", currentMessageId: MID }]);
  });
  it("off and false send the same request", async () => {
    const a = current(undefined, undefined), b = current(false, undefined);
    await a.analyse(); await b.analyse();
    expect(b.bodies[0]).toEqual(a.bodies[0]);
  });
  it("on: guideline with the key distinction, class decoded", async () => {
    const { bodies, analyse } = current(true, routing);
    const result = await analyse();
    const instruction = bodies[0]!.systemInstruction.parts[0]!.text;
    expect(instruction).toContain("ROUTING CLASS GUIDELINE");
    expect(instruction).toContain("they want to BUY from us or USE Limova = lead_commercial; they want to SELL us something = demarchage");
    expect(JSON.stringify(bodies[0]!.generationConfig)).toContain("notification_auto");
    expect(result.routing).toEqual(routing);
  });
  it.each([["an unknown class", { ...routing, class: "spam" }], ["an extra key", { ...routing, recipient: "x@example.test" }], ["null", null]])
  ("on: drops %s without failing the analysis", async (_name, answer) => {
    const result = await current(true, answer).analyse();
    expect(result.routing).toBeUndefined();
    expect(result.requests).toHaveLength(1);
  });
  // Production 24/11 (shadow): with the routing field, a mail without any unread file came back with keys the wire contract never offers and the whole
  // understanding analysis failed at decode (SAV_INTAKE_MODEL_CITATION_REJECTED / unknown_source), then fell to human qualification.
  const strays: [string, Record<string, unknown>][] = [
    ["an empty unreadAttachmentRequirements", { unreadAttachmentRequirements: [] }],
    ["an invented unreadAttachmentRequirements", { unreadAttachmentRequirements: [{ sourceId: "a1", role: "accessory" }] }],
    ["an attachmentObservations key", { attachmentObservations: [] }],
  ];
  it.each(strays)("on: %s on a mail without unread files never rejects the analysis; the class is kept", async (_name, extra) => {
    const result = await current(true, routing, extra).analyse();
    expect(result.routing).toEqual(routing);
    expect(result.requests).toEqual([{ id: "r1", kind: "commercial", currentMessageId: MID }]);
    expect(result.unreadAttachmentRequirements).toBeUndefined();
    expect(result.attachmentObservations).toBeUndefined();
  });
  it("on: the wire contract no longer offers unreadAttachmentRequirements without an unread file", async () => {
    const on = current(true, routing), off = current(undefined, undefined);
    await on.analyse(); await off.analyse();
    expect(JSON.stringify(on.bodies[0]!.generationConfig)).not.toContain("unreadAttachmentRequirements");
    expect(JSON.stringify(off.bodies[0]!.generationConfig)).toContain("unreadAttachmentRequirements");
  });
  it.each(strays)("off: %s is still refused exactly as before routing", async (_name, extra) => {
    await expect(current(undefined, undefined, extra).analyse()).rejects.toThrow("SAV_INTAKE_MODEL_CITATION_REJECTED");
  });
  it("on: a request citation outside the catalogue is still refused", async () => {
    const readers = createSavIntakeSemanticReaders({ model: "gemini-fixture", routing: true, call: async () => ({
      json: { messageId: MID, nature: "request", requests: [{ id: "r1", kind: "commercial", currentMessageId: MID, quoteId: "q-unknown" }], routing },
      metadata: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 } }) });
    await expect(readers.analyseMessage({ message, conversation: [message] }, new AbortController().signal)).rejects.toThrow();
  });
});

describe("simple pipeline", () => {
  const crm = { findContactsByEmail: async () => ({ status: "complete" as const, data: [], observedAt: "2026-11-23T08:00:00.000Z" }),
    directAssociations: async () => ({ status: "complete" as const, data: [], observedAt: "2026-11-23T08:00:00.000Z" }),
    getContact: async () => ({ status: "failed" as const, data: null, observedAt: "2026-11-23T08:00:00.000Z" }),
    ticketsForContact: async () => ({ status: "complete" as const, data: [], observedAt: "2026-11-23T08:00:00.000Z" }),
    ticketHistory: async () => ({ status: "complete" as const, data: [], observedAt: "2026-11-23T08:00:00.000Z" }) } as never;
  function simple(enabled: boolean, answer: unknown) {
    const bodies: Parameters<IntakeGeminiCall>[0]["body"][] = [];
    const call: IntakeGeminiCall = async request => {
      bodies.push(request.body);
      const data = JSON.parse(request.body.contents[0].parts[0].text) as { outputReferences: { snapshot: string; sources: Record<string, string> } };
      const current = Object.entries(data.outputReferences.sources).find(([, v]) => v === "current")![0];
      return { json: { v: data.outputReferences.snapshot, n: "request", r: [{ id: "r1", k: "commercial", s: "Demande de prix.", e: [current] }],
        i: { k: "unknown", c: [], w: "Aucun contact." }, j: [], x: [], w: "Prospect.", ...(answer === undefined ? {} : { routing: answer }) },
        metadata: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 } };
    };
    const readers = createSavIntakeSimpleReaders({ model: "gemini-fixture", call, crm, policy: { relationRevision: "r", admittedRelations: [], resources: {} } as never, routing: enabled });
    return { bodies, analyse: () => readers.analyseMessage({ message, conversation: [message] }, new AbortController().signal) };
  }
  it("off: no guideline and an unrequested class is dropped", async () => {
    const { bodies, analyse } = simple(false, routing);
    const result = await analyse();
    expect(bodies[0]!.systemInstruction.parts[0]!.text).not.toContain("ROUTING CLASS GUIDELINE");
    expect(result.routing).toBeUndefined();
  });
  it("on: class decoded; a malformed one is dropped without failing", async () => {
    expect((await simple(true, routing).analyse()).routing).toEqual(routing);
    const broken = await simple(true, { class: "lead_commercial", confidence: "sure" }).analyse();
    expect(broken.routing).toBeUndefined();
    expect(broken.requests).toHaveLength(1);
  });
});
