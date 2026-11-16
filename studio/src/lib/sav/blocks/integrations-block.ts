import type { SavBlockDraft } from "./block-attribution";

/**
 * SAV-92 phase 1: offline preparation only. NOT imported by the live block registry.
 * Candidate references are NOT knowledge ids, published sources or procedures. Leave
 * cardIds empty until publication and an explicit id/version mapping have been reviewed.
 * The harness rejects an unbound manifest (card_list_empty), rather than inventing cards.
 * In particular, do not register this block while the shared switch defaults to auto.
 */
export const SAV_INTEGRATIONS_BLOCK = {
  blockId: "integrations", label: "Intégrations et connexions d'outils", family: "usage", mode: "off",
  cardIds: [], supportCardIds: [],
  neighbours: ["access", "finance", "cancellation", "video"],
  exclusions: ["bug plateforme", "données sensibles", "jeton secret", "mot de passe", "code de connexion", "code de vérification WhatsApp", "numéro WhatsApp", "vidéo"],
  askBefore: [
    "Identifier l'outil, l'opération bloquée et le message d'erreur exact.",
    "Vérifier le diagnostic en lecture seule du compte connecté, sa date et sa source ; un statut connecté ne prouve pas la lecture.",
    "Demander une capture masquée si elle est absente et n'a pas déjà été demandée ; sinon conserver l'attente sans répéter la demande.",
    "Une pièce jointe présente ne prouve pas son contenu : ne jamais prétendre lire une image sans lecture vérifiée.",
  ],
  humanOnly: [
    "Bug plateforme confirmé ou suspecté, ou échec persistant après les étapes déjà vérifiées.",
    "Facturation, remboursement, paiement ou résiliation, y compris avec une demande d'intégration.",
    "Données sensibles, secrets, identité, changement de droits ou de titulaire ; ne demander ni mot de passe ni jeton.",
  ],
} as const satisfies SavBlockDraft;

/** Scope and evidence contract for the future block; descriptive, never an admission grant. */
export const SAV_INTEGRATIONS_PREPARATION = {
  revision: "sav-integrations-preparation.v1", status: "candidate_only",
  subfamilies: ["Gmail", "Outlook", "WhatsApp", "OVH", "IONOS", "Orange", "Shopify", "WordPress", "Pennylane", "Dougs", "Odoo", "LinkedIn"],
  admittedNeeds: ["connection_setup", "connection_failure", "read_failure_while_connected", "permission_error_403_diagnosis"],
  candidateRefs: ["K15", "K16", "K17", "K18", "K19", "K20", "K21", "K22", "K23", "K24", "K33", "K34"],
  accountDiagnostic: {
    access: "read_only", required: ["tool", "connection_status", "observed_at", "evidence_source", "operation", "error_text"],
    missing: "qualify_without_claiming_a_diagnosis", changesToPermissionsOrCredentials: "human_only",
  },
  screenshot: {
    absent: "ask_once_redacted", alreadyRequested: "await_without_repeating", present: "preserve_attachment_reference",
    reading: "verified_reading_only", secrets: "never_request",
  },
  relay: {
    required: ["tool", "customer_need", "verified_diagnostic_or_missing", "error_text", "steps_already_attempted", "screenshot_reference_or_pending", "unresolved_point"],
    resolution: "never_claim_resolved_without_proof",
  },
  releasePrerequisites: ["publish_and_map_candidates", "measure_index_and_holdout_separately", "review_default_off_live_wiring", "ugo_activation_decision"],
} as const;
