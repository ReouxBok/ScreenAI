import type {
  SavAgentToolTrace,
  savActionKind,
  savActionStatus,
  savDecisionKind,
  savLearningStatus,
  savPilotBatchStatus,
  savPilotItemStatus,
  savPilotVerdict,
  savThreadStatus,
} from "@/db/schema";
import type { SavStructuredProposal } from "./proposal";

/** Display labels only: form values and persisted SAV contracts remain unchanged. */
export const savCategoryLabels = {
  technical: "Problème technique",
  account: "Compte et accès",
  billing: "Facturation",
  integration: "Intégration",
  how_to: "Utilisation du produit",
  acknowledgement: "Remerciement ou confirmation",
  other: "Autre",
} as const satisfies Record<SavStructuredProposal["category"], string>;

export const savUrgencyLabels = {
  low: "Faible",
  normal: "Normale",
  high: "Élevée",
  critical: "Critique",
} as const satisfies Record<SavStructuredProposal["urgency"], string>;

export const savDecisionLabels = {
  ticket_pending: "Ticket à proposer",
  ticket_created: "Ticket créé",
  attached_to_existing_ticket: "Rattaché à un ticket existant",
  no_ticket_needed: "Aucun ticket nécessaire",
  spam: "Courrier indésirable",
  internal_notification: "Notification interne",
  automatic_reply: "Réponse automatique",
  bounce: "Échec de distribution",
  duplicate: "Doublon",
  human_review_required: "Revue humaine requise",
} as const satisfies Record<(typeof savDecisionKind.enumValues)[number], string>;

export const savThreadStatusLabels = {
  new: "Nouveau",
  ai_processing: "Analyse IA en cours",
  awaiting_customer: "En attente du client",
  followup_due: "Relance à effectuer",
  human_requested: "Intervention humaine demandée",
  human_processing: "Traitement humain en cours",
  resolved: "Résolu",
  closed_no_action: "Clos sans action",
  error: "Erreur",
} as const satisfies Record<(typeof savThreadStatus.enumValues)[number], string>;

export const savActionLabels = {
  create_ticket: "Créer un ticket",
  link_ticket: "Rattacher à un ticket",
  log_email: "Enregistrer l’email dans HubSpot",
  create_note: "Créer une note interne",
  draft_reply: "Préparer un brouillon",
  send_reply: "Envoyer la réponse",
  update_ticket_status: "Mettre à jour le statut du ticket",
  schedule_followup: "Planifier une relance",
  cancel_followup: "Annuler la relance",
  request_human: "Demander une intervention humaine",
  create_learning_candidate: "Proposer une connaissance",
} as const satisfies Record<(typeof savActionKind.enumValues)[number], string>;

export const savActionStatusLabels = {
  pending: "En attente",
  running: "En cours",
  succeeded: "Réussie",
  failed: "Échec",
  cancelled: "Annulée",
} as const satisfies Record<(typeof savActionStatus.enumValues)[number], string>;

export const savToolStatusLabels = {
  ...savActionStatusLabels,
  blocked: "Bloquée",
} as const satisfies Record<SavAgentToolTrace["status"], string>;

export const savProcessLabels = {
  human_review: "Vérification humaine",
  create_ticket: "Création de ticket proposée",
  link_ticket: "Rattachement à un ticket proposé",
  product_step: "Étape dans le produit",
  review_reply: "Relecture du brouillon",
  verify_outcome: "Vérification du résultat",
} as const satisfies Record<SavStructuredProposal["process"][number]["kind"], string>;

export const savRunStatusLabels = {
  pending: "En attente",
  running: "En cours",
  processing: "En cours",
  succeeded: "Analyse terminée",
  failed: "Échec de l’analyse",
  blocked: "Analyse bloquée",
  fallback: "Analyse de repli",
  shadow: "Analyse de simulation",
  cancelled: "Analyse annulée",
} as const;

export const savAnalysisStatusLabels = {
  pending: "À analyser",
  processing: "Analyse en cours",
  done: "Analyse terminée",
  failed: "Échec de l’analyse",
} as const;

export const savRoutingLabels = {
  none: "Aucun rattachement proposé",
  new: "Nouveau ticket proposé",
  matched: "Ticket correspondant trouvé",
  review: "Rattachement à vérifier",
  ambiguous: "Plusieurs tickets possibles",
} as const satisfies Record<SavStructuredProposal["routing"]["kind"], string> & { ambiguous: string };

export const savRoutingReasonLabels = {
  gmail_thread_link: "Ticket déjà lié à cette conversation",
  explicit_ticket_reference: "Référence du ticket dans l’objet",
  exact_subject: "Objet identique à celui du ticket",
  multiple_exact_subjects: "Plusieurs tickets portent le même objet",
  strong_subject_similarity: "Objet très proche de celui du ticket",
  multiple_similar_subjects: "Plusieurs tickets ont un objet proche",
  no_reliable_match: "Aucune correspondance suffisamment fiable",
  no_open_ticket: "Aucun ticket ouvert",
  no_contact: "Aucun contact reconnu",
  contact_not_found: "Aucun contact reconnu",
  customer_identity_unverified: "Identité du client à vérifier",
  hubspot_context_unavailable: "Contexte HubSpot indisponible",
} as const;

export const savVerdictLabels = {
  correct: "Correct",
  partial: "Partiel",
  incorrect: "Incorrect",
  critical: "Critique",
} as const satisfies Record<(typeof savPilotVerdict.enumValues)[number], string>;

export const savReviewStatusLabels = {
  pending: "À revoir",
  approved: "Validée",
  rejected: "Refusée",
} as const;

export const savLearningStatusLabels = {
  pending: "À examiner",
  approved: "Approuvée",
  rejected: "Refusée",
} as const satisfies Record<(typeof savLearningStatus.enumValues)[number], string>;

export const savPilotBatchStatusLabels = {
  processing: "Analyse en cours",
  reviewing: "À examiner",
  completed: "Terminé",
  cancelled: "Annulé",
} as const satisfies Record<(typeof savPilotBatchStatus.enumValues)[number], string>;

export const savPilotItemStatusLabels = {
  pending: "En attente",
  processing: "Analyse en cours",
  ready: "Prêt à examiner",
  reviewed: "Examiné",
  error: "Erreur",
} as const satisfies Record<(typeof savPilotItemStatus.enumValues)[number], string>;

export const savReusabilityLabels = {
  none: "Évaluation seulement",
  tone_only: "Ton uniquement",
  customer_specific: "Cas propre à ce client",
  reusable: "Procédure réutilisable à proposer à Ugo",
} as const;

export const savSourceLabels = {
  knowledge: "Connaissance",
  hubspot_ticket: "Ticket HubSpot",
  gmail_thread: "Conversation email",
  rule: "Règle de qualification",
} as const;

export const savDirectionLabels = {
  inbound: "Email reçu",
  outbound: "Email envoyé",
} as const;

/** Never expose an unknown internal enum or a prototype property as UI text. */
export function savLabel(labels: Readonly<Record<string, string>>, value: string | null | undefined, fallback = "État non reconnu") {
  if (!value?.trim()) return "Non renseigné";
  if (!Object.hasOwn(labels, value)) return fallback;
  return labels[value];
}
