import { intakeUncertaintyLabel, type IntakeUncertainty } from "./uncertainty";
const statuses: Record<string, string> = {
  human_hold: "À valider par l’équipe",
  human_other: "Autres · classement humain", human_review: "Décision confiée à l’équipe",
  handled_externally: "Traité hors Studio", external_completion_pending: "Traitement externe à vérifier",
  historical_outside_automation: "Historique — hors automatisation",
  processing: "Traitement en cours", pending: "Analyse en attente", analysing: "Analyse en cours", observed: "Analyse prête, actions en attente",
  waiting: "Vérification technique en attente", uncertain: "Incertitude à qualifier", running: "Vérification des actions en cours",
  paused: "Dossier en pause", human_refused: "Proposition refusée", human_revalidation: "Choix enregistré, vérification en cours",
  human_revalidation_wait: "Choix en attente de preuves", identity_sent: "Demande d’identification envoyée", human_choice: "Choix humain attendu",
  followup_pending: "Actions confirmées, suivi en attente", followup_started: "Suivi démarré", context_changed: "Nouvelles preuves à vérifier",
  not_applicable_sensitive: "Fermeture vérifiée · apprentissage exclu", summary_finished: "Bilan terminé", qualified_other: "Autres · classement qualifié",
  confirmed: "Actions confirmées", refused: "Poursuite arrêtée", superseded: "Version remplacée", v2_customer_return: "Retour client repris sur le dossier V2",
  // SAV-92: routed to a team queue with their named reason (console projection only, no automatic action).
  context_required: "Contexte à compléter par l’équipe", crm_review_required: "Changement HubSpot à arbitrer",
  execution_superseded: "Ancienne exécution obsolète, décision attendue", followup_partial: "Suivi partiel (limite de couverture)",
  sensitive_team: "Dossier sensible : décision de l’équipe",
};
const reasons: Array<[RegExp, string]> = [
  [/FORWARDED_ORIGIN_UNVERIFIED/, "Mail transféré sans instruction de l’expéditeur. Identifier la demande originale et vérifier son ticket dans HubSpot."],
  [/PRIOR_REQUEST_PENDING/, "Un mail antérieur reste à traiter. Vérifiez sa prise en charge avant de classer le dernier avis."],
  [/AUTOMATED_REPLY/, "Accusé de réception automatique classé sans appel à l’IA. Le mail est conservé."],
  [/SUPPORT_DELIVERY_FAILURE/, "Avis de distribution concernant un mail du support. Consulter l’avis pour vérifier son état."],
  [/ADDRESS_PROOF_UNRESOLVED/, "L’adresse retenue par l’analyse ne peut plus être prouvée à partir du mail. Aucune action n’est envoyée ; une décision humaine est nécessaire."],
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
/** Console projection: an uncertain dossier names what is uncertain (AI cost, external HubSpot/Gmail action, both) when the V1 ledgers say so. */
export const intakeProjectionLabel = (status: string, uncertainty?: IntakeUncertainty | null) => status === "uncertain" ? intakeUncertaintyLabel(uncertainty) : intakeStatusLabel(status);
/** An execution ends `uncertain` only when one of its HubSpot/Gmail effects is unconfirmed (executor reconciliation): never a generic uncertainty. */
export const intakeExecutionStateLabel = (state: string) => state === "uncertain" ? intakeUncertaintyLabel("effect") : intakeStatusLabel(state);
const crmClasses: Record<string, string> = {
  business_change: "changement dans HubSpot sur un élément utilisé par la décision", unattributed_email: "email ajouté dans HubSpot, non encore attribué",
  unknown: "écart dont le détail n’est pas disponible",
};
const crmReasons: Record<string, string> = {
  original_evidence_changed: "au premier contrôle, avant toute action", owned_effect_changed: "sur une action déjà confirmée par Studio",
  added_history_event: "nouvel événement dans l’historique du ticket", unrecognized_added_email: "avant la remise en Nouveau", snapshot_changed: "pendant la poursuite",
  choice_changed: "avant toute action, sur un élément du choix (fiche, ticket, étape, sujet ou description)",
  target_out_of_scope: "après une action confirmée : le ticket cible n’apparaît plus parmi les tickets des contacts relus (supprimé, fusionné ou rattaché à une autre fiche, non distingués)",
};
const nextSteps: Record<string, string> = {
  none: "aucune", read_only_verification: "vérification en lecture seule du résultat déjà envoyé, sans nouvel envoi",
  human_decision: "décision humaine : vérifier le dossier dans HubSpot, puis le reprendre en main ou le marquer traité ; aucune action automatique n’est relancée",
  automatic_recheck: "nouveau contrôle automatique borné, sans rejouer les actions confirmées", wait_resume: "reprise à la fin de la pause",
  unknown: "à déterminer : motif technique non classé",
};
export const intakeNextStepLabel = (step: string) => nextSteps[step] ?? nextSteps.unknown;
/** Readable summary of an allow-listed CRM delta: kind, moment, fields; never values. */
export function intakeCrmDeltaLabel(delta: { reason: string; classification: string; fields: string[]; fieldsKnown: boolean | null; ticketIds: string[] } | null | undefined) {
  if (!delta) return null;
  const fields = delta.fields.filter(f => f.includes(".")), where = delta.ticketIds.length ? ` (ticket${delta.ticketIds.length > 1 ? "s" : ""} ${delta.ticketIds.join(", ")})` : "";
  return `Écart HubSpot : ${crmClasses[delta.classification] ?? crmClasses.unknown}, ${crmReasons[delta.reason] ?? "pendant la vérification"}${where}. `
    + (fields.length ? `Champs : ${fields.join(", ")}.` : delta.fieldsKnown === false ? "Détail des champs inconnu pour cette analyse (empreinte d’origine absente)." : `Éléments : ${delta.fields.join(", ") || "non précisés"}.`);
}
export function intakeReasonLabel(reason: string | null | undefined) {
  if (!reason) return null;
  if (!/^[A-Z_:\d]+$/.test(reason) && /[ àéèêç]/.test(reason)) return reason;
  return reasons.find(([pattern]) => pattern.test(reason))?.[1] ?? "Une vérification technique est nécessaire ; les éléments déjà établis sont conservés.";
}
export const intakeContextReasonLabels: Record<string, string> = {
  other_rule_not_applicable: "aucune règle approuvée ne permet de classer ce message dans Autres",
  other_evidence_unavailable: "vérification des preuves de classement indisponible",
  forwarded_origin_unverified: "mail transféré sans texte de l’expéditeur actuel",
  classification_incomplete: "qualification de la demande", contact_lookup_failed: "recherche de la fiche", contact_lookup_incomplete: "complétude de la recherche de fiche",
  contact_ambiguous: "choix entre plusieurs fiches", association_incomplete: "liens directs entre les fiches", ticket_search_incomplete: "recherche exhaustive des tickets",
  history_incomplete: "historique et pièces non analysées", same_issue_unresolved: "correspondance du ticket avec toutes les demandes",
  ticket_creation_date_unknown: "date de création du ticket", ticket_closure_date_unknown: "date de fermeture du ticket", ticket_stage_unknown: "statut actuel du ticket",
  ticket_owner_unknown: "responsable du ticket", private_resource_unavailable: "ressource approuvée indisponible",
  // SAV-74: a per-analysis call count, not money; the daily and 30-day caps are separate causes.
  analysis_calls_limit: "historique trop long pour la limite d’appels d’analyse (aucun plafond financier atteint)",
};

/** Team-facing cause of a blocked dossier; the incident stays counted until resolved. */
const blockedCauses: Record<string, string> = {
  other_evidence_unavailable: "Bloqué — vérifier les preuves de classement du mail.",
  forwarded_origin_unverified: "Bloqué — transfert sans texte propre. Retrouver le mail ou l’activité CRM d’origine.",
  private_resource_unavailable: "Bloqué — règle ou modèle approuvé indisponible. Vérifier la configuration ou traiter ce dossier manuellement.",
  attempts_exhausted: "Bloqué — tentatives d’analyse épuisées. À traiter par l’équipe.",
  // SAV-88: the one rescue analysis did not conclude either. Terminal: no further automatic attempt.
  manual_required: "À traiter à la main — l’analyse de secours n’a pas abouti, aucun ticket n’a été créé.",
  input_invalid: "Bloqué — entrée invalide (date ou contenu). À traiter par l’équipe.",
  source_invalid: "Bloqué — source du mail invalide. À traiter par l’équipe.",
  technical_wait: "Bloqué — attente technique de plus de 15 minutes. À traiter par l’équipe.",
  // SAV-75: expected wait, not an incident; the dossier resumes when the pause is lifted.
  agent_paused: "En attente — agent SAV en pause complète. Reprise automatique à la levée de la pause ; pas un incident.",
};
export function intakeBlockedCauseLabel(cause: string | null | undefined) { return cause ? blockedCauses[cause] ?? "Bloqué — à traiter par l’équipe." : null; }

/** Console PR-1: `technical_wait` stays the stable API code; this names the real sub-cause from the status and reason the console already reads
 * (no extra query, no amount). Anything not recognised is said to be unclassified, never guessed. */
export type IntakeBlockedSubCause = "followup_queued" | "followup_incomplete" | "sources_changed" | "verification_pending" | "revalidation_running" | "analysis_queued" | "budget_deferred" | "unclassified"
  /** SAV-92 (B): V1 asked the team for missing HubSpot context; (B) an AI call whose cost is still to confirm; (C) a context change never retried. */
  | "context_required" | "usage_uncertain" | "context_changed_stalled"
  /** SAV-88: the dossier already has a ticket the team sees; only the follow-up is waiting. */
  | "ticket_tracked";
const subCauseLabels: Record<IntakeBlockedSubCause, string> = {
  followup_queued: "Premier suivi en file : le rattrapage le traitera au prochain passage",
  followup_incomplete: "Suivi incomplet : la lecture d’une source a échoué ; nouvelle lecture au suivi quotidien",
  sources_changed: "Sources modifiées : nouvelle vérification nécessaire",
  verification_pending: "Vérification HubSpot/Gmail en attente",
  revalidation_running: "Choix enregistré : vérification en cours",
  analysis_queued: "Mail en attente d’analyse : le prochain passage le prendra",
  budget_deferred: "Plafond IA atteint : reprise automatique quand il se libère",
  unclassified: "Attente technique : cause non classée, ouvrir le dossier",
  ticket_tracked: "Ticket créé, suivi en cours : l’équipe le voit dans HubSpot",
  context_required: "Contexte à compléter par l’équipe : V1 attend une information HubSpot (historique, tickets ou fiche)",
  usage_uncertain: "Coût IA à confirmer : aucun nouvel appel tant qu’il n’est pas rapproché (aucun reset)",
  context_changed_stalled: "Incident : contexte changé sans nouvelle tentative depuis plus de 24 h",
};
export const intakeSubCauseLabel = (sub: IntakeBlockedSubCause) => subCauseLabels[sub];
/** A console row; `ticketId` (thread ticket, SAV-88) is optional so older callers keep their labels. */
export type IntakeBlockedRow = { blockedCause?: string | null; status: string; reason?: string | null; ticketId?: string | null;
  /** SAV-92 (C): current run attempts and last update, read with the row; optional so older callers keep their labels. */
  runAttempts?: number | null; runUpdatedAt?: string | Date | null };
/** Raw CRM read reasons (lowercase) that leave V1 without the context it needs: the team completes it (SAV-92 B). */
const CONTEXT_READ_REASONS = /^(ticket_limit|history_limit|contact_limit|page_limit|request_limit|batch_limit|partial_batch|partial_response|total_mismatch|pagination_cycle|read_unavailable|cancelled|history_date_unknown|ticket_content_unavailable|ticket_membership_conflict|conflicting_contact|aliases_unavailable|archived_contact|history_incomplete|ticket_search_incomplete|contact_lookup_incomplete|association_incomplete|same_issue_unresolved)$/;
export const INTAKE_CONTEXT_CHANGED_STALL_MS = 24 * 3_600_000;
export function intakeBlockedSubCause(row: IntakeBlockedRow, now: Date = new Date()): IntakeBlockedSubCause | null {
  if (row.blockedCause !== "technical_wait") return null;
  const sub = technicalWaitSubCause(row, now);
  // SAV-88 (SAV-82 follow-up): with a real ticket nothing waits for an analysis any more: the ticket is followed.
  // A pending HubSpot/Gmail check stays named as such.
  return row.ticketId && sub === "analysis_queued" ? "ticket_tracked" : sub;
}
function technicalWaitSubCause(row: IntakeBlockedRow, now: Date): IntakeBlockedSubCause {
  const reason = row.reason ?? "";
  if (/DAILY_BUDGET_DEFERRED|ROLLING_BUDGET_DEFERRED|Plafond (quotidien|d’analyse)/.test(reason)) return "budget_deferred";
  if (/USAGE_UNCERTAIN|SETTLEMENT_UNCERTAIN|^usage_uncertain$|Coût IA à confirmer/.test(reason)) return "usage_uncertain";
  if (row.status === "context_required" || CONTEXT_READ_REASONS.test(reason) || /^Contexte à compléter/.test(reason)) return "context_required";
  if (row.status === "human_revalidation" || row.status === "human_revalidation_wait") return "revalidation_running";
  if (row.status === "followup_pending") return /incompl/i.test(reason) ? "followup_incomplete" : "followup_queued";
  if (row.status === "context_changed" || /SEMANTIC_CONTEXT_CHANGED|CONTEXT_CHANGED|CRM_CHANGED|SOURCES_STALE|sources (locales )?(ont changé|doivent)/i.test(reason)) {
    // SAV-92 (C): a context change no attempt ever took up for more than 24 h is an incident, named as such.
    const since = row.runUpdatedAt ? new Date(row.runUpdatedAt).getTime() : NaN;
    return row.runAttempts === 0 && Number.isFinite(since) && now.getTime() - since > INTAKE_CONTEXT_CHANGED_STALL_MS ? "context_changed_stalled" : "sources_changed";
  }
  if (row.status === "waiting" && (!reason || /CRM_READ_|vérification technique/i.test(reason))) return "verification_pending";
  if (row.status === "pending" || row.status === "analysing" || (row.status === "processing" && !reason) || /Nouvelle entrée en attente/.test(reason)) return "analysis_queued";
  return "unclassified";
}
/** The reconcile pulse older than this means the scheduler, not the dossier, is the cause. */
export const INTAKE_SCHEDULER_STALE_MINUTES = 30;
export function intakeSchedulerStopped(pulse: { startedAt: string | null; finishedAt: string | null } | null | undefined, now: Date = new Date()) {
  const last = pulse?.finishedAt ?? pulse?.startedAt ?? null;
  if (!last || Number.isNaN(Date.parse(last))) return false; // no pulse is unknown, never declared a stop
  return now.getTime() - Date.parse(last) > INTAKE_SCHEDULER_STALE_MINUTES * 60_000;
}
export const INTAKE_SCHEDULER_STOPPED_LABEL = "Traitement automatique arrêté";
/** The single line of a list row: the real sub-cause for a technical wait, else the stable cause label. */
export function intakeBlockedRowLabel(row: IntakeBlockedRow) {
  const sub = intakeBlockedSubCause(row);
  return sub ? intakeSubCauseLabel(sub) : intakeBlockedCauseLabel(row.blockedCause);
}

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
  other_evidence_unavailable: "Vérifier le message source et ses preuves techniques de classement.",
  other_rule_not_applicable: "Décider du classement à partir du message original et de son historique.",
  forwarded_origin_unverified: "Retrouver le message original et vérifier son auteur et son dossier dans HubSpot avant le rattachement.",
  private_resource_unavailable: "Une ressource approuvée manque (modèle de réponse, règle) : la configurer ou traiter manuellement.",
  attempts_exhausted: "Traiter le dossier manuellement ou relancer une analyse après correction de la cause.",
  manual_required: "Lire le mail et le traiter à la main dans HubSpot : l’analyse de secours a échoué, plus aucune tentative automatique.",
  SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED: "Le budget d’appels IA de ce message est atteint : traiter manuellement.",
  analysis_calls_limit: "Les tickets et historiques du contact demandent plus de lots d’analyse que la limite par analyse : choisir le ticket qui reçoit ce mail ou demander une création. Une nouvelle tentative identique échouerait de la même façon.",
  SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED: "Aucune action requise : reprise automatique au prochain jour (minuit UTC). Relever le plafond quotidien si l’attente gêne.",
  SAV_INTAKE_RUNTIME_ROLLING_BUDGET_DEFERRED: "En attente de budget disponible sur 30 jours : relever le plafond glissant ou traiter manuellement si l’attente gêne.",
};
/** SAV-74: the analysis-call limit is named for what it is, never as the money budget. */
export function intakeRuntimeHandoffReasons(payload: { reason?: string; budgetLimit?: string } | undefined) {
  if (payload?.reason === "SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED" && payload.budgetLimit === "analysis_calls") return ["analysis_calls_limit"];
  return payload?.reason === "SAV_INTAKE_RUNTIME_BUDGET_EXHAUSTED" || payload?.reason === "SAV_INTAKE_RUNTIME_DAILY_BUDGET_DEFERRED" || payload?.reason === "SAV_INTAKE_RUNTIME_ROLLING_BUDGET_DEFERRED" ? [payload.reason] : [];
}
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

/** SAV-92: where the console shows a dossier that waits on the team. Pure presentation: it never schedules, sends,
 * resets or re-reads anything; the projection stores the result, the automatic pipeline is unchanged. */
export type IntakeTeamRoute = { view: "to_validate" | "sensitive"; status: string; reason: string };
/** Dependencies that already carry a durable blocking marker with their own team label (console cause). */
const MARKED_CONTEXT_DEPENDENCIES = new Set(["private_resource_unavailable", "forwarded_origin_unverified", "other_evidence_unavailable"]);
/** (B) A V1 run that waits for context only the team can give (collect_context, no human choice yet). A scheduled
 * automatic read retry or transient retry is a next action, not a team request: it stays where it is. */
export function intakeContextRequiredRoute(input: { disposition?: { kind: string; reasons?: readonly string[] } | null; progressKind?: string | null;
  runState: string; readRetryScheduled?: boolean; retryScheduled?: boolean }): IntakeTeamRoute | null {
  if (input.runState !== "waiting" || input.disposition?.kind !== "collect_context" || input.progressKind === "human_choice") return null;
  if (input.readRetryScheduled || input.retryScheduled) return null;
  const reasons = [...new Set(input.disposition.reasons ?? [])];
  if (reasons.some(r => MARKED_CONTEXT_DEPENDENCIES.has(r))) return null;
  const causes = reasons.map(r => intakeContextReasonLabels[r]).filter((l): l is string => Boolean(l));
  const actions = [...new Set(reasons.map(r => intakeExpectedActions[r]).filter((a): a is string => Boolean(a)))];
  return { view: "to_validate", status: "context_required",
    reason: `Contexte à compléter par l’équipe : ${causes.length ? causes.join(" ; ") : "information manquante non précisée par l’analyse"}. `
      + (actions.length ? actions.join(" ") : "Lire le dossier, puis indiquer le ticket ou la création.") + " Aucune action automatique n’est lancée." };
}
/** (C) A V1 execution stopped for a human decision (CRM change to arbitrate). When a newer analysis exists, the old
 * execution is shown obsolete: it sent nothing and nothing will be sent from it; the team decides on the current one. */
export function intakeExecutionDecisionRoute(input: { progress: { state: string; confirmed: boolean; runId: string | null; version: number;
  crmRecheck?: { humanRequired: boolean } | null; crmDelta?: Parameters<typeof intakeCrmDeltaLabel>[0]; effects: readonly { state: string }[] } | null;
  run: { id: string; version: number; state: string } }): IntakeTeamRoute | null {
  const p = input.progress;
  if (!p || p.confirmed || p.state !== "waiting" || !p.crmRecheck?.humanRequired) return null;
  const sent = p.effects.some(e => e.state !== "planned");
  const delta = intakeCrmDeltaLabel(p.crmDelta ?? null);
  if (p.runId !== input.run.id && input.run.version > p.version && !sent)
    return { view: "to_validate", status: "execution_superseded",
      reason: `Exécution de la version ${p.version} obsolète : une analyse plus récente (version ${input.run.version}) existe. Aucune action n’a été envoyée par l’ancienne exécution et aucune ne le sera. `
        + `${delta ? `${delta} ` : ""}Décision de l’équipe : vérifier le dossier dans HubSpot, puis rattacher, créer ou marquer traité.` };
  return { view: "to_validate", status: "crm_review_required",
    reason: `Changement HubSpot à arbitrer${sent ? " (des actions déjà confirmées sont conservées)" : " ; aucune action envoyée"}. ${delta ? `${delta} ` : ""}Prochaine étape : ${nextSteps.human_decision}.` };
}
/** Statuses where a dossier is actively moving on its own (analysis or verification running, choice being revalidated). */
const ACTIVE_STATUSES = new Set(["processing", "pending", "analysing", "running", "human_revalidation", "v2_customer_return", "external_completion_pending", "paused"]);
/** (Sensitive) A finance/cancellation dossier is never left in a technical wait: it is shown in the team's sensitive queue
 * with the reason it was waiting on, while the automatic pipeline keeps its own state. */
export function intakeSensitiveRoute(result: { view: string | null; status: string; reason: string | null }, sensitive: boolean): IntakeTeamRoute | null {
  if (!sensitive || result.view !== null || ACTIVE_STATUSES.has(result.status)) return null;
  const why = intakeReasonLabel(result.reason) ?? "";
  return { view: "sensitive", status: "sensitive_team",
    reason: `Dossier sensible (résiliation ou facturation) : décision de l’équipe, jamais en attente technique. État : ${intakeStatusLabel(result.status)}.${why ? ` ${why}` : ""}` };
}
