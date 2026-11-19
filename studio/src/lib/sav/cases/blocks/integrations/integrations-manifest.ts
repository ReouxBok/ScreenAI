import type { BlockManifest } from "../../../skills/skill-contract";
import {
  SAV_INTEGRATIONS_DECISION_SKILL_ID, SAV_INTEGRATIONS_DECISION_SKILL_PROMPT_SHA256, SAV_INTEGRATIONS_DECISION_SKILL_REVISION, SAV_INTEGRATIONS_HANDOFF_REASONS,
} from "./integrations-decision-skill";
import { SAV_INTEGRATIONS_ENTRY_SKILL_ID, SAV_INTEGRATIONS_ENTRY_SKILL_PROMPT_SHA256, SAV_INTEGRATIONS_ENTRY_SKILL_REVISION } from "./integrations-entry-skill";
import { SAV_INTEGRATIONS_BLOCK_ID, SAV_INTEGRATIONS_NEIGHBOURS, type IntegrationsSubfamily } from "./integrations-scope";

/*
 * Block « Intégrations »: its manifest (METHODE_BLOCS_V3 §4 step 7). Data only, PURE (no server-only import). NOT registered anywhere: no live
 * registry, admission policy or switch reads it. Initial mode `off`; no automatic right (`autoAllowed: false`, J2 off) until Ugo's G5.
 *
 * Sources: EMPTY on purpose. A card enters `sources` only with its exact `contentVersionId`, mapped by root from the Studio (never a production id
 * guessed here, public repository). `SAV_INTEGRATIONS_SOURCE_PLAN` lists the proposed role of each card by a stable key, all « à confirmer ».
 * With no source, the decision skill can only orient or hand off: no customer answer can be supported.
 */

export const SAV_INTEGRATIONS_MANIFEST: BlockManifest = {
  blockId: SAV_INTEGRATIONS_BLOCK_ID,
  // Root decision (19/11, assembly): the Integrations block has its own family `integration` (entry, rule, policy and scope alike).
  family: "integration",
  skills: [
    { id: SAV_INTEGRATIONS_ENTRY_SKILL_ID, revision: SAV_INTEGRATIONS_ENTRY_SKILL_REVISION },
    { id: SAV_INTEGRATIONS_DECISION_SKILL_ID, revision: SAV_INTEGRATIONS_DECISION_SKILL_REVISION },
  ],
  excludedNeighbours: SAV_INTEGRATIONS_NEIGHBOURS,
  sources: [],
  // No resolutionProof: automatic closure stays disabled for this block.
  productVersion: "all",
};

export type IntegrationsSourcePlanRow = Readonly<{
  /** Stable key used in the private inventory; the Studio item and version ids live there, not here. */
  key: string;
  title: string;
  subfamilies: readonly IntegrationsSubfamily[];
  status: "active_card" | "draft" | "missing";
  proposedUse: "answer" | "orient_only" | "none";
  productVersion: "2" | "3" | "all" | "à confirmer";
  contentVersionId: "à confirmer";
}>;

/** Proposed knowledge plan (19/11), to validate by Ugo. Active cards: read in the private inventory of 14/11 (version ids to re-read by root). */
export const SAV_INTEGRATIONS_SOURCE_PLAN: readonly IntegrationsSourcePlanRow[] = [
  { key: "find-and-connect", title: "Trouver et connecter une intégration dans Limova", subfamilies: ["unlisted_tool", "unknown_tool"], status: "active_card", proposedUse: "answer", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "oauth-window", title: "Résoudre une fenêtre OAuth bloquée ou refusée", subfamilies: ["gmail_google", "outlook_microsoft", "linkedin", "facebook_instagram"], status: "active_card", proposedUse: "answer", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "google", title: "Connecter Gmail, Drive, Sheets ou Calendar", subfamilies: ["gmail_google"], status: "active_card", proposedUse: "answer", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "outlook", title: "Connecter Outlook ou un calendrier compatible", subfamilies: ["outlook_microsoft"], status: "active_card", proposedUse: "answer", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "linkedin", title: "Connecter LinkedIn pour prospecter ou publier", subfamilies: ["linkedin"], status: "active_card", proposedUse: "answer", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "meta", title: "Connecter Facebook ou Instagram", subfamilies: ["facebook_instagram"], status: "active_card", proposedUse: "answer", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "wordpress", title: "Connecter Wordpress (V3)", subfamilies: ["wordpress"], status: "active_card", proposedUse: "answer", productVersion: "3", contentVersionId: "à confirmer" },
  { key: "webflow", title: "Connecter Webflow (V3)", subfamilies: ["webflow_wix"], status: "active_card", proposedUse: "answer", productVersion: "3", contentVersionId: "à confirmer" },
  { key: "wix", title: "Connecter Wix (V3)", subfamilies: ["webflow_wix"], status: "active_card", proposedUse: "answer", productVersion: "3", contentVersionId: "à confirmer" },
  { key: "diagnose-handoff", title: "Diagnostiquer un blocage et transmettre au support humain", subfamilies: [], status: "active_card", proposedUse: "orient_only", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "shopify", title: "Shopify : liaison, erreur 403 et catalogue vide", subfamilies: ["shopify"], status: "draft", proposedUse: "none", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "odoo", title: "Odoo : connexion et accès en lecture", subfamilies: ["odoo"], status: "draft", proposedUse: "none", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "pennylane", title: "Pennylane : liaison technique uniquement", subfamilies: ["pennylane"], status: "draft", proposedUse: "none", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "mail-other", title: "Messageries OVH, IONOS, Orange (IMAP)", subfamilies: ["mail_other"], status: "missing", proposedUse: "none", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "dougs", title: "Dougs", subfamilies: ["dougs"], status: "missing", proposedUse: "none", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "crm", title: "CRM : Brevo, Axonaut, Sellsy, Act!, HubSpot", subfamilies: ["crm"], status: "missing", proposedUse: "none", productVersion: "à confirmer", contentVersionId: "à confirmer" },
  { key: "google-business", title: "Fiche d'établissement et avis Google", subfamilies: ["google_business"], status: "missing", proposedUse: "none", productVersion: "à confirmer", contentVersionId: "à confirmer" },
];

/** The rest of the manifest template (MANIFESTE_TEMPLATE.md): modes, rights, transfer, thresholds, measured budget, corpus. */
export const SAV_INTEGRATIONS_MANIFEST_DETAILS = {
  schema: "sav-block-manifest.v1",
  title: "Intégrations et connexions d'outils",
  promptSha256: { entry: SAV_INTEGRATIONS_ENTRY_SKILL_PROMPT_SHA256, decision: SAV_INTEGRATIONS_DECISION_SKILL_PROMPT_SHA256 },
  sharedSkills: ["layout", "closure", "followup", "handoff"],
  unknownVersionPolicy: { onlyAllSources: true, askOneQuestionIfProceduresDiverge: true },
  alwaysHuman: ["cancellation", "subscription", "finance", "rights", "identity"],
  blockHumanOnly: ["third_party_tool_billing", "permission_or_holder_change", "platform_bug", "secret_received"],
  modes: { initial: "off" },
  autoAllowed: false,
  j2: { allowed: false },
  resolutionProof: { kind: "customer_confirms_outcome", source: "customer_message", predicate: "not_written", autoClosure: false },
  transfer: { recipient: "support", reasonCodes: SAV_INTEGRATIONS_HANDOFF_REASONS },
  thresholds: {
    sensitiveAdmitted: 0, neighbourRouted: 0.95, blockRecall: 0.9, trapsRouted: 0.9, sourcesOutsideSupport: 0, doubleSend: 0,
    draftsMin: 10, draftsGoodRate: 0.9, draftsSensitiveMissed: 0,
  },
  /**
   * Bytes of the exact body sent, ceiling = V2 transport input limit, pass strictly under 85 % (22 100). Confirmation: the infra-entry lot's
   * `entryConfirmBudget` on the longest readable thread (pinned in `integrations-entry.test.ts`). Decision and router line: `integrations-budget.ts`.
   */
  budget: {
    ceilingBytes: 26_000,
    router: { blockLineBytes: 318 },
    confirmation: { longestReadableThread: 21_899 },
    counterRead: { owner: "infra-entry" },
    decision: { measuredP95OneMaxCard: 21_572, twoMaxCards: "over_85_percent" },
  },
  corpus: {
    fixture: "integrations-corpus.fixture.ts", size: 300,
    blindSet: "integrations-blind.fixture.ts", blindSize: 60,
    blindSetSha256: "9a9d227abf32550539c06cfa5235983c81141c609340293e3ee2667a3af65cf1",
  },
} as const;
