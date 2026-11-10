import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { caseGeminiDecisionPreflight, caseGeminiDecisionProvider, caseInvestigationPrompt, prepareCaseGeminiDecisionRequest } from "./investigation-v2-providers";
import { caseModelTransportDiagnosticSchema, describeCaseModelTransportDiagnostic } from "./investigation-transport-diagnostic";
import { caseCallLedgerAdapter, type CaseCallLedgerPort } from "./investigation-call-ledger";
import type { CaseInvestigationModelRequest } from "./investigation-runner";
import { retrieveSavKnowledgeByRequest } from "../request-retrieval";

const policy = { revision: "synthetic", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00Z",
  transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 42384, maxOutputTokens: 4096, maxInputBytes: 26000, embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1792 },
  model: { dailyCapMicroUsd: 197000, reserveMicroUsdPerCall: 48000, microUsdPerMillionInputTokens: 750000, microUsdPerMillionOutputTokens: 3750000 },
  embedding: { dailyCapMicroUsd: 3000, reserveMicroUsdPerCall: 1000, microUsdPerMillionInputTokens: 150000 } };
const environment = (p: unknown = policy) => ({ SAV_V2_GEMINI_API_KEY: "synthetic-secret-do-not-log", SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(p) });
const request = () => ({ purpose: "decision", caseId: "synthetic-case", caseVersion: 1, inputKey: "in:synthetic", call: 1,
  subjectKey: "synthetic-subject", callKey: "synthetic-call", caseBudgetKey: "synthetic-budget",
  snapshot: { version: 1, body: { openRequests: [], facts: [], questions: [], trials: [] } }, events: [], knowledge: [], coverage: null, feedback: [], closure: [] }) as unknown as CaseInvestigationModelRequest;
const success = () => Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3 } });
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.stubGlobal("fetch", vi.fn(() => { throw Error("EXTERNAL_NETWORK_FORBIDDEN"); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps the existing serialized instructions, schema, facts and all cards EXACTLY; preflight sends nothing", async () => {
  const req = request(); const card = { id: "synthetic-card", contentVersionId: "synthetic-version", title: "Connexion", content: "Donnée synthétique privée é🔒", resolution: { steps: ["Instruction inchangée"] } };
  req.knowledge = [card as never];
  const prepared = prepareCaseGeminiDecisionRequest(req, environment()); expect(prepared.ok).toBe(true); if (!prepared.ok) throw Error("PREPARE_FAILED");
  const prompt = caseInvestigationPrompt(req);
  const expected = JSON.stringify({ systemInstruction: { parts: [{ text: `${prompt.instruction}\n\nSchéma JSON de la réponse :\n${prompt.schema}` }] }, contents: [{ role: "user", parts: [{ text: JSON.stringify(prompt.payload) }] }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: policy.transport.maxOutputTokens } });
  expect(prepared.body).toBe(expected); expect(prepared.metadata.inputBytes).toBe(Buffer.byteLength(expected));
  expect(caseGeminiDecisionPreflight(() => environment())(req)).toBeNull();
  const network = vi.fn(async (url: string, init: RequestInit) => { expect(url).toMatch(/synthetic-model:generateContent$/); expect(init.method).toBe("POST"); return success(); });
  expect(await caseGeminiDecisionProvider({ env: () => environment(), network })(req)).toEqual({ result: { status: "ok", output: {} }, usage: { inputTokens: 10, outputTokens: 5 } });
  expect(network).toHaveBeenCalledOnce(); expect(network.mock.calls[0]![1].body).toBe(expected);
});

it("uses the FULL UTF8 body at the exact limit, rejects one byte less without dropping data", () => {
  const req = request(); req.snapshot.body.facts = [{ value: "é🔒".repeat(1000) }] as never;
  const prepared = prepareCaseGeminiDecisionRequest(req, environment()); if (!prepared.ok) throw Error("PREPARE_FAILED");
  const bytes = prepared.metadata.inputBytes!;
  expect(prepareCaseGeminiDecisionRequest(req, environment({ ...policy, transport: { ...policy.transport, maxInputBytes: bytes } })).ok).toBe(true);
  expect(caseGeminiDecisionPreflight(() => environment({ ...policy, transport: { ...policy.transport, maxInputBytes: bytes - 1 } }))(req)).toMatchObject({ code: "input_too_large", networkAttempted: false, inputBytes: bytes, maxInputBytes: bytes - 1 });
});

it("three cards accepted by REAL retrieval are rejected before MONEY/dispatch, not silently truncated or counted", async () => {
  const candidates = Array.from({ length: 3 }, (_, i) => ({ id: `synthetic-card-${i}`, contentVersionId: `synthetic-version-${i}`, title: "Connexion impossible", content: "Connexion impossible. ".repeat(220), source: "synthetic", verifiedAt: "2026-11-10T00:00:00Z", semanticScore: 1,
    resolution: { steps: ["Connexion impossible. ".repeat(170)], symptoms: ["Connexion impossible"] }, availability: { active: true, published: true, indexed: true, archived: false, aiEnabled: true, locale: "fr-FR", audience: "support" } }));
  const found = await retrieveSavKnowledgeByRequest({ requests: [{ id: "synthetic", summary: "Connexion impossible" }], now: new Date("2026-11-10T12:00:00Z") }, { readRevision: async () => "synthetic", search: async () => [candidates] });
  expect(found.sources).toHaveLength(3);
  const req = request(); req.knowledge = found.sources as never;
  const release = vi.fn(async () => {}), reserve = vi.fn(async () => ({ status: "reserved" as const, token: "synthetic-token", leaseUntil: "2026-11-11T00:00:00Z" }));
  const ledger: CaseCallLedgerPort = { reserve, release, markDispatched: vi.fn(), settle: vi.fn() };
  const money = vi.fn(), provider = vi.fn();
  const call = caseCallLedgerAdapter({ ledger, money, provider, preflight: caseGeminiDecisionPreflight(() => environment()), holder: "synthetic", leaseSeconds: 30, maxPerSubject: 3 });
  for (let n = 0; n < 2; n++) expect(await call(req)).toMatchObject({ status: "input_rejected", diagnostic: { code: "input_too_large", networkAttempted: false, knowledgeCards: 3 } });
  expect(release).toHaveBeenCalledTimes(2); expect(money).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled(); expect(ledger.markDispatched).not.toHaveBeenCalled(); expect(ledger.settle).not.toHaveBeenCalled();
  expect(req.knowledge).toHaveLength(3);
});

it.each(["known", "uncertain", "busy", "subject_exhausted"] as const)("preserves existing ledger precedence for %s without rechecking or replaying", async status => {
  const known = { status: "failed" as const, uncertain: false as const };
  const reservation = status === "known" ? { status, result: known } : status === "busy" ? { status, retryAt: "2027-01-01T00:00:00Z" } : { status };
  const ledger = { reserve: vi.fn(async () => reservation), release: vi.fn(), markDispatched: vi.fn(), settle: vi.fn() } as CaseCallLedgerPort;
  const preflight = vi.fn(), money = vi.fn(), provider = vi.fn();
  const result = await caseCallLedgerAdapter({ ledger, preflight, money, provider, holder: "synthetic", leaseSeconds: 30, maxPerSubject: 3 })(request());
  expect(result).toEqual(status === "known" ? known : status === "uncertain" ? { status: "failed", uncertain: true } : status === "busy" ? { status: "deferred" } : { status: "subject_exhausted" });
  expect(preflight).not.toHaveBeenCalled(); expect(money).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
});

it.each([400, 401, 403, 404, 408, 429, 500, 503])("retains HTTP %s without a provider error body, preserves existing uncertainty", async status => {
  const network = vi.fn(async () => new Response("synthetic-private-provider-body", { status }));
  const answer = await caseGeminiDecisionProvider({ env: () => environment(), network })(request());
  const uncertain = status === 408 || status === 429 || status >= 500;
  expect(answer).toMatchObject({ result: { status: "failed", uncertain, diagnostic: { stage: "http", code: "http_rejected", networkAttempted: true, httpStatus: status } }, usage: uncertain ? null : { inputTokens: 0, outputTokens: 0 } });
  expect(network).toHaveBeenCalledOnce(); expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("synthetic-private-provider-body");
});

it.each([
  ["MAX_TOKENS", "finish_not_stop"], ["SAFETY", "finish_not_stop"], ["secret-user-data", "finish_not_stop"],
] as const)("keeps a closed finish reason for %s", async (finishReason, code) => {
  const answer = await caseGeminiDecisionProvider({ env: () => environment(), network: async () => Response.json({ candidates: [{ finishReason }] }) })(request());
  expect(answer).toMatchObject({ result: { status: "failed", uncertain: false, diagnostic: { stage: "content", code, finishReason: finishReason === "secret-user-data" ? "UNKNOWN" : finishReason } } });
  expect(JSON.stringify(answer)).not.toContain("secret-user-data");
});

it.each([
  ["network_failed", async () => { throw Error("synthetic-secret-do-not-log"); }, true],
  ["envelope_invalid", async () => Response.json({ candidates: "synthetic-private-text" }), true],
  ["empty_response", async () => Response.json({ candidates: [] }), false],
  ["output_json_invalid", async () => Response.json({ candidates: [{ content: { parts: [{ text: "synthetic-private-text" }] }, finishReason: "STOP" }] }), false],
] as const)("distinguishes %s with no private content in diagnostics/logs", async (code, network, uncertain) => {
  const answer = await caseGeminiDecisionProvider({ env: () => environment(), network })(request());
  expect(answer).toMatchObject({ result: { status: "failed", uncertain, diagnostic: { code, networkAttempted: true } } });
  const text = JSON.stringify([answer, vi.mocked(console.warn).mock.calls]);
  for (const secret of ["synthetic-secret", "synthetic-private", "generativelanguage.googleapis.com"]) expect(text).not.toContain(secret);
});

it("rejects secret-shaped extra fields and unsafe reason strings; operator view never echoes them", () => {
  const good = { stage: "http", code: "http_rejected", networkAttempted: true, httpStatus: 403 };
  expect(caseModelTransportDiagnosticSchema.safeParse(good).success).toBe(true);
  for (const bad of [{ ...good, key: "secret" }, { ...good, message: "customer" }, { ...good, finishReason: "private" }, { ...good, httpStatus: 999 }]) {
    expect(caseModelTransportDiagnosticSchema.safeParse(bad).success).toBe(false); expect(describeCaseModelTransportDiagnostic(bad)).toBeNull();
  }
});
