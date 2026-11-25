// 25/11 (`SAV_V2_CASE_THREAD_REPLY`): nature acknowledgement and its one sentence reach V1's understanding call only with the switch; off, the request and
// the launch fingerprint are those of before. Model stubbed. Synthetic.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSavIntakeSemanticReaders, type IntakeGeminiCall } from "./model-readers";
import type { IntakeMessage } from "./engine-types";

const THREAD = "71000000-0000-4000-8000-000000000001", MID = "71000000-0000-4000-8000-000000000002";
const message: IntakeMessage = { id: MID, threadId: THREAD, fromEmail: "client@exemple.invalid", toEmails: ["support@exemple.invalid"],
  currentText: "Merci, cela semble ok.", contentComplete: true, direction: "inbound", receivedAt: "2026-11-25T08:00:00.000Z" };
const FOUR = JSON.stringify(["request", "newsletter", "information", "indeterminate"]);
const FIVE = JSON.stringify(["request", "newsletter", "information", "indeterminate", "acknowledgement"]);
const SENTENCE = "Report nature acknowledgement (with acknowledgement requests) only when";

function reader(enabled: boolean | undefined, nature: string, extra: { routing?: boolean } = {}) {
  const bodies: Parameters<IntakeGeminiCall>[0]["body"][] = [];
  const call: IntakeGeminiCall = async request => {
    bodies.push(request.body);
    const data = JSON.parse(request.body.contents[0].parts[0].text) as { citationCatalogue: { id: string; sourceId: string }[] };
    const quote = data.citationCatalogue.find(e => e.sourceId === "current")!.id;
    return { json: { messageId: MID, nature, requests: [{ id: "r1", kind: "acknowledgement", currentMessageId: MID, quoteId: quote }] },
      metadata: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0, totalTokens: 2 } };
  };
  const readers = createSavIntakeSemanticReaders({ model: "gemini-fixture", call, ...extra, ...(enabled === undefined ? {} : { caseThreadReply: enabled }) });
  return { bodies, analyse: () => readers.analyseMessage({ message, conversation: [message] }, new AbortController().signal) };
}

describe("understanding call", () => {
  it("off: four natures on the wire, no sentence; a nature acknowledgement is refused as before", async () => {
    const { bodies, analyse } = reader(undefined, "request");
    expect((await analyse()).nature).toBe("request");
    expect(JSON.stringify(bodies[0]!.generationConfig)).toContain(FOUR);
    expect(JSON.stringify(bodies[0]!.generationConfig)).not.toContain(FIVE);
    expect(bodies[0]!.systemInstruction.parts[0]!.text).not.toContain(SENTENCE);
    await expect(reader(undefined, "acknowledgement").analyse()).rejects.toThrow();
  });
  // Golden sha256 of the request body taken on origin/main 78160e60 with this very fixture: off, the request is byte-identical to the old code's.
  it("off: the request body is byte-identical to origin/main 78160e60 (without and with routing)", async () => {
    const plain = reader(undefined, "request"), routed = reader(undefined, "request", { routing: true });
    await plain.analyse(); await routed.analyse();
    const sha = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
    expect(sha(plain.bodies[0])).toBe("8d16b3e35e2aaa0bcf1208a42c3a0d1555b6a3e742fc1a75494da5d33d525141");
    expect(sha(routed.bodies[0])).toBe("b5d74669c126dd77875be1c8058ec60097a3f2e7735a753500e065b70e0b44ac");
  });
  it("off and false send the same request", async () => {
    const a = reader(undefined, "request"), b = reader(false, "request");
    await a.analyse(); await b.analyse();
    expect(b.bodies[0]).toEqual(a.bodies[0]);
  });
  it("on: five natures and the sentence; a nature acknowledgement is accepted", async () => {
    const { bodies, analyse } = reader(true, "acknowledgement");
    expect((await analyse()).nature).toBe("acknowledgement");
    expect(JSON.stringify(bodies[0]!.generationConfig)).toContain(FIVE);
    expect(bodies[0]!.systemInstruction.parts[0]!.text).toContain(SENTENCE);
  });
});

describe("launch configuration", () => {
  it("off keeps the previous launch hash; on is a new launch configuration", async () => {
    const { intakeRuntimeConfigurationHash, intakeRuntimeHash, savIntakeRuntimePins } = await import("./runtime-contract");
    const policy = { relationRevision: "synthetic", admittedRelations: [], resources: {} };
    const pins = savIntakeRuntimePins.parse({ mailboxId: "30000000-0000-4000-8000-0000000000aa", receivedAfter: "2026-11-25T00:00:00.000Z", createdAfter: "2026-11-25T00:00:00.000Z",
      expiresAt: "2026-11-25T23:00:00.000Z", codeRevision: "a".repeat(40), policyHash: intakeRuntimeHash(policy), resourcesHash: intakeRuntimeHash([]), maxNanoUsd: 3_000_000_000, maxCalls: 30 });
    const environment = { SAV_GEMINI_API_KEY: "fake", HUBSPOT_ACCESS_TOKEN: "fake" };
    const hash = intakeRuntimeConfigurationHash(pins, environment);
    expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_V2_CASE_THREAD_REPLY: "off" })).toBe(hash);
    expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_V2_CASE_THREAD_REPLY: "true" })).toBe(hash);
    expect(intakeRuntimeConfigurationHash(pins, { ...environment, SAV_V2_CASE_THREAD_REPLY: "on" })).not.toBe(hash);
  });
});
