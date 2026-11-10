import "server-only";
import { z } from "zod";
import { ticketOwnerPort } from "./admission-runtime";

/*
 * Pole A lot 10 (SAV-44), LOCAL / OFF: the HubSpot read behind A's `ticketOwnerPort`, on an INJECTED read transport.
 * This file holds no client, no credential, no host and no fetch: the caller passes the transport (authentication and
 * the network belong to it), and nothing here is wired in production. One GET of one ticket, the owner property only;
 * no URL from outside, no search, no mutation. The answer must be that very ticket, unarchived and well formed; anything
 * else is no reading at all (it throws), never "none". `ticketOwnerPort` keeps the classification (v2 / human / none /
 * unknown) unchanged.
 */

/** A read-only HubSpot GET: resolves to the parsed JSON body of a 2xx answer and THROWS on anything else (403, 404,
 * network, timeout). A 404 is never read as an unowned ticket: it is a failed read. */
export type CaseOwnerReadTransport = (request: Readonly<{ method: "GET"; path: string }>) => Promise<unknown>;

const TICKET_ID = /^[0-9]{1,30}$/;

/** The only request this reader makes, for a valid numeric ticket id. */
export const caseTicketOwnerReadPath = (ticketId: string) => `/crm/v3/objects/tickets/${ticketId}?properties=hubspot_owner_id`;

const ticketSchema = z.object({
  id: z.string(),
  archived: z.boolean().optional(),
  properties: z.record(z.string(), z.string().nullable()),
});

const fault = (code: string): never => { throw Error(`SAV_CASE_OWNER_READ_${code}`); };

/**
 * `readHubspotTicketOwner` for `ticketOwnerPort`. Same convention as V1's ticket reader (`hubspot-readers.ts`): the
 * owner property present and null or empty is an explicit "no owner" (null); the property missing from a valid
 * answer is not read (undefined, unknown). A wrong or non-numeric id is refused before any transport; a transport
 * error, an answer for another ticket, an archived ticket or a malformed body throws.
 */
export function hubspotTicketOwnerReader(transport: CaseOwnerReadTransport) {
  if (typeof transport !== "function") fault("TRANSPORT_REQUIRED");
  return async (ticketId: string): Promise<string | null | undefined> => {
    if (typeof ticketId !== "string" || !TICKET_ID.test(ticketId)) fault("TICKET_INVALID");
    const body = await transport({ method: "GET", path: caseTicketOwnerReadPath(ticketId) });
    const parsed = ticketSchema.safeParse(body);
    if (!parsed.success) return fault("RESPONSE_INVALID");
    if (parsed.data.id !== ticketId) fault("TICKET_MISMATCH");
    if (parsed.data.archived !== false && parsed.data.archived !== undefined) fault("TICKET_ARCHIVED");
    if (!Object.hasOwn(parsed.data.properties, "hubspot_owner_id")) return undefined;
    return parsed.data.properties.hubspot_owner_id || null;
  };
}

/** A's `ticketOwnerPort` on this reader. `env` is required (the V2 owner it names is read from it, never from the
 * process environment by default); the transport too. */
export function caseTicketOwnerPortFromTransport(input: { transport: CaseOwnerReadTransport; env: Record<string, string | undefined> }) {
  if (typeof input?.env !== "object" || input.env === null) fault("ENV_REQUIRED");
  return ticketOwnerPort({ readHubspotTicketOwner: hubspotTicketOwnerReader(input.transport), env: input.env });
}
