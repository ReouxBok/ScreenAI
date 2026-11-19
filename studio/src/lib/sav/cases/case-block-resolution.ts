import { reportsRestoredAccess } from "./restored-access";
import { SAV_CASE_ACCESS_BLOCK_ID } from "./case-types";

/*
 * Resolution proof per treatment block (19/11, SPEC §5). Pure: no model, network, database or clock.
 *
 * A `confirm_resolution` closes a case only when the validator accepts it. For a request of a block, the validator accepts it only under the proof that
 * block DECLARES here: without one (or with `autoClosure: false`), no `confirm_resolution` is accepted for that block, so there is no automatic closure;
 * the case goes on to the team or waits visibly. A block may still answer automatically without closing automatically.
 *
 * Every proof has the same shape, Access's being the first: the evidence is the customer's LATEST message (never ours, never the team's, nothing after
 * it from a person), its quote is found word for word in that message, and the block's pure predicate is true both on the customer's own words of that
 * message and on the quote. A « merci » alone never satisfies a predicate (PRODUCT_GUARDRAILS); a request still open prevents the closure (`other_requests_open`).
 *
 * Adding a block's proof: one entry below, its pure predicate in its own file, positive and negative cases in its corpus (a thanks alone, a partial
 * success, a new question), and a test that the entry is found. Never a change to Access's entry.
 */

export type CaseBlockResolutionProof = Readonly<{
  /** Closed identifier and revision of the proof rule (the block manifest's `resolutionProof`). */
  id: string;
  revision: string;
  blockId: string;
  /** Always the customer's own latest message. */
  source: "customer_message";
  /** Pure: true when these words of the customer (their own statement, normalised: no accents, lower case) confirm the outcome. */
  confirms: (customerWords: string) => boolean;
  /** False: the proof is declared but a `confirm_resolution` is still never accepted (no automatic closure for the block). */
  autoClosure: boolean;
}>;

/** Access's proof, exactly the check the validator made before blocks: the customer says their access works again (`reportsRestoredAccess`). */
export const SAV_CASE_ACCESS_RESOLUTION_PROOF: CaseBlockResolutionProof = Object.freeze({
  id: "access_restored_login", revision: "sav-access-resolution-2026-11-04.v1", blockId: SAV_CASE_ACCESS_BLOCK_ID,
  source: "customer_message", confirms: reportsRestoredAccess, autoClosure: true,
});

export const SAV_CASE_BLOCK_RESOLUTION_PROOFS: readonly CaseBlockResolutionProof[] = Object.freeze([SAV_CASE_ACCESS_RESOLUTION_PROOF]);

/** The one proof a block declares, or null (none, or an ambiguous double declaration: never guessed). */
export function caseBlockResolutionProof(blockId: string, proofs: readonly CaseBlockResolutionProof[] = SAV_CASE_BLOCK_RESOLUTION_PROOFS): CaseBlockResolutionProof | null {
  const found = proofs.filter(proof => proof.blockId === blockId);
  return found.length === 1 ? found[0]! : null;
}
