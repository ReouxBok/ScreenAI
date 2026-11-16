import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caseGeminiDecisionBody } from "./investigation-context-budget";
import { measureCaseContextFixture, type CaseContextFixture } from "./investigation-context-measure";
import { compactCaseKnowledgeContent, selectCaseKnowledgePassages } from "./investigation-prompt-compact";
import { caseDecisionProviderSchema, caseInvestigationPrompt, caseInvestigationPromptRevision, prepareCaseGeminiDecisionRequest } from "./investigation-v2-providers";
import { buildCaseCustomerContext } from "./investigation-customer-context";
import { expandInvestigationContext } from "./investigation-context-view";
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
      expect(hash(prepared.body)).toBe(purpose === "decision" ? "92459496e60ec77b18df30c2c0ee8dd6264f066c385b9820e13a10f5aa23ddae" : "1edc22e000efabb721586b6b355ed6ccc3000d92ea3d7f1b3bfdf33a02195111");
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
    expect(caseInvestigationPromptRevision(false, { SAV_V2_PROMPT_COMPACT: "on" })).toContain("+compact2");
  });
});

const noise = (seed: string, count = 180) => Array.from({ length: count }, (_, i) => hash(`${seed}:${i}`).slice(0, 12)).join(" ");
const largeCard = (seed = "base") => Array.from({ length: 12 }, (_, i) => `## Présentation ${i}\n${noise(`${seed}:${i}`)}`).join("\n\n")
  + "\n\n## Présentation zéphyr\nDétail pertinent : diagnostic zéphyr dans le panneau de démonstration.\n\n## Prérequis\nSession de démonstration ouverte.\n\n## Étapes\nDiagnostic zéphyr : ouvrir le panneau synthétique.\n\n## Exceptions\nNe jamais appliquer aux invités.\n\n## Version\nÉdition exacte SYN-2026.11.";
const unpack = (body: string) => {
  const payload = JSON.parse(JSON.parse(body).contents[0].parts[0].text);
  return payload.encoding ? expandInvestigationContext(payload) as Record<string, unknown> : payload;
};

describe("SAV-92 customer envelope and whole passages", () => {
  it("keeps unfamiliar sections and qualifications inside otherwise optional prose", () => {
    const content = `## Présentation\n${noise("background")}\n\nAttention : appliquer seulement au compte de démonstration.\n\n## Branche inconnue\nCondition opérationnelle à conserver intégralement.`;
    const selected = selectCaseKnowledgePassages(content, {}, "background", 400)!;
    expect(selected).toContain("Attention : appliquer seulement au compte de démonstration.");
    expect(selected).toContain("## Branche inconnue\nCondition opérationnelle à conserver intégralement.");
    expect(selectCaseKnowledgePassages("Texte inconnu sans section.".repeat(50), {}, "texte", 400)).toBeNull();
  });
  it("selects a relevant late passage, keeping prerequisites, exception and exact version deterministically", () => {
    const content = largeCard();
    const selected = selectCaseKnowledgePassages(content, {}, "diagnostic zéphyr", 4_000)!;
    expect(selected).toBe(selectCaseKnowledgePassages(content, {}, "diagnostic zéphyr", 4_000));
    for (const literal of ["Détail pertinent : diagnostic zéphyr", "Session de démonstration ouverte.", "Diagnostic zéphyr", "Ne jamais appliquer aux invités.", "SYN-2026.11"]) expect(selected).toContain(literal);
    expect(Buffer.byteLength(selected)).toBeLessThanOrEqual(4_000);
    expect(selectCaseKnowledgePassages(content, {}, "diagnostic zéphyr", 10)).toBeNull();
    process.stdout.write(JSON.stringify([{ fixture: "large-card", beforeBytes: Buffer.byteLength(content), afterBytes: Buffer.byteLength(selected), bound: 4_000 }]) + "\n");
  });

  it("keeps the customer words, CRM history, facts and failed trials under size pressure, and legacy OFF bytes", () => {
    const req = request();
    req.customerContext = buildCaseCustomerContext({ latestMessageId: "latest", messages: [
      { id: "earlier", direction: "outbound", at: "2026-11-01T10:00:00Z", subject: "Synthétique", text: "Vérifier les spams." },
      { id: "latest", direction: "inbound", at: "2026-11-01T11:00:00Z", subject: "Diagnostic zéphyr", text: "J’ai déjà vérifié les spams et essayé un autre navigateur, toujours bloqué." },
    ], crm: { status: "read", observedAt: "2026-11-01T10:30:00Z", caseTicketId: "ticket", tickets: [{ id: "ticket", stage: "open", subject: "Diagnostic fictif" }],
      histories: { ticket: [{ id: "note", kind: "note", at: "2026-11-01T10:20:00Z", text: "Essai déjà fait : autre navigateur sans succès." }] } } });
    req.snapshot.body.facts = [{ id: "fact-synthetic", value: "Spams déjà vérifiés" }] as never;
    req.snapshot.body.trials = [{ id: "trial-synthetic", outcome: "failed", detail: "Autre navigateur déjà essayé" }] as never;
    req.knowledge = Array.from({ length: 3 }, (_, i) => ({ ...req.knowledge[0], id: `synthetic-${i}`, content: largeCard(String(i)) }));
    const initialPrompt = caseInvestigationPrompt(req, { compact: true });
    const beforeBytes = Buffer.byteLength(caseGeminiDecisionBody(initialPrompt, initialPrompt.payload, 4096));
    expect(beforeBytes).toBeGreaterThan(26_000);
    const on = prepareCaseGeminiDecisionRequest(req, { ...env, SAV_V2_PROMPT_COMPACT: "on" });
    expect(on.ok).toBe(true);
    if (!on.ok) throw Error("preflight");
    const payload = unpack(on.body);
    expect(payload.customerContext).toEqual(req.customerContext);
    expect(payload.facts).toEqual(req.snapshot.body.facts);
    expect(payload.trials).toEqual(req.snapshot.body.trials);
    expect(Buffer.byteLength(on.body)).toBeLessThanOrEqual(26_000);
    const off = prepareCaseGeminiDecisionRequest(req, { ...env, SAV_V2_PROMPT_COMPACT: "off" });
    expect(off).toEqual(prepareCaseGeminiDecisionRequest(req, env));
    process.stdout.write(JSON.stringify([{ fixture: "customer-pressure", beforeBytes, afterBytes: on.metadata.inputBytes, bound: 26_000 }]) + "\n");
  });

  it("refuses before network when mandatory evidence alone exceeds the bound, preserving the input", () => {
    const req = request();
    req.knowledge[0].content = `## Exceptions\nNe jamais supprimer cette réserve. ${noise("mandatory", 2500)}`;
    const original = JSON.stringify(req);
    const result = prepareCaseGeminiDecisionRequest(req, { ...env, SAV_V2_PROMPT_COMPACT: "on" });
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "input_too_large", networkAttempted: false } });
    expect(JSON.stringify(req)).toBe(original);
  });
});
