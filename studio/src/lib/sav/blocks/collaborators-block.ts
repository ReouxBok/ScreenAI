import type { SavBlockDraft } from "./block-attribution";

/**
 * SAV-92 phase 1: offline advice scope only, never imported by the live registry.
 * No published knowledge mapping has been approved: keep cardIds empty and mode off.
 * This draft grants neither admission nor permission to invite, remove or change rights.
 */
export const SAV_COLLABORATORS_BLOCK = {
  blockId: "collaborators", label: "Collaborateurs et espaces de travail", family: "usage", mode: "off",
  cardIds: [], supportCardIds: [],
  neighbours: ["access", "integrations", "finance", "cancellation", "api"],
  exclusions: [
    "connexion à mon compte", "code de connexion", "lien de connexion",
    "intégration", "Gmail", "Outlook", "WhatsApp", "API", "webhook",
    "facturation", "facture", "siège", "sièges", "abonnement", "remboursement",
    "suppression de compte", "supprimer mon compte", "résiliation",
  ],
  askBefore: [
    "Préciser le besoin : invitation, mauvais espace de travail, compréhension des rôles ou procédure de retrait.",
    "Distinguer le code ou lien d'invitation du code ou lien de connexion au compte personnel.",
    "Identifier l'espace attendu et l'espace affiché, sans demander de secret ni de code ou lien d'invitation complet.",
    "Conserver le message d'erreur et les étapes déjà tentées ; demander une précision manquante une seule fois.",
    "Conseiller uniquement depuis une procédure publiée et vérifiée ; sinon préparer un relais contextualisé sans inventer d'étapes.",
  ],
  humanOnly: [
    "Toute exécution d'invitation, de retrait, de changement de rôle, de permission ou d'espace : conseil uniquement, aucune modification de droits.",
    "Identité, propriété du compte, attribution de droits et contestation d'un accès : vérification et décision humaines.",
    "Facturation et sièges, paiement, abonnement, remboursement ou résiliation, même associés à une invitation.",
    "Suppression de compte et toute demande mixte avec accès personnel, intégration ou API : relais humain contextualisé.",
    "Échec persistant après les étapes vérifiées : conserver les essais et les faits manquants dans le relais.",
  ],
} as const satisfies SavBlockDraft;
