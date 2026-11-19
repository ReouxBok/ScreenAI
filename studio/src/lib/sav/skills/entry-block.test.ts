import { describe, expect, it } from "vitest";
import { FAKE_BLOCK, FAKE_BLOCK_B } from "../../../../test/sav-entry-fake-block";
import { SAV_ACCESS_SKILL_PROMPT_SHA256, accessSkillPromptSha256 } from "../cases/access-skill/access-skill-guidelines";
import { SAV_ENTRY_SKILL_BLOCKS } from "../cases/blocks/registry";
import { lintCorpus } from "./corpus-lint";
import { entryAccessJudgeBudget, entryConfirmBudget, entryCounterBudget, entryRouterBudget } from "./entry-budget";
import { entryConfirmPromptSha256, entrySkillBlockProblems, entrySkillPinned, renderEntryConfirmPrompt, SAV_ENTRY_CONFIRM_OUTPUT_JSON_SCHEMA } from "./entry-block";
import { entryPackageSha256 } from "./entry-package";
import { entryRouterAccessLine, entryRouterFrameSha256, entryRouterLineOf, entryRouterPinned, readEntryRouterOutput, renderEntryRouterPrompt, SAV_ENTRY_ROUTER_FRAME_SHA256 } from "./entry-router";
import { entryActiveSkillBlockCount, readEntrySwitch } from "./entry-switch";

describe("enregistrement d'un bloc à skill (interface publiée)", () => {
  it("le bloc factice est valide, épinglé, son corpus passe le lint N3", () => {
    expect(entrySkillBlockProblems(FAKE_BLOCK)).toEqual([]);
    expect(entrySkillBlockProblems(FAKE_BLOCK_B)).toEqual([]);
    expect(entryConfirmPromptSha256(FAKE_BLOCK)).toBe(FAKE_BLOCK.promptSha256);
    expect(lintCorpus({ cases: FAKE_BLOCK.corpus, examples: FAKE_BLOCK.skill.examples, minimums: FAKE_BLOCK.corpusMinimums })).toEqual([]);
  });
  it("le prompt rendu = cadre commun + skill N3 ; toute retouche le dépingle", () => {
    const prompt = renderEntryConfirmPrompt(FAKE_BLOCK);
    expect(prompt).toMatch(/^COMPÉTENCE D'ENTRÉE « Démo export » \(bloc "demo_export"\)/);
    expect(prompt).toContain('Skill "demo_export-entry-skill" (confirm, revision "sav-demo_export-entry-skill-2026-11-19.v1")');
    const edited = { ...FAKE_BLOCK, skill: { ...FAKE_BLOCK.skill, examples: [...FAKE_BLOCK.skill.examples, { id: "d05", text: "Imprimer ?", verdict: "block", comment: "x" }] } };
    expect(entrySkillPinned(edited)).toBe(false);
    expect(entrySkillBlockProblems(edited)).toEqual(["prompt_unpinned"]);
  });
  it("refuse un bloc mal formé (codes fermés)", () => {
    const bad = { ...FAKE_BLOCK, blockId: "access", family: "access" as never, label: "", router: { covers: "", notThis: "x" },
      skill: { ...FAKE_BLOCK.skill, id: "x", role: "entry" as const, outputSchema: { type: "object" }, examples: [{ id: "e", text: "t", verdict: "maybe", comment: "c" }] },
      corpus: [], corpusMinimums: { ...FAKE_BLOCK.corpusMinimums, trap: 0 }, initialMode: "on" as never };
    expect(entrySkillBlockProblems(bad).sort()).toEqual(["block_id_invalid", "corpus_empty", "corpus_quota_invalid", "example_verdict_invalid", "example_verdict_missing", "family_invalid",
      "initial_mode_invalid", "label_invalid", "manifest_block_mismatch", "manifest_family_mismatch", "manifest_skill_missing", "output_schema_invalid", "prompt_unpinned", "router_line_invalid",
      "skill_id_invalid", "skill_role_invalid"]);
  });
  it("le schéma de sortie commun est celui du juge (verdict block)", () => {
    expect(JSON.stringify(SAV_ENTRY_CONFIRM_OUTPUT_JSON_SCHEMA)).toContain('"block"');
  });
  it("le registre de production est vide tant que l'assemblage n'y ajoute pas les blocs ; chaque bloc listé serait valide", () => {
    for (const block of SAV_ENTRY_SKILL_BLOCKS) expect(entrySkillBlockProblems(block)).toEqual([]);
    expect(new Set(SAV_ENTRY_SKILL_BLOCKS.map(block => block.blockId)).size).toBe(SAV_ENTRY_SKILL_BLOCKS.length);
  });
});

describe("Accès inchangé", () => {
  it("même empreinte becaf5e… et même révision", () => {
    expect(SAV_ACCESS_SKILL_PROMPT_SHA256).toBe("becaf5e200142452bccdaf15b53600cf74996a0a1391cb00deb08ccedae73012");
    expect(accessSkillPromptSha256()).toBe(SAV_ACCESS_SKILL_PROMPT_SHA256);
  });
});

describe("routeur", () => {
  it("cadre épinglé ; catalogue trié ; le rendu change avec le catalogue", () => {
    expect(entryRouterFrameSha256()).toBe(SAV_ENTRY_ROUTER_FRAME_SHA256);
    expect(entryRouterPinned()).toBe(true);
    const a = renderEntryRouterPrompt([entryRouterLineOf(FAKE_BLOCK), entryRouterAccessLine()]), b = renderEntryRouterPrompt([entryRouterAccessLine(), entryRouterLineOf(FAKE_BLOCK)]);
    expect(a).toBe(b);
    expect(a.indexOf("- access")).toBeLessThan(a.indexOf("- demo_export"));
    expect(renderEntryRouterPrompt([entryRouterAccessLine()])).not.toBe(a);
  });
  it("sortie stricte : chaque demande une fois, route connue", () => {
    const ok = { mailSensitive: "no", requests: [{ requestId: "r1", route: "demo_export", reason: "x" }, { requestId: "r2", route: "other", reason: "x" }] };
    expect(readEntryRouterOutput(ok, ["r1", "r2"], ["access", "demo_export"])).toMatchObject({ ok: true });
    expect(readEntryRouterOutput(ok, ["r1"], ["access", "demo_export"])).toEqual({ ok: false, problem: "router_request_set_mismatch" });
    expect(readEntryRouterOutput(ok, ["r1", "r2"], ["access"])).toEqual({ ok: false, problem: "router_route_unknown" });
    expect(readEntryRouterOutput({ ...ok, extra: 1 }, ["r1", "r2"], ["access", "demo_export"])).toEqual({ ok: false, problem: "router_invalid" });
  });
});

describe("interrupteur d'entrée SAV_V2_ENTRY_BLOCKS_JSON", () => {
  const registry = [FAKE_BLOCK, FAKE_BLOCK_B];
  it("absent, vide ou illisible : tout off, Accès inchangé", () => {
    for (const value of [undefined, "", "  ", "nope", "[]", "null"]) {
      const entry = readEntrySwitch({ SAV_V2_ACCESS_SKILL: "on", ...(value === undefined ? {} : { SAV_V2_ENTRY_BLOCKS_JSON: value }) }, registry);
      expect([...entry.modes.values()]).toEqual(["off", "off"]);
      expect(entry.accessMode).toBe("on");
      expect(entryActiveSkillBlockCount(entry)).toBe(1);
    }
    expect(readEntrySwitch({ SAV_V2_ENTRY_BLOCKS_JSON: "nope" }, registry).problem).toBe("setting_invalid");
  });
  it("on / shadow ; inconnu, access, mode invalide ignorés ; on exige Accès on", () => {
    const value = JSON.stringify({ demo_export: "on", demo_voice: "shadow", ghost: "on", access: "off", other: "ON" });
    const entry = readEntrySwitch({ SAV_V2_ACCESS_SKILL: "on", SAV_V2_ENTRY_BLOCKS_JSON: value }, registry);
    expect(entry.on.map(block => block.blockId)).toEqual(["demo_export"]);
    expect(entry.shadow.map(block => block.blockId)).toEqual(["demo_voice"]);
    expect(entry.ignored).toEqual([{ key: "ghost", reason: "unknown_block" }, { key: "access", reason: "access_has_own_switch" }, { key: "other", reason: "unknown_block" }]);
    expect(entryActiveSkillBlockCount(entry)).toBe(2);
    const off = readEntrySwitch({ SAV_V2_ACCESS_SKILL: "shadow", SAV_V2_ENTRY_BLOCKS_JSON: value }, registry);
    expect(off.on).toEqual([]);
    expect(off.ignored).toContainEqual({ key: "demo_export", reason: "access_skill_not_on" });
    expect(readEntrySwitch({ SAV_V2_ACCESS_SKILL: "on", SAV_V2_ENTRY_BLOCKS_JSON: JSON.stringify({ demo_export: "maybe" }) }, registry).ignored).toEqual([{ key: "demo_export", reason: "mode_invalid" }]);
  });
  it("un bloc invalide (dépinglé) n'est jamais actif", () => {
    const broken = { ...FAKE_BLOCK, promptSha256: "0".repeat(64) };
    const entry = readEntrySwitch({ SAV_V2_ACCESS_SKILL: "on", SAV_V2_ENTRY_BLOCKS_JSON: JSON.stringify({ demo_export: "on" }) }, [broken]);
    expect(entry.on).toEqual([]);
    expect(entry.ignored).toEqual([{ key: "demo_export", reason: "block_invalid" }]);
  });
});

describe("paquet et budget de prompt par étage (≤ 85 % de 26 000 octets, fil le plus long accepté)", () => {
  it("l'empreinte du paquet dépend de la composition, pas de l'ordre", () => {
    const a = entryPackageSha256({ access: true, blocks: [FAKE_BLOCK, FAKE_BLOCK_B] }, "m"), b = entryPackageSha256({ access: true, blocks: [FAKE_BLOCK_B, FAKE_BLOCK] }, "m");
    expect(a).toBe(b);
    expect(entryPackageSha256({ access: true, blocks: [FAKE_BLOCK] }, "m")).not.toBe(a);
    expect(entryPackageSha256({ access: true, blocks: [FAKE_BLOCK, FAKE_BLOCK_B] }, "m2")).not.toBe(a);
  });
  it("chiffres exacts", () => {
    const router4 = entryRouterBudget([FAKE_BLOCK, FAKE_BLOCK_B, { ...FAKE_BLOCK, blockId: "demo_c" }]);
    const measures = { router4, confirm: entryConfirmBudget(FAKE_BLOCK), counter: entryCounterBudget(), accessJudge: entryAccessJudgeBudget() };
    expect(measures).toEqual({
      router4: { stage: "entry", bodyBytes: router4.bodyBytes, ceilingBytes: 26_000, status: "pass" },
      confirm: { stage: "confirm", bodyBytes: 19_504, ceilingBytes: 26_000, status: "pass" },
      counter: { stage: "confirm", bodyBytes: 15_792, ceilingBytes: 26_000, status: "pass" },
      // SAV-97's judge, unchanged: on the longest accepted thread it is already above the transport ceiling (input_too_large → the team). Reported, not altered.
      accessJudge: { stage: "confirm", bodyBytes: 29_467, ceilingBytes: 26_000, status: "fail" },
    });
    expect(router4.bodyBytes).toBeLessThan(26_000 * 0.85);
  });
});
