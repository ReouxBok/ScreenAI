import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseGeminiDecisionBody } from "./investigation-context-budget";
import { measureCaseContextFixture, type CaseContextFixture } from "./investigation-context-measure";
import { compactCaseKnowledgeContent } from "./investigation-prompt-compact";
import { caseDecisionProviderSchema, caseInvestigationPrompt, caseInvestigationPromptRevision, prepareCaseGeminiDecisionRequest } from "./investigation-v2-providers";
import type { CaseInvestigationModelRequest } from "./investigation-runner";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/syn-context-budget.v1.json", import.meta.url), "utf8")) as CaseContextFixture;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const request = (purpose: "decision" | "resolution_check" = "decision") => ({ purpose, snapshot: { version: 1, body: { openRequests: [], facts: [], questions: [], trials: [] } },
  knowledge: [{ id: "synthetic", contentVersionId: "synthetic-v1", title: "Accès fictif", content: "Texte fictif.", resolution: { steps: ["Étape fictive."], exceptions: ["Ne jamais changer un droit."] } }],
  coverage: null, feedback: [], closure: [] }) as unknown as CaseInvestigationModelRequest;
const policy = { revision: "synthetic", approvedBy: "20000000-0000-4000-8000-000000000004", approvedAt: "2026-11-01T00:00:00Z",
  transport: { model: "synthetic-model", embeddingModel: "synthetic-embedding", priceExpiresAt: "2027-01-01T00:00:00Z", maxInputTokens: 42384, maxOutputTokens: 4096, maxInputBytes: 26000, embeddingMaxInputTokens: 2048, embeddingMaxTexts: 3, embeddingMaxTextBytes: 1792 },
  model: { dailyCapMicroUsd: 197000, reserveMicroUsdPerCall: 48000, microUsdPerMillionInputTokens: 750000, microUsdPerMillionOutputTokens: 3750000 },
  embedding: { dailyCapMicroUsd: 3000, reserveMicroUsdPerCall: 1000, microUsdPerMillionInputTokens: 150000 } };
const env = { SAV_V2_GEMINI_API_KEY: "synthetic", SAV_V2_MODEL: "synthetic-model", SAV_V2_EMBEDDING_MODEL: "synthetic-embedding", SAV_V2_SPEND_POLICY_JSON: JSON.stringify(policy) };

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("SAV-92 compact prompt (offline, synthetic, attachments off)", () => {
  it("prints reproducible wire sizes for every compact/structured combination on the existing Access fixture", () => {
    const measure = () => [false, true].flatMap(compact => [false, true].map(structuredOutput => ({ compact, structuredOutput,
      ...measureCaseContextFixture(fixture, { compact, structuredOutput }) })));
    const rows = measure();
    expect(measure()).toEqual(rows);
    console.table(rows.map(({ compact, structuredOutput, totalBytes }) => ({ compact, structuredOutput, totalBytes })));
    expect(rows.find(row => row.compact && row.structuredOutput)!.totalBytes).toBeLessThanOrEqual(22000);
  });

  for (const purpose of ["decision", "resolution_check"] as const) it(`${purpose}: off has the legacy SHA-256; native schema removed only with both flags on`, () => {
    const req = request(purpose), prompt = caseInvestigationPrompt(req);
    const legacy = JSON.stringify({ systemInstruction: { parts: [{ text: `${prompt.instruction}\n\nSchéma JSON de la réponse :\n${prompt.schema}` }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(prompt.payload) }] }], generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 4096 } });
    for (const flag of [undefined, "off", "invalid"]) {
      const prepared = prepareCaseGeminiDecisionRequest(req, { ...env, SAV_V2_PROMPT_COMPACT: flag });
      expect(prepared).toMatchObject({ ok: true });
      if (!prepared.ok) throw Error("prepare");
      expect(hash(prepared.body)).toBe(hash(legacy));
      expect(hash(prepared.body)).toBe(purpose === "decision" ? "daf597e6e0b707f80852c50bd655bac9f13163dbe738797dc8f5bedb79b99929" : "e90239c01d21d104b7768057048191e5a585d69a9653a19fdfae5bd7611c0de8");
    }
    for (const compact of [false, true]) for (const structuredOutput of [false, true]) {
      const prepared = prepareCaseGeminiDecisionRequest(req, { ...env, SAV_V2_PROMPT_COMPACT: compact ? "on" : "off", SAV_V2_STRUCTURED_OUTPUT: structuredOutput ? "on" : "off" });
      if (!prepared.ok) throw Error("prepare");
      const body = JSON.parse(prepared.body);
      expect(body.systemInstruction.parts[0].text.includes("Schéma JSON de la réponse")).toBe(!(compact && structuredOutput));
      expect(body.generationConfig.responseJsonSchema).toEqual(structuredOutput ? caseDecisionProviderSchema(purpose) : undefined);
      expect(prepared.body).toBe(caseGeminiDecisionBody(caseInvestigationPrompt(req, { compact, structuredOutput }), caseInvestigationPrompt(req, { compact, structuredOutput }).payload, 4096, "", structuredOutput ? { responseJsonSchema: caseDecisionProviderSchema(purpose) } : {}));
    }
  });

  it("preserves exceptions, warnings, unknown prose beyond 6000, source/version identities and all structured metadata", () => {
    const resolution = { steps: ["Ouvrir le diagnostic."], exceptions: ["Ne pas appliquer aux invités."], warnings: ["Ne jamais demander de code."], sources: ["https://example.invalid/source"], productVersion: "synthetic-v2" };
    const content = `## Étapes\nOuvrir le diagnostic.\n\n## Exceptions\nNe pas appliquer aux invités.\n\n## Avertissements\nNe jamais demander de code.\n\n## Sources\nhttps://example.invalid/source\n\n## Autre\n${"x".repeat(6100)}\nAttention : conserver cette réserve.`;
    const req = request();
    req.knowledge[0] = { ...req.knowledge[0], content, resolution, source: "https://example.invalid/card" };
    const prompt = caseInvestigationPrompt(req, { compact: true });
    expect(prompt.payload.knowledge[0]).toMatchObject({ knowledgeId: "synthetic", contentVersionId: "synthetic-v1", source: "https://example.invalid/card", resolution });
    expect(prompt.payload.knowledge[0].content).toContain("Attention : conserver cette réserve.");
    expect(prompt.payload.knowledge[0].content).not.toContain("Ouvrir le diagnostic.");
    for (const literal of [resolution.steps[0], resolution.exceptions[0], resolution.warnings[0], resolution.sources[0]]) expect(JSON.stringify(prompt.payload)).toContain(literal);
    expect(compactCaseKnowledgeContent("## Exceptions\nOuvrir le diagnostic.", { steps: ["Ouvrir le diagnostic."] })).toContain("## Exceptions");
    expect(compactCaseKnowledgeContent("Texte inconnu avec avertissement.", null)).toBe("Texte inconnu avec avertissement.");
    expect(caseInvestigationPromptRevision(false, { SAV_V2_PROMPT_COMPACT: "on" })).toContain("+compact1");
  });
});
