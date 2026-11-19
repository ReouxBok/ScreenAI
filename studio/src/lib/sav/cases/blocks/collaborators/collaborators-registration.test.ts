import { describe, expect, it } from "vitest";
import { lintCorpus } from "../../../skills/corpus-lint";
import { entryConfirmPromptSha256, entrySkillBlockProblems, renderEntryConfirmPrompt } from "../../../skills/entry-block";
import { entryConfirmBudget } from "../../../skills/entry-budget";
import { COLLABORATORS_ENTRY_BLOCK as BLOCK } from "./collaborators-entry";
import { SAV_COLLABORATORS_CONFIRM_MEASURED } from "./collaborators-skill";

/* The four minimal tests of INTERFACE.md §4 for the Collaborators registration (written at the assembly, 19/11). */
describe("Collaborateurs : enregistrement à l'entrée", () => {
  it("enregistrement valide", () => expect(entrySkillBlockProblems(BLOCK)).toEqual([]));
  it("empreinte épinglée (celle mesurée par le lot du bloc)", () => {
    expect(entryConfirmPromptSha256(BLOCK)).toBe(BLOCK.promptSha256);
    expect(BLOCK.promptSha256).toBe(SAV_COLLABORATORS_CONFIRM_MEASURED.promptSha256);
    expect(Buffer.byteLength(renderEntryConfirmPrompt(BLOCK), "utf8")).toBe(SAV_COLLABORATORS_CONFIRM_MEASURED.promptBytes);
  });
  it("corpus lint", () => expect(lintCorpus({ cases: BLOCK.corpus, examples: BLOCK.skill.examples, minimums: BLOCK.corpusMinimums })).toEqual([]));
  it("budget de prompt ≤ 85 %", () => {
    const budget = entryConfirmBudget(BLOCK);
    expect(budget.status).toBe("pass");
    expect(budget.bodyBytes).toBe(SAV_COLLABORATORS_CONFIRM_MEASURED.confirmBodyBytes);
  });
  it("arrive off, famille usage, ligne de routeur dans les limites", () => {
    expect(BLOCK.initialMode).toBe("off");
    expect(BLOCK.family).toBe("usage");
    expect(BLOCK.manifest.family).toBe("usage");
  });
});
