import { afterEach, describe, expect, it, vi } from "vitest";
import { SAV_CASE_BLOCK_REGISTRY } from "../cases/case-block-registry";
import { SAV_INTEGRATIONS_BLOCK } from "./integrations-block";
import { SAV_INTEGRATIONS_EVAL_CASES, SAV_INTEGRATIONS_MISSING_KNOWLEDGE } from "./integrations-eval-cases";
import { evaluateIntegrations, integrationsEvalMarkdown } from "./integrations-eval";

afterEach(() => vi.unstubAllGlobals());
describe("Intégrations phase 2 — préparation synthétique hors ligne", () => {
  it("covers six existing subfamilies, neighbours and mixed traps with review annotations", () => {
    const cases = SAV_INTEGRATIONS_EVAL_CASES;
    expect(cases).toHaveLength(40);
    expect(new Set(cases.map(row => row.id)).size).toBe(40);
    expect(new Set(cases.map(row => row.text)).size).toBe(40);
    expect(["positive", "neighbour", "trap"].map(kind => cases.filter(row => row.kind === kind).length)).toEqual([18, 10, 12]);
    for (const family of SAV_INTEGRATIONS_MISSING_KNOWLEDGE) {
      expect(cases.filter(row => row.kind === "positive" && row.subfamily === family.subfamily)).toHaveLength(3);
      expect(family.title.length).toBeGreaterThan(10);
      expect(family.expectedContent.length).toBeGreaterThan(40);
    }
    for (const row of cases) {
      expect(row.expectedDecision.length).toBeGreaterThan(0);
      expect(Array.isArray(row.factsToAsk)).toBe(true);
      if (row.expectedDecision === "demander") expect(row.factsToAsk.length).toBeGreaterThan(0);
    }
  });

  it("runs deterministically without network, effects, activation or expected-label leakage", () => {
    const network = vi.fn(() => { throw Error("NETWORK_FORBIDDEN"); });
    vi.stubGlobal("fetch", network);
    const report = evaluateIntegrations();
    expect(evaluateIntegrations()).toEqual(report);
    const relabelled = evaluateIntegrations(SAV_INTEGRATIONS_EVAL_CASES.map(row => ({ ...row, expectedBlock: "ask", expectedDecision: "passer à l'équipe", factsToAsk: [] })));
    expect(relabelled.rows.map(row => [row.predictedBlock, row.cards])).toEqual(report.rows.map(row => [row.predictedBlock, row.cards]));
    expect(network).not.toHaveBeenCalled();
    expect(report).toMatchObject({ releaseQualified: false, actionEvaluation: "not_measured_annotations_only", modelCalls: 0, effects: "none" });
    expect(SAV_INTEGRATIONS_BLOCK).toMatchObject({ mode: "off", cardIds: [] });
    expect(SAV_CASE_BLOCK_REGISTRY.map(row => row.blockId)).toEqual(["access"]);
  });

  it("reports actual errors rather than treating expected decisions as predictions", () => {
    const report = evaluateIntegrations();
    expect(report.total).toBe(40);
    expect(report.recall).toEqual({ hits: 17, total: 18, rate: 17 / 18 });
    expect(report.falsePositives).toBe(5);
    expect(report.precision).toEqual({ hits: 17, total: 22, rate: 17 / 22 });
    expect(report.accuracy).toEqual({ hits: 34, total: 40, rate: 34 / 40 });
    expect(report.confusionMatrix).toEqual({ integrations: { integrations: 17, team: 1 }, access: { access: 2 }, team: { team: 15, integrations: 5 } });
    expect(report.routing.neighbourRejection).toEqual({ hits: 10, total: 10, rate: 1 });
    expect(report.routing.traps).toEqual({ hits: 7, total: 12, rate: 7 / 12 });
    expect(report.confusions).toContainEqual(expect.objectContaining({ id: "p03", expected: "integrations", predicted: "team" }));
    expect(report.confusionMatrix.integrations?.team).toBe(1);
    expect(report.precision.total).toBe(report.truePositives + report.falsePositives);
    expect(report.confusions.length + report.accuracy.hits).toBe(40);
    expect(report.routing.gate.passed).toBe(false);
    expect(report.routing.gate.reasons).toContain("too_many_phrases:40>30");
    expect(integrationsEvalMarkdown(report)).toContain("aucun texte client produit");
    for (const card of SAV_INTEGRATIONS_MISSING_KNOWLEDGE) expect(integrationsEvalMarkdown(report)).toContain(card.title);
  });

  it("uses null for undefined rates and preserves the fixed index across subsets", () => {
    expect(evaluateIntegrations([])).toMatchObject({ total: 0, precision: { rate: null }, recall: { rate: null }, accuracy: { rate: null }, confusionMatrix: {} });
    const caseToRun = SAV_INTEGRATIONS_EVAL_CASES[0]!;
    expect(evaluateIntegrations([caseToRun]).rows[0]).toEqual(evaluateIntegrations().rows[0]);
  });
});
