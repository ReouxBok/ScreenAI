import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { caseDecisionProposalSchema } from "./decision-contract";
import { caseDecisionBodyBreakdown } from "./investigation-context-budget";
import { caseDecisionPromptRevision, caseProviderJsonSchema, readCaseDecisionGeneration } from "./investigation-decision-generation";
import type { CaseInvestigationModelRequest } from "./investigation-runner";
import { caseDecisionProviderSchema, caseGeminiDecisionProvider, caseInvestigationPrompt, caseInvestigationPromptRevision, prepareCaseGeminiDecisionRequest,
  SAV_CASE_INVESTIGATION_PROMPT_REVISION } from "./investigation-v2-providers";
import { readCaseV2TransportPolicy } from "./investigation-v2-spend";

// Synthetic only: no real key, model call or customer data. The network is a mock.
const MODEL = "gemini-3.6-flash";
const policy = { revision: "synthetic", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00Z",
  transport: { model: MODEL, embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 131072, maxOutputTokens: 1024, maxInputBytes: 100_000,
    embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1024 },
  model: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 200_000, microUsdPerMillionInputTokens: 1_000_000, microUsdPerMillionOutputTokens: 1_000_000 },
  embedding: { dailyCapMicroUsd: 2_000_000, reserveMicroUsdPerCall: 10_000, microUsdPerMillionInputTokens: 1_000_000 } };
const env = (flags: Record<string, string> = {}, p: unknown = policy, model = MODEL) => ({ SAV_V2_GEMINI_API_KEY: "synthetic-key", SAV_V2_MODEL: model,
  SAV_V2_EMBEDDING_MODEL: "synthetic-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(p), ...flags });
const request = (purpose: "decision" | "resolution_check" = "decision") => ({ purpose, snapshot: { version: 1, body: { openRequests: [], facts: [], questions: [], trials: [] } },
  knowledge: [], coverage: null, feedback: [], closure: [] }) as unknown as CaseInvestigationModelRequest;
const okResponse = () => Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 300 } });
type WireBody = { systemInstruction: { parts: Array<{ text: string }> }; generationConfig: Record<string, unknown> };
const send = async (flags: Record<string, string>, purpose: "decision" | "resolution_check" = "decision", model = MODEL) => {
  const network = vi.fn(async (_url: string, _init: RequestInit) => okResponse());
  const result = await caseGeminiDecisionProvider({ env: () => env(flags, model === MODEL ? policy : { ...policy, transport: { ...policy.transport, model } }, model), network })(request(purpose));
  return { result, network, body: network.mock.calls[0] ? JSON.parse(String(network.mock.calls[0][1].body)) as WireBody : null, raw: network.mock.calls[0] ? String(network.mock.calls[0][1].body) : null };
};
/** The pre-SAV-92 wire format, copied verbatim from main (8bcdb4c), to prove the flags off change no byte. */
const legacyBody = (instruction: string, schema: string, payload: unknown, maxOutputTokens: number) => JSON.stringify({ systemInstruction: { parts: [{ text: `${instruction}\n\nSchéma JSON de la réponse :\n${schema}` }] },
  contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens } });
const keysOf = (node: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(node)) node.forEach(child => keysOf(child, found));
  else if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) {
    found.add(key);
    if (key === "properties") Object.values(value as object).forEach(child => keysOf(child, found)); else keysOf(value, found);
  }
  return found;
};

describe("SAV-92 idée 3 — flags off: today's request, byte for byte", () => {
  for (const flags of [{}, { SAV_V2_STRUCTURED_OUTPUT: "off" }, { SAV_V2_STRUCTURED_OUTPUT: " ", SAV_V2_THINKING_DECISION: "" }] as Array<Record<string, string>>) it(`flags ${JSON.stringify(flags)}`, async () => {
    const { raw, body, network } = await send(flags);
    expect(network).toHaveBeenCalledTimes(1);
    const prompt = caseInvestigationPrompt(request());
    expect(raw).toBe(legacyBody(prompt.instruction, prompt.schema, prompt.payload, 1024));
    expect(body!.generationConfig).toEqual({ responseMimeType: "application/json", temperature: 0, maxOutputTokens: 1024 });
    expect(caseInvestigationPromptRevision(env(flags))).toBe(SAV_CASE_INVESTIGATION_PROMPT_REVISION);
  });
});

describe("SAV_V2_STRUCTURED_OUTPUT=on", () => {
  it("sends the decision schema as responseJsonSchema, keeps the mime type, the bound and the schema text of the instruction", async () => {
    const { body, result } = await send({ SAV_V2_STRUCTURED_OUTPUT: "on" });
    const config = body!.generationConfig;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.maxOutputTokens).toBe(1024);
    expect(config).not.toHaveProperty("responseSchema");
    expect(config).not.toHaveProperty("thinkingConfig");
    expect(config.responseJsonSchema).toEqual(caseDecisionProviderSchema("decision"));
    const prompt = caseInvestigationPrompt(request());
    expect(body!.systemInstruction.parts[0].text).toBe(`${prompt.instruction}\n\nSchéma JSON de la réponse :\n${prompt.schema}`);
    // The provider only transports: its output still goes to the validator, untouched ("{}" is not a valid proposal and is returned as is).
    expect(result).toMatchObject({ result: { status: "ok", output: {} }, usage: { inputTokens: 10, outputTokens: 302 } });
  });

  it("the provider copy uses only keywords Gemini documents for responseJsonSchema", () => {
    const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum", "enum", "anyOf"]);
    for (const purpose of ["decision", "resolution_check"] as const) {
      const used = keysOf(caseDecisionProviderSchema(purpose));
      expect([...used].filter(key => !allowed.has(key))).toEqual([]);
    }
    const nextAction = (caseDecisionProviderSchema("decision").properties as Record<string, { anyOf: Array<{ properties: { kind: unknown } }> }>).nextAction!;
    expect(nextAction.anyOf.map(branch => branch.properties.kind)).toEqual(["ask", "answer", "confirm_resolution", "handoff", "observe_only"].map(kind => ({ type: "string", enum: [kind] })));
  });

  it("the validator's schema keeps every constraint the copy drops", () => {
    const original = keysOf(z.toJSONSchema(caseDecisionProposalSchema, { io: "input", unrepresentable: "any" }));
    for (const key of ["minLength", "maxLength", "pattern", "const", "oneOf"]) expect(original.has(key)).toBe(true);
  });

  it("the resolution check gets the closure schema", async () => {
    const { body } = await send({ SAV_V2_STRUCTURED_OUTPUT: "on" }, "resolution_check");
    expect(body!.generationConfig.responseJsonSchema).toEqual(caseDecisionProviderSchema("resolution_check"));
    expect(body!.generationConfig.responseJsonSchema).not.toEqual(caseDecisionProviderSchema("decision"));
  });

  it("the byte budget measures the provider schema too (breakdown = body actually built)", () => {
    const tight = { ...policy, transport: { ...policy.transport, maxInputBytes: 1 } };
    const prepared = prepareCaseGeminiDecisionRequest(request(), env({ SAV_V2_STRUCTURED_OUTPUT: "on" }, tight));
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.diagnostic).toMatchObject({ code: "input_too_large", networkAttempted: false });
    expect(prepared.breakdown!.rawBytes).toBe(prepared.diagnostic.inputBytes);
    const off = prepareCaseGeminiDecisionRequest(request(), env({}, tight));
    expect(!off.ok && off.diagnostic.inputBytes! < prepared.diagnostic.inputBytes!).toBe(true);
    expect(!off.ok && off.breakdown!.rawBytes).toBe(caseDecisionBodyBreakdown(caseInvestigationPrompt(request()), 1024).rawBytes);
  });
});

describe("caseProviderJsonSchema", () => {
  it("rewrites const and oneOf, drops annotations and length/pattern, refuses anything unknown", () => {
    expect(caseProviderJsonSchema({ $schema: "x", oneOf: [{ type: "object", properties: { k: { type: "string", const: "a" }, t: { type: "string", minLength: 1, maxLength: 9, pattern: "^a$" } },
      required: ["k"], additionalProperties: false, default: {} }] })).toEqual({ anyOf: [{ type: "object", properties: { k: { type: "string", enum: ["a"] }, t: { type: "string" } }, required: ["k"], additionalProperties: false }] });
    for (const schema of [{ type: "string", contentEncoding: "base64" }, { $ref: "#/x" }, { allOf: [] }, { type: "object", properties: { a: { not: {} } } }, { const: 1 }])
      expect(() => caseProviderJsonSchema(schema)).toThrow(/SAV_V2_PROVIDER_SCHEMA_UNSUPPORTED/);
  });
});

describe("SAV_V2_THINKING_DECISION", () => {
  for (const level of ["low", "medium", "high"] as const) it(`${level}: thinkingConfig on this call only, same output bound and same reserve`, async () => {
    const { body } = await send({ SAV_V2_THINKING_DECISION: level });
    expect(body!.generationConfig.thinkingConfig).toEqual({ thinkingLevel: level });
    expect(body!.generationConfig.maxOutputTokens).toBe(1024);
    // Thoughts are output tokens inside maxOutputTokens: the per-call reserve covers them whatever the level.
    expect(readCaseV2TransportPolicy(env({ SAV_V2_THINKING_DECISION: level }))).toEqual(readCaseV2TransportPolicy(env()));
    expect(caseInvestigationPromptRevision(env({ SAV_V2_THINKING_DECISION: level }))).toBe(`${SAV_CASE_INVESTIGATION_PROMPT_REVISION}+think-${level}`);
  });

  it("both flags together", async () => {
    const { body } = await send({ SAV_V2_STRUCTURED_OUTPUT: "on", SAV_V2_THINKING_DECISION: "high" });
    expect(Object.keys(body!.generationConfig)).toEqual(["responseMimeType", "temperature", "maxOutputTokens", "responseJsonSchema", "thinkingConfig"]);
    expect(caseInvestigationPromptRevision(env({ SAV_V2_STRUCTURED_OUTPUT: "on", SAV_V2_THINKING_DECISION: "high" }))).toBe(`${SAV_CASE_INVESTIGATION_PROMPT_REVISION}+so1+think-high`);
  });
});

describe("authority and V1 continuity", () => {
  it("V1's configHash ignores both flags (V1 is never frozen by them)", async () => {
    const { intakeRuntimeConfigurationHash, savIntakeRuntimePins } = await import("../intake/runtime-contract");
    const { SAV_INTAKE_BUDGET_BOUNDS } = await import("../intake/budget-profile");
    const pins = savIntakeRuntimePins.parse({ mailboxId: "20000000-0000-4000-8000-000000000001", createdAfter: "2026-11-01T00:00:00Z", receivedAfter: "2026-11-01T00:00:00Z",
      expiresAt: "2026-12-01T00:00:00Z", codeRevision: "a".repeat(40), resourcesHash: "b".repeat(64), policyHash: "c".repeat(64),
      maxNanoUsd: SAV_INTAKE_BUDGET_BOUNDS.qualification.maxNanoUsd, maxCalls: SAV_INTAKE_BUDGET_BOUNDS.qualification.maxCalls });
    const v1 = { SAV_GEMINI_API_KEY: "synthetic-v1-key", HUBSPOT_ACCESS_TOKEN: "synthetic-token" };
    const base = intakeRuntimeConfigurationHash(pins, v1);
    expect(intakeRuntimeConfigurationHash(pins, { ...v1, SAV_V2_STRUCTURED_OUTPUT: "on", SAV_V2_THINKING_DECISION: "high" })).toBe(base);
  });
});

describe("review P2-1: a mistyped flag is refused by the factory, with its precise code, before any knowledge search", () => {
  const cases: Array<[Record<string, string>, string, string]> = [
    [{ SAV_V2_STRUCTURED_OUTPUT: "On" }, MODEL, "v2_structured_output_invalid"],
    [{ SAV_V2_THINKING_DECISION: "minimal" }, MODEL, "v2_thinking_decision_invalid"],
    [{ SAV_V2_THINKING_DECISION: "high" }, "gemini-2.5-flash", "v2_thinking_decision_model_unsupported"],
  ];
  for (const [flags, model, code] of cases) it(`${JSON.stringify(flags)} on ${model} -> ${code}`, async () => {
    const { createCaseInvestigationV2Deps } = await import("./investigation-v2-factory");
    const network = vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); });
    const p = model === MODEL ? policy : { ...policy, transport: { ...policy.transport, model } };
    const built = createCaseInvestigationV2Deps({ env: () => ({ ...env(flags, p, model), SAV_V2_INVESTIGATION: "observe" }), readPolicyRecord: async () => null, network });
    expect(built).toEqual({ ok: false, refusals: [code] });
    expect(network).not.toHaveBeenCalled();
  });

  it("valid flags build the ports as before (nothing called while building)", async () => {
    const { createCaseInvestigationV2Deps } = await import("./investigation-v2-factory");
    const network = vi.fn(async () => { throw Error("NETWORK_FORBIDDEN"); });
    for (const flags of [{}, { SAV_V2_STRUCTURED_OUTPUT: "on", SAV_V2_THINKING_DECISION: "medium" }] as Array<Record<string, string>>) {
      const built = createCaseInvestigationV2Deps({ env: () => ({ ...env(flags), SAV_V2_INVESTIGATION: "observe" }), readPolicyRecord: async () => null, network });
      expect(built.ok).toBe(true);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("the preflight (second barrier) keeps policy_invalid in the stored diagnostic and logs the precise reason beside it", async () => {
    const { caseGeminiDecisionPreflight } = await import("./investigation-v2-providers");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const diagnostic = caseGeminiDecisionPreflight(() => env({ SAV_V2_THINKING_DECISION: "HIGH" }))(request());
      expect(diagnostic).toEqual({ stage: "preflight", code: "policy_invalid", networkAttempted: false });
      expect(warn).toHaveBeenCalledWith("sav_v2_model_transport", { stage: "preflight", code: "policy_invalid", networkAttempted: false, problem: "v2_thinking_decision_invalid" });
    } finally { warn.mockRestore(); }
  });
});

describe("review P2-2: the K1 measurement tool sees the provider schema", () => {
  it("on adds exactly the provider schema to the fixed part; off is the previous measure", async () => {
    const { readFileSync } = await import("node:fs");
    const { measureCaseContextFixture } = await import("./investigation-context-measure");
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/syn-context-budget.v1.json", import.meta.url), "utf8"));
    const off = measureCaseContextFixture(fixture), on = measureCaseContextFixture(fixture, { structuredOutput: true });
    expect(measureCaseContextFixture(fixture, { structuredOutput: false })).toEqual(off);
    const added = Buffer.byteLength(`,"responseJsonSchema":${JSON.stringify(caseDecisionProviderSchema("decision"))}`, "utf8");
    expect(added).toBeGreaterThan(6_000);
    expect(on.fixedBytes - off.fixedBytes).toBe(added);
    expect(on.totalBytes - off.totalBytes).toBe(added);
    expect([on.caseBytes, on.knowledgeBytes]).toEqual([off.caseBytes, off.knowledgeBytes]);
    expect(on.cardsRoomBytes).toBe(off.cardsRoomBytes - added);
    const thinking = measureCaseContextFixture(fixture, { thinkingLevel: "high" });
    expect(thinking.fixedBytes - off.fixedBytes).toBe(Buffer.byteLength(`,"thinkingConfig":{"thinkingLevel":"high"}`, "utf8"));
  });
});

describe("refusals before any network (and before any reservation: same preflight)", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ SAV_V2_STRUCTURED_OUTPUT: "true" }, MODEL], [{ SAV_V2_STRUCTURED_OUTPUT: "ON" }, MODEL],
    [{ SAV_V2_THINKING_DECISION: "minimal" }, MODEL], [{ SAV_V2_THINKING_DECISION: "HIGH" }, MODEL], [{ SAV_V2_THINKING_DECISION: "xhigh" }, MODEL],
    [{ SAV_V2_THINKING_DECISION: "high" }, "gemini-2.5-flash"], [{ SAV_V2_THINKING_DECISION: "low" }, "synthetic-model"],
  ];
  for (const [flags, model] of cases) it(`${JSON.stringify(flags)} on ${model}`, async () => {
    const { result, network } = await send(flags, "decision", model);
    expect(network).not.toHaveBeenCalled();
    expect(result).toMatchObject({ result: { status: "failed", uncertain: false, diagnostic: { stage: "preflight", code: "policy_invalid", networkAttempted: false } }, usage: { inputTokens: 0, outputTokens: 0 } });
    expect(caseInvestigationPromptRevision(env(flags, policy, model))).toBe(SAV_CASE_INVESTIGATION_PROMPT_REVISION);
  });

  it("structured output alone works on any model (no thinking pairing to check)", () => {
    expect(readCaseDecisionGeneration({ SAV_V2_STRUCTURED_OUTPUT: "on" }, "synthetic-model")).toEqual({ ok: true, generation: { structuredOutput: true, thinkingLevel: null } });
    expect(caseDecisionPromptRevision("base", { ok: false, problem: "v2_thinking_decision_invalid" })).toBe("base");
  });
});
