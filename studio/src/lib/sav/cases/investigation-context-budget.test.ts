import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseDecisionBodyBreakdown, caseGeminiDecisionBody, SAV_CASE_BREAKDOWN_MAX_CARDS, type CaseDecisionBodyBreakdown } from "./investigation-context-budget";
import { measureCaseContextFixture } from "./investigation-context-measure";
import { caseModelTransportDiagnosticSchema, describeCaseModelTransportDiagnostic } from "./investigation-transport-diagnostic";
import { caseGeminiDecisionPreflight, caseGeminiDecisionProvider, caseInvestigationPrompt, prepareCaseGeminiDecisionRequest } from "./investigation-v2-providers";
import type { CaseInvestigationModelRequest } from "./investigation-runner";

/*
 * K1 (12/11), SYN only: the size of a V2 decision request, broken down into its fixed part (instruction, JSON schema, envelope), the case
 * and each card, measured on the very body the transport serializes. The diagnostic keeps its former shape when the breakdown is absent.
 */

const policy = { revision: "synthetic", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00Z",
  transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 42384, maxOutputTokens: 4096, maxInputBytes: 26000, embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1792 },
  model: { dailyCapMicroUsd: 197000, reserveMicroUsdPerCall: 48000, microUsdPerMillionInputTokens: 750000, microUsdPerMillionOutputTokens: 3750000 },
  embedding: { dailyCapMicroUsd: 3000, reserveMicroUsdPerCall: 1000, microUsdPerMillionInputTokens: 150000 } };
const environment = (maxInputBytes = 26000) => ({ SAV_V2_GEMINI_API_KEY: "synthetic-secret-do-not-log", SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding",
  SAV_V2_SPEND_POLICY_JSON: JSON.stringify({ ...policy, transport: { ...policy.transport, maxInputBytes } }) });
const card = (id: string, size: number) => ({ id, contentVersionId: `${id}-v1`, title: `Fiche synthétique ${id}`, source: "synthetic",
  content: `Procédure synthétique ${id} é🔒 `.repeat(size), resolution: { steps: [`Étape ${id}`], symptoms: [`Symptôme ${id}`], escalation: "Transférer." } });
const request = (cards: ReturnType<typeof card>[]) => ({ purpose: "decision", caseId: "synthetic-case", caseVersion: 3, inputKey: "in:synthetic", call: 1,
  subjectKey: "synthetic-subject", callKey: "synthetic-call", caseBudgetKey: "synthetic-budget",
  snapshot: { version: 3, body: { openRequests: [{ id: "r1", status: "open", summary: "Demande synthétique." }], facts: [{ value: "Fait synthétique." }], questions: [], trials: [] } },
  events: [], knowledge: cards, coverage: [{ requestId: "r1", family: "access", status: "covered", knowledge: cards.map(c => ({ knowledgeId: c.id, contentVersionId: c.contentVersionId })), limitations: [] }],
  feedback: [], closure: [] }) as unknown as CaseInvestigationModelRequest;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.stubGlobal("fetch", vi.fn(() => { throw Error("EXTERNAL_NETWORK_FORBIDDEN"); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("K1 breakdown of the decision body", () => {
  it("fixed + case + cards add up to the exact serialized body; each card counts what removing it saves", () => {
    const req = request([card("a", 20), card("b", 60), card("c", 5)]);
    const prompt = caseInvestigationPrompt(req);
    const body = caseGeminiDecisionBody(prompt, prompt.payload, 4096);
    const b = caseDecisionBodyBreakdown(prompt, 4096);
    expect(b.rawBytes).toBe(bytes(body));
    expect(b.fixedBytes + b.caseBytes + b.knowledgeBytes).toBe(b.rawBytes);
    expect(b.fixedBytes).toBe(bytes(caseGeminiDecisionBody(prompt, {}, 4096)));
    expect(b.cards.map(row => row.knowledgeId)).toEqual(["a", "b", "c"]);
    for (const [index, row] of b.cards.entries()) {
      const without = { ...prompt.payload, knowledge: prompt.payload.knowledge.filter((_, i) => i !== index) };
      expect(row.bytes).toBe(b.rawBytes - bytes(caseGeminiDecisionBody(prompt, without, 4096)));
    }
    // The biggest card weighs the most; the JSON schema and instruction stay in the fixed part, whatever the cards.
    expect(b.cards[1]!.bytes).toBeGreaterThan(b.cards[0]!.bytes);
    expect(caseDecisionBodyBreakdown(caseInvestigationPrompt(request([])), 4096).fixedBytes).toBe(b.fixedBytes);
    expect(b.fixedBytes).toBeGreaterThan(bytes(prompt.schema));
  });

  it("the transport body is unchanged: the same bytes as before the breakdown existed", () => {
    const req = request([card("a", 10)]);
    const prepared = prepareCaseGeminiDecisionRequest(req, environment());
    if (!prepared.ok) throw Error("PREPARE_FAILED");
    const prompt = caseInvestigationPrompt(req);
    expect(prepared.body).toBe(JSON.stringify({ systemInstruction: { parts: [{ text: `${prompt.instruction}\n\nSchéma JSON de la réponse :\n${prompt.schema}` }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(prompt.payload) }] }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 4096 } }));
  });

  const distinct = (id: string) => ({ ...card(id, 1), content: Array.from({ length: 700 }, (_, j) => createHash("sha256").update(`${id}-${j}`).digest("hex").slice(0, 12)).join(" ") });
  const loggedBreakdown = () => vi.mocked(console.warn).mock.calls.filter(([name]) => name === "sav_v2_model_transport").map(([, value]) => (value as { breakdown?: CaseDecisionBodyBreakdown }).breakdown);

  it("input_too_large: the breakdown goes to the structured log only (ids and byte counts), never into the diagnostic the record stores", () => {
    const req = request([distinct("a"), distinct("b"), distinct("c")]);
    const diagnostic = caseGeminiDecisionPreflight(() => environment())(req);
    expect(diagnostic).toEqual({ stage: "preflight", code: "input_too_large", networkAttempted: false, inputBytes: expect.any(Number), maxInputBytes: 26000, knowledgeCards: 3 });
    expect(diagnostic).not.toHaveProperty("breakdown");
    const [breakdown] = loggedBreakdown();
    expect(breakdown!.cards.map(row => row.knowledgeId)).toEqual(["a", "b", "c"]);
    expect(breakdown!.truncated).toBe(false);
    expect(breakdown!.fixedBytes + breakdown!.caseBytes + breakdown!.knowledgeBytes).toBe(breakdown!.rawBytes);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(distinct("a").content.slice(0, 40));
  });

  it("a provider failure logs the breakdown of the body it sent; its stored diagnostic has none", async () => {
    const answer = await caseGeminiDecisionProvider({ env: () => environment(), network: async () => new Response("x", { status: 400 }) })(request([card("a", 10)]));
    expect(answer.result).toMatchObject({ status: "failed", diagnostic: { code: "http_rejected" } });
    expect((answer.result as { diagnostic: object }).diagnostic).not.toHaveProperty("breakdown");
    expect(loggedBreakdown()[0]).toMatchObject({ cards: [{ knowledgeId: "a", contentVersionId: "a-v1" }], truncated: false });
  });

  it("rollback safety: the stored diagnostic schema is main's, byte for byte (no new field); a record with a breakdown is refused as before", () => {
    // The exact field list of origin/main (ae2558c): a record written here is readable by main, and the reverse.
    expect(Object.keys(caseModelTransportDiagnosticSchema.shape)).toEqual(["stage", "code", "networkAttempted", "inputBytes", "maxInputBytes", "knowledgeCards", "httpStatus", "finishReason"]);
    const old = { stage: "preflight", code: "input_too_large", networkAttempted: false, inputBytes: 32336, maxInputBytes: 26000, knowledgeCards: 3 };
    expect(caseModelTransportDiagnosticSchema.parse(old)).toEqual(old);
    expect(describeCaseModelTransportDiagnostic(old)).toEqual({ label: "Contexte trop volumineux : aucun appel de génération envoyé.",
      detail: "input_too_large · preflight · 32336 octets / limite 26000 · 3 fiche(s)" });
    expect(caseModelTransportDiagnosticSchema.safeParse({ ...old, breakdown: {} }).success).toBe(false);
  });

  it("past 200 cards the breakdown keeps the 200 largest with `truncated`, never fails; its size stays bounded", () => {
    const cards = Array.from({ length: 250 }, (_, i) => ({ ...card(`c${String(i).padStart(3, "0")}`, 1), content: "x".repeat(i + 1) }));
    const b = caseDecisionBodyBreakdown(caseInvestigationPrompt(request(cards)), 4096);
    expect(b.truncated).toBe(true);
    expect(b.cards).toHaveLength(SAV_CASE_BREAKDOWN_MAX_CARDS);
    expect(SAV_CASE_BREAKDOWN_MAX_CARDS).toBe(200);
    // The largest ones, in body order; totals still describe every card.
    expect(b.cards.map(row => row.knowledgeId)).toEqual(cards.slice(50).map(row => row.id));
    expect(b.fixedBytes + b.caseBytes + b.knowledgeBytes).toBe(b.rawBytes);
    expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThan(30_000);
    const diagnostic = caseGeminiDecisionPreflight(() => environment())(request(cards));
    expect(diagnostic).toMatchObject({ code: "input_too_large", knowledgeCards: 250 });
    expect(caseModelTransportDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
  });
});

describe("K1 local measurement tool on the committed synthetic fixture", () => {
  it("is reproducible and adds up: fixed + case + cards = total; the 85 % target and the room for cards follow", async () => {
    const { readFileSync } = await import("node:fs");
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/syn-context-budget.v1.json", import.meta.url), "utf8"));
    const first = measureCaseContextFixture(fixture), second = measureCaseContextFixture(fixture);
    expect(second).toEqual(first);
    expect(first.fixedBytes + first.caseBytes + first.knowledgeBytes).toBe(first.totalBytes);
    expect(first.targetBytes).toBe(Math.floor(26000 * 0.85));
    expect(first.cardsRoomBytes).toBe(first.targetBytes - first.fixedBytes - first.caseBytes);
    expect(first.cards.map(row => row.knowledgeId)).toEqual(["syn-measure-0", "syn-measure-1", "syn-measure-2"]);
    expect(first.largestFirst[0]).toBe("syn-measure-1");
    // The card longer than the prompt's 6 000-character cut is flagged (K4 will replace the cut), measured as actually sent.
    expect(first.cards.find(row => row.knowledgeId === "syn-measure-1")).toMatchObject({ cutAt6000: true });
    expect(first.cards.find(row => row.knowledgeId === "syn-measure-2")).toMatchObject({ cutAt6000: false });
    // A different bound only moves the target, never the measured bytes.
    const wider = measureCaseContextFixture({ ...fixture, maxInputBytes: 80000 });
    expect(wider.totalBytes).toBe(first.totalBytes);
    expect(wider.targetBytes).toBe(68000);
  });
});
