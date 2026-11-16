import { describe, expect, it, vi } from "vitest";
import { SAV_CASE_BLOCK_REGISTRY } from "../cases/case-block-registry";
import { caseBlockCandidates } from "../cases/case-blocks";
import { firstPersonalLoginRequest } from "../cases/investigation-return-qualify";
import { savBlockManifestProblems } from "./block-attribution";
import { runSavBlockReplay } from "./block-replay";
import { SAV_COLLABORATORS_BLOCK } from "./collaborators-block";
import { SAV_COLLABORATORS_INDEX_PHRASES, SAV_COLLABORATORS_TEST_PHRASES } from "./collaborators-phrases";

const holdout = SAV_COLLABORATORS_TEST_PHRASES.filter(row => row.split === "holdout");

describe("SAV-92 collaborators: offline preparation only", () => {
  it("keeps the reserved phrases out of the index input", () => {
    expect([SAV_COLLABORATORS_INDEX_PHRASES.length, holdout.length]).toEqual([20, 10]);
    expect(new Set(SAV_COLLABORATORS_TEST_PHRASES.map(row => row.id)).size).toBe(30);
    expect(new Set(SAV_COLLABORATORS_TEST_PHRASES.map(row => row.text)).size).toBe(30);
    expect(SAV_COLLABORATORS_TEST_PHRASES.filter(row => row.kind === "neighbour")).toHaveLength(9);
    expect(SAV_COLLABORATORS_TEST_PHRASES.filter(row => row.kind === "trap")).toHaveLength(6);
    const indexContent = SAV_COLLABORATORS_INDEX_PHRASES.map(row => row.text).join("\n");
    for (const row of holdout) {
      expect(SAV_COLLABORATORS_INDEX_PHRASES).not.toContain(row);
      expect(indexContent).not.toContain(row.text);
    }
  });

  it("is off, unbound and absent from live admission even with an explicit rule", () => {
    expect(SAV_COLLABORATORS_BLOCK.mode).toBe("off");
    expect(SAV_COLLABORATORS_BLOCK.cardIds).toEqual([]);
    expect(SAV_COLLABORATORS_BLOCK.supportCardIds).toEqual([]);
    expect(SAV_CASE_BLOCK_REGISTRY.map(row => [row.blockId, row.family])).toEqual([["access", "access"]]);
    expect(SAV_CASE_BLOCK_REGISTRY[0]!.firstRequest).toBe(firstPersonalLoginRequest);
    expect(caseBlockCandidates([{ blockId: "collaborators", ruleId: "syn-collaborators", revision: "syn",
      family: "usage", v1Kind: "support", at: "2026-11-16T09:00:00Z" }], SAV_CASE_BLOCK_REGISTRY)).toEqual([]);
    expect(savBlockManifestProblems([SAV_COLLABORATORS_BLOCK])).toEqual([{ code: "card_list_empty", blockId: "collaborators" }]);
  });

  it("refuses replay before search while no published cards are bound", async () => {
    const search = vi.fn(async () => { throw Error("SEARCH_FORBIDDEN_BEFORE_BINDING"); });
    await expect(runSavBlockReplay([], { blocks: [SAV_COLLABORATORS_BLOCK], now: new Date("2026-11-16T09:00:00Z") },
      { search: { readRevision: async () => "syn", search } })).rejects.toThrow("card_list_empty:collaborators");
    expect(search).not.toHaveBeenCalled();
  });
});

describe("unchanged Access detector: personal login only", () => {
  it.each(SAV_COLLABORATORS_TEST_PHRASES)("$id [$split] $kind: $expected", row => {
    expect(firstPersonalLoginRequest(row.text, "")).toBe(row.expected === "access");
  });

  it("does not admit collaborator wording under an Access subject", () => {
    for (const row of SAV_COLLABORATORS_TEST_PHRASES.filter(row => row.expected === "collaborators")) {
      expect(firstPersonalLoginRequest(row.text, "Code de connexion à mon compte Limova")).toBe(false);
    }
  });
});
