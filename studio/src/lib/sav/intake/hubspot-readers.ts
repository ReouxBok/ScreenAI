import { z } from "zod";
import { createSavHubspotTransport, SavCrmReadError, SavCrmLocalReadError, type SavCrmReadDiagnostic } from "../hubspot-transport";
import { assertSavSupportPipeline, SAV_HUBSPOT_SUPPORT } from "../hubspot-mapping";
import {
  intakeContactSchema, intakeHistorySchema, intakeTicketSchema,
  type IntakeAdapters, type IntakeAssociation, type IntakeContact, type IntakeHistory, type IntakeTicket, type ReadResult,
} from "./engine-types";

export const SAV_INTAKE_READERS_REVISION = "sav-intake-hubspot-2026-10-25.v2";
const id = z.union([z.string().regex(/^\d{1,30}$/), z.number().int().nonnegative().safe()]).transform(String);
const recordSchema = z.object({ id, archived: z.boolean().optional(), createdAt: z.string().optional(),
  properties: z.record(z.string(), z.string().nullable()) });
type RecordRow = z.infer<typeof recordSchema>;
const pageSchema = z.object({ results: z.array(z.unknown()), total: z.number().int().nonnegative().optional(),
  status: z.string().optional(), errors: z.array(z.unknown()).optional(),
  paging: z.object({ next: z.object({ after: z.union([z.string(), z.number().safe()]) }) }).optional() });
const associationSchema = z.object({ toObjectId: id, associationTypes: z.array(z.object({
  typeId: z.number().int().nonnegative(), category: z.enum(["HUBSPOT_DEFINED", "USER_DEFINED"]), label: z.string().nullable().optional(),
})).min(1) });
const contactProperties = ["email", "hs_additional_emails"];
const ticketProperties = ["subject", "content", "createdate", "hs_pipeline", "hs_pipeline_stage", "hs_last_closed_date", "closed_date", "hubspot_owner_id"];
const engagementProperties = {
  notes: ["hs_note_body", "hs_timestamp"],
  emails: ["hs_email_text", "hs_email_html", "hs_email_subject", "hs_email_from_email", "hs_email_to_email", "hs_email_direction", "hs_timestamp"],
} as const;
const unique = <T>(values: T[]) => [...new Set(values)];
const address = (value: string) => value.trim().toLowerCase();
const iso = (value: string | undefined | null): string | undefined => {
  if (!value) return undefined;
  const date = /^\d{10,}$/.test(value) ? new Date(Number(value)) : z.iso.datetime({ offset: true }).safeParse(value).success ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
class ReadFault extends SavCrmLocalReadError {}
export type IntakeReadTrace = { operation: string; status: "complete" | "partial" | "failed"; reason: string | null; observedAt: string; requests: number; transport?: SavCrmReadDiagnostic };
export type SavIntakeCrmReaders = Pick<IntakeAdapters, "findContactsByEmail" | "directAssociations" | "getContact" | "ticketsForContact" | "ticketHistory">;

/** An allowlist before the existing transport: no mutation, redirect, arbitrary
 * origin, auth discovery, DB, Gmail or environment access. Authentication belongs
 * to the separately trusted network capability, never to a corpus or model. */
export function isSavIntakeHubspotRead(path: string, method: string): boolean {
  if (!path.startsWith("/") || path.includes("#") || path.includes("\\") || /%(?:2e|2f|5c)/i.test(path)) return false;
  const url = new URL(path, "https://api.hubapi.com");
  if (url.origin !== "https://api.hubapi.com") return false;
  if ([...url.searchParams.keys()].some(key => !["limit", "after", "properties", "archived"].includes(key))) return false;
  if (method === "GET") return /^\/crm\/v3\/objects\/contacts\/\d{1,30}$/.test(url.pathname)
    || /^\/crm\/v3\/pipelines\/tickets\/0$/.test(url.pathname)
    || /^\/crm\/v4\/objects\/(?:contacts\/\d{1,30}\/associations\/(?:contacts|tickets)|tickets\/\d{1,30}\/associations\/(?:contacts|notes|emails))$/.test(url.pathname);
  return method === "POST" && !url.search && /^\/crm\/v3\/objects\/(?:contacts\/search|(?:tickets|notes|emails)\/batch\/read)$/.test(url.pathname);
}

export function createSavIntakeHubspotReaders(options: {
  network: typeof fetch; now?: () => Date; onRead?: (trace: IntakeReadTrace) => void;
  maxPages?: number; maxNetworkRequests?: number;
}): SavIntakeCrmReaders {
  const now = options.now ?? (() => new Date());
  const maxPages = options.maxPages ?? 5, maxRequests = options.maxNetworkRequests ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5 || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) throw Error("SAV_INTAKE_READ_LIMIT_INVALID");
  let requests = 0;
  const transport = createSavHubspotTransport(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.hubapi.com" || !isSavIntakeHubspotRead(url.pathname + url.search, init?.method ?? "GET")) throw Error("SAV_INTAKE_MUTATION_FORBIDDEN");
    if (requests >= maxRequests) throw new ReadFault("partial", "request_limit");
    requests++;
    return options.network(input, { ...init, redirect: "error" });
  });
  async function read(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const method = body === undefined ? "GET" : "POST";
    if (!isSavIntakeHubspotRead(path, method)) throw new ReadFault("failed", "operation_forbidden");
    return transport(path, { method, signal, headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, status => `HUBSPOT_HTTP_${status}`);
  }
  async function wrap<T>(operation: string, empty: T, work: () => Promise<T>): Promise<ReadResult<T>> {
    const observedAt = now().toISOString(), before = requests;
    try {
      const data = await work();
      options.onRead?.({ operation, status: "complete", reason: null, observedAt, requests: requests - before });
      return { status: "complete", data, observedAt };
    } catch (error) {
      const status = error instanceof ReadFault ? error.status : "failed";
      const reason = error instanceof ReadFault ? error.code : error instanceof SavCrmReadError ? error.message : error instanceof Error && /^HUBSPOT_HTTP_\d{3}$/.test(error.message) ? error.message : "read_unavailable";
      options.onRead?.({ operation, status, reason, observedAt, requests: requests - before, ...(error instanceof SavCrmReadError ? { transport: error.diagnostic } : {}) });
      // An incomplete response never becomes an empty successful search.
      return { status, data: empty, observedAt };
    }
  }
  async function pages(path: string, signal: AbortSignal, body?: Record<string, unknown>) {
    const rows: unknown[] = [], seen = new Set<string>(); let after: string | undefined;
    for (let index = 0; index < maxPages; index++) {
      if (signal.aborted) throw new ReadFault("failed", "cancelled");
      const query = new URL(path, "https://api.hubapi.com");
      if (after && !body) query.searchParams.set("after", after);
      const page = pageSchema.parse(await read(query.pathname + query.search, signal, body ? { ...body, ...(after ? { after } : {}) } : undefined));
      if (page.errors?.length || page.status && page.status !== "COMPLETE") throw new ReadFault("partial", "partial_response");
      rows.push(...page.results);
      const next = page.paging?.next ? String(page.paging.next.after) : undefined;
      if (!next) {
        if (page.total !== undefined && rows.length !== page.total) throw new ReadFault("partial", "total_mismatch");
        return rows;
      }
      if (seen.has(next)) throw new ReadFault("partial", "pagination_cycle");
      seen.add(next); after = next;
    }
    throw new ReadFault("partial", "page_limit");
  }
  const associations = async (type: "contacts" | "tickets", sourceId: string, to: "contacts" | "tickets" | "notes" | "emails", signal: AbortSignal) => {
    id.parse(sourceId);
    return (await pages(`/crm/v4/objects/${type}/${sourceId}/associations/${to}?limit=100`, signal)).map(row => associationSchema.parse(row));
  };
  function contact(row: RecordRow): IntakeContact {
    if (row.archived) throw new ReadFault("partial", "archived_contact");
    if (!Object.hasOwn(row.properties, "email") || !Object.hasOwn(row.properties, "hs_additional_emails")) throw new ReadFault("partial", "aliases_unavailable");
    return intakeContactSchema.parse({ id: row.id, emails: unique([row.properties.email ?? "", ...(row.properties.hs_additional_emails ?? "").split(";")].map(address).filter(Boolean)).sort() });
  }
  async function batch(type: "tickets" | "notes" | "emails", ids: string[], properties: readonly string[], signal: AbortSignal) {
    const selected = unique(ids).sort(); if (!selected.length) return [];
    if (selected.length > 100) throw new ReadFault("partial", "batch_limit");
    const page = pageSchema.parse(await read(`/crm/v3/objects/${type}/batch/read`, signal, { inputs: selected.map(id => ({ id })), properties }));
    const rows = page.results.map(row => recordSchema.parse(row));
    if (page.errors?.length || page.status && page.status !== "COMPLETE" || rows.length !== selected.length || new Set(rows.map(r => r.id)).size !== selected.length
      || rows.some(r => !selected.includes(r.id) || r.archived)) throw new ReadFault("partial", "partial_batch");
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }
  return {
    findContactsByEmail: (email, signal) => wrap("email_lookup", [], async () => {
      const value = z.email().parse(address(email));
      const records: RecordRow[] = [];
      // Broad documented search includes secondary addresses. Exact membership,
      // not a substring, is checked after both complete paginated queries.
      for (const query of [{ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value }] }] }, { query: value }]) {
        records.push(...(await pages("/crm/v3/objects/contacts/search", signal, { ...query, properties: contactProperties, limit: 100 })).map(r => recordSchema.parse(r)));
      }
      const found = new Map<string, IntakeContact>();
      for (const row of records) {
        const parsed = contact(row);
        if (found.has(parsed.id) && JSON.stringify(found.get(parsed.id)) !== JSON.stringify(parsed)) throw new ReadFault("partial", "conflicting_contact");
        found.set(parsed.id, parsed);
      }
      const retained = [...found.values()].filter(c => c.emails.includes(value)).sort((a, b) => a.id.localeCompare(b.id));
      if (retained.length > 10) throw new ReadFault("partial", "contact_limit");
      return retained;
    }),
    getContact: (contactId, signal) => wrap("contact", undefined as unknown as IntakeContact, async () => {
      id.parse(contactId); const row = recordSchema.parse(await read(`/crm/v3/objects/contacts/${contactId}?properties=${contactProperties.join(",")}`, signal));
      if (row.id !== contactId) throw new ReadFault("partial", "wrong_contact"); return contact(row);
    }),
    directAssociations: (contactId, signal) => wrap("direct_associations", [], async () => {
      const rows = await associations("contacts", contactId, "contacts", signal);
      const edges: IntakeAssociation[] = rows.flatMap(row => row.associationTypes.map(type => ({ fromContactId: contactId, toContactId: row.toObjectId, typeId: type.typeId, category: type.category })));
      return [...new Map(edges.map(e => [JSON.stringify(e), e])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }),
    ticketsForContact: (contactId, signal) => wrap("contact_tickets", [], async () => {
      const pipeline = await read("/crm/v3/pipelines/tickets/0", signal);
      const definition = z.object({ id: z.string(), stages: z.array(z.object({ id: z.string(), metadata: z.object({ isClosed: z.union([z.string(), z.boolean()]) }) })) }).parse(pipeline);
      assertSavSupportPipeline(definition);
      const linked = await associations("contacts", contactId, "tickets", signal);
      const ids = unique(linked.map(r => r.toObjectId));
      if (ids.length > 20) throw new ReadFault("partial", "ticket_limit");
      const tickets: IntakeTicket[] = [];
      for (const row of await batch("tickets", ids, ticketProperties, signal)) {
        if (z.string().regex(/^\d+$/).parse(row.properties.hs_pipeline) !== SAV_HUBSPOT_SUPPORT.pipelineId) continue;
        const members = unique((await associations("tickets", row.id, "contacts", signal)).map(r => r.toObjectId)).sort();
        if (!members.includes(contactId)) throw new ReadFault("partial", "ticket_membership_conflict");
        const stage = row.properties.hs_pipeline_stage;
        const owner = Object.hasOwn(row.properties, "hubspot_owner_id") ? row.properties.hubspot_owner_id || null : undefined;
        if (!Object.hasOwn(row.properties, "content")) throw new ReadFault("partial", "ticket_content_unavailable");
        tickets.push(intakeTicketSchema.parse({ id: row.id, contactIds: members,
          stage: stage === "1" ? "new" : stage === "4" ? "closed" : ["2", "3"].includes(stage ?? "") ? "open" : "unknown",
          createdAt: iso(row.properties.createdate ?? row.createdAt), closedAt: iso(row.properties.hs_last_closed_date || row.properties.closed_date),
          ...(owner === undefined ? {} : { ownerId: owner }), subject: z.string().parse(row.properties.subject), content: z.string().parse(row.properties.content ?? "") }));
      }
      return tickets;
    }),
    ticketHistory: (ticketId, signal) => wrap("ticket_history", [], async () => {
      const events: IntakeHistory = [];
      for (const type of ["notes", "emails"] as const) {
        const ids = unique((await associations("tickets", ticketId, type, signal)).map(row => row.toObjectId));
        if (ids.length > 100) throw new ReadFault("partial", "history_limit");
        for (const row of await batch(type, ids, engagementProperties[type], signal)) {
          const at = iso(row.properties.hs_timestamp); if (!at) throw new ReadFault("partial", "history_date_unknown");
          const props = row.properties;
          const body = type === "notes" ? props.hs_note_body : props.hs_email_text || props.hs_email_html;
          if (body === undefined || body === null) throw new ReadFault("partial", "history_body_unavailable");
          const text = type === "notes" ? body : JSON.stringify({ from: props.hs_email_from_email, to: props.hs_email_to_email, direction: props.hs_email_direction, subject: props.hs_email_subject, body });
          events.push({ id: `${type}:${row.id}`, kind: type === "notes" ? "note" : "email", at, text });
        }
      }
      return intakeHistorySchema.parse(events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)));
    }),
  };
}
