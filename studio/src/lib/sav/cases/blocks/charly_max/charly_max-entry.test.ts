import { describe, expect, it } from "vitest";
import { lintCorpus } from "../../../skills/corpus-lint";
import { entryConfirmJudgmentSchema, entryConfirmPromptSha256, entrySkillBlockProblems, renderEntryConfirmPrompt, SAV_ENTRY_CONFIRM_EXAMPLE_VERDICTS } from "../../../skills/entry-block";
import { entryConfirmBudget } from "../../../skills/entry-budget";
import { accessSkillKernelHits } from "../../access-skill/access-skill-kernel";
import { CHARLY_MAX_ENTRY_BLOCK } from "./charly_max-entry";
import { CHARLY_MAX_ENTRY_EXAMPLES, CHARLY_MAX_ENTRY_SKILL, CHARLY_MAX_ENTRY_SKILL_REVISION } from "./charly-max-skill-entry";

const PINNED = "388d1caf51eda26149b2685a84564f9cbaa84dd61b57ab02697329f91a591f47";

// The minimal tests of INTERFACE.md v1.2 §4 (lot infra-entry), then the block's own checks.
describe("Charly Max, enregistrement à l'entrée (interface infra-entry)", () => {
  it("enregistrement valide", () => expect(entrySkillBlockProblems(CHARLY_MAX_ENTRY_BLOCK)).toEqual([]));
  it("empreinte épinglée (cadre commun + skill), changée seulement avec la révision", () => {
    expect(entryConfirmPromptSha256(CHARLY_MAX_ENTRY_BLOCK)).toBe(CHARLY_MAX_ENTRY_BLOCK.promptSha256);
    expect(CHARLY_MAX_ENTRY_BLOCK.promptSha256).toBe(PINNED);
    expect(CHARLY_MAX_ENTRY_SKILL_REVISION).toBe("sav-charly_max-entry-skill-2026-11-19.v1");
  });
  it("corpus lint", () => expect(lintCorpus({ cases: CHARLY_MAX_ENTRY_BLOCK.corpus, examples: CHARLY_MAX_ENTRY_BLOCK.skill.examples, minimums: CHARLY_MAX_ENTRY_BLOCK.corpusMinimums })).toEqual([]));
  it("budget de prompt ≤ 85 % sur le fil le plus long que l'entrée lit", () => {
    expect(entryConfirmBudget(CHARLY_MAX_ENTRY_BLOCK)).toEqual({ stage: "confirm", bodyBytes: 21_832, ceilingBytes: 26_000, status: "pass" });
  });
  it("arrive off, famille usage, ligne du routeur courte", () => {
    expect(CHARLY_MAX_ENTRY_BLOCK).toMatchObject({ blockId: "charly_max", family: "usage", label: "Charly Max", initialMode: "off" });
    expect(CHARLY_MAX_ENTRY_BLOCK.skill.id).toBe("charly_max-entry-skill");
    expect(CHARLY_MAX_ENTRY_BLOCK.router.covers.length).toBeLessThanOrEqual(240);
    expect(CHARLY_MAX_ENTRY_BLOCK.router.notThis.length).toBeLessThanOrEqual(240);
    expect(Object.isFrozen(CHARLY_MAX_ENTRY_BLOCK)).toBe(true);
  });
});

describe("Charly Max, skill de confirmation : exemples fictifs", () => {
  const byId = new Map(CHARLY_MAX_ENTRY_EXAMPLES.map(row => [row.id, row]));
  it("les 4 verdicts de l'interface sont représentés, ids uniques", () => {
    for (const verdict of SAV_ENTRY_CONFIRM_EXAMPLE_VERDICTS) expect(CHARLY_MAX_ENTRY_EXAMPLES.some(row => row.verdict === verdict), verdict).toBe(true);
    expect(byId.size).toBe(CHARLY_MAX_ENTRY_EXAMPLES.length);
    // Budget-bound (see the report): fewer than the method's 40, every verdict and every neighbour of the brief still shown.
    expect(CHARLY_MAX_ENTRY_EXAMPLES.length).toBeGreaterThanOrEqual(20);
  });
  it("paires proches réciproques, verdicts opposés ; voisins accès, collaborateurs, intégrations ; sensibles du brief", () => {
    const pairs = CHARLY_MAX_ENTRY_EXAMPLES.filter(row => row.pair);
    expect(pairs.length).toBeGreaterThanOrEqual(14);
    for (const row of pairs) {
      const twin = byId.get(row.pair!);
      expect(twin?.pair, row.id).toBe(row.id);
      expect(twin!.verdict === "block", row.id).not.toBe(row.verdict === "block");
    }
    expect(byId.get("c7")).toMatchObject({ verdict: "block", pair: "o1" });
    expect(byId.get("o1")).toMatchObject({ verdict: "team_other", comment: "accès" });
    expect(byId.get("o2")).toMatchObject({ verdict: "team_other", comment: "collaborateurs" });
    expect(byId.get("o3")).toMatchObject({ verdict: "team_other", comment: "intégrations" });
    expect(byId.get("o4")).toMatchObject({ verdict: "team_other", comment: "commercial" });
    for (const id of ["s2", "s3", "s4", "s5"]) expect(byId.get(id)?.verdict, id).toBe("team_sensitive");
  });
  it("aucun exemple « block » ne contient une phrase du noyau", () => {
    for (const row of CHARLY_MAX_ENTRY_EXAMPLES.filter(item => item.verdict === "block")) expect(accessSkillKernelHits(row.subject, row.text), row.id).toEqual([]);
  });
  it("le prompt rendu contient le cadre commun, les consignes du bloc et chaque exemple", () => {
    const prompt = renderEntryConfirmPrompt(CHARLY_MAX_ENTRY_BLOCK);
    expect(prompt).toContain("COMPÉTENCE D'ENTRÉE « Charly Max »");
    expect(prompt).toContain(CHARLY_MAX_ENTRY_SKILL_REVISION);
    for (const line of CHARLY_MAX_ENTRY_SKILL.guidelines) expect(prompt).toContain(line);
    for (const row of CHARLY_MAX_ENTRY_EXAMPLES) expect(prompt).toContain(`"id":"${row.id}"`);
  });
  it("sortie : le schéma commun, strict", () => {
    const valid = { mail: { sensitive: "none", thirdParty: false, instructionLike: false },
      requests: [{ requestId: "r1", verdict: "block", family: null, confidence: "high", quote: "Charly ne répond plus", reason: "incident" }], sensitiveMentions: [] };
    expect(entryConfirmJudgmentSchema.safeParse(valid).success).toBe(true);
    expect(entryConfirmJudgmentSchema.safeParse({ ...valid, requests: [{ ...valid.requests[0], verdict: "charly_max" }] }).success).toBe(false);
    expect(entryConfirmJudgmentSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });
});
