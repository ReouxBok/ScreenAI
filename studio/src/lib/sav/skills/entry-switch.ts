import { readAccessSkillMode, type AccessSkillMode } from "../cases/access-skill/access-skill-mode";
import { entrySkillBlockProblems, type EntrySkillBlock } from "./entry-block";

/*
 * The ENTRY switch of the blocks with a skill (chantier « 3 blocs », 19/11). Pure: reads the environment only.
 *
 *   SAV_V2_ENTRY_BLOCKS_JSON = {"<blockId>": "off" | "shadow" | "on", ...}
 *
 * A block absent from the setting is `off`. Absent, empty or unreadable setting: every block `off`, Access UNCHANGED (Access keeps its own switch,
 * `SAV_V2_ACCESS_SKILL`; an `access` key here is ignored). No wildcard: an unknown id is ignored and reported.
 *   off     nothing computed, nothing stored, nothing paid: production as before;
 *   shadow  the two-stage entry is computed and stored beside the real decision (on the relay only), disagreements stored and logged; it never changes
 *           an admission;
 *   on      the block takes part in the real entry. It still admits nobody until its rule `<blockId>-entry-skill` at its revision is configured in
 *           `SAV_V2_ADMISSION_RULES_JSON` and approved by the policy. `on` needs the Access skill `on` too (the shared kernel, counter-read and send
 *           fence live on Access's switch): otherwise the block is read `off` and the reason reported.
 * Whether an admitted case is answered as a draft or automatically is NOT this switch: it is the block switch (`block-switch.ts`) and the auto list.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_V2_ENTRY_BLOCKS_ENV = "SAV_V2_ENTRY_BLOCKS_JSON";
export type EntryBlockMode = "off" | "shadow" | "on";
export type EntrySwitchIgnored = Readonly<{ key: string; reason: "unknown_block" | "access_has_own_switch" | "mode_invalid" | "block_invalid" | "access_skill_not_on" }>;
export type EntrySwitch = Readonly<{
  accessMode: AccessSkillMode;
  /** Effective mode of each REGISTERED block (absent from the setting: `off`). */
  modes: ReadonlyMap<string, EntryBlockMode>;
  /** The registered blocks whose effective mode is `on`, in registry order. */
  on: readonly EntrySkillBlock[];
  /** The registered blocks whose effective mode is `shadow`, in registry order. */
  shadow: readonly EntrySkillBlock[];
  /** `setting_invalid`: the JSON could not be read (everything `off`). */
  problem: "setting_invalid" | null;
  ignored: readonly EntrySwitchIgnored[];
}>;

export function readEntrySwitch(env: Env, registry: readonly EntrySkillBlock[]): EntrySwitch {
  const accessMode = readAccessSkillMode(env), raw = env[SAV_V2_ENTRY_BLOCKS_ENV];
  const modes = new Map<string, EntryBlockMode>(registry.map(block => [block.blockId, "off"]));
  const ignored: EntrySwitchIgnored[] = [];
  let setting: Record<string, unknown> = {}, problem: EntrySwitch["problem"] = null;
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("not an object");
      setting = parsed as Record<string, unknown>;
    } catch { problem = "setting_invalid"; }
  }
  for (const [key, value] of Object.entries(setting)) {
    if (key === "access") { ignored.push({ key, reason: "access_has_own_switch" }); continue; }
    const block = registry.find(row => row.blockId === key);
    if (!block) { ignored.push({ key, reason: "unknown_block" }); continue; }
    if (value !== "off" && value !== "shadow" && value !== "on") { ignored.push({ key, reason: "mode_invalid" }); continue; }
    if (value === "off") continue;
    if (entrySkillBlockProblems(block).length) { ignored.push({ key, reason: "block_invalid" }); continue; }
    if (value === "on" && accessMode !== "on") { ignored.push({ key, reason: "access_skill_not_on" }); continue; }
    modes.set(key, value);
  }
  return { accessMode, modes, problem, ignored,
    on: registry.filter(block => modes.get(block.blockId) === "on"), shadow: registry.filter(block => modes.get(block.blockId) === "shadow") };
}

/**
 * How many blocks with a skill take part in the real entry: Access (when its skill is `on`) and every block `on`. The router is used only from 2;
 * with Access alone, the entry is exactly the SAV-97 path, byte for byte.
 */
export const entryActiveSkillBlockCount = (entry: EntrySwitch) => (entry.accessMode === "on" ? 1 : 0) + entry.on.length;
