import "server-only";
import type { CaseBlockDetector } from "./case-blocks";
import { SAV_CASE_ACCESS_BLOCK_ID } from "./case-types";
import { firstPersonalLoginRequest } from "./investigation-return-qualify";

/*
 * The code half of a treatment block (11/11): its first-mail detector, by `blockId`. Everything else about a block is data (its admission rule,
 * its policy entry, its scope of sources). A block listed here admits nobody until an approved rule names it and the policy approves that rule.
 * The family `access` is reserved to the `access` block. Adding a block: one entry here, its own detector, and its tests (positive, neighbour,
 * ambiguous with Access), never a change to Access's detector.
 */
export const SAV_CASE_BLOCK_REGISTRY: readonly CaseBlockDetector[] = [
  { blockId: SAV_CASE_ACCESS_BLOCK_ID, family: "access", firstRequest: firstPersonalLoginRequest },
];
