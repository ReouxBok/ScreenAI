import { describe, expect, it } from "vitest";
import { entrySkillBlockProblems } from "../../skills/entry-block";
import { entryConfirmBudget, entryRouterBudget } from "../../skills/entry-budget";
import { entryActiveSkillBlockCount, readEntrySwitch } from "../../skills/entry-switch";
import { SAV_ACCESS_SKILL_PROMPT_SHA256, SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID, accessSkillPromptPinned } from "../access-skill/access-skill-guidelines";
import { accessSkillSendProblem } from "../access-skill/access-skill-send-fence";
import { readAutoReplyConfig, savAutoReplyBlockListed, savAutoReplyLegacyAccessOnly } from "../block-auto-reply";
import { SAV_CASE_ADMISSIBLE_FAMILIES } from "../case-types";
import { SAV_CASE_BLOCK_SCOPE_FAMILIES } from "../investigation-access-scope";
import { SAV_ENTRY_SKILL_BLOCKS } from "./registry";

/*
 * Assembly of the « 3 blocs » (19/11): the three blocks are registered, valid, and OFF. No default value turns one on; Access stays exactly as in
 * production (same fingerprint, revision, rule, send fence; `SAV_V2_AUTO_REPLY=access` keeps today's list).
 */

const APPROVER = "20000000-0000-4000-8000-000000000009";
/** Production-like settings today: Access's skill on, Access alone in the auto list, no entry-block setting. */
const PROD_LIKE = { SAV_V2_ACCESS_SKILL: "on", SAV_V2_AUTO_REPLY: "access", SAV_V2_AUTO_APPROVER_ID: APPROVER };

describe("registre des blocs à skill (assemblage)", () => {
  it("Collaborateurs et Charly Max en `usage`, Intégrations en `integration` ; manifestes alignés ; familles admissibles et périmètres d'accord", () => {
    expect(SAV_ENTRY_SKILL_BLOCKS.map(block => [block.blockId, block.family, block.manifest.family])).toEqual([
      ["collaborators", "usage", "usage"], ["charly_max", "usage", "usage"], ["integrations", "integration", "integration"]]);
    for (const block of SAV_ENTRY_SKILL_BLOCKS) {
      expect(entrySkillBlockProblems(block), block.blockId).toEqual([]);
      expect((SAV_CASE_ADMISSIBLE_FAMILIES as readonly string[]).includes(block.family), block.blockId).toBe(true);
      expect((SAV_CASE_BLOCK_SCOPE_FAMILIES as readonly string[]).includes(block.family), block.blockId).toBe(true);
    }
  });
  it("tous arrivent `off` : aucune valeur par défaut ne les allume", () => {
    for (const block of SAV_ENTRY_SKILL_BLOCKS) expect(block.initialMode).toBe("off");
    for (const env of [{}, PROD_LIKE, { ...PROD_LIKE, SAV_V2_ENTRY_BLOCKS_JSON: "" }, { ...PROD_LIKE, SAV_V2_ENTRY_BLOCKS_JSON: "{}" },
      { ...PROD_LIKE, SAV_V2_ENTRY_BLOCKS_JSON: "not json" }, { ...PROD_LIKE, SAV_V2_ENTRY_BLOCKS_JSON: "[\"collaborators\"]" },
      { ...PROD_LIKE, SAV_V2_ENTRY_BLOCKS_JSON: JSON.stringify({ "*": "on", all: "on", access: "on" }) }]) {
      const entry = readEntrySwitch(env, SAV_ENTRY_SKILL_BLOCKS);
      expect(entry.on).toEqual([]);
      expect(entry.shadow).toEqual([]);
      expect([...entry.modes.values()]).toEqual(["off", "off", "off"]);
    }
    // `on` needs Access's skill `on`: otherwise read `off`, reason reported.
    const noAccess = readEntrySwitch({ SAV_V2_ENTRY_BLOCKS_JSON: JSON.stringify({ collaborators: "on", charly_max: "on", integrations: "on" }) }, SAV_ENTRY_SKILL_BLOCKS);
    expect(noAccess.on).toEqual([]);
    expect(noAccess.ignored.map(row => row.reason)).toEqual(["access_skill_not_on", "access_skill_not_on", "access_skill_not_on"]);
  });
  it("réglages de prod actuels : Accès seul compte à l'entrée, donc le chemin SAV-97 octet pour octet", () => {
    expect(entryActiveSkillBlockCount(readEntrySwitch(PROD_LIKE, SAV_ENTRY_SKILL_BLOCKS))).toBe(1);
  });
  it("Accès strictement identique : empreinte becaf5e…, révision, règle, barrière d'envoi", () => {
    expect(SAV_ACCESS_SKILL_PROMPT_SHA256).toBe("becaf5e200142452bccdaf15b53600cf74996a0a1391cb00deb08ccedae73012");
    expect(SAV_ACCESS_SKILL_REVISION).toBe("sav-access-entry-skill-2026-11-18.v1");
    expect(SAV_ACCESS_SKILL_RULE_ID).toBe("access-entry-skill");
    expect(accessSkillPromptPinned()).toBe(true);
    const access = { qualification: { requests: [{ provenance: { kind: "qualified_rule", ruleId: SAV_ACCESS_SKILL_RULE_ID, revision: SAV_ACCESS_SKILL_REVISION } }] } };
    // The real registry (3 blocks) changes nothing for an Access case.
    expect(accessSkillSendProblem({ env: PROD_LIKE, admission: access, text: "Voici la marche à suivre.", purpose: "answer" })).toBeNull();
    expect(accessSkillSendProblem({ env: { SAV_V2_ACCESS_SKILL: "off" }, admission: access, text: "Voici la marche à suivre.", purpose: "answer" })).toBe("CANCELLED_ACCESS_SKILL_CHANGED");
  });
  it("`SAV_V2_AUTO_REPLY=access` garde la liste d'aujourd'hui : aucun des 3 blocs n'est listé", () => {
    const config = readAutoReplyConfig(PROD_LIKE);
    expect(config.mode).toBe("on");
    expect(savAutoReplyLegacyAccessOnly(config)).toBe(true);
    for (const block of SAV_ENTRY_SKILL_BLOCKS) expect(savAutoReplyBlockListed(config, block.blockId)).toBe(false);
  });
  it("budgets de prompt (plafond 26 000 o inchangé) : chaque confirmation et le routeur à 4 blocs sous 85 %", () => {
    const bytes = Object.fromEntries(SAV_ENTRY_SKILL_BLOCKS.map(block => [block.blockId, entryConfirmBudget(block)]));
    for (const [blockId, measure] of Object.entries(bytes)) {
      expect(measure.ceilingBytes, blockId).toBe(26_000);
      expect(measure.status, blockId).toBe("pass");
      expect(measure.bodyBytes, blockId).toBeLessThan(22_100);
    }
    expect(Object.fromEntries(Object.entries(bytes).map(([blockId, measure]) => [blockId, measure.bodyBytes]))).toEqual({ collaborators: 22_068, charly_max: 21_832, integrations: 21_899 });
    const router = entryRouterBudget(SAV_ENTRY_SKILL_BLOCKS);
    expect(router.status).toBe("pass");
    expect(router.bodyBytes).toBe(ROUTER_BYTES);
  });
});
/** Router body with Access + the 3 blocks on the longest accepted mail (68,5 % of 26 000). */
const ROUTER_BYTES = 17_804;
