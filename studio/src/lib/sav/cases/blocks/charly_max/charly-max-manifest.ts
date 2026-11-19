import type { BlockManifest } from "../../../skills/skill-contract";
import { CHARLY_MAX_DECISION_SKILL_ID, CHARLY_MAX_DECISION_SKILL_PROMPT_SHA256, CHARLY_MAX_DECISION_SKILL_REVISION } from "./charly-max-skill-decision";
import { CHARLY_MAX_BLOCK_ID, CHARLY_MAX_ENTRY_SKILL_ID, CHARLY_MAX_ENTRY_SKILL_REVISION, CHARLY_MAX_NEIGHBOURS } from "./charly-max-skill-entry";

/*
 * Charly Max block manifest (method V3 step 7). Typed data, PURE, NOT WIRED: nothing at runtime reads it today.
 *
 * Public repository: no production identifier, setting, budget or allow-list here. The Studio card ids are given by root once Ugo has
 * confirmed and published them; until then `sources` stays EMPTY (a card without an exact version never enters `sources`), so the block
 * can support no answer and every decision is a motivated handoff.
 */

/** N3 contract view: what the package fingerprint reads. */
export const CHARLY_MAX_MANIFEST: BlockManifest = {
  blockId: CHARLY_MAX_BLOCK_ID,
  family: "usage",
  skills: [
    { id: CHARLY_MAX_ENTRY_SKILL_ID, revision: CHARLY_MAX_ENTRY_SKILL_REVISION },
    { id: CHARLY_MAX_DECISION_SKILL_ID, revision: CHARLY_MAX_DECISION_SKILL_REVISION },
  ],
  excludedNeighbours: CHARLY_MAX_NEIGHBOURS,
  sources: [],
  // No `resolutionProof`: automatic closure is disabled for this block.
  // The product version of the block's procedures is not confirmed (à confirmer par Ugo); `all` is the N3 value until it is.
  productVersion: "all",
};

/** Cards the block needs, described without production ids. Status « à confirmer »: none may support an answer yet. */
export const CHARLY_MAX_PENDING_SOURCES = [
  { title: "Synchroniser Charly Max (WhatsApp) avec le compte Limova", intendedUsage: "answer", scope: "first_connection", limovaVersion: "à confirmer", status: "published_version_to_confirm", note: "Active card fits the first connection only; its incident part asks troubleshooting questions (not the 9/11 rule)." },
  { title: "Charly Max : incident, pièces à demander", intendedUsage: "answer", scope: "incident", limovaVersion: "all (à confirmer)", status: "draft_to_publish_by_ugo", note: "May be the corrected draft already in the Studio." },
  { title: "Charly Max : deuxième profil ou deuxième numéro", intendedUsage: "answer", scope: "second_number", limovaVersion: "à confirmer", status: "to_write" },
  { title: "Charly Max : numéro du profil déjà utilisé", intendedUsage: "answer", scope: "number_already_used", limovaVersion: "à confirmer", status: "to_write", note: "Real cause to be given by the team." },
  { title: "Charly Max, WhatsApp Business ou API : orientation", intendedUsage: "orient_only", scope: "orientation", limovaVersion: "all (à confirmer)", status: "to_write" },
] as const;

/** Block metadata of the method's manifest template that the N3 type does not carry yet. */
export const CHARLY_MAX_BLOCK_META = {
  schema: "sav-block-manifest.v1",
  title: "Charly Max",
  modes: { initial: "off" },
  autoAllowed: false,
  j2: { allowed: false },
  /** Permanent rule: never editable by a block. The block adds its own human family: escalated complaints. */
  alwaysHuman: ["cancellation", "subscription", "finance", "rights", "identity"],
  blockHuman: ["complaint", "activation_by_team", "second_subscription", "phone_change_on_account", "price_and_offer"],
  unknownVersionPolicy: { onlyAllSources: true, askOneQuestionIfProceduresDiverge: true },
  resolutionProof: null,
  transfer: {
    incident: "support_technique",
    default: "support",
    commercial: "commercial",
    finance: "finance",
    cancellation: "resiliation",
    reasonCodes: ["incident_evidence_complete", "incident_evidence_asked_once", "number_already_used", "second_profile_no_card", "no_answer_source", "procedure_already_given", "not_this_block", "unclear_request"],
    /** Never « transmis » in a customer text without a stored handoff receipt. */
    customerTextRequiresReceipt: true,
  },
  thresholds: {
    sensitiveAdmitted: 0, neighbourRouted: 0.95, blockRecall: 0.9, sourcesOutsideSupport: 0, doubleSend: 0,
    draftsMin: 10, draftsGoodRate: 0.9, draftsSensitiveMissed: 0,
  },
  /** Measured bytes, pinned by the test: re-measure on any change. Confirm: interface worst case (12 000 characters) and corpus p95/max. Decision: corpus p95/max. */
  budget: {
    confirm: { measuredWorstCase: 21_832, measuredP95: 8_101, measuredMax: 8_143, limit: 26_000 },
    decision: { measuredWorstCase: 34_213, measuredP95: 20_998, measuredMax: 21_031, limit: 26_000 },
  },
  /** Entry: sha256 of the rendered confirmation (frame + skill), equal to `CHARLY_MAX_ENTRY_BLOCK.promptSha256` (tested). */
  prompts: { entrySha256: "388d1caf51eda26149b2685a84564f9cbaa84dd61b57ab02697329f91a591f47", decisionSha256: CHARLY_MAX_DECISION_SKILL_PROMPT_SHA256 },
  corpus: {
    fixture: "charly-max-corpus.fixture.ts",
    blindSet: "charly-max-blind.fixture.ts",
    blindSetSha256: "94a94e59f03afd3bb5651daa6b742cd64fc528ab22ed666fbc038af2a5abc9a6",
  },
} as const;
