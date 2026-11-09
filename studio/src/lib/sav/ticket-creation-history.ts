import { z } from "zod";

// HubSpot's create-record history includes these five activity types, not
// marketing events. IDs are linked; no activity or message is copied/sent.
export const ticketHistoryTypes = ["calls", "emails", "notes", "meetings", "tasks"] as const;
const objectId = z.union([z.string().regex(/^\d{1,30}$/), z.number().int().nonnegative().safe()]).transform(String);
const activityType = z.enum(ticketHistoryTypes);
const activity = z.object({ type: activityType, id: objectId, associationTypeId: z.number().int().positive() });
export const ticketCreationHistorySchema = z.object({
  version: z.literal(1), contactId: objectId, from: z.iso.datetime(), through: z.iso.datetime(),
  activities: z.array(activity).max(2000),
});
export type TicketCreationHistory = z.infer<typeof ticketCreationHistorySchema>;
export type HistoryRead = (path: string, body?: unknown) => Promise<unknown>;
const fail = (): never => { throw Error("SAV_TICKET_HISTORY_INCOMPLETE"); };
const pageSchema = z.object({ results: z.array(z.object({ toObjectId: objectId })),
  paging: z.object({ next: z.object({ after: z.union([z.string().min(1), z.number().safe()]) }) }).optional() });

async function associatedIds(read: HistoryRead, source: "contacts" | "tickets", id: string, type: string) {
  const result = new Set<string>(), cursors = new Set<string>(); let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "500", ...(after ? { after } : {}) });
    const data = pageSchema.parse(await read(`/crm/v4/objects/${source}/${objectId.parse(id)}/associations/${type}?${query}`));
    data.results.forEach(row => result.add(row.toObjectId));
    if (!data.paging?.next) return result;
    after = String(data.paging.next.after);
    if (cursors.has(after)) fail();
    cursors.add(after);
  }
  return fail();
}

/** The selected record in every Studio creation path is the contact. Do not
 * silently extend this to all of its companies (which the ticket did not select).
 * Read all association pages, then select the activities in the 30-day window. Beyond HubSpot's documented
 * 2,000 create-form limit, refuse explicitly rather than silently truncating. */
export async function collectTicketCreationHistory(contactId: string, read: HistoryRead, now = new Date()): Promise<TicketCreationHistory> {
  const through = now.getTime(), from = through - 30 * 24 * 60 * 60 * 1000;
  const selected: Array<z.infer<typeof activity> & { at: number }> = [];
  for (const type of ticketHistoryTypes) {
    const ids = [...await associatedIds(read, "contacts", contactId, type)];
    const dated: Array<{ id: string; at: number }> = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const data = z.object({ status: z.literal("COMPLETE"), errors: z.array(z.unknown()).optional(),
        results: z.array(z.object({ id: objectId, archived: z.boolean().optional(), properties: z.object({ hs_timestamp: z.string().nullable() }) }))
      }).parse(await read(`/crm/v3/objects/${type}/batch/read`, { properties: ["hs_timestamp"], inputs: batch.map(id => ({ id })) }));
      if (data.errors?.length || data.results.length !== batch.length || new Set(data.results.map(r => r.id)).size !== batch.length || data.results.some(r => !batch.includes(r.id))) fail();
      for (const row of data.results) {
        if (row.archived) continue;
        const raw = row.properties.hs_timestamp;
        const at = raw && /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw ?? "");
        if (!Number.isFinite(at)) fail();
        if (at >= from && at <= through) dated.push({ id: row.id, at });
      }
    }
    if (!dated.length) continue;
    const labels = z.object({ results: z.array(z.object({ category: z.string(), typeId: z.number().int().positive(), label: z.string().nullable() })) })
      .parse(await read(`/crm/v4/associations/tickets/${type}/labels`));
    const defaults = labels.results.filter(row => row.category === "HUBSPOT_DEFINED" && row.label === null);
    if (defaults.length !== 1) fail();
    selected.push(...dated.map(row => ({ ...row, type, associationTypeId: defaults[0].typeId })));
  }
  if (selected.length > 2000) throw Error("SAV_TICKET_HISTORY_LIMIT_EXCEEDED");
  selected.sort((a, b) => b.at - a.at || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  return ticketCreationHistorySchema.parse({ version: 1, contactId, from: new Date(from).toISOString(), through: now.toISOString(),
    activities: selected.map(({ at: _at, ...row }) => row) });
}

export function ticketCreationAssociations(history: TicketCreationHistory) {
  const data = ticketCreationHistorySchema.parse(history);
  return [{ to: { id: data.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 16 }] },
    ...data.activities.map(row => ({ to: { id: row.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: row.associationTypeId }] }))];
}

/** Read-back only, including on recovery. A partial provider result is never a
 * successful history copy; no second ticket or resend can repair it implicitly. */
export async function verifyTicketCreationHistory(ticketId: string, history: TicketCreationHistory, read: HistoryRead) {
  const expected = ticketCreationHistorySchema.parse(history);
  for (const type of ticketHistoryTypes) {
    const ids = expected.activities.filter(a => a.type === type).map(a => a.id);
    if (!ids.length) continue;
    const actual = await associatedIds(read, "tickets", ticketId, type);
    if (ids.some(id => !actual.has(id))) return false;
  }
  return true;
}
