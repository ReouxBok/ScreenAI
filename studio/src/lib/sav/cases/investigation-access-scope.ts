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

export type CaseAccessScope = z.infer<typeof accessScopeSchema>;
export type CaseAccessScopeReadProblem = "scope_missing" | "scope_invalid" | "scope_unreadable" | "scope_policy_mismatch";
/** What a decision keeps of the scope it was accepted under, and what a consumer compares before using it. */
export type CaseAccessScopeStamp = { revision: string; policyRevision: string };
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

/** Reads the scope through its port once per run; a read that throws is unreadable, never an empty scope. */
export async function readCaseAccessScope(port: () => Promise<unknown>, policyRevision: string | null) {
  let value: unknown;
  try { value = await port(); } catch { return { ok: false as const, problem: "scope_unreadable" as const }; }
  return parseCaseAccessScope(value, policyRevision);
}

export const caseAccessScopeStamp = (scope: CaseAccessScope): CaseAccessScopeStamp => ({ revision: scope.revision, policyRevision: scope.policyRevision });

/**
 * Before a pilot decision is used (a reply prepared, a draft shown), the scope it was accepted under must be known and be
 * the one in force now. Unknown on either side (an older decision recorded without a stamp, no current scope) is closed.
 */
export function caseAccessScopeStampProblem(recorded: CaseAccessScopeStamp | null | undefined, current: CaseAccessScopeStamp | null): "access_scope_unknown" | "access_scope_changed" | null {
  if (!recorded || !current) return "access_scope_unknown";
  return recorded.revision === current.revision && recorded.policyRevision === current.policyRevision ? null : "access_scope_changed";
}

/** Why this cited source cannot support an answer on an `access` request, or null when the scope allows it at this version. */
export function caseAccessSourceProblem(scope: CaseAccessScope | null, ref: { knowledgeId: string; contentVersionId: string }): CaseAccessSourceProblem | null {
  if (!scope) return "access_scope_missing";
  const listed = scope.sources.find(source => source.knowledgeId === ref.knowledgeId);
  if (!listed) return "access_source_out_of_scope";
  if (listed.contentVersionId !== ref.contentVersionId) return "access_source_version_out_of_scope";
  return listed.use === "answer" ? null : "access_source_orient_only";
}
