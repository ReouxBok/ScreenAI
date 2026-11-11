import { z } from "zod";

/*
 * Pilot ACCÈS (3/11): which published sources may support an autonomous answer on an `access` request. The scope is a
 * datum injected by the approved pilot policy, never written in code: no article id, version or title lives here. Pure:
 * no model, network, database or clock. A request A classified `access` by mistake (an address change, a role, two-factor
 * authentication) may retrieve a source outside the scope; that source can then orient a handoff, never an answer.
 * ROOT (3/11): in this pilot `access` is the only admissible family, and a scope is bound to the admission policy in force:
 * a scope written for another policy (or with no schema) is no scope.
 */

export const SAV_CASE_ACCESS_SCOPE_REVISION = "sav-case-access-scope-2026-11-03.v1";

// Read as written: an identifier with surrounding spaces is refused, never rewritten.
const id = z.string().min(1).max(100).regex(/^\S(?:.*\S)?$/);
const accessScopeSchema = z.object({
  schema: z.literal(SAV_CASE_ACCESS_SCOPE_REVISION),
  /** The approved admission policy this scope was approved with; any other policy in force voids it. */
  policyRevision: id,
  revision: id,
  family: z.literal("access"),
  /** `answer`: may support an answer at this exact version. `orient_only`: decision pending or sensitive-adjacent: never an answer. */
  sources: z.array(z.object({ knowledgeId: id, contentVersionId: id, use: z.enum(["answer", "orient_only"]), firstReply: z.enum(["procedure_steps", "login_code_steps"]).optional() }).strict()).min(1).max(200),
}).strict();

/*
 * Treatment blocks (11/11): any other block's scope, same rules, its own identity. Access keeps its schema above, its env and its two
 * first-reply kinds; another block may not take the family `access` (Access's own) nor the login template. Several block scopes are given
 * as a list (`SAV_V2_BLOCK_SCOPES_JSON`); a malformed or ambiguous entry voids that block only, never Access nor another block.
 */
export const SAV_CASE_BLOCK_SCOPE_REVISION = "sav-case-block-scope-2026-11-11.v1";
// Kept pure (zod only, as the purity test requires): the same values as `case-types.ts` (`SAV_CASE_ACCESS_BLOCK_ID`, `SAV_CASE_BLOCK_ID`, and the
// admissible families other than `access`); `case-blocks.test.ts` proves they stay equal.
const SAV_CASE_ACCESS_BLOCK_ID = "access";
export const SAV_CASE_BLOCK_SCOPE_FAMILIES = ["usage"] as const;
const caseBlockIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/);
/** At most this many block scopes in the list (Access excluded): a longer list voids every listed block, never Access. */
export const SAV_CASE_BLOCK_SCOPES_MAX = 20;
const blockScopeSchema = z.object({
  schema: z.literal(SAV_CASE_BLOCK_SCOPE_REVISION),
  blockId: caseBlockIdSchema.refine(value => value !== SAV_CASE_ACCESS_BLOCK_ID, "ACCESS_BLOCK_RESERVED"),
  family: z.enum(SAV_CASE_BLOCK_SCOPE_FAMILIES),
  policyRevision: id,
  revision: id,
  sources: z.array(z.object({ knowledgeId: id, contentVersionId: id, use: z.enum(["answer", "orient_only"]), firstReply: z.enum(["procedure_steps"]).optional() }).strict()).min(1).max(200),
}).strict();

export type CaseAccessScope = z.infer<typeof accessScopeSchema>;
/** One block's scope as consumers read it: Access's exactly as parsed (no `blockId`), another block's with its `blockId`. */
export type CaseBlockScope = CaseAccessScope | z.infer<typeof blockScopeSchema>;
export type CaseAccessScopeReadProblem = "scope_missing" | "scope_invalid" | "scope_unreadable" | "scope_policy_mismatch";
/** What a decision keeps of the scope it was accepted under, and what a consumer compares before using it. `blockId`: only for a block other than Access. */
export type CaseAccessScopeStamp = { revision: string; policyRevision: string; blockId?: string };
export type CaseAccessSourceProblem = "access_scope_missing" | "access_source_out_of_scope" | "access_source_version_out_of_scope" | "access_source_orient_only";

/** A missing, malformed or ambiguous scope (one source listed twice), or one for another policy, is no scope: nothing is searched. */
export function parseCaseAccessScope(value: unknown, policyRevision: string | null): { ok: true; scope: CaseAccessScope } | { ok: false; problem: CaseAccessScopeReadProblem } {
  if (value === null || value === undefined) return { ok: false, problem: "scope_missing" };
  const parsed = accessScopeSchema.safeParse(value);
  if (!parsed.success) return { ok: false, problem: "scope_invalid" };
  const ids = parsed.data.sources.map(source => source.knowledgeId);
  if (new Set(ids).size !== ids.length) return { ok: false, problem: "scope_invalid" };
  if (policyRevision === null || parsed.data.policyRevision !== policyRevision) return { ok: false, problem: "scope_policy_mismatch" };
  return { ok: true, scope: parsed.data };
}

type ScopeRead = { ok: true; scope: CaseBlockScope } | { ok: false; problem: CaseAccessScopeReadProblem };

/** One listed block's scope: absent from the list is missing; listed twice, malformed or ambiguous is invalid; another policy's is no scope. */
export function parseCaseBlockScopeList(value: unknown, policyRevision: string | null, blockId: string): ScopeRead {
  if (value === null || value === undefined) return { ok: false, problem: "scope_missing" };
  if (!Array.isArray(value) || value.length > SAV_CASE_BLOCK_SCOPES_MAX) return { ok: false, problem: "scope_invalid" };
  const entries = value.filter(entry => typeof entry === "object" && entry !== null && (entry as { blockId?: unknown }).blockId === blockId);
  if (!entries.length) return { ok: false, problem: "scope_missing" };
  const parsed = entries.length === 1 ? blockScopeSchema.safeParse(entries[0]) : null;
  if (!parsed?.success) return { ok: false, problem: "scope_invalid" };
  const ids = parsed.data.sources.map(source => source.knowledgeId);
  if (new Set(ids).size !== ids.length) return { ok: false, problem: "scope_invalid" };
  if (policyRevision === null || parsed.data.policyRevision !== policyRevision) return { ok: false, problem: "scope_policy_mismatch" };
  return { ok: true, scope: parsed.data };
}

/**
 * What the configuration port gives when other blocks are configured: Access's datum and the list, each read on its own (`investigation-pilot-readers.ts`).
 * Marked by a symbol, which no JSON can carry: a configured datum can never pass itself off as this bundle.
 */
export const SAV_CASE_BLOCK_SCOPES_BUNDLE: unique symbol = Symbol("sav-case-block-scopes-bundle-2026-11-11.v1");
export type CaseScopePart = Readonly<{ state: "absent" }> | Readonly<{ state: "unreadable" }> | Readonly<{ state: "read"; value: unknown }>;
export type CaseBlockScopesBundle = Readonly<{ [SAV_CASE_BLOCK_SCOPES_BUNDLE]: true; access: CaseScopePart; blocks: CaseScopePart }>;
const isBundle = (value: unknown): value is CaseBlockScopesBundle =>
  typeof value === "object" && value !== null && (value as { [SAV_CASE_BLOCK_SCOPES_BUNDLE]?: unknown })[SAV_CASE_BLOCK_SCOPES_BUNDLE] === true;

/**
 * One block's scope from the port's value. A bare value (the only shape before blocks) is Access's datum, read exactly as before; it gives
 * no other block a scope. A bundle gives Access its own datum and every other block its entry of the list, so one never voids the other.
 */
export function parseCaseBlockScope(value: unknown, policyRevision: string | null, blockId: string = SAV_CASE_ACCESS_BLOCK_ID): ScopeRead {
  if (!isBundle(value)) return blockId === SAV_CASE_ACCESS_BLOCK_ID ? parseCaseAccessScope(value, policyRevision) : { ok: false, problem: "scope_missing" };
  const part = blockId === SAV_CASE_ACCESS_BLOCK_ID ? value.access : value.blocks;
  if (part.state === "unreadable") return { ok: false, problem: "scope_unreadable" };
  const raw = part.state === "read" ? part.value : null;
  return blockId === SAV_CASE_ACCESS_BLOCK_ID ? parseCaseAccessScope(raw, policyRevision) : parseCaseBlockScopeList(raw, policyRevision, blockId);
}

/** Reads one block's scope (Access by default) through its port once per run; a read that throws is unreadable, never an empty scope. */
export async function readCaseAccessScope(port: () => Promise<unknown>, policyRevision: string | null, blockId: string = SAV_CASE_ACCESS_BLOCK_ID): Promise<ScopeRead> {
  let value: unknown;
  try { value = await port(); } catch { return { ok: false as const, problem: "scope_unreadable" as const }; }
  return parseCaseBlockScope(value, policyRevision, blockId);
}

/** The block a recorded stamp was decided under: an Access stamp (or one recorded before blocks) carries none. */
export const caseStampBlockId = (stamp: CaseAccessScopeStamp | null | undefined): string => typeof stamp?.blockId === "string" ? stamp.blockId : SAV_CASE_ACCESS_BLOCK_ID;

export const caseAccessScopeStamp = (scope: CaseBlockScope): CaseAccessScopeStamp => "blockId" in scope
  ? { revision: scope.revision, policyRevision: scope.policyRevision, blockId: scope.blockId }
  : { revision: scope.revision, policyRevision: scope.policyRevision };

/**
 * Before a pilot decision is used (a reply prepared, a draft shown), the scope it was accepted under must be known and be
 * the one in force now. Unknown on either side (an older decision recorded without a stamp, no current scope) is closed.
 */
export function caseAccessScopeStampProblem(recorded: CaseAccessScopeStamp | null | undefined, current: CaseAccessScopeStamp | null): "access_scope_unknown" | "access_scope_changed" | null {
  if (!recorded || !current) return "access_scope_unknown";
  return recorded.revision === current.revision && recorded.policyRevision === current.policyRevision && caseStampBlockId(recorded) === caseStampBlockId(current) ? null : "access_scope_changed";
}

/** Why this cited source cannot support an answer on an `access` request, or null when the scope allows it at this version. */
export function caseAccessSourceProblem(scope: CaseBlockScope | null, ref: { knowledgeId: string; contentVersionId: string }): CaseAccessSourceProblem | null {
  if (!scope) return "access_scope_missing";
  const listed = scope.sources.find(source => source.knowledgeId === ref.knowledgeId);
  if (!listed) return "access_source_out_of_scope";
  if (listed.contentVersionId !== ref.contentVersionId) return "access_source_version_out_of_scope";
  return listed.use === "answer" ? null : "access_source_orient_only";
}
