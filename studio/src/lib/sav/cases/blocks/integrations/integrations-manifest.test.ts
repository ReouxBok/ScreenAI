import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageFingerprint, skillFingerprint } from "../../../skills/skill-contract";
import { integrationsBudgetReport, SAV_INTEGRATIONS_BUDGET_CEILING_BYTES } from "./integrations-budget";
import { SAV_INTEGRATIONS_CORPUS } from "./integrations-corpus.fixture";
import { SAV_INTEGRATIONS_DECISION_SKILL } from "./integrations-decision-skill";
import { SAV_INTEGRATIONS_ENTRY_SKILL } from "./integrations-entry-skill";
import { SAV_INTEGRATIONS_MANIFEST, SAV_INTEGRATIONS_MANIFEST_DETAILS, SAV_INTEGRATIONS_SOURCE_PLAN } from "./integrations-manifest";
import { SAV_INTEGRATIONS_SUBFAMILIES } from "./integrations-scope";

// Block « Intégrations » (V3, 19/11): manifest (off, no automatic right), measured prompt budget per stage, purity of the block's files.
describe("manifeste du bloc", () => {
  it("mode initial off, aucun droit d'automatique ni de J2, pas de clôture automatique", () => {
    expect(SAV_INTEGRATIONS_MANIFEST_DETAILS.modes.initial).toBe("off");
    expect(SAV_INTEGRATIONS_MANIFEST_DETAILS.autoAllowed).toBe(false);
    expect(SAV_INTEGRATIONS_MANIFEST_DETAILS.j2.allowed).toBe(false);
    expect(SAV_INTEGRATIONS_MANIFEST_DETAILS.resolutionProof.autoClosure).toBe(false);
    expect(SAV_INTEGRATIONS_MANIFEST.resolutionProof).toBeUndefined();
  });
  it("la liste « toujours humain » est la règle permanente, inchangée", () => {
    expect(SAV_INTEGRATIONS_MANIFEST_DETAILS.alwaysHuman).toEqual(["cancellation", "subscription", "finance", "rights", "identity"]);
  });
  it("les révisions et empreintes correspondent aux skills réels ; bloc et famille non réservés à Accès", () => {
    expect(SAV_INTEGRATIONS_MANIFEST.blockId).toBe("integrations");
    expect(SAV_INTEGRATIONS_MANIFEST.family).toBe("integration");
    expect(SAV_INTEGRATIONS_MANIFEST.skills).toEqual([SAV_INTEGRATIONS_ENTRY_SKILL, SAV_INTEGRATIONS_DECISION_SKILL].map(({ id, revision }) => ({ id, revision })));
    expect(SAV_INTEGRATIONS_MANIFEST_DETAILS.promptSha256).toEqual({ entry: skillFingerprint(SAV_INTEGRATIONS_ENTRY_SKILL), decision: skillFingerprint(SAV_INTEGRATIONS_DECISION_SKILL) });
    expect(SAV_INTEGRATIONS_MANIFEST.excludedNeighbours).toEqual(expect.arrayContaining(["access", "charly_max", "platform_bug", "commercial"]));
  });
  it("aucune source sans version exacte : l'appui est vide tant que root n'a pas mappé les fiches", () => {
    expect(SAV_INTEGRATIONS_MANIFEST.sources).toEqual([]);
    for (const row of SAV_INTEGRATIONS_SOURCE_PLAN) expect(row.contentVersionId, row.key).toBe("à confirmer");
    for (const key of ["shopify", "odoo", "crm", "pennylane", "dougs", "mail-other"]) expect(SAV_INTEGRATIONS_SOURCE_PLAN.find(row => row.key === key)?.proposedUse, key).toBe("none");
    for (const row of SAV_INTEGRATIONS_SOURCE_PLAN) for (const sub of row.subfamilies) expect(SAV_INTEGRATIONS_SUBFAMILIES).toContain(sub);
  });
  it("seuils pas plus faibles que la méthode", () => {
    const t = SAV_INTEGRATIONS_MANIFEST_DETAILS.thresholds;
    expect(t).toMatchObject({ sensitiveAdmitted: 0, sourcesOutsideSupport: 0, doubleSend: 0, draftsSensitiveMissed: 0 });
    expect(t.neighbourRouted).toBeGreaterThanOrEqual(0.95);
    expect(t.blockRecall).toBeGreaterThanOrEqual(0.9);
  });
  it("l'empreinte de paquet se calcule sur le manifeste (bloc non actif : calcul local seulement)", () => {
    const fingerprint = packageFingerprint({ activeBlocks: [SAV_INTEGRATIONS_MANIFEST], model: "model-under-test",
      skills: [SAV_INTEGRATIONS_ENTRY_SKILL, SAV_INTEGRATIONS_DECISION_SKILL].map(skill => ({ id: skill.id, revision: skill.revision, promptFingerprint: skillFingerprint(skill) })), scopes: [] });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("budget d'octets de prompt par étage (corps exact, plafond 26 000, < 85 %)", () => {
  const report = integrationsBudgetReport(SAV_INTEGRATIONS_CORPUS);
  it("décision au p95 avec une fiche au maximum de la norme : sous 85 % ; ligne du routeur ; chiffres épinglés", () => {
    expect(report.ceilingBytes).toBe(SAV_INTEGRATIONS_BUDGET_CEILING_BYTES);
    expect({ measured: report.measuredCases, skipped: report.skippedTruncated }).toEqual({ measured: 290, skipped: 10 });
    expect(report.decision.p95OneCard).toMatchObject({ status: "pass", bodyBytes: SAV_INTEGRATIONS_MANIFEST_DETAILS.budget.decision.measuredP95OneMaxCard });
    expect(report.routerCardBytes).toBe(SAV_INTEGRATIONS_MANIFEST_DETAILS.budget.router.blockLineBytes);
  });
  it("limite connue, mesurée et non cachée : deux fiches au maximum de la norme dépassent", () => {
    expect(report.decision.p95TwoCards.status).toBe("fail");
  });
});

describe("pureté des fichiers du bloc", () => {
  it("aucun import server-only, réseau, base ou horloge ; aucune zone interdite", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(/from "server-only"|import "server-only"|from "pg"|fetch\(|Date\.now|new Date\(|process\.env|app\/api/);
    }
  });
});
