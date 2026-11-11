import "server-only";
import { sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { readRuntimeTemporaryIncidents } from "@/lib/knowledge/temporary-incidents-runtime";
import { admissionPolicyRevisionPort, type AdmissionPolicyRecord } from "./admission-runtime";
import type { KnowledgeRef } from "./case-types";
import { SAV_CASE_BLOCK_SCOPES_BUNDLE, type CaseBlockScopesBundle, type CaseScopePart } from "./investigation-access-scope";
import type { PilotActiveSource, PilotProvenanceDeps } from "./pilot-passage-provenance";

/*
 * B (4/11, LOCAL): the canonical readers of the pilot ACCÈS provenance (`PilotProvenanceDeps`) and of the runtime's `accessScope` port.
 * OFF by default: no configured scope is no scope (nothing searched, nothing answered). Nothing here invents an id, a right or a version:
 * the scope is Ugo's configured datum, checked against the policy in force by `readCaseAccessScope`; a source is the knowledge base's
 * activated, published version, read now; the policy record is A's (`readPolicyRecord`).
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The configured scope datum (JSON), approved with the admission policy; its schema and policy revision are checked by the reader's caller. */
export const SAV_V2_ACCESS_SCOPE_ENV = "SAV_V2_ACCESS_SCOPE_JSON";
/** A bound on the configured text: a scope lists at most 200 sources; anything larger is refused, never truncated. */
export const SAV_V2_ACCESS_SCOPE_MAX_CHARS = 32_768;

/**
 * `accessScope()`: absent or empty is OFF (null: `scope_missing`); too large or not JSON throws (`scope_unreadable`); anything parsed is
 * returned as is, so a malformed scope or one written for another policy is refused by `readCaseAccessScope` (`scope_invalid` / `scope_policy_mismatch`).
 */
export function caseAccessScopeConfigReader(env: () => Env = () => process.env): () => Promise<unknown> {
  return async () => {
    const values = env();
    const blocks = values[SAV_V2_BLOCK_SCOPES_ENV];
    // No other block configured: Access's datum, read exactly as before blocks existed.
    if (blocks === undefined || blocks.trim() === "") {
      const raw = values[SAV_V2_ACCESS_SCOPE_ENV];
      if (raw === undefined || raw.trim() === "") return null;
      if (raw.length > SAV_V2_ACCESS_SCOPE_MAX_CHARS) throw Error("SAV_V2_ACCESS_SCOPE_TOO_LARGE");
      return JSON.parse(raw) as unknown;
    }
    // Other blocks configured: each datum read on its own, so a broken list never voids Access (nor the reverse).
    const bundle: CaseBlockScopesBundle = { [SAV_CASE_BLOCK_SCOPES_BUNDLE]: true,
      access: scopePart(values[SAV_V2_ACCESS_SCOPE_ENV], SAV_V2_ACCESS_SCOPE_MAX_CHARS), blocks: scopePart(blocks, SAV_V2_BLOCK_SCOPES_MAX_CHARS) };
    return bundle;
  };
}

/** Treatment blocks (11/11): the scopes of the blocks other than Access, a JSON list (`investigation-access-scope.ts`). Absent: no other block has a scope. */
export const SAV_V2_BLOCK_SCOPES_ENV = "SAV_V2_BLOCK_SCOPES_JSON";
export const SAV_V2_BLOCK_SCOPES_MAX_CHARS = 131_072;
function scopePart(raw: string | undefined, max: number): CaseScopePart {
  if (raw === undefined || raw.trim() === "") return { state: "absent" };
  if (raw.length > max) return { state: "unreadable" };
  try { return { state: "read", value: JSON.parse(raw) as unknown }; } catch { return { state: "unreadable" }; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rowsOf = (result: unknown): Record<string, unknown>[] => Array.isArray(result) ? result : (result as { rows: Record<string, unknown>[] }).rows;

/**
 * `readActiveSource(ref)`: the exact version of a card, as the knowledge base holds it now. Null when that card / version pair does not exist
 * (or the ids are not the base's); `active: false` unless it is THE activated version of a SAV article that is published, not archived, AI
 * enabled, in this locale and audience. `verifiedAt` is the same proof date as V2's search (the version's own review, never renewed by a
 * later version); the freshness policy itself is applied by the provenance reader.
 */
export function caseActiveSourceReader(options: Readonly<{ locale?: string; audience?: "support" | "lead" }> = {}): (ref: KnowledgeRef) => Promise<PilotActiveSource | null> {
  const locale = options.locale ?? "fr-FR", audience = options.audience ?? "support";
  return async ref => {
    if (!UUID.test(ref.knowledgeId) || !UUID.test(ref.contentVersionId)) return null;
    const [row] = rowsOf(await requireDb().execute(sql`
      SELECT item.title AS "itemTitle", activation.title AS "activeTitle", version.body_markdown AS content,
        (activation.version_id = version.id AND item.agent_key = 'sav' AND item.slug <> 'sav-master-playbook' AND item.type = 'article'
          AND item.status <> 'archived' AND item.ai_enabled = true AND item.published_version_id IS NOT NULL AND item.locale = ${locale}
          AND COALESCE(version.metadata -> 'resolution' ->> 'audience', 'support') = ${audience}) AS active,
        CASE WHEN item.verified_at IS NULL OR activation.version_id IS DISTINCT FROM version.id THEN NULL ELSE
          COALESCE(version_review.verified_at, CASE
            WHEN item.published_version_id = activation.version_id THEN LEAST(item.verified_at, activation.activated_at)
            ELSE LEAST(item.verified_at, activation.activated_at, version.created_at)
          END) END AS "verifiedAt"
      FROM content_items item
      JOIN content_versions version ON version.id = ${ref.contentVersionId}::uuid AND version.item_id = item.id
      LEFT JOIN sav_knowledge_activations activation ON activation.item_id = item.id
      LEFT JOIN LATERAL (
        SELECT max(event.created_at) AS verified_at FROM review_events event
        WHERE event.version_id = version.id AND event.item_id = item.id AND event.action IN ('approved', 'emergency_published')
      ) version_review ON TRUE
      WHERE item.id = ${ref.knowledgeId}::uuid
    `));
    if (!row) return null;
    const active = row.active === true;
    return { active, title: String(row.activeTitle ?? row.itemTitle ?? ""), content: String(row.content ?? ""),
      verifiedAt: active && row.verifiedAt ? new Date(String(row.verifiedAt)).toISOString() : null };
  };
}

/** `now()`: the wall clock, the one the provenance dates its evaluation with. */
export const caseInvestigationClock = (): Date => new Date();

/** `currentPolicyRevision()`: A's policy record (A provides `readPolicyRecord`), valid now; none, expired or malformed is null (nothing approved). */
export function casePolicyRevisionReader(readPolicyRecord: () => Promise<AdmissionPolicyRecord | null>, now: () => Date = caseInvestigationClock) {
  return admissionPolicyRevisionPort({ read: readPolicyRecord, now });
}

/** The four provenance readers together, for the integrator: `PilotProvenanceDeps` with no default but the clock and the environment. */
export function caseProvenanceReaders(input: Readonly<{
  readPolicyRecord: () => Promise<AdmissionPolicyRecord | null>; env?: () => Env; now?: () => Date; locale?: string; audience?: "support" | "lead";
}>): PilotProvenanceDeps {
  const now = input.now ?? caseInvestigationClock;
  return {
    readTemporaryIncidents: readRuntimeTemporaryIncidents,
    accessScope: caseAccessScopeConfigReader(input.env), currentPolicyRevision: casePolicyRevisionReader(input.readPolicyRecord, now),
    readActiveSource: caseActiveSourceReader({ ...(input.locale ? { locale: input.locale } : {}), ...(input.audience ? { audience: input.audience } : {}) }), now,
  };
}
