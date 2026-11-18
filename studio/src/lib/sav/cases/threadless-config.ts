import type { CaseReplyProposal } from "./case-effects";

export const THREADLESS_ACCESS_DRAFT = "Bonjour,\n\nNous avons reçu votre demande concernant l’accès à Limova. Nous pouvons vous aider à déterminer ce qui bloque la connexion.";

export const THREADLESS_ADMIT_PERMISSION = "admit_case_hubspot_ticket";
export const THREADLESS_SEND_PERMISSION = "send_case_new_thread";
export const THREADLESS_CRM_PERMISSION = "log_case_threadless_email";
export const savV2NewThreadEnabled = (env: Readonly<Record<string, string | undefined>>) => env.SAV_V2_NEW_THREAD === "on";

export function threadlessReplyShape(proposal: CaseReplyProposal) {
  return proposal.inboundMessageId === null && proposal.ticketSource?.kind === "hubspot_ticket"
    && /^[a-f0-9]{64}$/.test(proposal.ticketSource.version)
    && /^ticket:[a-f0-9-]{36}$/.test(proposal.triggerEventId)
    && proposal.purpose === "answer" && !proposal.question && !proposal.questions && !proposal.procedures;
}

export const threadlessReplySubject = (ticketId: string) => `Votre demande d’accès à Limova – ticket ${ticketId}`;
