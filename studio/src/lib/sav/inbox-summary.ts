import type { SavStructuredProposal } from "./proposal";

export type SavInboxPartnershipStatus = "succeeded" | "uncertain" | "pending" | "failed";

type InboxSummaryInput = {
  subject: string;
  analysisStatus: string;
  analysisErrorCode: string | null;
  proposal: SavStructuredProposal | null;
  originalProposal: SavStructuredProposal | null;
  reviewStatus: string | null;
  hubspotTicketId: string | null;
  partnershipTransferStatus?: SavInboxPartnershipStatus | null;
};

const cleanText = (value: string) => value.replace(/\s+/g, " ").trim();

/** Presentation only: the original subject remains the CRM matching key. */
export function savInboxSubject(subject: string) {
  return cleanText(subject).replace(/^(?:(?:re|rép|aw|sv|fw|fwd|tr)\s*:\s*)+/i, "").trim() || "Email sans objet";
}

const requestThemes: Record<string, string> = {
  technical: "Problème technique", account: "Compte et accès", integration: "Aide à une intégration",
  how_to: "Aide à l’utilisation", financial_operation: "Demande financière", financial_data: "Facturation",
  cancellation: "Demande de résiliation", commercial: "Demande commerciale", partnership: "Demande de partenariat", callback: "Demande de rappel",
  human_request: "Demande d’assistance humaine", security: "Sécurité", privacy: "Confidentialité",
  data_deletion: "Suppression de données", legal: "Demande juridique", acknowledgement: "Remerciement ou confirmation",
  non_support: "Sollicitation externe",
};

const partnershipDeliveryLabels: Record<SavInboxPartnershipStatus, string> = {
  succeeded: "Déjà transféré à Nathan.",
  uncertain: "Résultat du transfert à Nathan incertain. Vérifier l’envoi dans Gmail avant toute reprise.",
  pending: "Transfert à Nathan en attente. Vérifier son résultat dans le dossier.",
  failed: "Transfert à Nathan non confirmé. Vérifier le dossier avant de préparer un nouvel aperçu.",
};

function suggestedNextAction(input: InboxSummaryInput) {
  const p = input.proposal;
  if (!p) return input.analysisStatus === "pending" || input.analysisStatus === "processing"
    ? "Consulter le message ; l’analyse est en attente."
    : "Lire le message et qualifier la demande manuellement.";
  if (input.reviewStatus === "rejected") return "Corriger le dossier avant de poursuivre.";
  if (p.humanProcess && input.reviewStatus === "approved") {
  if (input.hubspotTicketId) return "Consulter le ticket lié.";
    return ({create_ticket:"Préparer puis confirmer la création du ticket.",link_ticket:"Préparer puis confirmer le rattachement au ticket choisi.",reopen_ticket:"Préparer puis confirmer le retour sur le ticket choisi.",partnership:"Préparer puis confirmer le transfert partenariat.",commercial:"Traiter la demande commerciale selon la règle existante.",no_ticket:"Aucun ticket nécessaire selon le process validé."})[p.humanProcess.action];
  }
  if (input.reviewStatus !== "approved" && p.understanding?.status !== "qualified") return "Vérifier la demande et compléter sa qualification.";
  if (p.decision.kind === "no_ticket_needed") return "Vérifier qu’aucune suite n’est nécessaire.";
  if (["spam", "automatic_reply", "bounce", "internal_notification", "duplicate"].includes(p.decision.kind)) return "Vérifier le classement de cet email.";
  if (["cancellation_human_only", "finance_human_only", "legal_human_only"].includes(p.decision.reasonCode)
    || p.understanding?.requests.some(request => ["cancellation", "financial_operation", "financial_data", "legal"].includes(request.nature))) {
    return input.reviewStatus === "approved" ? "Faire traiter la demande par l’équipe humaine." : "Valider le dossier pour une prise en charge humaine.";
  }
  if (p.understanding?.status === "qualified" && p.understanding.requests.some(request => request.nature === "partnership")) {
    if (!input.partnershipTransferStatus) return "Relire la demande de partenariat et préparer le transfert à Nathan.";
    // A confirmed transfer does not settle another support or financial request.
    if (p.understanding.requests.every(request => ["partnership", "acknowledgement"].includes(request.nature))) return "";
  }
  if (input.analysisErrorCode && input.reviewStatus !== "approved") return "Relire la demande et vérifier la proposition avant toute action.";
  if (input.hubspotTicketId) return "Consulter le ticket lié et vérifier la suite à donner.";
  if (p.routing.kind === "matched") {
    const ticketId = p.routing.ticketId;
    const name = p.dossierContext?.crm.data?.tickets.find(candidate => candidate.id === ticketId)?.subject;
    return name ? `Vérifier le ticket « ${cleanText(name)} » et choisir l’action.` : "Vérifier le ticket HubSpot et choisir l’action.";
  }
  // This routing snapshot predates later CRM refreshes. The dossier chooses the
  // actual operation from its current context when the human opens it.
  if (p.routing.kind === "new") return input.reviewStatus === "approved" ? "Vérifier les tickets existants puis choisir l’action adaptée." : "Valider le dossier puis choisir l’action adaptée au ticket.";
  if (p.routing.kind === "review") return "Vérifier le client et le ticket à utiliser.";
  if (p.replyDraft?.trim()) return "Relire le brouillon avant un éventuel envoi.";
  return "Examiner la demande et décider de la suite à donner.";
}

function nextAction(input: InboxSummaryInput) {
  const delivery = input.partnershipTransferStatus ? partnershipDeliveryLabels[input.partnershipTransferStatus] : "";
  // Keep the outstanding request first in the compact inbox, particularly a
  // financial/cancellation handoff that the internal transfer does not resolve.
  return [suggestedNextAction(input), delivery].filter(Boolean).join(" ");
}

/** Uses the current, already recorded understanding. No generation or write. */
export function buildSavInboxSummary(input: InboxSummaryInput) {
  const p = input.proposal;
  const u = p?.understanding;
  const requests = p?.humanProcess?.understanding.requests ?? (u?.status === "qualified" ? u.requests : []);
  const primary = requests.find(request => request.id === (p?.humanProcess?.understanding.primaryRequestId ?? u?.primaryRequestId));
  const reviewed = input.reviewStatus === "approved" || input.reviewStatus === "rejected";
  const titleCorrected = reviewed && p && input.originalProposal && cleanText(p.ticket.title) !== cleanText(input.originalProposal.ticket.title);
  const descriptionCorrected = reviewed && p && input.originalProposal && cleanText(p.ticket.description) !== cleanText(input.originalProposal.ticket.description);
  const topic = primary?.feature?.trim() ? [...new Set([primary.product, primary.feature].filter((value): value is string => Boolean(value?.trim())).map(cleanText))].join(" · ") : "";
  const title = titleCorrected ? cleanText(p.ticket.title)
    : primary ? topic && requestThemes[primary.nature] ? `${requestThemes[primary.nature]} : ${topic}` : cleanText(primary.summary)
    : savInboxSubject(input.subject);
  const secondary = requests.filter(request => request.id !== primary?.id);
  const problem = descriptionCorrected ? cleanText(p.ticket.description)
    : primary ? [cleanText(primary.summary), ...secondary.map(request => `Autre demande : ${cleanText(request.summary)}`)].join(" ")
    : u?.status === "needs_clarification" ? "La demande reste à clarifier à partir du message."
    : input.analysisStatus === "pending" || input.analysisStatus === "processing" ? "La demande n’a pas encore été analysée."
    : "Aucun résumé fiable disponible. Le message doit être relu.";
  return {
    title,
    problem,
    nextAction: nextAction(input),
    sourceLabel: titleCorrected || descriptionCorrected ? "Dossier corrigé" : input.reviewStatus === "rejected" ? "Synthèse à corriger" : primary ? "Synthèse de la demande" : "Objet de l’email",
    additionalRequests: secondary.length,
  };
}
