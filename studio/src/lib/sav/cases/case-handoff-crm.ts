// V2 human handoff notice (local, OFF): the CRM reading that lets a notice show a contact link and a ticket link only when HubSpot confirms them. Read-only by
// construction: three requests, GET for the ticket and its associations and POST only on the documented `batch/read`, on the api.hubapi.com origin, no redirect.
// The token comes from the injected environment; the network is injected (a test answers with synthetic JSON, nothing here opens a socket of its own).
// A reading that cannot be completed THROWS (the pass waits and reads again); it is never turned into « no contact », which would hide a real relation.
import type { HandoffCrmReading } from "./case-handoff-notice";

const API = "https://api.hubapi.com";
const ID = /^[0-9]{1,30}$/;
const TIMEOUT_MS = 10_000;
const CONTACT_LIMIT = 50;

export type HandoffCrmReader = (input: Readonly<{ ticketId: string }>, signal: AbortSignal) => Promise<HandoffCrmReading>;
export type HandoffCrmDeps = Readonly<{ network: typeof fetch; env: () => Record<string, string | undefined> }>;
const fault = (code: string): never => { throw new Error(code); };

/** The only requests this module may make. */
export function isHandoffCrmRead(path: string, method: string): boolean {
  if (method === "GET") return /^\/crm\/v3\/objects\/tickets\/[0-9]{1,30}$/.test(path) || /^\/crm\/v4\/objects\/tickets\/[0-9]{1,30}\/associations\/contacts$/.test(path);
  return method === "POST" && path === "/crm/v3/objects/contacts/batch/read";
}

export function createHandoffCrmReader(deps: HandoffCrmDeps): HandoffCrmReader {
  return async ({ ticketId }, signal) => {
    if (!ID.test(ticketId)) return fault("SAV_HANDOFF_CRM_TICKET_INVALID");
    const token = deps.env().HUBSPOT_ACCESS_TOKEN;
    if (!token) return fault("SAV_HANDOFF_CRM_TOKEN_MISSING");
    async function request(method: "GET" | "POST", path: string, query: Record<string, string> = {}, body?: unknown) {
      if (!isHandoffCrmRead(path, method)) return fault("SAV_HANDOFF_CRM_REQUEST_FORBIDDEN");
      const url = new URL(path, API);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      let response: Response;
      try {
        response = await deps.network(url.toString(), { method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch { return fault("SAV_HANDOFF_CRM_UNREADABLE"); }
      return response;
    }
    const readJson = async (response: Response): Promise<Record<string, unknown>> => {
      try { const value = await response.json() as unknown; if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* below */ }
      return fault("SAV_HANDOFF_CRM_UNREADABLE");
    };

    const ticketResponse = await request("GET", `/crm/v3/objects/tickets/${ticketId}`, { properties: "subject", archived: "false" });
    if (ticketResponse.status === 404) return { ticket: null, contacts: [] };
    if (ticketResponse.status !== 200) return fault("SAV_HANDOFF_CRM_UNREADABLE");
    const ticket = await readJson(ticketResponse);
    if (ticket.id !== ticketId) return { ticket: null, contacts: [] };
    const found = { id: ticketId, archived: ticket.archived === true };

    const associations = await request("GET", `/crm/v4/objects/tickets/${ticketId}/associations/contacts`, { limit: String(CONTACT_LIMIT) });
    if (associations.status !== 200) return fault("SAV_HANDOFF_CRM_UNREADABLE");
    const edges = await readJson(associations);
    const paging = edges.paging as { next?: unknown } | undefined;
    // More contacts than one page: the match cannot be proven unique from a part of the list.
    if (!Array.isArray(edges.results) || paging?.next) return fault("SAV_HANDOFF_CRM_UNREADABLE");
    const ids = [...new Set((edges.results as Array<{ toObjectId?: unknown }>).map(edge => String(edge?.toObjectId ?? "")))].filter(id => ID.test(id));
    if (!ids.length) return { ticket: found, contacts: [] };

    const batch = await request("POST", "/crm/v3/objects/contacts/batch/read", {}, { properties: ["firstname", "lastname", "email", "hs_additional_emails"], inputs: ids.map(id => ({ id })) });
    if (batch.status !== 200 && batch.status !== 207) return fault("SAV_HANDOFF_CRM_UNREADABLE");
    const read = await readJson(batch);
    if (read.status !== "COMPLETE" || !Array.isArray(read.results) || (Array.isArray(read.errors) && read.errors.length)) return fault("SAV_HANDOFF_CRM_UNREADABLE");
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    const contacts = (read.results as Array<{ id?: unknown; archived?: unknown; properties?: Record<string, unknown> }>).flatMap(row => {
      if (typeof row?.id !== "string" || !ids.includes(row.id) || !row.properties) return [];
      const extra = text(row.properties.hs_additional_emails)?.split(/[;,\s]+/).filter(Boolean) ?? [];
      return [{ id: row.id, firstname: text(row.properties.firstname), lastname: text(row.properties.lastname), emails: [text(row.properties.email), ...extra].filter((email): email is string => email !== null), archived: row.archived === true }];
    });
    // A contact that was named by the association and did not come back is a gap in the reading, not an absence.
    if (contacts.length !== ids.length) return fault("SAV_HANDOFF_CRM_UNREADABLE");
    return { ticket: found, contacts };
  };
}
