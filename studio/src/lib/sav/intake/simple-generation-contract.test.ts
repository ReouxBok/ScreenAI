import { expect, it } from "vitest";
import { createSavIntakeSimpleReaders } from "./simple-readers";
import type { IntakeGeminiCall } from "./model-readers";

it("generation uses the compact contract, binds snapshot references, and never asks to repeat a description", async () => {
  const complete = (data: unknown) => ({ status: "complete" as const, data, observedAt: "2026-10-30T10:00:00Z" });
  const crm = { findContactsByEmail: async () => complete([]), directAssociations: async () => complete([]), getContact: async () => complete(null),
    ticketsForContact: async () => complete([]), ticketHistory: async () => complete([]) };
  let wireSeen: Parameters<IntakeGeminiCall>[0] | undefined;
  const call: IntakeGeminiCall = async request => {
    wireSeen = request;
    const data = JSON.parse(request.body.contents[0].parts[0].text);
    return { json: { v: data.outputReferences?.snapshot, n: "request", r: [{ id: "r1", k: "support", s: "Agenda en panne.", e: ["s0"] }],
      t: "Synchronisation agenda en panne", i: { k: "unknown", c: [], w: "Aucune fiche." }, j: [], x: [], w: "Demande support." },
      metadata: { inputTokens: 10, outputTokens: 10, thoughtTokens: 0, totalTokens: 20 } };
  };
  const reader = createSavIntakeSimpleReaders({ model: "gemini-fixture", call, crm: crm as never, policy: { admittedRelations: [] } as never });
  const accepted = await reader.analyseMessage({ message: { id: "10000000-0000-4000-8000-000000000001", threadId: "20000000-0000-4000-8000-000000000001", receivedAt: "2026-10-30T10:00:00Z",
    fromEmail: "sender@example.test", toEmails: ["support@example.test"], direction: "inbound", currentText: "Mon agenda ne fonctionne plus.", contentComplete: true }, conversation: [] }, new AbortController().signal).catch(() => undefined);
  const schema = wireSeen!.body.generationConfig.responseSchema as { properties: Record<string, unknown> };
  expect(schema.properties).toHaveProperty("v");
  expect(schema.properties).toHaveProperty("r");
  expect(schema.properties).not.toHaveProperty("ticketDescription");
  expect(wireSeen!.body.generationConfig.maxOutputTokens).toBe(8192);
  const data = JSON.parse(wireSeen!.body.contents[0].parts[0].text);
  expect(data.outputReferences.sources).toEqual({ s0: "current" });
  expect(wireSeen!.body.systemInstruction.parts[0].text).toContain("Each summary is at most160 UTF-8 bytes");
  expect(wireSeen!.body.systemInstruction.parts[0].text).toContain("server reconstructs the description");
  expect(accepted?.requests).toMatchObject([{ id: "r1", kind: "support" }]);
});
