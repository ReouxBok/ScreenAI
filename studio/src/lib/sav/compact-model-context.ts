import type { SavDossierContext } from "./dossier-context";
import type { SavUnderstandingV1 } from "./understanding";
import type { SavAttachmentInventory, SavAttachmentRead } from "./attachment-contract";
import { savAttachmentContext } from "./attachment-context";

export const SAV_COMPACT_CONTEXT_REVISION = "sav-compact-context-2026-10-19.v2";
export const SAV_COMPACT_CONTEXT_LIMITS = Object.freeze({ bytes: 24_000, currentBytes: 10_000, criticalBytes: 16_000, historyMessages: 6, historyMessageBytes: 1_500, tickets: 6, ticketDescriptionBytes: 700 });
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function clipped(text: string, maximum: number) {
  let value = "", count = 0;
  for (const character of text) {
    const next = new TextEncoder().encode(character).length;
    if (count + next > maximum) break;
    value += character; count += next;
  }
  return { text: value, truncated: value.length !== text.length, originalBytes: new TextEncoder().encode(text).length };
}

/** Explicit allowlist: no raw dossier, CRM properties, owner data or action payloads. */
export function compactSavModelContext(input: {
  current: { messageId: string; sourceId: string; receivedAt: string; subject?: string; text: string };
  expectedCustomerEmail: string;
  understanding: SavUnderstandingV1;
  dossier?: SavDossierContext | null;
  attachmentRead?: SavAttachmentRead | null; attachmentInventory?: SavAttachmentInventory | null;
}) {
  const limits = SAV_COMPACT_CONTEXT_LIMITS, u = input.understanding, dossier = input.dossier;
  const limitations: string[] = [];
  const fail = (code: string) => {
    const result = { contractRevision: SAV_COMPACT_CONTEXT_REVISION, status: "blocked" as const,
      payload: null, limitations: [code], metrics: { serializedBytes: 0, contextTextTokensUpperBound: 0 }, omittedRequestIds: u.requests.map(request => request.id) };
    for (let i = 0; i < 4; i++) { result.metrics.serializedBytes = size(result); result.metrics.contextTextTokensUpperBound = result.metrics.serializedBytes; }
    return result;
  };
  if (size([input.current.subject, input.current.text]) > limits.currentBytes) return fail("current_message_over_budget");
  const identityMatches = Boolean(dossier?.messageId === input.current.messageId && dossier.customerIdentity.email && dossier.customerIdentity.email.toLowerCase() === input.expectedCustomerEmail.toLowerCase());
  if (!identityMatches) {
    if (u.evidence.some(e => e.source === "crm")) return fail("crm_identity_mismatch_in_evidence");
    if (dossier) limitations.push("dossier_identity_mismatch");
  }
  const referenced = new Set([...u.requests, ...u.knownFacts, ...u.attemptedSteps].flatMap(value => value.evidenceIds));
  for (const id of u.customerRelationship?.evidenceIds ?? []) referenced.add(id);
  const evidence = u.evidence.filter(e => referenced.has(e.id));
  if (evidence.length !== referenced.size) return fail("referenced_evidence_missing");
  const understanding = { status: u.status, language: u.language, primaryRequestId: u.primaryRequestId,
    customerRelationship: u.customerRelationship, requests: u.requests, knownFacts: u.knownFacts,
    attemptedSteps: u.attemptedSteps, missingInformation: u.missingInformation, uncertainties: u.uncertainties, evidence };
  const attachments = savAttachmentContext(input.attachmentRead, input.current.messageId, input.attachmentInventory);
  if (evidence.some(e => e.source === "current_attachment" && !attachments.sources.some(s => s.sourceId === e.sourceId))) return fail("attachment_source_unavailable");
  const critical = { current: { messageId: input.current.messageId, sourceId: input.current.sourceId, receivedAt: input.current.receivedAt, subject: input.current.subject, text: input.current.text }, understanding,
    ...(attachments.states.length || attachments.inventory ? { attachments: { states: attachments.states.slice(0, 10), additionalStates: Math.max(0, attachments.states.length - 10), inventory: attachments.inventory, notice: attachments.notice } } : {}) };
  if (size(critical) > limits.criticalBytes) return fail("critical_facts_or_evidence_over_budget");
  if (evidence.length < u.evidence.length) limitations.push("unreferenced_evidence_omitted");
  type Ticket = { sourceId: string; id: string; subject: string; status: string; createdAt?: string | null; closedAt?: string | null; updatedAt?: string | null; description: ReturnType<typeof clipped> };
  const crm = { sourceId: "crm_snapshot", collectedAt: identityMatches ? dossier!.collectedAt : null,
    status: identityMatches ? dossier!.crm.status : "unavailable", errorCode: identityMatches ? dossier!.crm.errorCode : "context_not_confirmed",
    contactFound: identityMatches ? dossier!.crm.data?.contactFound ?? false : false,
    tickets: [] as Ticket[], ticketsOmitted: 0,
    events: [] as Array<{ sourceId: string; ticketId: string; kind: string; occurredAt: string; text: ReturnType<typeof clipped> }> };
  const history: Array<{ sourceId: string; receivedAt: string; direction: string; text: string; truncated: boolean; originalBytes: number }> = [];
  const payload = { ...critical, crm, history };
  if (identityMatches) {
    const tickets = dossier!.crm.data?.tickets ?? [];
    const routing = dossier!.crm.data?.routing;
    const matchedId = routing?.kind === "matched" ? routing.ticketId : null;
    const sorted = [...tickets].sort((a, b) => Number(b.id === matchedId) - Number(a.id === matchedId)
      || (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0) || a.id.localeCompare(b.id));
    for (const ticket of sorted.slice(0, limits.tickets)) {
      const projected: Ticket = { sourceId: `hubspot:ticket:${ticket.id}`, id: ticket.id, subject: ticket.subject, status: ticket.status,
        createdAt: ticket.createdAt, closedAt: ticket.closedAt, updatedAt: ticket.updatedAt,
        description: clipped(ticket.description ?? "", limits.ticketDescriptionBytes) };
      if (size({ ...payload, crm: { ...crm, tickets: [...crm.tickets, projected] } }) > limits.bytes - 1_000) break;
      crm.tickets.push(projected);
      if (projected.description.truncated || ticket.descriptionTruncated) limitations.push("ticket_description_incomplete");
    }
    crm.ticketsOmitted = tickets.length - crm.tickets.length;
    if (crm.ticketsOmitted) limitations.push("additional_ticket_candidates_omitted");
    if (dossier!.crm.status !== "ready") limitations.push("crm_incomplete");
    const crmHistory = dossier!.crm.data?.history;
    for (const event of (crmHistory?.events ?? []).filter(e => e.ticketId === crmHistory?.relevantTicketId).slice(0, 6)) {
      const projected = { sourceId: event.sourceId, ticketId: event.ticketId, kind: event.kind, occurredAt: event.occurredAt, text: clipped(event.text, 1000) };
      if (size({ ...payload, crm: { ...crm, events: [...crm.events, projected] } }) > limits.bytes - 1_000) { limitations.push("crm_history_over_budget"); break; }
      crm.events.push(projected);
      if (event.truncated || projected.text.truncated) limitations.push("crm_history_incomplete");
    }
    if (crmHistory?.limitations.length) limitations.push("crm_history_incomplete");
    const conversation = dossier!.conversation;
    if (conversation?.senderMatchesCustomer && conversation.currentMessageId === input.current.messageId && dossier!.customerIdentity.kind === "sender") {
      const messages = conversation.messages.filter(message => message.id !== input.current.messageId);
      for (const message of messages.slice(-limits.historyMessages).reverse()) {
        const text = clipped(message.text, limits.historyMessageBytes);
        const projected = { sourceId: `message:${message.id}`, receivedAt: message.receivedAt, direction: message.direction,
          ...text, truncated: text.truncated || message.truncated };
        if (size({ ...payload, history: [...history, projected] }) > limits.bytes - 1_000) break;
        history.push(projected);
      }
      history.reverse();
      if (history.length < messages.length || history.some(message => message.truncated) || conversation.historyTruncated) limitations.push("history_incomplete");
    } else if (conversation) limitations.push("history_identity_unconfirmed");
    if (dossier!.otherConversations.length) limitations.push("other_conversation_candidates_not_injected");
  } else limitations.push("crm_unavailable");
  const result = { contractRevision: SAV_COMPACT_CONTEXT_REVISION, status: limitations.length ? "limited" as const : "ready" as const,
    payload, limitations: [...new Set(limitations)], metrics: { serializedBytes: 0, contextTextTokensUpperBound: 0 }, omittedRequestIds: [] as string[] };
  for (let i = 0; i < 4; i++) {
    result.metrics.serializedBytes = size(result);
    result.metrics.contextTextTokensUpperBound = result.metrics.serializedBytes;
  }
  return size(result) > limits.bytes ? fail("context_over_budget") : result;
}
