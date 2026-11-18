import "server-only";
import type { CaseReturnRulePort } from "../investigation-return-qualify";
import type { CaseEntryRule } from "../case-blocks";
import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID } from "./access-skill-guidelines";
import { accessSkillLogFields, readOrComputeAccessSkill, type AccessSkillDeps } from "./access-skill-judge";
import { readAccessSkillMode } from "./access-skill-rule";

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

export function accessSkillReturnRule(input: Readonly<{ env: () => Env; now: () => Date; deps?: Partial<AccessSkillDeps> }>): CaseReturnRulePort {
  return async ({ caseId, messageId, text, changedSubject, requests }) => {
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
