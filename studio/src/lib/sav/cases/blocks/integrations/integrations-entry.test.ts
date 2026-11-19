import { describe, expect, it } from "vitest";
import { lintCorpus } from "../../../skills/corpus-lint";
import { entryConfirmJudgmentSchema, entryConfirmPromptSha256, entrySkillBlockProblems, renderEntryConfirmPrompt } from "../../../skills/entry-block";
import { entryConfirmBudget, entryRouterBudget } from "../../../skills/entry-budget";
import { INTEGRATIONS_ENTRY_BLOCK as BLOCK } from "./integrations-entry";
import { integrationsEntryJudgmentSchema } from "./integrations-entry-skill";
import { SAV_INTEGRATIONS_MANIFEST_DETAILS } from "./integrations-manifest";

// Block « Intégrations »: its registration at the entry, per INTERFACE.md v1.2 §4 (infra-entry lot). Needs `skills/entry-block.ts` and `entry-budget.ts`.
describe("enregistrement du bloc Intégrations à l'entrée", () => {
  it("enregistrement valide (aucun problème structurel), mode initial off", () => {
    expect(entrySkillBlockProblems(BLOCK)).toEqual([]);
    expect(BLOCK.initialMode).toBe("off");
    expect(BLOCK.skill.id).toBe("integrations-entry-skill");
  });
  it("empreinte épinglée du prompt de confirmation (cadre commun + skill du bloc)", () => {
    expect(entryConfirmPromptSha256(BLOCK)).toBe(BLOCK.promptSha256);
    expect(renderEntryConfirmPrompt(BLOCK)).toContain(BLOCK.skill.revision);
  });
  it("le schéma local est exactement le schéma commun de confirmation", () => {
    const sample = { mail: { sensitive: "none", thirdParty: false, instructionLike: false },
      requests: [{ requestId: "r1", verdict: "block", family: null, confidence: "high", quote: "relier Gmail", reason: "tool" }], sensitiveMentions: [] };
    expect(integrationsEntryJudgmentSchema.parse(sample)).toEqual(entryConfirmJudgmentSchema.parse(sample));
  });
  it("corpus lint vert contre les exemples du skill d'entrée", () => {
    expect(lintCorpus({ cases: BLOCK.corpus, examples: BLOCK.skill.examples, minimums: BLOCK.corpusMinimums })).toEqual([]);
  });
  it("mots des demandes multiples : chaque cas multi-demandes en a, et chaque mot est verbatim dans le texte", () => {
    const words = BLOCK.corpusRequestWords!;
    for (const row of BLOCK.corpus.filter(row => row.requests.length > 1)) {
      expect(Object.keys(words[row.id] ?? {}).sort(), row.id).toEqual(row.requests.map(request => request.requestId).sort());
      for (const value of Object.values(words[row.id])) expect(row.text, row.id).toContain(value);
    }
  });
  it("budget de confirmation ≤ 85 % sur le fil le plus long (chiffre épinglé) ; routeur avec ce bloc sous 85 %", () => {
    expect(entryConfirmBudget(BLOCK)).toMatchObject({ status: "pass", bodyBytes: SAV_INTEGRATIONS_MANIFEST_DETAILS.budget.confirmation.longestReadableThread });
    expect(entryRouterBudget([BLOCK]).status).toBe("pass");
  });
});
