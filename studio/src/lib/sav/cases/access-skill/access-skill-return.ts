import "server-only";
import type { CaseReturnRulePort } from "../investigation-return-qualify";
import type { CaseEntryRule } from "../case-blocks";
import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID } from "./access-skill-guidelines";
import { accessSkillLogFields, readOrComputeAccessSkill, type AccessSkillDeps } from "./access-skill-judge";
import { readAccessSkillMode } from "./access-skill-rule";
import type { CaseAdmissionQualification } from "../case-types";
import { caseOpenBlockId } from "../case-blocks";
import { readCase } from "../case-store";
import { SAV_ENTRY_SKILL_BLOCKS } from "../blocks/registry";
import { entrySkillRuleOf } from "../entry-skills/entry-skill-rules";
import { entrySkillLogFields, readOrComputeEntrySkills } from "../entry-skills/entry-skill-reading";
import type { EntrySkillBlock } from "../../skills/entry-block";
import { readEntrySwitch } from "../../skills/entry-switch";

/*
 * SAV-97: a customer's return on an open V2 case, requalified by the SAME skill (its own stored reading, purpose `return`), replacing the lexical
 * judgment of `caseReturnContentRule` when the switch is `on`. The source checks before it (stored mail, thread, sender, version) are unchanged.
 *   - the skill admits and every open request is Access: they stay `access` under the skill's rule (`qualified_rule`, this revision);
 *   - a kernel phrase or a sensitive family named by the model or the counter-read: every open request takes that family, so the case is withdrawn to the team;
 *   - anything else (unsure, other, failed, unavailable): no rule answers, the hints alone never admit, the team.
 * `shadow`: the legacy rule decides, the skill is computed and compared in the logs only.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The skill's rule at THIS revision, as configured in `SAV_V2_ADMISSION_RULES_JSON`; null when absent (then the skill answers nothing on a return). */
export function configuredAccessSkillRule(env: Env): CaseEntryRule | null {
  let rules: unknown;
  try { rules = JSON.parse(env.SAV_V2_ADMISSION_RULES_JSON ?? "[]"); } catch { return null; }
  if (!Array.isArray(rules)) return null;
  return (rules as CaseEntryRule[]).find(rule => rule?.ruleId === SAV_ACCESS_SKILL_RULE_ID && rule.revision === SAV_ACCESS_SKILL_REVISION && rule.family === "access"
    && rule.v1Kind === "support" && (rule.blockId === undefined || rule.blockId === "access")) ?? null;
}

/** Chantier « 3 blocs »: where the return reads the one block of a case's open requests (`caseOpenBlockId` on the stored admission), and the known blocks. */
export type EntryBlockReturnDeps = Readonly<{ caseBlock?: (caseId: string) => Promise<string | null>; skillBlocks?: readonly EntrySkillBlock[] }>;

/**
 * Chantier « 3 blocs »: a return on a case whose open requests are all ONE other block's (admitted by its skill), requalified by THAT block's skill
 * (purpose `return`, no router: one block) and the shared counter-read, exactly like Access's return above:
 *   - admitted and every open request is the block's: they stay the block's under its rule (`qualified_rule`, its revision, its `blockId`);
 *   - a kernel phrase or a sensitive family named by the skill or the counter-read: every open request takes that family (the case goes to the team);
 *   - anything else: no rule answers, the team.
 * `null` when it does not apply (no block `on` at the entry, Access or no single block, the block's rule not configured): Access's path then, unchanged.
 */
async function entryBlockReturn(input: Readonly<{ env: () => Env; now: () => Date; deps?: Partial<AccessSkillDeps> & EntryBlockReturnDeps }>,
  port: Parameters<CaseReturnRulePort>[0]): Promise<CaseAdmissionQualification["requests"] | null> {
  const env = input.env(), entry = readEntrySwitch(env, input.deps?.skillBlocks ?? SAV_ENTRY_SKILL_BLOCKS);
  if (!entry.on.length || !port.requests.length || port.requests.some(row => row.family === "access")) return null;
  const blockId = await (input.deps?.caseBlock ?? (async (caseId: string) => { const snapshot = await readCase(caseId); return snapshot ? caseOpenBlockId(snapshot) : null; }))(port.caseId);
  const block = entry.on.find(row => row.blockId === blockId);
  let rules: CaseEntryRule[] = [];
  try { const parsed = JSON.parse(env.SAV_V2_ADMISSION_RULES_JSON ?? "[]") as unknown; rules = Array.isArray(parsed) ? parsed as CaseEntryRule[] : []; } catch { return null; }
  const rule = block ? entrySkillRuleOf(rules, block) : null;
  if (!block || !rule || port.requests.some(row => row.family !== block.family)) return null;
  const reading = await readOrComputeEntrySkills({ env: input.env, now: input.now, ...input.deps }, { purpose: "return", messageId: port.messageId, compute: true, catalog: { access: false, blocks: [block] },
    input: { purpose: "return", subject: port.changedSubject ?? "", text: port.text, originalRequest: null, requests: port.requests.map(row => ({ requestId: row.requestId, kind: row.family, words: null })) } });
  console.info("sav_v2_entry_skill", { caseId: port.caseId, messageId: port.messageId, mode: "on", purpose: "return", blockId: block.blockId, ...entrySkillLogFields(reading) });
  if (reading.status !== "ready") return [];
  const at = input.now().toISOString(), provenance = { kind: "qualified_rule" as const, ruleId: rule.ruleId, revision: rule.revision, at, blockId: block.blockId };
  const verdict = reading.verdict;
  if (verdict.outcome === "team") return verdict.family ? port.requests.map(row => ({ requestId: row.requestId, family: verdict.family!, provenance })) : [];
  if (port.requests.every(row => { const route = verdict.requests[row.requestId]; return route && "blockId" in route && route.blockId === block.blockId; }))
    return port.requests.map(row => ({ requestId: row.requestId, family: block.family, provenance }));
  return [];
}

export function accessSkillReturnRule(input: Readonly<{ env: () => Env; now: () => Date; deps?: Partial<AccessSkillDeps> & EntryBlockReturnDeps }>): CaseReturnRulePort {
  return async ({ caseId, messageId, text, changedSubject, requests }) => {
    const ruledByBlock = await entryBlockReturn(input, { caseId, messageId, text, changedSubject, requests });
    if (ruledByBlock) return ruledByBlock;
    const rule = configuredAccessSkillRule(input.env());
    if (!rule || !requests.length) return [];
    const reading = await readOrComputeAccessSkill({ env: input.env, now: input.now, ...input.deps }, { purpose: "return", messageId, compute: true,
      input: { purpose: "return", subject: changedSubject ?? "", text, originalRequest: null, requests: requests.map(row => ({ requestId: row.requestId, kind: row.family, words: null })) } });
    console.info("sav_v2_access_skill", { caseId, messageId, mode: "on", purpose: "return", ...accessSkillLogFields(reading) });
    if (reading.status !== "ready") return [];
    const at = input.now().toISOString(), provenance = { kind: "qualified_rule" as const, ruleId: rule.ruleId, revision: rule.revision, at };
    const verdict = reading.verdict;
    if (verdict.outcome === "team") return verdict.family ? requests.map(row => ({ requestId: row.requestId, family: verdict.family!, provenance })) : [];
    if (requests.every(row => row.family === "access" && verdict.requests[row.requestId] === "access"))
      return requests.map(row => ({ requestId: row.requestId, family: "access" as const, provenance }));
    return [];
  };
}

/** `shadow` on a return: the legacy rule's answer, unchanged; the skill computed beside it and compared in the logs (closed codes). */
export function shadowAccessSkillReturnRule(legacy: CaseReturnRulePort, input: Readonly<{ env: () => Env; now: () => Date; deps?: Partial<AccessSkillDeps> }>): CaseReturnRulePort {
  return async port => {
    const answer = await legacy(port);
    try {
      const reading = await readOrComputeAccessSkill({ env: input.env, now: input.now, ...input.deps }, { purpose: "return", messageId: port.messageId, compute: true,
        input: { purpose: "return", subject: port.changedSubject ?? "", text: port.text, originalRequest: null, requests: port.requests.map(row => ({ requestId: row.requestId, kind: row.family, words: null })) } });
      const legacyAdmits = answer.length > 0 && answer.every(row => row.family === "access"), fields = accessSkillLogFields(reading);
      console.info("sav_v2_access_skill_shadow", { caseId: port.caseId, messageId: port.messageId, purpose: "return", detectors: legacyAdmits ? "admit" : "team", ...fields, disagree: (fields.skill === "admit") !== legacyAdmits });
    } catch { console.error("sav_v2_access_skill_shadow", { messageId: port.messageId, purpose: "return", skill: "failed" }); }
    return answer;
  };
}

/** The return rule port the investigation uses for this switch (`off`: exactly the legacy one, or none). */
export function caseReturnRulesForAccessSkill(env: () => Env, now: () => Date, legacy: CaseReturnRulePort | undefined): CaseReturnRulePort | undefined {
  const mode = readAccessSkillMode(env());
  if (mode === "on") return accessSkillReturnRule({ env, now });
  if (mode === "shadow" && legacy) return shadowAccessSkillReturnRule(legacy, { env, now });
  return legacy;
}
