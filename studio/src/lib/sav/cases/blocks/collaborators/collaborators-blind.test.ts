import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintCorpus } from "../../../skills/corpus-lint";
import { accessSkillKernelHits } from "../../access-skill/access-skill-kernel";
import { SAV_COLLABORATORS_BLIND_SET } from "./collaborators-blind.fixture";
import { SAV_COLLABORATORS_CORPUS } from "./collaborators-corpus.fixture";
import { SAV_COLLABORATORS_DECISION_EXAMPLES } from "./collaborators-decision-skill";
import { SAV_COLLABORATORS_ENTRY_EXAMPLES } from "./collaborators-entry-skill";
import { SAV_COLLABORATORS_BLOCK_SETTINGS } from "./collaborators-manifest";
import { SAV_COLLABORATORS_CONFIRM_EXAMPLES } from "./collaborators-skill";

/*
 * The frozen blind set (60 cases), written by another agent without seeing the skills or the corpus. It is never used to tune the skills:
 * a measure under the thresholds means a new revision written on other grounds, not an edit of these cases. Diagnostics print ids only.
 */
const blind = SAV_COLLABORATORS_BLIND_SET;

describe("collaborators blind set: frozen and disjoint", () => {
  it("is the file whose fingerprint was noted at freeze", () => {
    const bytes = readFileSync(new URL("./collaborators-blind.fixture.ts", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(SAV_COLLABORATORS_BLOCK_SETTINGS.corpus.blindSetSha256);
  });
  it("passes the N3 lint against both skills' examples, with its own quotas", () => {
    expect(lintCorpus({
      cases: blind, examples: [...SAV_COLLABORATORS_ENTRY_EXAMPLES, ...SAV_COLLABORATORS_DECISION_EXAMPLES, ...SAV_COLLABORATORS_CONFIRM_EXAMPLES],
      minimums: { positive: 18, neighbour: 12, sensitive: 12, mixed: 8, trap: 10 },
    })).toEqual([]);
    expect(blind).toHaveLength(60);
  });
  it("is disjoint from the corpus (no text equal, containing or contained, normalized)", () => {
    const corpusAsExamples = SAV_COLLABORATORS_CORPUS.map(row => ({ id: row.id, text: row.text, verdict: "corpus", comment: "corpus" }));
    const overlaps = lintCorpus({ cases: blind, examples: corpusAsExamples, minimums: { positive: 1, neighbour: 1, sensitive: 1, mixed: 1, trap: 1 } })
      .filter(issue => issue.code === "example_overlap");
    expect(overlaps).toEqual([]);
  });
  it("admits no case that holds a kernel phrase and sends every sensitive mail wholly to the team", () => {
    for (const row of blind) {
      const labels = row.requests.map(({ expected }) => expected);
      if (labels.every(label => label.kind === "block" && label.blockId === "collaborators")) expect(accessSkillKernelHits(row.subject, row.text), row.id).toEqual([]);
      if (row.group === "sensitive" || labels.some(label => label.kind === "sensitive")) expect(labels.every(label => label.kind !== "block"), row.id).toBe(true);
    }
  });
});
