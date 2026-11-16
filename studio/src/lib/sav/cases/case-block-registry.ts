import "server-only";
import { firstFollowupRequest } from "../blocks/followups-decision";
import type { CaseBlockDetector } from "./case-blocks";
import { SAV_CASE_ACCESS_BLOCK_ID } from "./case-types";
import { firstPersonalLoginRequest } from "./investigation-return-qualify";

/*
 * The code half of a treatment block (11/11): its first-mail detector, by `blockId`. Everything else about a block is data (its admission rule,
 * its policy entry, its scope of sources). A block listed here admits nobody until an approved rule names it and the policy approves that rule.
 * The family `access` is reserved to the `access` block. Adding a block: one entry here, its own detector, and its tests (positive, neighbour,
 * ambiguous with Access), never a change to Access's detector.
 */
export const SAV_CASE_BLOCK_REGISTRY: readonly CaseBlockDetector[] = Object.freeze([
  { blockId: SAV_CASE_ACCESS_BLOCK_ID, family: "access", firstRequest: firstPersonalLoginRequest },
]);

/*
 * SAV-92, followups block (PR #277, phase 1): registered only behind ONE explicit switch, `SAV_V2_FOLLOWUPS_BLOCK=on` (exact value). Absent, empty or any
 * other value: the registry is exactly `SAV_CASE_BLOCK_REGISTRY` (Access alone), as before. Registered, the block still admits nobody until an approved
 * admission rule names `followups`, its scope is valid (`SAV_V2_BLOCK_SCOPES_JSON`) and its Studio switch is not `off` (no row = off). A non-Access block
 * is never `auto` (`savBlockEffectiveMode`): at most a draft for a person, so a thank-you never closes a ticket alone.
 */
export const SAV_CASE_FOLLOWUPS_BLOCK_ID = "followups";
export const SAV_CASE_FOLLOWUPS_BLOCK_SWITCH = "SAV_V2_FOLLOWUPS_BLOCK";
export const SAV_CASE_FOLLOWUPS_BLOCK_DETECTOR: CaseBlockDetector = Object.freeze({ blockId: SAV_CASE_FOLLOWUPS_BLOCK_ID, family: "usage", firstRequest: firstFollowupRequest });
const WITH_FOLLOWUPS: readonly CaseBlockDetector[] = Object.freeze([...SAV_CASE_BLOCK_REGISTRY, SAV_CASE_FOLLOWUPS_BLOCK_DETECTOR]);

export const savFollowupsBlockRegistered = (env: Readonly<Record<string, string | undefined>>) => env[SAV_CASE_FOLLOWUPS_BLOCK_SWITCH] === "on";

/** The live registry for this environment: the entry, the Studio block switch and its panel all read this one. */
export const savCaseBlockRegistry = (env: Readonly<Record<string, string | undefined>>): readonly CaseBlockDetector[] =>
  savFollowupsBlockRegistered(env) ? WITH_FOLLOWUPS : SAV_CASE_BLOCK_REGISTRY;
