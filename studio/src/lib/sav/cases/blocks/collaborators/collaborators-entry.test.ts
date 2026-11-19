import { describe, expect, it } from "vitest";
import { lintCorpus } from "../../../skills/corpus-lint";
import { accessSkillKernelHits } from "../../access-skill/access-skill-kernel";
import { SAV_COLLABORATORS_CORPUS } from "./collaborators-corpus.fixture";
import {
  SAV_COLLABORATORS_CONFIRM_EXAMPLES, SAV_COLLABORATORS_CONFIRM_GUIDELINES, SAV_COLLABORATORS_CONFIRM_MEASURED, SAV_COLLABORATORS_CONFIRM_SKILL_REVISION,
  SAV_COLLABORATORS_CORPUS_MINIMUMS, SAV_COLLABORATORS_LABEL, SAV_COLLABORATORS_ROUTER_LINE,
} from "./collaborators-skill";

/*
 * The registration data for the shared entry (INTERFACE v1.2). What needs `entry-block.ts` (structural problems, pinned hash, budget) is measured
 * at assembly; here: everything checkable without it.
 */
describe("collaborators registration data for the shared entry", () => {
  const rows = SAV_COLLABORATORS_CONFIRM_EXAMPLES;
  it("uses the four shared example verdicts, each present", () => {
    expect(new Set(rows.map(row => row.verdict))).toEqual(new Set(["block", "team_sensitive", "team_other", "team_unsure"]));
    expect(rows).toHaveLength(24);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  });
  it("pairs near examples reciprocally with another verdict, block twins on the rights, seats and neighbour sides", () => {
    const pairs = rows.filter(row => row.pair);
    expect(pairs.length).toBeGreaterThanOrEqual(16);
    for (const row of pairs) {
      const twin = rows.find(candidate => candidate.id === row.pair)!;
      expect(twin.pair, row.id).toBe(row.id);
      expect(twin.verdict, row.id).not.toBe(row.verdict);
    }
    for (const row of rows.filter(candidate => candidate.verdict === "block")) expect(accessSkillKernelHits(undefined, row.text), row.id).toEqual([]);
  });
  it("states the rights rule even as a how-to, and the not-a-third-party rule", () => {
    const text = SAV_COLLABORATORS_CONFIRM_GUIDELINES.join("\n");
    for (const words of ["même en « comment faire »", "retirer un accès", "propriété", "sièges", "SA connexion", "Ce n'est pas un tiers"]) expect(text, words).toContain(words);
  });
  it("has a router line within the catalog limits and a short label", () => {
    expect(SAV_COLLABORATORS_LABEL.length).toBeLessThanOrEqual(80);
    expect(SAV_COLLABORATORS_ROUTER_LINE.covers.length).toBeLessThanOrEqual(240);
    expect(SAV_COLLABORATORS_ROUTER_LINE.notThis.length).toBeLessThanOrEqual(240);
    expect(SAV_COLLABORATORS_CONFIRM_SKILL_REVISION).toMatch(/^[A-Za-z0-9._-]{1,120}$/);
  });
  it("keeps the corpus lint green against these examples, with the registered quotas", () => {
    expect(lintCorpus({ cases: SAV_COLLABORATORS_CORPUS, examples: rows, minimums: SAV_COLLABORATORS_CORPUS_MINIMUMS })).toEqual([]);
  });
  it("records a confirm budget measured strictly under 85 % of 26 000 bytes", () => {
    expect(SAV_COLLABORATORS_CONFIRM_MEASURED.confirmBodyBytes).toBeLessThan(22_100);
    expect(SAV_COLLABORATORS_CONFIRM_MEASURED.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
