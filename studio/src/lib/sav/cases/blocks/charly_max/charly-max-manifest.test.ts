import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageFingerprint } from "../../../skills/skill-contract";
import { charlyMaxConfirmWorstCase, charlyMaxDecisionWorstCase, measureCharlyMaxBudget, charlyMaxSkillFixedBytes } from "./charly-max-budget";
import { CHARLY_MAX_ENTRY_BLOCK } from "./charly_max-entry";
import { CHARLY_MAX_BLOCK_META, CHARLY_MAX_MANIFEST, CHARLY_MAX_PENDING_SOURCES } from "./charly-max-manifest";
import { CHARLY_MAX_DECISION_SKILL, CHARLY_MAX_DECISION_SKILL_PROMPT_SHA256, charlyMaxDecisionSkillSha256 } from "./charly-max-skill-decision";
import { CHARLY_MAX_ENTRY_SKILL } from "./charly-max-skill-entry";
import { entryConfirmPromptSha256 } from "../../../skills/entry-block";

describe("Charly Max, manifeste", () => {
  it("arrive en mode off, sans droit d'automatique, sans J2, sans clôture automatique", () => {
    expect(CHARLY_MAX_BLOCK_META.modes.initial).toBe("off");
    expect(CHARLY_MAX_BLOCK_META.autoAllowed).toBe(false);
    expect(CHARLY_MAX_BLOCK_META.j2.allowed).toBe(false);
    expect(CHARLY_MAX_BLOCK_META.resolutionProof).toBeNull();
    expect(CHARLY_MAX_MANIFEST.resolutionProof).toBeUndefined();
  });
  it("identité du bloc : charly_max, famille usage, jamais access", () => {
    expect(CHARLY_MAX_MANIFEST).toMatchObject({ blockId: "charly_max", family: "usage" });
    expect(CHARLY_MAX_MANIFEST.blockId).toMatch(/^[a-z][a-z0-9_-]{1,39}$/);
    expect([...CHARLY_MAX_MANIFEST.excludedNeighbours].sort()).toEqual(["access", "collaborators", "commercial", "integrations"]);
  });
  it("la liste toujours humaine est exactement la règle permanente", () => {
    expect([...CHARLY_MAX_BLOCK_META.alwaysHuman]).toEqual(["cancellation", "subscription", "finance", "rights", "identity"]);
    expect(CHARLY_MAX_BLOCK_META.blockHuman).toContain("complaint");
  });
  it("aucune source sans version exacte : tant que les fiches ne sont pas confirmées, l'appui est vide", () => {
    for (const source of CHARLY_MAX_MANIFEST.sources) {
      expect(source.contentVersionId).toMatch(/\S/);
      expect(["answer", "orient_only"]).toContain(source.usage);
    }
    expect(CHARLY_MAX_MANIFEST.sources).toEqual([]);
    expect(CHARLY_MAX_PENDING_SOURCES.length).toBeGreaterThanOrEqual(4);
    for (const pending of CHARLY_MAX_PENDING_SOURCES) expect(pending.status).not.toBe("published");
  });
  it("seuils jamais plus faibles que la méthode", () => {
    const t = CHARLY_MAX_BLOCK_META.thresholds;
    expect(t.sensitiveAdmitted).toBe(0);
    expect(t.neighbourRouted).toBeGreaterThanOrEqual(0.95);
    expect(t.blockRecall).toBeGreaterThanOrEqual(0.9);
    expect(t.sourcesOutsideSupport).toBe(0);
    expect(t.doubleSend).toBe(0);
    expect(t.draftsMin).toBeGreaterThanOrEqual(10);
    expect(t.draftsGoodRate).toBeGreaterThanOrEqual(0.9);
    expect(t.draftsSensitiveMissed).toBe(0);
  });
  it("les révisions et empreintes correspondent aux skills réels ; le paquet se calcule", () => {
    expect(CHARLY_MAX_MANIFEST.skills).toEqual([
      { id: CHARLY_MAX_ENTRY_SKILL.id, revision: CHARLY_MAX_ENTRY_SKILL.revision },
      { id: CHARLY_MAX_DECISION_SKILL.id, revision: CHARLY_MAX_DECISION_SKILL.revision },
    ]);
    expect(CHARLY_MAX_BLOCK_META.prompts).toEqual({ entrySha256: entryConfirmPromptSha256(CHARLY_MAX_ENTRY_BLOCK), decisionSha256: charlyMaxDecisionSkillSha256() });
    expect(CHARLY_MAX_BLOCK_META.prompts).toEqual({ entrySha256: CHARLY_MAX_ENTRY_BLOCK.promptSha256, decisionSha256: CHARLY_MAX_DECISION_SKILL_PROMPT_SHA256 });
    const fingerprint = packageFingerprint({
      activeBlocks: [CHARLY_MAX_MANIFEST], model: "model-to-confirm", scopes: [],
      skills: [{ ...CHARLY_MAX_ENTRY_SKILL, promptFingerprint: CHARLY_MAX_ENTRY_BLOCK.promptSha256 }, { ...CHARLY_MAX_DECISION_SKILL, promptFingerprint: charlyMaxDecisionSkillSha256() }],
    });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  it("les transferts : jamais « transmis » sans reçu ; codes fermés", () => {
    expect(CHARLY_MAX_BLOCK_META.transfer.customerTextRequiresReceipt).toBe(true);
    expect(CHARLY_MAX_BLOCK_META.transfer.incident).toBe("support_technique");
    expect(new Set(CHARLY_MAX_BLOCK_META.transfer.reasonCodes).size).toBe(CHARLY_MAX_BLOCK_META.transfer.reasonCodes.length);
  });
  it("fichiers purs : aucun import serveur, réseau, base ou horloge ; non branchés", () => {
    const dir = __dirname;
    for (const file of readdirSync(dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/server-only|from "@\/|fetch\(|process\.env|Date\.now|new Date\(|Math\.random|drizzle|postgres/);
    }
  });
});

describe("Charly Max, budget de prompt par étage (< 85 % de 26 000 octets)", () => {
  const budget = measureCharlyMaxBudget();
  it("confirmation : pire cas de l'interface (12 000 caractères) et p95 du corpus passent, chiffres épinglés dans le manifeste", () => {
    expect(charlyMaxConfirmWorstCase()).toEqual({ stage: "confirm", bodyBytes: 21_832, ceilingBytes: 26_000, status: "pass" });
    expect(budget.confirm).toMatchObject({ status: "pass", maxStatus: "pass", ceilingBytes: 26_000, measuredCases: 290, skippedTruncated: 10 });
    expect({ measuredWorstCase: 21_832, measuredP95: budget.confirm.bodyBytes, measuredMax: budget.confirm.maxBytes, limit: 26_000 }).toEqual(CHARLY_MAX_BLOCK_META.budget.confirm);
  });
  it("décision (non branchée) : le p95 du corpus passe ; le pire cas à 12 000 caractères NE PASSE PAS (limite signalée, à découper avant tout branchement)", () => {
    expect(budget.decision).toMatchObject({ status: "pass", maxStatus: "pass", ceilingBytes: 26_000, measuredCases: 120 });
    const worst = charlyMaxDecisionWorstCase();
    expect(worst).toEqual({ stage: "decision", bodyBytes: 34_213, ceilingBytes: 26_000, status: "fail" });
    expect({ measuredWorstCase: worst.bodyBytes, measuredP95: budget.decision.bodyBytes, measuredMax: budget.decision.maxBytes, limit: 26_000 }).toEqual(CHARLY_MAX_BLOCK_META.budget.decision);
  });
  it("le coût fixe de chaque skill laisse une place mesurée au mail", () => {
    const fixed = charlyMaxSkillFixedBytes();
    expect(fixed.confirm).toBeLessThan(26_000 * 0.85);
    expect(fixed.decision).toBeLessThan(26_000 * 0.85);
  });
});
