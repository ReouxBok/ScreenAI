import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID } from "../access-skill/access-skill-guidelines";
import type { CaseEntryRule } from "../case-blocks";
import { SAV_CASE_ACCESS_BLOCK_ID } from "../case-types";
import { entrySkillRuleId, type EntrySkillBlock } from "../../skills/entry-block";
import type { EntryCatalog } from "../../skills/entry-decision";
import type { EntrySwitch } from "../../skills/entry-switch";

/*
 * Chantier « 3 blocs »: which configured admission rule speaks for each block with a skill. Pure. A block's rule is `<blockId>-entry-skill` at the block
 * skill's revision, family the block's, `v1Kind` `support`, and its `blockId` (always explicit). Access's is SAV-97's: `access-entry-skill` at its revision,
 * family `access`, no `blockId` or `access`. Any other revision, family or block: no rule, so nobody admitted (`decideCaseAdmission` then checks the
 * approved policy lists that rule and revision, exactly like Access).
 */

export const accessSkillRuleOf = (rules: readonly CaseEntryRule[]): CaseEntryRule | null =>
  rules.find(rule => rule?.ruleId === SAV_ACCESS_SKILL_RULE_ID && rule.revision === SAV_ACCESS_SKILL_REVISION && rule.family === "access" && rule.v1Kind === "support"
    && (rule.blockId === undefined || rule.blockId === SAV_CASE_ACCESS_BLOCK_ID)) ?? null;

export const entrySkillRuleOf = (rules: readonly CaseEntryRule[], block: EntrySkillBlock): CaseEntryRule | null =>
  rules.find(rule => rule?.ruleId === entrySkillRuleId(block.blockId) && rule.revision === block.skill.revision && rule.family === block.family
    && rule.v1Kind === "support" && rule.blockId === block.blockId) ?? null;

/**
 * The catalog of the REAL entry: Access when its rule is configured, and every block `on` whose rule is configured; with the rule of each.
 * The catalog of the SHADOW entry: Access when its skill is `on` or `shadow`, and every block `on` or `shadow`, rules or not (it never admits).
 */
export function entrySkillCatalog(rules: readonly CaseEntryRule[], entry: EntrySwitch, purpose: "real" | "shadow"): { catalog: EntryCatalog; rules: ReadonlyMap<string, CaseEntryRule> } {
  const found = new Map<string, CaseEntryRule>();
  const access = accessSkillRuleOf(rules);
  if (access) found.set(SAV_CASE_ACCESS_BLOCK_ID, access);
  for (const block of [...entry.on, ...entry.shadow]) { const rule = entrySkillRuleOf(rules, block); if (rule) found.set(block.blockId, rule); }
  if (purpose === "shadow") return { catalog: { access: entry.accessMode !== "off", blocks: [...entry.on, ...entry.shadow] }, rules: found };
  return { catalog: { access: Boolean(access) && entry.accessMode === "on", blocks: entry.on.filter(block => found.has(block.blockId)) }, rules: found };
}
