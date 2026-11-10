import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { compactInvestigationContext, expandInvestigationContext } from "./investigation-context-view";
import { caseInvestigationPrompt, prepareCaseGeminiDecisionRequest, caseGeminiDecisionProvider } from "./investigation-v2-providers";
import type { CaseInvestigationModelRequest } from "./investigation-runner";
const policy = { revision: "synthetic", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00Z",
  transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 42384, maxOutputTokens: 4096, maxInputBytes: 26000, embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1792 },
  model: { dailyCapMicroUsd: 197000, reserveMicroUsdPerCall: 48000, microUsdPerMillionInputTokens: 750000, microUsdPerMillionOutputTokens: 3750000 },
  embedding: { dailyCapMicroUsd: 3000, reserveMicroUsdPerCall: 1000, microUsdPerMillionInputTokens: 150000 } };
const env = { SAV_V2_GEMINI_API_KEY: "synthetic-key", SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(policy) };
const noise = (key: string, n = 90) => Array.from({ length: n }, (_, i) => createHash("sha256").update(`${key}:${i}`).digest("hex")).join(" ");
const req = (knowledge: unknown[] = []) => ({ purpose: "decision", snapshot: { version: 4, body: { openRequests: [{ id: "access", status: "open", summary: "Code absent" }, { id: "finance", status: "open", summary: "Facture à vérifier par un humain" }], facts: [{ id: "f1", value: "Spams déjà vérifiés", source: "mail1" }], questions: [{ id: "q1", text: "Capture déjà demandée", answered: false }], trials: [{ id: "t1", result: "Accès toujours bloqué" }] } }, knowledge, coverage: { missing: ["finance"] }, feedback: ["Ne pas clôturer la facture"], closure: [] }) as unknown as CaseInvestigationModelRequest;
function rawBody(request: CaseInvestigationModelRequest) {
  const p = caseInvestigationPrompt(request);
  return JSON.stringify({ systemInstruction: { parts: [{ text: `${p.instruction}\n\nSchéma JSON de la réponse :\n${p.schema}` }] }, contents: [{ role: "user", parts: [{ text: JSON.stringify(p.payload) }] }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 4096 } });
}
const repeated = "Donnée synthétique é🔒\n\\\" — ne pas répéter les contrôles, finance exclue. ".repeat(40);
it("roundtrips all JSON characters, object keys, identities and source-like injected references exactly", () => {
  const payload = JSON.parse(JSON.stringify({ knowledge: [0, 1, 2].map(i => ({ knowledgeId: `id-${i}`, contentVersionId: `v-${i}`, content: repeated, resolution: { steps: [repeated], denied: ["finance"] } })),
    facts: [repeated, "\ud800\r\n\t😀é", { blockId: "b1", encoding: "sav-case-context.v1", parts: [{ objectId: "o1" }] }],
    malicious: JSON.parse('{"__proto__":{"literal":"do not execute"}}'), nullValue: null, number: 0, truth: false }));
  const before = JSON.stringify(payload), packed = compactInvestigationContext(payload)!;
  expect(JSON.stringify(expandInvestigationContext(packed))).toBe(before);
  expect(JSON.stringify(payload)).toBe(before); expect(Object.prototype).not.toHaveProperty("literal");
});
it("rejects missing references and duplicate replacements, never interpreting customer text as references", () => {
  const packed = compactInvestigationContext({ a: repeated, b: repeated })!;
  const invalid = structuredClone(packed); invalid.blocks = [];
  expect(() => expandInvestigationContext(invalid)).toThrow();
  const duplicate = structuredClone(packed); duplicate.fields.push(duplicate.fields[0]);
  expect(() => expandInvestigationContext(duplicate)).toThrow();
});
it("keeps different sources and different content even when they share identical metadata", () => {
  const payload = { cards: [0, 1, 2].map(i => ({ id: `source-${i}`, version: `version-${i}`, content: `Unique ${i} ${repeated}`, resolution: { steps: [repeated], exclusions: ["finance"] } })) };
  const packed = compactInvestigationContext(payload)!;
  expect(JSON.stringify(expandInvestigationContext(packed))).toBe(JSON.stringify(payload));
});
it("fits three distinct cards with repeated metadata, retaining exact logical history and canonical schema", () => {
  const request = req([0, 1, 2].map(i => ({ id: `source-${i}`, contentVersionId: `version-${i}`, title: `Source ${i}`, content: `Unique ${i}\n${repeated}`, resolution: { steps: [repeated], exclusions: [repeated] } })));
  const raw = rawBody(request); expect(Buffer.byteLength(raw)).toBeGreaterThan(26000);
  const p = prepareCaseGeminiDecisionRequest(request, env); expect(p.ok).toBe(true); if (!p.ok) throw Error("PREPARE_FAILED");
  expect(p.metadata.inputBytes).toBe(Buffer.byteLength(p.body)); expect(Buffer.byteLength(p.body)).toBeLessThanOrEqual(26000);
  const wire = JSON.parse(p.body), view = JSON.parse(wire.contents[0].parts[0].text);
  expect(JSON.stringify(expandInvestigationContext(view))).toBe(JSON.stringify(caseInvestigationPrompt(request).payload));
  expect(wire.systemInstruction.parts[0].text).toContain(JSON.parse(raw).systemInstruction.parts[0].text);
  expect(wire.generationConfig).toEqual(JSON.parse(raw).generationConfig);
});
it("single small card uses unchanged wire bytes; inherited 6000-character projection remains explicit", () => {
  const request = req([{ id: "a", contentVersionId: "v", title: "Titre", content: noise("single", 120), resolution: {} }]);
  expect(caseInvestigationPrompt(request).payload.knowledge[0].content).toHaveLength(6000);
  const p = prepareCaseGeminiDecisionRequest(request, env); if (!p.ok) throw Error("PREPARE_FAILED");
  expect(p.body).toBe(rawBody(request));
});
it("distinct incompressible cards still refuse before network with the unchanged cap", async () => {
  const request = req([0, 1, 2].map(i => ({ id: `s${i}`, contentVersionId: `v${i}`, title: "Synthétique", content: noise(`content${i}`), resolution: { steps: [noise(`steps${i}`, 60)] } })));
  const network = vi.fn(); const result = await caseGeminiDecisionProvider({ env: () => env, network })(request);
  expect(result).toMatchObject({ result: { status: "failed", uncertain: false, diagnostic: { code: "input_too_large", networkAttempted: false, maxInputBytes: 26000 } } });
  expect(network).not.toHaveBeenCalled();
});
it("preserves an optional incident envelope exactly without giving it authority or shortening it", () => {
  const payload = { facts: [repeated], temporaryIncidents: { scope: "bound", entries: [0, 1].map(i => ({ proof: { incidentId: `i${i}`, canonicalRevisionId: `r${i}` }, reply: repeated, grantsActions: false })), fingerprint: "synthetic" } };
  const view = compactInvestigationContext(payload)!;
  expect(JSON.stringify(expandInvestigationContext(view))).toBe(JSON.stringify(payload));
});
it("preserves closure checks and no-reference payloads", () => {
  expect(compactInvestigationContext({ a: "unique", b: true, c: null })).toBeNull();
  const request = req(); request.purpose = "resolution_check";
  const p = prepareCaseGeminiDecisionRequest(request, env); if (!p.ok) throw Error("PREPARE_FAILED");
  expect(p.body).toBe(rawBody(request));
});
