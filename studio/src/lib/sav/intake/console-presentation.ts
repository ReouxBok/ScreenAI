const statuses: Record<string, string> = {
  human_hold: "À valider par l’équipe",
  human_other: "Autres · classement humain", human_review: "Décision confiée à l’équipe",
  handled_externally: "Traité hors Studio", external_completion_pending: "Traitement externe à vérifier",
  historical_outside_automation: "Historique — hors automatisation",
  processing: "Traitement en cours", pending: "Analyse en attente", analysing: "Analyse en cours", observed: "Analyse prête, actions en attente",
  waiting: "Vérification technique en attente", uncertain: "Résultat externe à rapprocher", running: "Vérification des actions en cours",
  paused: "Dossier en pause", human_refused: "Proposition refusée", human_revalidation: "Choix enregistré, vérification en cours",
  human_revalidation_wait: "Choix en attente de preuves", identity_sent: "Demande d’identification envoyée", human_choice: "Choix humain attendu",
  followup_pending: "Actions confirmées, suivi en attente", followup_started: "Suivi démarré", context_changed: "Nouvelles preuves à vérifier",
  not_applicable_sensitive: "Fermeture vérifiée · apprentissage exclu", summary_finished: "Bilan terminé", qualified_other: "Autres · classement qualifié",
  confirmed: "Actions confirmées", refused: "Poursuite arrêtée", superseded: "Version remplacée",
};
const reasons: Array<[RegExp, string]> = [
  [/CRM_READ_/, "La lecture HubSpot est incomplète ou indisponible. Les actions déjà confirmées sont conservées ; la reprise vérifie le contexte sans les recréer."],
  [/MESSAGE_METADATA_INVALID/, "L’adresse de l’expéditeur ou la liste des destinataires est invalide ou dépasse les limites. Ce mail reste à vérifier ; les autres dossiers peuvent continuer."],
  [/BUDGET_EXHAUSTED|ADMISSION_LIMIT|CALLS_EXHAUSTED/, "Plafond de qualification atteint. Une reprise technique est nécessaire."],
  [/USAGE_UNCERTAIN|SETTLEMENT_UNCERTAIN/, "Le coût du dernier appel reste à confirmer. Aucun nouvel appel ne peut partir."],
  [/ATTEMPTS|attempts_exhausted/, "Les tentatives bornées sont épuisées. Les éléments vérifiés sont conservés."],
  [/SEMANTIC_PROVENANCE_MISSING/, "Cette analyse ne conserve pas les résultats validés nécessaires à la reprise."],
  [/SEMANTIC_CONTEXT_CHANGED|CONTEXT_CHANGED|CRM_CHANGED|REVALIDATION/, "Les sources ont changé ou ne correspondent plus au choix. Une nouvelle vérification est nécessaire."],
  [/SOURCES_STALE/, "Les preuves doivent être relues avant de poursuivre."],
  [/ASSOCIATION_INCOMPLETE|association_incomplete/, "Les liens entre fiches ne sont pas entièrement vérifiés."],
  [/MUTATION_NOT_GRANTED|PERMISSION|REVOKED|DISABLED/, "L’autorisation actuelle ne permet pas de poursuivre cette action."],
  [/OWNER/, "Le responsable du ticket doit être vérifié avant sa réouverture."],
  [/RESOURCE/, "La ressource approuvée nécessaire à ce parcours est indisponible."],
];
export const intakeStatusLabel = (status: string) => statuses[status] ?? "Vérification en attente";
export function intakeReasonLabel(reason: string | null | undefined) {
  if (!reason) return null;
  if (!/^[A-Z_:\d]+$/.test(reason) && /[ àéèêç]/.test(reason)) return reason;
  return reasons.find(([pattern]) => pattern.test(reason))?.[1] ?? "Une vérification technique est nécessaire ; les éléments déjà établis sont conservés.";
}
export const intakeContextReasonLabels: Record<string, string> = {
  classification_incomplete: "qualification de la demande", contact_lookup_failed: "recherche de la fiche", contact_lookup_incomplete: "complétude de la recherche de fiche",
  contact_ambiguous: "choix entre plusieurs fiches", association_incomplete: "liens directs entre les fiches", ticket_search_incomplete: "recherche exhaustive des tickets",
  history_incomplete: "historique et pièces non analysées", same_issue_unresolved: "correspondance du ticket avec toutes les demandes",
  ticket_creation_date_unknown: "date de création du ticket", ticket_closure_date_unknown: "date de fermeture du ticket", ticket_stage_unknown: "statut actuel du ticket",
  ticket_owner_unknown: "responsable du ticket", private_resource_unavailable: "ressource approuvée indisponible",
};
