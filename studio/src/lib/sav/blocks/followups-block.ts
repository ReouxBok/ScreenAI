import type { SavBlockDraft } from "./block-attribution";

/** Phase 1, offline only: no registry entry, published cards or authority to close a ticket. */
export const SAV_FOLLOWUPS_BLOCK = {
  blockId: "followups", label: "Suivis et accusés de réception", family: "usage", mode: "off",
  cardIds: [], supportCardIds: [],
  neighbours: ["access", "integrations", "collaborators", "finance", "cancellation"],
  exclusions: ["nouvelle demande", "problème persistant", "facturation", "résiliation", "identité", "droits", "historique incomplet"],
  askBefore: [
    "Relire le mail entier, y compris signature et pièces jointes ; une lecture incomplète interdit toute proposition de clôture.",
    "Vérifier l'historique complet et chaque demande connue, avec sa preuve de résolution vérifiée.",
    "Confirmer explicitement l'absence de nouvelle demande et de sujet sensible ; un merci seul ne prouve rien.",
  ],
  humanOnly: [
    "Toute clôture effective : le bloc produit uniquement une proposition pour revue humaine.",
    "Sujet sensible, demande cachée, problème persistant ou contenu ambigu : relais contextualisé à l'équipe.",
    "Finance, résiliation, identité et droits restent humains, même dans un remerciement.",
  ],
} as const satisfies SavBlockDraft;
