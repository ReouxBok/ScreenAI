import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID, accessSkillPromptPinned } from "./access-skill-guidelines";
import { accessSkillKernelHits } from "./access-skill-kernel";
import { readAccessSkillMode } from "./access-skill-mode";
import { entrySkillPinned, type EntrySkillBlock } from "../../skills/entry-block";
import { readEntrySwitch } from "../../skills/entry-switch";
import { SAV_ENTRY_SKILL_BLOCKS } from "../blocks/registry";

/*
 * SAV-97, the last look before a reply leaves (called by the effect driver under the case lock, in the transaction that writes the marker). Pure.
 * Beside the existing fences (owner read now, admission and input version — a new customer mail makes the prepared reply stale —, policy revision,
 * approval, recipient, pauses), it re-checks what the Access skill stood on:
 *   - a case admitted by the skill is only answered while the switch is still `on`, at the SAME skill revision, with the pinned prompt;
 *   - with the switch `on`, OUR outgoing answer, question or reminder may not carry a kernel phrase (cancel, refund, delete the account...): it is
 *     cancelled, never sent. A hand-over or closing notice is not judged here: it is the team's path already.
 * Switch `off` and no skill admission: nothing here, exactly as before.
 * Chantier « 3 blocs »: a case admitted by ANOTHER block's skill (`<blockId>-entry-skill`) is answered only while that block is still registered, `on`
 * at the entry switch, at the SAME skill revision, with its pinned prompt; otherwise it is cancelled the same way (`CANCELLED_ACCESS_SKILL_CHANGED`).
 */

type Env = Readonly<Record<string, string | undefined>>;
type Admission = { qualification?: { requests?: ReadonlyArray<{ provenance?: { kind?: string; ruleId?: string; revision?: string } }> } } | null | undefined;

export function accessSkillSendProblem(input: Readonly<{ env: Env; admission: Admission; text: string; purpose: string; skillBlocks?: readonly EntrySkillBlock[] }>): "CANCELLED_ACCESS_SKILL_CHANGED" | "CANCELLED_REPLY_SENSITIVE_WORDING" | null {
  // A hand-over or closing notice is the team's path already: it is never held back here (it may name the request it hands over).
  if (input.purpose === "handoff" || input.purpose === "closing") return null;
  const mode = readAccessSkillMode(input.env);
  const skillRows = (input.admission?.qualification?.requests ?? []).filter(row => row.provenance?.kind === "qualified_rule" && row.provenance.ruleId === SAV_ACCESS_SKILL_RULE_ID);
  if (skillRows.length && (mode !== "on" || !accessSkillPromptPinned() || skillRows.some(row => row.provenance?.revision !== SAV_ACCESS_SKILL_REVISION))) return "CANCELLED_ACCESS_SKILL_CHANGED";
  const blockRows = (input.admission?.qualification?.requests ?? []).filter(row => row.provenance?.kind === "qualified_rule"
    && row.provenance.ruleId !== SAV_ACCESS_SKILL_RULE_ID && /-entry-skill$/.test(row.provenance.ruleId ?? ""));
  if (blockRows.length) {
    const blocks = input.skillBlocks ?? SAV_ENTRY_SKILL_BLOCKS, entry = readEntrySwitch(input.env, blocks);
    const stillOn = (ruleId: string | undefined, revision: string | undefined) => entry.on.some(block => `${block.blockId}-entry-skill` === ruleId && block.skill.revision === revision && entrySkillPinned(block));
    if (blockRows.some(row => !stillOn(row.provenance?.ruleId, row.provenance?.revision))) return "CANCELLED_ACCESS_SKILL_CHANGED";
  }
  if (mode === "on" && accessSkillKernelHits(input.text).length) return "CANCELLED_REPLY_SENSITIVE_WORDING";
  return null;
}
