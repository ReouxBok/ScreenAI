import { SAV_ACCESS_SKILL_REVISION, SAV_ACCESS_SKILL_RULE_ID, accessSkillPromptPinned } from "./access-skill-guidelines";
import { accessSkillKernelHits } from "./access-skill-kernel";
import { readAccessSkillMode } from "./access-skill-mode";

/*
 * SAV-97, the last look before a reply leaves (called by the effect driver under the case lock, in the transaction that writes the marker). Pure.
 * Beside the existing fences (owner read now, admission and input version — a new customer mail makes the prepared reply stale —, policy revision,
 * approval, recipient, pauses), it re-checks what the Access skill stood on:
 *   - a case admitted by the skill is only answered while the switch is still `on`, at the SAME skill revision, with the pinned prompt;
 *   - with the switch `on`, OUR outgoing answer, question or reminder may not carry a kernel phrase (cancel, refund, delete the account...): it is
 *     cancelled, never sent. A hand-over or closing notice is not judged here: it is the team's path already.
 * Switch `off` and no skill admission: nothing here, exactly as before.
 */

type Env = Readonly<Record<string, string | undefined>>;
type Admission = { qualification?: { requests?: ReadonlyArray<{ provenance?: { kind?: string; ruleId?: string; revision?: string } }> } } | null | undefined;

export function accessSkillSendProblem(input: Readonly<{ env: Env; admission: Admission; text: string; purpose: string }>): "CANCELLED_ACCESS_SKILL_CHANGED" | "CANCELLED_REPLY_SENSITIVE_WORDING" | null {
  // A hand-over or closing notice is the team's path already: it is never held back here (it may name the request it hands over).
  if (input.purpose === "handoff" || input.purpose === "closing") return null;
  const mode = readAccessSkillMode(input.env);
  const skillRows = (input.admission?.qualification?.requests ?? []).filter(row => row.provenance?.kind === "qualified_rule" && row.provenance.ruleId === SAV_ACCESS_SKILL_RULE_ID);
  if (skillRows.length && (mode !== "on" || !accessSkillPromptPinned() || skillRows.some(row => row.provenance?.revision !== SAV_ACCESS_SKILL_REVISION))) return "CANCELLED_ACCESS_SKILL_CHANGED";
  if (mode === "on" && accessSkillKernelHits(input.text).length) return "CANCELLED_REPLY_SENSITIVE_WORDING";
  return null;
}
