import { SAV_HUBSPOT_SUPPORT } from "./hubspot-mapping";

/** Acknowledgement is not proof that the remote target still matches dispatch. */
export function assertSavTicketMatchesDispatch(ticket: { id: string; properties: Record<string, string | null>; associations?: Record<string, { results?: Array<{ id: string }> }> }, expected: { ticketId: string; contactId: string; properties: Record<string, string> }) {
  if (!expected.contactId || ticket.id !== expected.ticketId || ticket.properties.hs_pipeline !== SAV_HUBSPOT_SUPPORT.pipelineId
    || !ticket.associations?.contacts?.results?.some(contact => contact.id === expected.contactId)
    || Object.entries(expected.properties).some(([key, value]) => ticket.properties[key] !== value)) throw new Error("SAV_TICKET_ACK_CONTEXT_CHANGED");
}
