import { SAV_CASE_ACCESS_BLOCK_ID, type CaseRequestFamily, type CaseSnapshot } from "./case-types";

/*
 * Treatment blocks (bloc d'intervention), 11/11. A block is one customer topic treated end to end by the same V2 chain: its admission rule,
 * its scope of sources, its first-reply kinds. A family is not a block: two blocks may share `usage`. Pure: no model, network, database or clock.
 *
 * Data: an approved admission rule names its block (`blockId`) and family; a block's scope lists its sources (`investigation-access-scope.ts`).
 * Code: the detector that reads a first mail for a block (`case-block-registry.ts`), looked up by `blockId`. A rule whose block has no detector,
 * or whose family is not the block's, is never a candidate. The family `access` belongs to the `access` block only, so every Access-specific
 * check keyed on that family (login keys, official link, resolution proof, auto approval) stays the Access block's.
 *
 * Backward compatible: a rule written before blocks (no `blockId`) with the family `access` is the Access block's rule, and its provenance is
 * recorded exactly as before (no `blockId` field). Any other family needs an explicit `blockId`.
 */

/** A rule as configured in `SAV_V2_ADMISSION_RULES_JSON`; `decideCaseAdmission` still checks each against the approved policy. */
export type CaseEntryRule = Readonly<{ ruleId: string; revision: string; v1Kind: string; family: CaseRequestFamily; at: string; blockId?: string }>;
/** One block's first-mail detector: true only when the whole first mail is this block's request. */
export type CaseBlockDetector = Readonly<{ blockId: string; family: CaseRequestFamily; firstRequest: (text: string, subject: string) => boolean }>;
export type CaseBlockCandidate = Readonly<{ rule: CaseEntryRule; block: CaseBlockDetector }>;

/** Closed reasons of the entry's block selection. Only `admitted` gives evidence; the others admit nobody. */
/** `block_scope_unavailable` (entry, `v2-entry.ts`): a block other than Access matched, but has no valid scope for the policy in force. */
export const SAV_CASE_BLOCK_ENTRY_REASONS = ["admitted", "no_block_rule", "no_block_match", "ambiguous_block", "block_scope_unavailable"] as const;
export type CaseBlockEntryReason = typeof SAV_CASE_BLOCK_ENTRY_REASONS[number];
export type CaseBlockSelection =
  | Readonly<{ reason: "admitted"; rule: CaseEntryRule; block: CaseBlockDetector }>
  | Readonly<{ reason: Exclude<CaseBlockEntryReason, "admitted" | "block_scope_unavailable">; blockIds: readonly string[] }>;

/** The block a rule names; a rule written before blocks is Access's only when its family is `access`. */
export const caseRuleBlockId = (rule: Pick<CaseEntryRule, "family" | "blockId">): string | null =>
  typeof rule.blockId === "string" ? rule.blockId : rule.family === "access" ? SAV_CASE_ACCESS_BLOCK_ID : null;

/** Every approved `support` rule whose block has a detector of the same family. Nothing else is read, and nothing here reads the mail. */
export function caseBlockCandidates(rules: readonly CaseEntryRule[], registry: readonly CaseBlockDetector[]): CaseBlockCandidate[] {
  return rules.flatMap(rule => {
    if (rule?.v1Kind !== "support") return [];
    const blockId = caseRuleBlockId(rule), block = registry.find(entry => entry.blockId === blockId);
    // The family `access` is the Access block's alone, both ways, whatever the registry or the configured rule says.
    if (!block || (rule.family === "access") !== (blockId === SAV_CASE_ACCESS_BLOCK_ID) || (block.family === "access") !== (block.blockId === SAV_CASE_ACCESS_BLOCK_ID)) return [];
    return block.family === rule.family ? [{ rule, block }] : [];
  });
}

/** Every candidate is evaluated: exactly one matching rule admits; none, or more than one (two blocks, or one block configured twice), admits nobody. */
export function selectCaseBlockRule(candidates: readonly CaseBlockCandidate[], text: string, subject: string): CaseBlockSelection {
  if (!candidates.length) return { reason: "no_block_rule", blockIds: [] };
  const matched = candidates.filter(candidate => candidate.block.firstRequest(text, subject));
  if (matched.length === 1) return { reason: "admitted", rule: matched[0]!.rule, block: matched[0]!.block };
  return { reason: matched.length ? "ambiguous_block" : "no_block_match", blockIds: [...new Set(matched.map(row => row.block.blockId))].sort() };
}

/** The provenance the admitted rule leaves: a rule without `blockId` leaves exactly what it left before blocks existed. */
export const caseBlockRuleProvenance = (rule: CaseEntryRule) => ({ kind: "qualified_rule" as const, ruleId: rule.ruleId, revision: rule.revision, at: rule.at,
  ...(typeof rule.blockId === "string" ? { blockId: rule.blockId } : {}) });

/**
 * The block of one open request, from the admission that recorded it: `access` for the family `access`; otherwise the `blockId` its
 * qualified rule recorded. Null when nothing names one (a human or older qualification, two rules disagreeing): never guessed.
 */
export function caseRequestBlockId(snapshot: Pick<CaseSnapshot, "admission">, request: Readonly<{ id: string; family: CaseRequestFamily }>): string | null {
  if (request.family === "access") return SAV_CASE_ACCESS_BLOCK_ID;
  const entries = (snapshot.admission?.qualification.requests ?? []).filter(row => row.requestId === request.id && row.family === request.family);
  const ids = new Set(entries.map(row => row.provenance.kind === "qualified_rule" ? row.provenance.blockId ?? null : null));
  const [only] = [...ids];
  return ids.size === 1 && only ? only : null;
}

/** The one block of a case's open requests, or null (none open, one without a block, or several blocks). */
export function caseOpenBlockId(snapshot: Pick<CaseSnapshot, "admission" | "body">): string | null {
  const open = snapshot.body.openRequests.filter(row => row.status === "open");
  const ids = new Set(open.map(row => caseRequestBlockId(snapshot, row)));
  const [only] = [...ids];
  return ids.size === 1 && only ? only : null;
}
