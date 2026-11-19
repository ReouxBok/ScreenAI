import type { CaseReplyProposal } from "./case-effects";

export const THREADLESS_ACCESS_DRAFT = "Bonjour,\n\nNous avons reçu votre demande concernant l’accès à Limova. Nous pouvons vous aider à déterminer ce qui bloque la connexion.";

export const THREADLESS_ADMIT_PERMISSION = "admit_case_hubspot_ticket";
export const THREADLESS_SEND_PERMISSION = "send_case_new_thread";
export const THREADLESS_CRM_PERMISSION = "log_case_threadless_email";
export const savV2NewThreadEnabled = (env: Readonly<Record<string, string | undefined>>) => env.SAV_V2_NEW_THREAD === "on";
/**
 * SAV-96 B (Ugo 18/11): `SAV_V2_NEW_THREAD_AUTO=on` lets the V2 decision model write the first mail under the first-mail skill and, when the
 * existing Access auto-reply authority covers it (`SAV_V2_AUTO_REPLY=access` + approver, block switch `auto`), sends it without a click.
 * Absent, empty or any other value: off, today's fixed draft for a person, byte for byte. Never a right by itself.
 */
export const savV2NewThreadAutoEnabled = (env: Readonly<Record<string, string | undefined>>) => savV2NewThreadEnabled(env) && env.SAV_V2_NEW_THREAD_AUTO === "on";

export function threadlessReplyShape(proposal: CaseReplyProposal) {
  return proposal.inboundMessageId === null && proposal.ticketSource?.kind === "hubspot_ticket"
    && /^[a-f0-9]{64}$/.test(proposal.ticketSource.version)
    && /^ticket:[a-f0-9-]{36}$/.test(proposal.triggerEventId)
    && !proposal.questions && !proposal.procedures
    // SAV-96 B: the model's first mail may instead be ONE question (`caseDecisionDraft`); the fixed draft stays an answer.
    && (proposal.purpose === "answer" && !proposal.question || proposal.purpose === "question" && Boolean(proposal.question));
}

export const threadlessReplySubject = (ticketId: string) => `Votre demande d’accès à Limova – ticket ${ticketId}`;
