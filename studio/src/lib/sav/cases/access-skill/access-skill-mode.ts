/*
 * SAV-97: the switch of the Access skill, `SAV_V2_ACCESS_SKILL`. Pure, no import: read by the entry, the decision prompt, the validator and the send fence.
 *   off    (default: absent, empty or any other value) production as before SAV-97, byte for byte: same admissions, same prompts;
 *   shadow the skill is computed, stored and compared with the detectors in the logs, it never changes an admission;
 *   on     the skill decides Access.
 */
type Env = Readonly<Record<string, string | undefined>>;
export const SAV_V2_ACCESS_SKILL_ENV = "SAV_V2_ACCESS_SKILL";
export type AccessSkillMode = "off" | "shadow" | "on";
export function readAccessSkillMode(env: Env = process.env): AccessSkillMode {
  const value = env[SAV_V2_ACCESS_SKILL_ENV];
  return value === "on" || value === "shadow" ? value : "off";
}
