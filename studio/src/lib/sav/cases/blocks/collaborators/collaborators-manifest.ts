import type { BlockManifest } from "../../../skills/skill-contract";
import { SAV_COLLABORATORS_DECISION_SKILL_ID, SAV_COLLABORATORS_DECISION_SKILL_REVISION, SAV_COLLABORATORS_HANDOFF_REASONS, SAV_COLLABORATORS_HANDOFF_RECIPIENTS } from "./collaborators-decision-skill";
import { SAV_COLLABORATORS_BLOCK_ID, SAV_COLLABORATORS_ENTRY_SKILL_ID, SAV_COLLABORATORS_SENSITIVE_FAMILIES } from "./collaborators-entry-skill";
import { SAV_COLLABORATORS_CONFIRM_SKILL_REVISION } from "./collaborators-skill";

/*
 * Collaborators block (19/11): the typed manifest. Data only; pure (no `server-only`, no I/O); not imported by any live registry.
 * Mode `off`, no automatic right, no J2. Nothing here changes production behaviour.
 *
 * Sources: the public repository holds no production identifier. Each source has a stable symbolic id; its knowledge id and exact
 * `contentVersionId` are kept in the private inventory and handed over by root at binding time. Until then every version reads
 * `TO_CONFIRM` and `collaboratorsManifestBindable()` is false, so the block can bind no card and admit nobody.
 */

export const SAV_COLLABORATORS_VERSION_TO_CONFIRM = "TO_CONFIRM";

/** The N3 manifest. `resolutionProof` is omitted on purpose: no automatic closure for this block. */
export const SAV_COLLABORATORS_BLOCK_MANIFEST = {
  blockId: SAV_COLLABORATORS_BLOCK_ID,
  family: "usage",
  productVersion: "all",
  skills: [
    // The registered confirmation is the compact v2 inside the shared entry frame (collaborators-skill.ts); v1 (collaborators-entry-skill.ts) is the
    // standalone reference reading, too large for the shared frame and never registered.
    { id: SAV_COLLABORATORS_ENTRY_SKILL_ID, revision: SAV_COLLABORATORS_CONFIRM_SKILL_REVISION },
    { id: SAV_COLLABORATORS_DECISION_SKILL_ID, revision: SAV_COLLABORATORS_DECISION_SKILL_REVISION },
  ],
  excludedNeighbours: ["access", "charly_max", "integrations"],
  sources: [
    // « Inviter un membre dans l'organisation » (SAV card, published and SAV-active on 10/11; version in the private inventory). The only answer card.
    { sourceId: "collaborators.invite-member", contentVersionId: SAV_COLLABORATORS_VERSION_TO_CONFIRM, usage: "answer", productVersion: "all" },
    // « Comprendre les rôles, la visibilité et la propriété »: orientation only (rights stay with the team).
    { sourceId: "collaborators.roles", contentVersionId: SAV_COLLABORATORS_VERSION_TO_CONFIRM, usage: "orient_only", productVersion: "all" },
    // « Retrouver l'accès à son organisation ou à son espace »: orientation towards Access and workspaces.
    { sourceId: "organisation.find-access", contentVersionId: SAV_COLLABORATORS_VERSION_TO_CONFIRM, usage: "orient_only", productVersion: "all" },
  ],
} as const satisfies BlockManifest;

/** What the N3 manifest does not carry: modes, rights, transfer, thresholds, budget and the frozen sets. */
export const SAV_COLLABORATORS_BLOCK_SETTINGS = {
  schema: "sav-block-manifest.v1",
  title: "Collaborateurs : aide à inviter un membre",
  modes: { initial: "off" },
  autoAllowed: false,
  j2: { allowed: false },
  /** Permanent rule, never edited: the whole mail goes to the team. */
  alwaysHuman: SAV_COLLABORATORS_SENSITIVE_FAMILIES,
  /** Sources without a confirmed exact version, or without a confirmed Limova version (« all » is a default to confirm). */
  sourcesToConfirm: ["collaborators.invite-member", "collaborators.roles", "organisation.find-access"] as readonly string[],
  unknownVersionPolicy: { onlyAllSources: true, askOneQuestionIfProceduresDiverge: true },
  /** Missing cards (drafts in the private inventory, never published by an agent): resend, expiry and cancellation of an invitation. */
  missingCards: ["collaborators.invitation-not-received-or-expired", "collaborators.cancel-invitation", "collaborators.seats-orientation"],
  resolutionProof: {
    kind: "customer_confirms_outcome",
    source: "customer_message",
    predicate: "the customer confirms that the invited person joined the organisation, quoted verbatim, with no other open need",
    autoClosure: false,
  },
  transfer: { recipients: SAV_COLLABORATORS_HANDOFF_RECIPIENTS, reasonCodes: SAV_COLLABORATORS_HANDOFF_REASONS },
  thresholds: {
    sensitiveAdmitted: 0, neighbourRouted: 0.95, blockRecall: 0.9, trapsRouted: 0.9, sourcesOutsideSupport: 0, doubleSend: 0,
    draftsMin: 10, draftsGoodRate: 0.9, draftsSensitiveMissed: 0,
  },
  /** Measured by `collaborators-budget.ts` at the read bounds (pinned by the test). Ceiling to confirm against the transport policy. */
  budget: {
    ceilingBytes: 26_000,
    confirm: { measuredBytes: 21_768 },
    decision: { measuredBytes: 22_075 },
  },
  corpus: {
    fixture: "collaborators-corpus.fixture.ts",
    blindSet: "collaborators-blind.fixture.ts",
    /** sha256 of the blind set file bytes, noted at freeze (19/11), before any measure. */
    blindSetSha256: "7197dc422c593d33387093edea906643f801f213d7360916457bc040d342b765",
  },
} as const;

/** True only when every source has an exact version and none is left to confirm. False today: the block can bind nothing. */
export function collaboratorsManifestBindable(): boolean {
  return SAV_COLLABORATORS_BLOCK_SETTINGS.sourcesToConfirm.length === 0 &&
    SAV_COLLABORATORS_BLOCK_MANIFEST.sources.every(source => source.contentVersionId !== SAV_COLLABORATORS_VERSION_TO_CONFIRM);
}
