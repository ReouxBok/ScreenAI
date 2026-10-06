import { z } from "zod";
import { savActiveSubject, savNonSupportIntent, splitSavMessageText } from "./message-context";
import { cleanSavModelDraft, isSavAiAuthoredReply, LEGACY_AI_CHOICES, LEGACY_AI_DISCLOSURE, LEGACY_AI_NOTICE, renderSavOutboundReply } from "./reply-format";

export const HUMAN_SLA_DAYS = 3;
export const FOLLOWUP_DAY_OFFSETS = [2, 5, 10] as const;

export const AI_DISCLOSURE = LEGACY_AI_DISCLOSURE;
export const AI_HANDOFF_NOTICE = LEGACY_AI_NOTICE;
export const AI_HANDOFF_CHOICES = LEGACY_AI_CHOICES;

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

/** Cancellation is an internal human dossier, not an AI response procedure. */
export function isSavCancellationRequest(input: Pick<SavClassificationInput, "subject" | "body">) {
  const text = `${savActiveSubject(input)}\n${splitSavMessageText(input.body).currentText}`.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  if (/\b(?:resiliation|resili(?:er|e|ee|ez|ons)|desabonn(?:ement|er|e|ez)|unsubscribe)\b/.test(text)) return true;
  if (/\b(?:ne (?:veux|souhaite) plus|arreter|mettre fin|stop|end|terminate)\b.{0,80}\b(?:abonnement|subscription|membership|payer|paying)\b/.test(text)) return true;
  return /\b(?:annul(?:er|ation|e|ez)|cancel(?:lation|ling|ing|led)?|terminate|termination)\b/.test(text)
    && /\b(?:abonnement|subscription|membership)\b/.test(text);
}

/** Financial operations/data are human-only. Product navigation is not finance. */
export function isSavFinancialRequest(input: Pick<SavClassificationInput, "subject" | "body">) {
  const text = `${savActiveSubject(input)}\n${splitSavMessageText(input.body).currentText}`.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  // These signals always win, even in a mixed phone-bug/refund request.
  if (/\b(?:rembours\w*|refund\w*|prelev\w*|debite\w*|debit|paiement\w*|payment\w*|paye\w*|paying|paid|montant\w*|amount\w*|transaction\w*|bancaire\w*|bank\w*|rib|iban|tva|vat|tax\w*|prix|price\w*|tarif\w*|cout\w*|cost\w*|conteste\w*|contestation\w*|chargeback\w*|charged|overcharg\w*|recharg\w*|top[ -]?up|racheter|acheter des credits|buy credits)\b|\d\s*(?:€|\$|euros?\b|dollars?\b|eur\b|usd\b)/.test(text)) return true;
  if (/\b(?:financ\w*|chiffre d['’]affaires|revenus?|revenue|double facturation|un avoir|credit note)\b|(?:ete|suis|was|being)\s+factur\w*/.test(text)) return true;
  const invoice = /\b(?:factures?|invoices?)\b/.test(text);
  const invoiceNavigation = invoice && /\b(?:retrouver|trouver|telecharger|consulter|acceder|ou|where|find|download|access|view)\b/.test(text);
  if (invoice && !invoiceNavigation) return true;
  const phone = /\b(?:telephon\w*|telephone|tel|appels?|calling|calls?|phone)\b/.test(text);
  const technical = /\b(?:bug\w*|erreur\w*|error\w*|bloqu\w*|fail\w*|broken|not working|doesn['’]?t work|(?:marche|fonctionne) (?:pas|plus))\b|(?:ne|n['’]).{0,40}(?:pas|plus)/.test(text);
  if (phone && technical) return false;
  if (/\b(?:credits?|solde|balance)\b/.test(text)) return true;
  if (invoiceNavigation) return false;
  return /\b(?:facturation|billing)\b/.test(text);
}

export function humanDueAt(requestedAt: Date, slaDays = HUMAN_SLA_DAYS) {
  return new Date(requestedAt.getTime() + slaDays * 24 * 60 * 60 * 1_000);
}

export function followupDates(from: Date) {
  return FOLLOWUP_DAY_OFFSETS.map((days) => new Date(from.getTime() + days * 24 * 60 * 60 * 1_000));
}

export function ensureAiTransparency(body: string) {
  return renderSavOutboundReply(cleanSavModelDraft(body));
}

export function safeSavTriageDraft(language: "fr" | "en" | "unknown" = "fr") {
  return language === "en" ? "Hello, thank you for your message. Could you describe the issue and any error message you see?"
    : "Bonjour, merci pour votre message. Pouvez-vous préciser le problème rencontré et le message d’erreur éventuel ?";
}

export function safeSavHumanHandoffDraft(language: "fr" | "en" | "unknown" = "fr") {
  return language === "en" ? "Hello, thank you for your message. Your request needs a review by the Limova team before a reliable answer can be provided."
    : "Bonjour, merci pour votre message. Votre demande nécessite une vérification par l’équipe Limova avant de pouvoir vous apporter une réponse fiable.";
}

export function safeSavFinanceDraft(language: "fr" | "en" | "unknown" = "fr") {
  return language === "en" ? "Hello, thank you for your message. Financial matters are handled by the Limova team. A human review is needed to answer your request."
    : "Bonjour, merci pour votre message. Les questions financières sont traitées par l’équipe Limova. Une vérification humaine est nécessaire pour répondre à votre demande.";
}

export function isTransparentAiReply(body: string) {
  return isSavAiAuthoredReply(body);
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
  const subject = savActiveSubject(input).trim();
  const body = splitSavMessageText(sanitizeInboundText(input.body)).currentText;
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
  const nonSupport = savNonSupportIntent(input);
  if (nonSupport) {
    return { kind: "human_review_required", reasonCode: `${nonSupport}_review`,
      explanation: "Ce message est une sollicitation, une vérification d’expéditeur ou un historique sans nouvelle demande exploitable. Qualifier manuellement sans demander d’identité Limova ni préparer de réponse IA.",
      confidence: 700, requiresHumanApproval: true };
  }
  if (isSavCancellationRequest(input)) {
    return { kind: "human_review_required", reasonCode: "cancellation_human_only", explanation: "La demande de résiliation est réservée à l’équipe humaine. Préparer le dossier interne sans proposer de réponse IA, même un accusé de réception.", confidence: 995, requiresHumanApproval: true };
  }
  if (isSavFinancialRequest(input)) {
    return { kind: "human_review_required", reasonCode: "finance_human_only", explanation: "Les données et opérations financières sont réservées à l’équipe humaine. Proposer seulement un ticket dans la catégorie facturation et un brouillon standard sans diagnostic ni engagement financier.", confidence: 995, requiresHumanApproval: true };
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
  if (!/\?|\b(?:comment|how|aide|help|bug|erreur|error|problème|problem|impossible|bloqu|fonctionne|facture|invoice|abonnement|subscription|connexion|connecter|intégration|integration|paramètre|résilier|cancel)\b|(?:ne|n['’]).{0,40}(?:pas|plus)|(?:marche|fonctionne).{0,20}(?:pas|plus)|not working/i.test(text)) {
    return { kind: "human_review_required", reasonCode: "ambiguous_inbound_message", explanation: "Aucun signal suffisant ne confirme une demande SAV ; l’humain doit qualifier ce message avant de proposer une action.", confidence: 500, requiresHumanApproval: true };
  }
  return { kind: "ticket_pending", reasonCode: "new_customer_support_request", explanation: "Le message présente une demande potentiellement liée au support ; le dossier HubSpot doit être recherché avant toute proposition de création validée par un humain.", confidence: 820, requiresHumanApproval: false };
}
