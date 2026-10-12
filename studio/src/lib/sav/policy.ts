import { z } from "zod";
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
  // Business meaning is established by the versioned semantic contract, never by
  // a keyword. This is only a technical preflight, not a successful AI analysis.
  return { kind: "ticket_pending", reasonCode: "semantic_understanding_required", explanation: "La demande courante doit être comprise avant de proposer une catégorie ou une réponse.", confidence: 0, requiresHumanApproval: false };
}
