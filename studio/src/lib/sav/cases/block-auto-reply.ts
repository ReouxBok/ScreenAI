import { SAV_CASE_ACCESS_BLOCK_ID, SAV_CASE_BLOCK_ID } from "./case-types";
import { accessSkillKernelHits } from "./access-skill/access-skill-kernel";

/*
 * Automatic reply per treatment block (19/11). Pure: no model, network, database or clock (one log line for an ignored entry).
 *
 * Until now only Access could answer alone, and the right was written in seven places. It is now ONE explicit allow-list, read from the server
 * setting `SAV_V2_AUTO_REPLY` (production configuration: only Ugo changes it, for one target at a time):
 *   - a comma-separated list of block ids: `access` (today's value, unchanged meaning), `access,collaborators`...;
 *   - a qualified PAIR of listed blocks, `access+collaborators`, lets one reply that covers exactly those two blocks go out alone; without it, a reply
 *     covering several blocks stays a draft for a person (`multi_block_draft`);
 *   - never a joker: `*`, `all`, an id in capitals or with any other character, a pair whose two blocks are not both listed, are ignored (and logged);
 *     an empty list means none. Absent, empty or only ignored entries: off, as today without `access`.
 * The stricter wins: being listed is necessary, never sufficient. The block's own switch must also be an explicit `auto`, not paused, and every
 * proof of A's rule still holds (`decideAutoApproval`).
 *
 * Byte-for-byte compatibility: with the list `access` alone (no other block, no pair) every decision is the one made before this file existed,
 * with the same reason codes (`not_access_only`). Any other list judges the blocks of the open requests (`autoBlockProblem`).
 */

export type AutoReplyConfig =
  | Readonly<{ mode: "off"; why: "disabled" | "approver_invalid"; blocks: ReadonlySet<string>; pairs: ReadonlySet<string>; ignored: readonly string[] }>
  | Readonly<{ mode: "on"; approverId: string; blocks: ReadonlySet<string>; pairs: ReadonlySet<string>; ignored: readonly string[] }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Words that could read as a joker: never a block id, even though they match the id pattern. */
const RESERVED = new Set(["all", "any", "none", "every", "everything", "tous", "toutes"]);
const blockToken = (token: string) => SAV_CASE_BLOCK_ID.test(token) && !RESERVED.has(token);
/** The canonical key of a pair: its two ids sorted, joined by `+`. */
export const savAutoReplyPairKey = (ids: readonly string[]) => [...ids].sort().join("+");

const logged = new Set<string>();
function logIgnored(raw: string, ignored: readonly string[]) {
  if (!ignored.length || logged.has(raw) || logged.size > 50) return;
  logged.add(raw);
  console.warn(`[sav-v2] SAV_V2_AUTO_REPLY: ${ignored.length} ignored entr${ignored.length > 1 ? "ies" : "y"} (never a joker): ${ignored.map(entry => JSON.stringify(entry.slice(0, 60))).join(", ")}`);
}

/** The one reading of the allow-list. `on` needs at least one listed block AND a rule approver UUID (never a person's), exactly as before. */
export function readAutoReplyConfig(env: Readonly<Record<string, string | undefined>>): AutoReplyConfig {
  const raw = env.SAV_V2_AUTO_REPLY ?? "";
  const blocks = new Set<string>(), pairTokens: string[] = [], ignored: string[] = [];
  for (const token of raw.split(",").map(part => part.trim()).filter(Boolean)) {
    const pair = token.split("+");
    if (pair.length === 2 && pair.every(blockToken) && pair[0] !== pair[1]) pairTokens.push(token);
    else if (blockToken(token)) blocks.add(token);
    else ignored.push(token);
  }
  const pairs = new Set<string>();
  for (const token of pairTokens) {
    const ids = token.split("+");
    if (ids.every(id => blocks.has(id))) pairs.add(savAutoReplyPairKey(ids));
    else ignored.push(token);
  }
  logIgnored(raw, ignored);
  if (!blocks.size) return { mode: "off", why: "disabled", blocks, pairs, ignored };
  const approverId = env.SAV_V2_AUTO_APPROVER_ID ?? "";
  return UUID.test(approverId) ? { mode: "on", approverId: approverId.toLowerCase(), blocks, pairs, ignored } : { mode: "off", why: "approver_invalid", blocks, pairs, ignored };
}

/** Today's list: Access alone, no other block, no pair. Every decision then follows the code that existed before the allow-list, reason codes included. */
export const savAutoReplyLegacyAccessOnly = (config: Pick<AutoReplyConfig, "blocks" | "pairs">) =>
  config.blocks.size === 1 && config.blocks.has(SAV_CASE_ACCESS_BLOCK_ID) && config.pairs.size === 0;

/** Whether the allow-list lets this block answer alone (listed). The block's switch and A's rule still decide. */
export const savAutoReplyBlockListed = (config: AutoReplyConfig, blockId: string) => config.mode === "on" && config.blocks.has(blockId);

export const SAV_AUTO_BLOCK_PROBLEMS = ["not_access_only", "block_unknown", "block_not_allowed", "multi_block_draft"] as const;
export type SavAutoBlockProblem = typeof SAV_AUTO_BLOCK_PROBLEMS[number];

/**
 * The single place of the block rule, shared by the approval (`decideAutoApproval`), the reply passage and J2: why the blocks of the case's open
 * requests do not let the rule approve, or null.
 *   - legacy list (`access` alone): every open request is of the family `access`, else `not_access_only` (unchanged);
 *   - otherwise each open request has a known block (`block_unknown`: none recorded, never guessed from a family two blocks may share), each of
 *     those blocks is listed (`block_not_allowed`), and they are ONE block, or exactly two whose pair is qualified (`multi_block_draft`: a person).
 * `openBlocks`: each open request's family and block (`caseRequestBlockId`, null when no admission names one); absent: not read, so unknown.
 */
export type SavAutoOpenBlock = Readonly<{ family: string; blockId: string | null }>;
export function autoBlockProblem(facts: Readonly<{ openFamilies: readonly string[]; openBlocks?: readonly SavAutoOpenBlock[] }>,
  config: Pick<AutoReplyConfig, "blocks" | "pairs">): SavAutoBlockProblem | null {
  if (savAutoReplyLegacyAccessOnly(config))
    return !facts.openFamilies.length || facts.openFamilies.some(family => family !== "access") ? "not_access_only" : null;
  const rows = facts.openBlocks;
  if (!rows?.length || rows.some(row => typeof row.blockId !== "string" || !SAV_CASE_BLOCK_ID.test(row.blockId))) return "block_unknown";
  // The family `access` is the Access block's alone, both ways: anything else is a mis-recorded block, never trusted.
  if (rows.some(row => (row.family === "access") !== (row.blockId === SAV_CASE_ACCESS_BLOCK_ID))) return "block_unknown";
  const distinct = [...new Set(rows.map(row => row.blockId as string))].sort();
  if (distinct.some(id => !config.blocks.has(id))) return "block_not_allowed";
  if (distinct.length > 1 && !(distinct.length === 2 && config.pairs.has(savAutoReplyPairKey(distinct)))) return "multi_block_draft";
  return null;
}

/**
 * Revue Astra P1 (19/11): the allow-list is read AGAIN at the send fence, for a reply the RULE approved (its basis), not only at the approval. Between the
 * approval and the send an operator may withdraw a block from `SAV_V2_AUTO_REPLY`: the queued reply then no longer goes out alone. Why, or null:
 *   - `auto_off`: the list no longer grants anything (absent, empty, no valid approver);
 *   - with the list `access` alone: the case's admission names a block other than Access (`caseBlockAdmittedOtherThanAccess`), so its approval came from a
 *     longer list (`not_access_only`); an Access case is judged exactly as before (no new reading, nothing else checked);
 *   - any other list: the same rule as the approval (`autoBlockProblem`) on the open requests' blocks, read in the admission (`caseRequestBlockId`): each
 *     block listed, and one block or a qualified pair. Absent rows: unknown, never a default block.
 * The same config and the same facts as at the approval give the same answer: nothing changes while the operator changes nothing.
 */
export type SavAutoReplyWithdrawn = "auto_off" | SavAutoBlockProblem;
export function autoReplyWithdrawnProblem(config: AutoReplyConfig, facts: Readonly<{ admission: unknown; openBlocks: readonly SavAutoOpenBlock[] | null }>): SavAutoReplyWithdrawn | null {
  if (config.mode !== "on") return "auto_off";
  if (savAutoReplyLegacyAccessOnly(config)) return caseBlockAdmittedOtherThanAccess(facts.admission) ? "not_access_only" : null;
  const rows = facts.openBlocks ?? [];
  return autoBlockProblem({ openFamilies: rows.map(row => row.family), openBlocks: facts.openBlocks ?? undefined }, config);
}

/**
 * « Le noyau dans notre réponse » for every block other than Access: OUR outgoing answer, question or reminder of a case a block's rule admitted
 * never carries a kernel phrase (cancel, refund, delete the account...). A hit: not approved by the rule, and cancelled at the send fence, whoever
 * approved it. A hand-over or closing notice is the team's path already and is not judged here. Access keeps its own fence, unchanged
 * (`access-skill-send-fence.ts`, behind its switch). Keyed on the admission (a `qualified_rule` naming a block other than Access), so a case no
 * such rule admitted (every case in production before a second block exists) is untouched.
 */
type Admission = { qualification?: { requests?: ReadonlyArray<{ provenance?: { kind?: string; blockId?: string } }> } } | null | undefined;
export function caseBlockAdmittedOtherThanAccess(admission: unknown): boolean {
  const rows = (admission as Admission)?.qualification?.requests ?? [];
  return rows.some(row => row.provenance?.kind === "qualified_rule" && typeof row.provenance.blockId === "string" && row.provenance.blockId !== SAV_CASE_ACCESS_BLOCK_ID);
}
export function caseBlockReplyKernelProblem(input: Readonly<{ admission: unknown; text: string; purpose: string }>): "CANCELLED_REPLY_SENSITIVE_WORDING" | null {
  if (input.purpose === "handoff" || input.purpose === "closing") return null;
  if (!caseBlockAdmittedOtherThanAccess(input.admission)) return null;
  return accessSkillKernelHits(input.text).length ? "CANCELLED_REPLY_SENSITIVE_WORDING" : null;
}
