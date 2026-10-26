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
  [/DAILY_BUDGET_DEFERRED/, "Plafond quotidien d’analyse IA atteint : reprise automatique au prochain jour (minuit UTC), aucune tentative consommée."],
  [/ROLLING_BUDGET_DEFERRED/, "Plafond d’analyse IA sur 30 jours atteint : en attente de budget disponible, aucune tentative consommée."],
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

/** Team-facing cause of a blocked dossier; the incident stays counted until resolved. */
const blockedCauses: Record<string, string> = {
  attempts_exhausted: "Bloqué — tentatives d’analyse épuisées. À traiter par l’équipe.",
  input_invalid: "Bloqué — entrée invalide (date ou contenu). À traiter par l’équipe.",
  source_invalid: "Bloqué — source du mail invalide. À traiter par l’équipe.",
  technical_wait: "Bloqué — attente technique de plus de 15 minutes. À traiter par l’équipe.",
};
export function intakeBlockedCauseLabel(cause: string | null | undefined) { return cause ? blockedCauses[cause] ?? "Bloqué — à traiter par l’équipe." : null; }

/** Paris time of the next automatic retry, for the processing list. */
export function intakeRetryLabel(retryAt: string | Date) {
  const time = new Date(retryAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  return `Reprise automatique prévue à ${time} — incident fournisseur temporaire.`;
}

/** The exact intervention expected from the team, per cause: never just "to validate". */
export const intakeExpectedActions: Record<string, string> = {
  classification_incomplete: "Lire le mail et indiquer la catégorie de la demande (support, finance, résiliation, autre).",
  contact_lookup_failed: "Rechercher la fiche HubSpot de l’expéditeur ; la recherche automatique a échoué.",
  contact_lookup_incomplete: "Vérifier la fiche HubSpot de l’expéditeur ; la recherche était incomplète.",
  contact_ambiguous: "Choisir la bonne fiche parmi les fiches proposées.",
  association_incomplete: "Vérifier les fiches liées à ce contact dans HubSpot.",
  ticket_search_incomplete: "Vérifier les tickets du contact dans HubSpot ; la liste était incomplète.",
  history_incomplete: "Vérifier l’historique du ticket ou la pièce jointe indispensable, puis indiquer le ticket ou la création.",
  same_issue_unresolved: "Choisir le ticket qui reçoit ce mail, ou demander une création si aucun ne correspond.",
  ticket_creation_date_unknown: "Vérifier la date de création du ticket candidat dans HubSpot.",
  ticket_closure_date_unknown: "Vérifier la date de fermeture du ticket : réouverture (15 jours ou moins) ou nouveau ticket.",
  ticket_stage_unknown: "Vérifier le statut actuel du ticket dans HubSpot.",
  ticket_owner_unknown: "Vérifier le responsable du ticket fermé avant sa réouverture.",
  private_resource_unavailable: "Une ressource approuvée manque (modèle de réponse, règle) : la configurer ou traiter manuellement.",
  attempts_exhausted: "Traiter le dossier manuellement ou relancer une analyse après correction de la cause.",
  SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED: "Le budget d’appels IA de ce message est atteint : traiter manuellement.",
  SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED: "Aucune action requise : reprise automatique au prochain jour (minuit UTC). Relever le plafond quotidien si l’attente gêne.",
  SAV_INTAKE_RUNTIME_ROLLING_BUDGET_DEFERRED: "En attente de budget disponible sur 30 jours : relever le plafond glissant ou traiter manuellement si l’attente gêne.",
};
export type IntakeHandoffInput = {
  reasons: readonly string[]; blockedCause?: string | null;
  assessments?: readonly { ticketId: string; relation: string }[];
  judgement?: { rationale?: string; missing?: { kind: string; why: string }[]; tickets?: { ticketId: string; relation: string; why: string }[] };
};
/** What a person needs to act without re-investigating: cause, exact action, tickets examined and what was missing. */
export function intakeHandoff(input: IntakeHandoffInput) {
  const causes = [...new Set([...(input.blockedCause ? [input.blockedCause] : []), ...input.reasons])];
  const actions = [...new Set(causes.map(c => intakeExpectedActions[c]).filter((a): a is string => Boolean(a)))];
  const relation: Record<string, string> = { same: "même problème", different: "autre problème", unclear: "incertain", unknown: "incertain", partial: "partiel" };
  const tickets = (input.judgement?.tickets ?? input.assessments ?? []).map(t => ({ ticketId: t.ticketId, relation: relation[t.relation] ?? t.relation,
    why: "why" in t ? (t as { why: string }).why : undefined }));
  return { causes: causes.map(c => intakeContextReasonLabels[c] ?? intakeBlockedCauseLabel(c) ?? c), actions, tickets,
    missing: input.judgement?.missing ?? [], rationale: input.judgement?.rationale };
}
