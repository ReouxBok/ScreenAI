import { createHash } from "node:crypto";
import { savIntakeCanonicalEvidence, savIntakeEvidenceContentHash } from "./engine";
import type { IntakeAdapters, IntakePlan, ReadResult } from "./engine-types";
import type { CrmSnapshot } from "./execution-types";

/** CRM evidence of an analysis, re-read the way the executor re-reads it. */
export type CrmEvidenceCategory = "lookup" | "associations" | "association" | "contact" | "ticket_list" | "ticket" | "history";
type Evidence = IntakePlan["decision"]["evidence"][number];
export function executionEvidenceValue(e: Evidence, s: CrmSnapshot): { category: CrmEvidenceCategory; value: unknown } | null {
  if (e.id === "email-lookup") return { category: "lookup", value: { address: s.address, status: "complete", contacts: s.lookup, reconstructedAsOf: undefined } };
  if (e.id === "association-search") return { category: "associations", value: [...s.associations].sort((a, b) => savIntakeCanonicalEvidence(a).localeCompare(savIntakeCanonicalEvidence(b))) };
  if (e.source === "crm_contact" && e.id.startsWith("contact-")) return { category: "contact", value: s.contacts[e.sourceId] };
  if (e.source === "crm_ticket" && /^(?:ticket|identity)-search-/.test(e.id)) return { category: "ticket_list", value: s.tickets[e.sourceId.replace(/^search-/, "")] };
  if (e.source === "crm_ticket") return { category: "ticket", value: Object.values(s.tickets).flat().find(t => t.id === e.sourceId) };
  if (e.source === "crm_event") return { category: "history", value: s.histories[e.sourceId] };
  if (e.source === "contact_association") return { category: "association", value: s.associations.find(a => `${a.fromContactId}:${a.toContactId}:${a.typeId}` === e.sourceId) };
  return null;
}

/** No customer text leaves this projection: bodies, subjects, contents and email
 * addresses become digests; identifiers, owner, stage and dates stay comparable. */
const digest = (value: unknown) => value === undefined ? "absent" : createHash("sha256").update(savIntakeCanonicalEvidence(value)).digest("base64url").slice(0, 22);
type Row = Record<string, unknown>;
const ticket = (t: Row) => ({ id: t.id, contactIds: t.contactIds, ownerId: Object.hasOwn(t, "ownerId") ? t.ownerId : "absent", stage: t.stage, createdAt: t.createdAt ?? null,
  closedAt: t.closedAt ?? null, subject: digest(t.subject), content: digest(t.content) });
const contact = (c: Row) => ({ id: c.id, emails: digest(c.emails) });
export function projectCrmEvidence(category: CrmEvidenceCategory, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (category === "ticket") return ticket(value as Row);
  if (category === "ticket_list") return (value as Row[]).map(ticket);
  if (category === "contact") return contact(value as Row);
  if (category === "history") return (value as Row[]).map(e => ({ id: e.id, kind: e.kind, at: e.at, text: digest(e.text) }));
  if (category === "lookup") { const l = value as Row; return { address: digest(l.address), contacts: (l.contacts as Row[]).map(contact) }; }
  return value;
}

export type CrmEvidenceFingerprint = { version: 1; entries: Record<string, { category: CrmEvidenceCategory; projection: unknown }> };
/** Only evidence whose re-read value has exactly the analysed hash is kept; anything
 * else stays unknown rather than reconstructed. */
export function intakeCrmEvidenceFingerprint(plan: IntakePlan, snapshots: readonly CrmSnapshot[]): CrmEvidenceFingerprint {
  const entries: CrmEvidenceFingerprint["entries"] = {};
  for (const e of plan.decision.evidence) for (const s of snapshots) {
    const read = executionEvidenceValue(e, s);
    if (!read || read.value === undefined || savIntakeEvidenceContentHash(read.value) !== e.contentHash) continue;
    entries[e.id] = { category: read.category, projection: projectCrmEvidence(read.category, read.value) };
    break;
  }
  return { version: 1, entries };
}

/** Named differences between two projections of the same evidence, at most 20. */
export function crmProjectionFields(category: CrmEvidenceCategory, before: unknown, after: unknown): string[] {
  if (savIntakeCanonicalEvidence(before) === savIntakeCanonicalEvidence(after)) return [];
  if (before === null || after === null) return [`${category}.missing`];
  const byId = (rows: unknown) => new Map((rows as Row[]).map(r => [String(r.id), r]));
  const fields = new Set<string>();
  const compare = (prefix: string, a: Row, b: Row) => { for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (savIntakeCanonicalEvidence(a[key]) !== savIntakeCanonicalEvidence(b[key])) fields.add(`${prefix}.${key}`); };
  if (category === "ticket" || category === "contact") compare(category, before as Row, after as Row);
  else if (category === "ticket_list" || category === "history") {
    const prefix = category === "history" ? "history" : "ticket", a = byId(before), b = byId(after);
    for (const id of a.keys()) if (!b.has(id)) fields.add(`${prefix}.removed`);
    for (const [id, row] of b) if (!a.has(id)) fields.add(category === "history" ? `history.added_${row.kind === "note" ? "note" : "email"}` : "ticket.added");
    for (const [id, row] of a) if (b.has(id)) compare(prefix, row, b.get(id)!);
  } else if (category === "lookup") {
    const a = before as Row, b = after as Row;
    if (a.address !== b.address) fields.add("lookup.address");
    if (savIntakeCanonicalEvidence(a.contacts) !== savIntakeCanonicalEvidence(b.contacts)) fields.add("lookup.contacts");
  } else fields.add(category);
  return [...fields].sort().slice(0, 20);
}

type CrmReaders = Pick<IntakeAdapters, "findContactsByEmail" | "directAssociations" | "getContact" | "ticketsForContact" | "ticketHistory">;
/** Records complete reads of one analysis (bounded) so its CRM evidence can be
 * fingerprinted afterwards. Reads are passed through unchanged. */
export function recordIntakeCrmReads<T extends CrmReaders>(readers: T) {
  const lookups = new Map<string, CrmSnapshot["lookup"]>(), edges = new Map<string, CrmSnapshot["associations"]>();
  const base: Omit<CrmSnapshot, "address" | "lookup" | "associations"> = { contacts: {}, tickets: {}, histories: {} };
  let recorded = 0;
  const keep = <V>(result: ReadResult<V>, store: (data: V) => void) => { if (result.status === "complete" && recorded++ < 200) store(result.data); return result; };
  const wrapped: T = { ...readers,
    findContactsByEmail: async (email, signal) => keep(await readers.findContactsByEmail(email, signal), data => { lookups.set(email.trim().toLowerCase(), data); for (const c of data) base.contacts[c.id] ??= c; }),
    directAssociations: async (id, signal) => keep(await readers.directAssociations(id, signal), data => { edges.set(id, data); }),
    getContact: async (id, signal) => keep(await readers.getContact(id, signal), data => { base.contacts[id] = data; }),
    ticketsForContact: async (id, signal) => keep(await readers.ticketsForContact(id, signal), data => { base.tickets[id] = data; }),
    ticketHistory: async (id, signal) => keep(await readers.ticketHistory(id, signal), data => { base.histories[id] = data; }),
  };
  // The executor reads associations of the primary contact only: one candidate per source.
  return { readers: wrapped, snapshots: (): CrmSnapshot[] => [...lookups].flatMap(([address, lookup]) =>
    [...(edges.size ? [...edges.values()] : [[]])].map(associations => ({ address, lookup, associations, ...base }))) };
}
