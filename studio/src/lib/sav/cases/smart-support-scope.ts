import { caseRequestBlockId } from "./case-blocks";
import { SAV_SMART_ENTRY_ADMISSION, SAV_SMART_ENTRY_BLOCK_ID, SAV_SMART_ENTRY_POLICY_REVISION, type CaseSnapshot } from "./case-types";
import { caseStampBlockId, type CaseAccessScopeStamp } from "./investigation-access-scope";
import { savV2EntrySmartOn } from "./smart-entry-switch";

/*
 * SAV-123 (N8): what replaces the approved block scope for a smart case. Pure: reads only the values given.
 *
 * The block pilots (Access, usage) prove an answer by an approved LIST of sources. The smart brain has no list: it may cite any published card the circuit
 * retrieved. So a smart decision carries this fixed stamp instead of a scope's, and every consumer that compares stamps (draft, provenance, reply passage)
 * finds it "in force" only while `SAV_V2_ENTRY_SMART=on`: switched off, the stamp is unknown and nothing is proposed nor sent. The proof of each source shown
 * stays: active at that exact version and fresh (`readActiveSource` + `savKnowledgeFreshness`, `pilot-passage-provenance.ts`), never a list.
 * The validator applies its general checks to a smart decision (known, same version, valid, not superseded, coverage, sensitive → hand-over only).
 */

export const SAV_SMART_SUPPORT_SCOPE_REVISION = "smart-support-scope-2026-11-21.v1";
export const SAV_SMART_SUPPORT_STAMP: Readonly<CaseAccessScopeStamp> = Object.freeze({
  revision: SAV_SMART_SUPPORT_SCOPE_REVISION, policyRevision: SAV_SMART_ENTRY_POLICY_REVISION, blockId: SAV_SMART_ENTRY_BLOCK_ID,
});

type Env = Readonly<Record<string, string | undefined>>;

/** The smart stamp as the one in force now, or null (switch off). */
export const smartSupportStampInForce = (env: Env): CaseAccessScopeStamp | null => savV2EntrySmartOn(env) ? { ...SAV_SMART_SUPPORT_STAMP } : null;

/** A decision recorded under the smart stamp. */
export const isSmartSupportStamp = (stamp: CaseAccessScopeStamp | null | undefined): boolean => Boolean(stamp) && caseStampBlockId(stamp) === SAV_SMART_ENTRY_BLOCK_ID;

/** A case admitted by the smart entry whose open requests are all of the smart block (at least one). */
export function caseSmartSupportOpen(snapshot: Pick<CaseSnapshot, "admission" | "body">): boolean {
  if (snapshot.admission?.admission !== SAV_SMART_ENTRY_ADMISSION || snapshot.admission.policyRevision !== SAV_SMART_ENTRY_POLICY_REVISION) return false;
  const open = snapshot.body.openRequests.filter(row => row.status === "open");
  return open.length > 0 && open.every(row => caseRequestBlockId(snapshot, row) === SAV_SMART_ENTRY_BLOCK_ID);
}
