import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { checkSavBlockLessons, SAV_BLOCK_LESSONS } from "./lesson-controls";
import { emptySavBlockBrief, exportSavBlockBriefMarkdown, savBlockBriefFromForm, savBlockBriefSchema, savBlockBriefToDraft, SAV_BLOCK_BRIEF_QUESTIONS, validateSavBlockBrief } from "./block-brief";

const completeBrief = () => savBlockBriefSchema.parse({
  ...emptySavBlockBrief("synthetic-block"), objective: "Expliquer la procédure de démonstration", examples: ["Comment ouvrir le panneau de démonstration ?"],
  exclusions: ["Suppression du panneau"], neighbours: ["autre-bloc"], humanOnly: ["Action irréversible"], transferTo: "Équipe support", resolutionProof: "Panneau visible et résultat vérifié",
  lessons: Object.fromEntries(SAV_BLOCK_LESSONS.map(({ id }) => [id, { confirmed: true, plan: `Prévoir le test synthétique ${id} et vérifier son résultat.` }])),
});
for (const lesson of SAV_BLOCK_LESSONS) {
  it(`lesson ${lesson.id}: accepts a confirmed plan, rejects absent/unconfirmed/empty plans`, () => {
    const brief = completeBrief();
    expect(lesson.control(brief)).toMatchObject({ id: lesson.id, status: "ok", reason: expect.any(String) });
    for (const review of [undefined, { confirmed: false, plan: "Plan de contrôle renseigné" }, { confirmed: true, plan: " " }]) {
      const draft = { ...brief, lessons: { ...brief.lessons, [lesson.id]: review } };
      expect(lesson.control(draft).status).toBe("blocked");
      expect(validateSavBlockBrief(draft).ok).toBe(false);
    }
  });
}
it("off is the default and an attempted automatic mode fails closed", () => {
  expect(emptySavBlockBrief("synthetic-block").mode).toBe("off");
  expect(SAV_BLOCK_LESSONS.find(row => row.id === "off")!.control({ ...completeBrief(), mode: "automatic" }).status).toBe("blocked");
  expect(savBlockBriefSchema.safeParse({ ...completeBrief(), mode: "automatic" }).success).toBe(false);
  expect(checkSavBlockLessons({})).toHaveLength(11);
  expect(checkSavBlockLessons({}).every(row => row.status === "blocked")).toBe(true);
});
it("validates the six sections and rejects incomplete or oversized briefs and injected fields", () => {
  expect(SAV_BLOCK_BRIEF_QUESTIONS).toHaveLength(6);
  expect(validateSavBlockBrief(completeBrief())).toEqual({ ok: true, reasons: [] });
  for (const patch of [{ objective: "" }, { examples: [] }, { examples: Array.from({ length: 29 }, (_, index) => `Exemple ${index}`) }, { exclusions: [] }, { neighbours: [] }, { humanOnly: [] }, { transferTo: "" }, { resolutionProof: "" }, { objective: "x".repeat(3001) }, { blockId: "../bad" }, { published: true }])
    expect(validateSavBlockBrief({ ...completeBrief(), ...patch }).ok).toBe(false);
  expect(() => savBlockBriefToDraft(emptySavBlockBrief("synthetic-block"))).toThrow("SAV_BLOCK_BRIEF_INCOMPLETE");
});
it("converts deterministically without mutating input, inventing cards or enabling a block", () => {
  const brief = completeBrief(), before = JSON.stringify(brief);
  const draft = savBlockBriefToDraft(brief);
  expect(draft).toEqual(savBlockBriefToDraft(JSON.parse(before)));
  expect(JSON.stringify(brief)).toBe(before);
  expect(draft).toMatchObject({ blockId: brief.blockId, mode: "off", cardIds: [], supportCardIds: [], exclusions: brief.exclusions, neighbours: brief.neighbours });
  expect(draft.humanOnly).toEqual(expect.arrayContaining(["Finance", "Résiliation", "Identité et droits"]));
  expect(draft.testPhrases?.map(row => row.kind)).toEqual(["positive", "neighbour", "trap"]);
});
it("exports all sections and lesson results with an honest incomplete state and escaped Markdown", () => {
  const brief = completeBrief();
  const markdown = exportSavBlockBriefMarkdown(brief);
  expect(markdown).toBe(exportSavBlockBriefMarkdown(brief));
  expect(markdown).toContain("## Squelette SavBlockDraft");
  expect(markdown).toContain('"cardIds": []');
  for (const text of ["Mode : off", "## Objectif", "## Exemples", "## Exclusions", "## Voisins", "## Sujets toujours humains", "## Destinataire des transferts", "## Preuve de résolution", "Aucune publication"])
    expect(markdown).toContain(text);
  for (const { id } of SAV_BLOCK_LESSONS) expect(markdown).toContain(`- [x] ${id}`);
  expect(exportSavBlockBriefMarkdown(emptySavBlockBrief("synthetic-block"))).toContain("- [ ] wake");
  expect(exportSavBlockBriefMarkdown({ ...brief, objective: "<script> *test*" })).toContain("\\<script\\> \\*test\\*");
});
it("parses form lines, never accepts a submitted mode or a missing confirmation", () => {
  const form = new FormData();
  form.set("blockId", "synthetic-block"); form.set("examples", "  Exemple A\r\n\n Exemple B  "); form.set("mode", "automatic");
  const brief = savBlockBriefFromForm(form);
  expect(brief.examples).toEqual(["Exemple A", "Exemple B"]);
  expect(brief.mode).toBe("off");
  expect(checkSavBlockLessons(brief).every(row => row.status === "blocked")).toBe(true);
});
it("public lesson source contains neither addresses nor long numeric sequences", () => {
  const source = readFileSync(new URL("./lesson-controls.ts", import.meta.url), "utf8");
  expect(source).not.toContain("@");
  expect(source).not.toMatch(/\d{5,}/);
});
