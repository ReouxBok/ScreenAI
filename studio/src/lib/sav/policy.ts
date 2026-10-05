import { z } from "zod";

export const HUMAN_SLA_DAYS = 3;
export const FOLLOWUP_DAY_OFFSETS = [2, 5, 10] as const;

export const AI_DISCLOSURE = "Bonjour, je suis Charly, l’assistant IA du SAV Limova.";
export const AI_HANDOFF_NOTICE = "Je peux vous aider immédiatement. Vous pouvez à tout moment demander l’intervention d’un humain ; le délai de traitement est alors de 3 jours.";
export const AI_HANDOFF_CHOICES = "Continuer avec l’IA — réponse instantanée\nTransférer à un humain — délai de 3 jours";

export const decisionKindSchema = z.enum([
  "ticket_pending",
  "ticket_created",
  "attached_to_existing_ticket",
  "no_ticket_needed",
  "spam",
  "internal_notification",
  "automatic_reply",
  "bounce",
  "duplicate",
  "human_review_required",
]);
export type SavDecisionKind = z.infer<typeof decisionKindSchema>;

export type DecisionProposal = {
  kind: SavDecisionKind;
  reasonCode: string;
  explanation: string;
  confidence: number;
  requiresHumanApproval: boolean;
};

export type SavClassificationInput = {
  from: string;
  subject: string;
  body: string;
  autoSubmitted?: string;
  contentType?: string;
};

const humanRequestPatterns = [
  /(?:parler|échanger|discuter)\s+(?:à|avec)\s+(?:un|une)\s+(?:humain|personne|conseiller|conseillère|agent)/i,
  /(?:transf(?:ère|erer|érez)|passez-moi)\s+(?:à|vers)\s+(?:un|une)\s+(?:humain|conseiller|personne)/i,
  /(?:je veux|je souhaite|j['’]aimerais)\s+(?:un|une)\s+(?:humain|conseiller|personne)/i,
  /human\s+(?:agent|support|advisor)/i,
];

const highRiskPatterns = [
  /\b(?:remboursement|rembourser|prélèvement|facturation contestée|double facturation)\b/i,
  /\b(?:piraté|piratage|fraude|fuite de données|sécurité|rgpd|données personnelles)\b/i,
  /\b(?:avocat|juridique|mise en demeure|plainte|tribunal)\b/i,
  /\b(?:supprimer mon compte|effacer mes données|droit à l['’]oubli)\b/i,
  /\b(?:mot de passe|password|otp|code de connexion|2fa|clé api|api key|access token|secret)\b/i,
];

const promptInjectionPatterns = [
  /ignore (?:all|any|the|your) previous instructions/i,
  /oublie (?:toutes|les) instructions précédentes/i,
  /révèle (?:ton|le) prompt système/i,
  /system prompt|developer message|jailbreak/i,
];

export function normalizeEmailAddress(value: string) {
  const angle = String(value || "").match(/<([^>]+)>/);
  return (angle?.[1] ?? value).trim().toLocaleLowerCase("en");
}

export function sanitizeInboundText(value: string) {
  return String(value || "")
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, 100_000);
}

export function containsPromptInjection(value: string) {
  return promptInjectionPatterns.some((pattern) => pattern.test(value));
}

export function requestsHuman(value: string) {
  return humanRequestPatterns.some((pattern) => pattern.test(value));
}

export function humanDueAt(requestedAt: Date, slaDays = HUMAN_SLA_DAYS) {
  return new Date(requestedAt.getTime() + slaDays * 24 * 60 * 60 * 1_000);
}

export function followupDates(from: Date) {
  return FOLLOWUP_DAY_OFFSETS.map((days) => new Date(from.getTime() + days * 24 * 60 * 60 * 1_000));
}

export function ensureAiTransparency(body: string) {
  const cleanBody = String(body || "").trim();
  const withoutDuplicateDisclosure = cleanBody
    .replace(AI_DISCLOSURE, "")
    .replace(AI_HANDOFF_NOTICE, "")
    .replace(AI_HANDOFF_CHOICES, "")
    .trim();
  return [AI_DISCLOSURE, withoutDuplicateDisclosure, AI_HANDOFF_NOTICE, AI_HANDOFF_CHOICES]
    .filter(Boolean)
    .join("\n\n");
}

export function safeSavTriageDraft() {
  return ensureAiTransparency("J’ai bien reçu votre demande. Je commence son analyse et je vous demanderai uniquement les informations nécessaires si le diagnostic doit être précisé.");
}

export function safeSavHumanHandoffDraft() {
  return ensureAiTransparency("J’ai bien reçu votre demande. Par précaution, je ne vais pas avancer de solution non vérifiée et je prépare le dossier pour l’équipe Limova.");
}

export function isTransparentAiReply(body: string) {
  return body.includes(AI_DISCLOSURE)
    && body.includes("réponse instantanée")
    && body.includes("délai de 3 jours")
    && body.includes("Transférer à un humain");
}

export function isSavOutboundRecipientAllowed(
  email: string,
  options: { testMode?: boolean; allowlist?: string } = {},
) {
  const testMode = options.testMode ?? process.env.SAV_TEST_MODE === "true";
  if (!testMode) return true;
  const recipient = normalizeEmailAddress(email);
  const rules = String(options.allowlist ?? process.env.SAV_TEST_OUTBOUND_ALLOWLIST ?? "")
    .split(",")
    .map((rule) => rule.trim().toLocaleLowerCase("en"))
    .filter(Boolean);
  return rules.some((rule) => rule.startsWith("*@")
    ? recipient.endsWith(rule.slice(1))
    : recipient === normalizeEmailAddress(rule));
}

export function assertSavOutboundRecipientAllowed(email: string) {
  if (!isSavOutboundRecipientAllowed(email)) throw new Error("SAV_TEST_OUTBOUND_RECIPIENT_BLOCKED");
}

export function isSavPilotHubspotActionAllowed(kind: string) {
  // A pilot batch is a strict simulation: proposed HubSpot actions are kept in
  // sav.actions for review, but no external mutation is ever authorized.
  void kind;
  return false;
}

export function assertSavPilotReplyApprovalAllowed(pilotBatchId: string | null | undefined) {
  if (pilotBatchId) throw new Error("SAV_PILOT_REPLY_SEND_BLOCKED");
}

export function assertSavTicketStageNotClosed(stageId: string, closedStageIds: ReadonlySet<string>) {
  if (closedStageIds.has(stageId)) throw new Error("SAV_AGENT_CANNOT_RESOLVE_TICKET");
}

export function deterministicDecision(input: SavClassificationInput): DecisionProposal {
  const from = normalizeEmailAddress(input.from);
  const subject = input.subject.trim();
  const body = sanitizeInboundText(input.body);
  const text = `${subject}\n${body}`;
  const autoSubmitted = String(input.autoSubmitted || "").split(";")[0].trim().toLocaleLowerCase("en");
  const deliveryReport = /multipart\/report\s*;[^\n]*report-type\s*=\s*"?delivery-status/i.test(input.contentType ?? "");

  // Never infer a bounce from a phrase quoted in a customer's support request.
  if (/^(?:mailer-daemon|postmaster)@/i.test(from) || deliveryReport) {
    return { kind: "bounce", reasonCode: "delivery_failure", explanation: "Le message est un avis automatique d’échec de distribution ; aucun ticket client n’est créé.", confidence: 990, requiresHumanApproval: false };
  }
  if (["auto-replied", "auto-generated"].includes(autoSubmitted)) {
    return { kind: "automatic_reply", reasonCode: "automated_sender_reply", explanation: "L’en-tête Auto-Submitted indique un message automatique ; il est conservé dans l’audit sans créer de nouveau ticket.", confidence: 980, requiresHumanApproval: false };
  }
  if (autoSubmitted && autoSubmitted !== "no") {
    return { kind: "human_review_required", reasonCode: "unknown_automation_header", explanation: "L’en-tête d’automatisation est inconnu ; la nature du message doit être vérifiée par un humain.", confidence: 300, requiresHumanApproval: true };
  }
  if (/^(?:no-?reply|notifications?)@limova\.ai$/i.test(from)) {
    return { kind: "internal_notification", reasonCode: "limova_system_notification", explanation: "Le message provient d’une adresse technique Limova et ne correspond pas à une demande client.", confidence: 960, requiresHumanApproval: false };
  }
  if (requestsHuman(text)) {
    return { kind: "human_review_required", reasonCode: "customer_requested_human", explanation: "Le client demande explicitement l’intervention d’une personne ; l’automatisation doit être suspendue et le ticket transmis au SAV.", confidence: 995, requiresHumanApproval: true };
  }
  if (containsPromptInjection(text)) {
    return { kind: "human_review_required", reasonCode: "prompt_injection_detected", explanation: "Le message contient des instructions visant le fonctionnement interne de l’IA ; aucune action automatique n’est autorisée.", confidence: 970, requiresHumanApproval: true };
  }
  if (highRiskPatterns.some((pattern) => pattern.test(text))) {
    return { kind: "human_review_required", reasonCode: "sensitive_or_high_risk_request", explanation: "La demande touche à une opération sensible ou engageante et doit être relue par un humain.", confidence: 940, requiresHumanApproval: true };
  }
  if (/\b(?:buy followers|crypto giveaway|seo backlinks)\b/i.test(text)
    && !/\b(?:limova|support|bug|erreur|problem|problème)\b/i.test(text)) {
    return { kind: "spam", reasonCode: "unsolicited_bulk_message", explanation: "Le contenu correspond à une sollicitation commerciale sans rapport apparent avec le SAV ; aucun ticket n’est proposé.", confidence: 900, requiresHumanApproval: false };
  }
  if (!body || /^(?:bonjour|bonsoir|salut|hello|hi)[\s!.]*$/i.test(body)) {
    return { kind: "human_review_required", reasonCode: "insufficient_message_content", explanation: "Le message ne contient pas de demande exploitable ; son contenu et ses éventuelles pièces jointes doivent être vérifiés par un humain.", confidence: 300, requiresHumanApproval: true };
  }
  // Only classify the whole short message, not a 'merci' preceding a new issue.
  if (/^(?:(?:bonjour|bonsoir|hello)[\s,!]*)?(?:merci(?:\s+beaucoup)?(?:\s+pour\s+(?:votre|ton|la)\s+(?:aide|réponse|retour))?|thanks(?:\s+a\s+lot)?|thank\s+you|c['’]est\s+(?:bon|résolu)|tout\s+(?:fonctionne|est\s+bon))(?:[\s,!;.]+(?:bonne\s+journée|à\s+bientôt))?[\s!.]*$/i.test(body)) {
    return { kind: "no_ticket_needed", reasonCode: "simple_acknowledgement", explanation: "Le message est uniquement un remerciement ou une confirmation, sans nouvelle demande ; aucun nouveau ticket n’est proposé.", confidence: 950, requiresHumanApproval: false };
  }
  if (/^(?:absence du bureau|out of office|réponse automatique|automatic reply)(?:\s*[:—-]|$)/i.test(subject)) {
    return { kind: "human_review_required", reasonCode: "unconfirmed_automatic_reply", explanation: "L’objet évoque une réponse automatique, mais aucun en-tête fiable ne le confirme ; une revue humaine est nécessaire.", confidence: 500, requiresHumanApproval: true };
  }
  if (!/\?|\b(?:comment|how|aide|help|bug|erreur|error|problème|problem|impossible|bloqu|fonctionne|facture|invoice|abonnement|subscription|connexion|connecter|intégration|integration|paramètre|résilier|cancel)\b|(?:ne|n['’]).{0,40}(?:pas|plus)/i.test(text)) {
    return { kind: "human_review_required", reasonCode: "ambiguous_inbound_message", explanation: "Aucun signal suffisant ne confirme une demande SAV ; l’humain doit qualifier ce message avant de proposer une action.", confidence: 500, requiresHumanApproval: true };
  }
  return { kind: "ticket_pending", reasonCode: "new_customer_support_request", explanation: "Le message présente une demande potentiellement liée au support ; le dossier HubSpot doit être recherché avant toute proposition de création validée par un humain.", confidence: 820, requiresHumanApproval: false };
}
