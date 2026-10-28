import { createHash } from "node:crypto";
import { z } from "zod";
import { savIntakeCanonicalEvidence, savIntakeEvidenceContentHash } from "./engine";
import type { CrmSnapshot, Effect, EffectIntent } from "./execution-types";
import type { IntakePlan, IntakeAdapters, ReadResult } from "./engine-types";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import { crmProjectionFields, executionEvidenceValue, projectCrmEvidence, type CrmEvidenceCategory, type CrmEvidenceFingerprint } from "./crm-evidence-fingerprint";
// An incomplete read or an unproven address is not a CRM mutation: distinct codes.
const value = <T>(r: ReadResult<T>): T => {
    if (r.status !== "complete")
        throw Error("SAV_INTAKE_EXECUTION_CRM_READ_INCOMPLETE");
    return r.data;
};
function retainedAddress(plan: IntakePlan, input: unknown) {
    const i = input as {
        message?: {
            fromEmail?: string;
            currentText?: string;
        };
        conversation?: {
            data?: {
                fromEmail: string;
                currentText: string;
                direction: string;
            }[];
        };
    };
    const current = i.message;
    if (!current?.fromEmail)
        throw Error("SAV_INTAKE_EXECUTION_ADDRESS_PROOF_UNRESOLVED");
    const texts = [current.currentText ?? "", ...(i.conversation?.data ?? []).filter(m => m.direction === "inbound" && m.fromEmail === current.fromEmail).map(m => m.currentText)];
    const candidates = [current.fromEmail, ...texts.flatMap(t => t.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? [])].map(e => e.toLowerCase());
    const source = plan.decision.evidence.find(e => e.id === "email-lookup")?.sourceId;
    const matches = [...new Set(candidates)].filter(e => z.email().safeParse(e).success && source === `lookup-${createHash("sha256").update(e).digest("base64url")}`);
    if (matches.length !== 1)
        throw Error("SAV_INTAKE_EXECUTION_ADDRESS_PROOF_UNRESOLVED");
    return matches[0];
}
export async function collectExecutionCrm(plan: IntakePlan, input: unknown, config: IntakeRuntimeConfig, readers: Pick<IntakeAdapters, "findContactsByEmail" | "directAssociations" | "getContact" | "ticketsForContact" | "ticketHistory">, signal: AbortSignal): Promise<CrmSnapshot> {
    const address = retainedAddress(plan, input), lookup = value(await readers.findContactsByEmail(address, signal));
    const snap: CrmSnapshot = {
        address, lookup, contacts: {}, associations: [], tickets: {}, histories: {}
    };
    const d = plan.decision.disposition;
    const primary = d.kind === "ticket" ? d.contactScope.primaryContactId : null;
    if (primary) {
        snap.associations = value(await readers.directAssociations(primary, signal));
        if (snap.associations.some(a => a.fromContactId !== primary || !config.policy.admittedRelations.some(r => r.category === a.category && r.typeId === a.typeId)))
            throw Error("SAV_INTAKE_EXECUTION_ASSOCIATION_INCOMPLETE");
    }
    const ids = [...new Set([...lookup.map(c => c.id), ...(d.kind === "ticket" ? d.contactScope.contacts.map(c => c.contactId) : []), ...snap.associations.map(a => a.toContactId)])].sort();
    if (ids.length > 20)
        throw Error("SAV_INTAKE_EXECUTION_CRM_READ_CONTACT_LIMIT");
    for (const id of ids) {
        snap.contacts[id] = value(await readers.getContact(id, signal));
        snap.tickets[id] = value(await readers.ticketsForContact(id, signal));
        for (const ticket of snap.tickets[id])
            if (!Object.hasOwn(snap.histories, ticket.id))
                snap.histories[ticket.id] = value(await readers.ticketHistory(ticket.id, signal));
    }
    return snap;
}
export function executionScopeKeys(s: CrmSnapshot, threadId: string, ticketId?: string | null) { return [...new Set([`thread:${threadId}`, `email:${s.address.toLowerCase()}`, ...Object.keys(s.contacts).map(id => `contact:${id}`), ...s.associations.flatMap(a => [`contact:${a.fromContactId}`, `contact:${a.toContactId}`]), ...(ticketId ? [`ticket:${ticketId}`] : [])])].sort(); }
const categoryField: Record<CrmEvidenceCategory, string> = { lookup: "lookup", associations: "associations", association: "associations", contact: "contacts", ticket_list: "tickets", ticket: "tickets", history: "histories" };
const crmIds = (ids: string[], pattern: RegExp) => [...new Set(ids.filter(id => pattern.test(id)))].sort().slice(0, 20);
const historyIds = (before: unknown, after: unknown) => {
    const ids = (rows: unknown) => new Map((Array.isArray(rows) ? rows : []).map((r: { id: string }) => [r.id, savIntakeCanonicalEvidence(r)]));
    const a = ids(before), b = ids(after);
    return [...a.keys(), ...b.keys()].filter(id => a.get(id) !== b.get(id));
};
/** First check against the analysis: same refusal as before, now with the evidence
 * concerned and, when the analysis fingerprint exists, the named fields. Without it
 * the detail stays explicitly unknown (fieldsKnown false), never reconstructed. */
export function assertOriginalExecutionCrm(plan: IntakePlan, s: CrmSnapshot, original?: CrmEvidenceFingerprint) {
    const evidence: NonNullable<CrmDeltaDiagnostic["evidence"]> = [], fields = new Set<string>(), eventIds: string[] = [], ticketIds: string[] = [], current: unknown[] = [];
    const ignored: { fields: string[]; ticketIds: string[]; eventIds: string[] }[] = [];
    let fieldsKnown = true;
    for (const e of plan.decision.evidence) {
        const read = executionEvidenceValue(e, s);
        if (!read || read.value !== undefined && savIntakeEvidenceContentHash(read.value) === e.contentHash)
            continue;
        const known = original?.entries[e.id], now = projectCrmEvidence(read.category, read.value);
        const named = known?.category === read.category ? crmProjectionFields(read.category, known.projection, now) : null;
        const ids = ["ticket", "ticket_list", "history"].includes(read.category) && read.category !== "ticket_list" ? [e.sourceId] : [];
        // Choice rule (Ugo, 27/10): history and owner never alter the choice; traced, not refused.
        if (read.value !== undefined && (read.category === "history" || named && named.length && named.every(crmChoiceIrrelevant))) {
            ignored.push({ fields: [categoryField[read.category], ...(named ?? [])], ticketIds: crmIds(ids, /^\d{1,30}$/), eventIds: read.category === "history" && known ? crmIds(historyIds(known.projection, now), /^(?:emails|notes):\d{1,30}$/) : [] });
            continue;
        }
        evidence.push({ id: e.id, category: read.category, state: read.value === undefined ? "missing" : "changed" });
        current.push(read.value ?? null);
        fields.add(categoryField[read.category]);
        ticketIds.push(...ids);
        if (!named) { fieldsKnown = false; continue; }
        for (const field of named) fields.add(field);
    }
    if (!evidence.length)
        return ignored;
    throw new IntakeCrmDeltaError(withClass({ stage: "original", reason: "original_evidence_changed", ticketIds: crmIds(ticketIds, /^\d{1,30}$/), eventIds: crmIds(eventIds, /^(?:emails|notes):\d{1,30}$/),
        baselineHash: savIntakeEvidenceContentHash(evidence.map(e => plan.decision.evidence.find(x => x.id === e.id)!.contentHash)), currentHash: savIntakeEvidenceContentHash(current),
        fields: [...fields].sort().slice(0, 20), evidence: evidence.slice(0, 20), fieldsKnown, truncated: evidence.length > 20 || fields.size > 20 }));
}
/** Choice rule (Ugo, 27/10): only a change that can alter the choice of customer or ticket
 * matters. History (notes, emails, HubSpot's own logging) and the owner never do. */
export type ExecutionContinuation = { finalizing?: boolean; nextKind?: EffectIntent["kind"]; targetTicketId?: string | null };
export const CRM_DELTA_REASONS = ["unrecognized_added_email", "snapshot_changed", "original_evidence_changed", "owned_effect_changed", "added_history_event", "choice_changed", "target_out_of_scope"] as const;
/** business_change: a fact the choice relies on moved. unattributed_email: only emails were
 * added (stored diagnostics of earlier versions). unknown: the detail is not available. */
export type CrmDeltaClass = "business_change" | "unattributed_email" | "unknown";
export type CrmDeltaDiagnostic = { stage: string; reason: typeof CRM_DELTA_REASONS[number]; ticketIds:string[];eventIds:string[];baselineHash:string;currentHash:string; fields?:string[];
  evidence?: { id: string; category: CrmEvidenceCategory; state: "changed" | "missing" }[]; effect?: EffectIntent["kind"]; fieldsKnown?: boolean; truncated?: boolean; classification?: CrmDeltaClass };
export class IntakeCrmDeltaError extends Error { constructor(readonly diagnostic:CrmDeltaDiagnostic){super("SAV_INTAKE_EXECUTION_CRM_CHANGED");} }
export function classifyCrmDelta(d: Pick<CrmDeltaDiagnostic, "reason" | "fields" | "fieldsKnown">): CrmDeltaClass {
    if (d.reason === "unrecognized_added_email") return "unattributed_email";
    const fields = d.fields ?? [], detail = fields.filter(f => f.includes("."));
    if (d.fieldsKnown === false && !detail.length || !fields.length) return "unknown";
    return detail.length && detail.every(f => f === "history.added_email") ? "unattributed_email" : "business_change";
}
const withClass = (d: CrmDeltaDiagnostic): CrmDeltaDiagnostic => ({ ...d, classification: classifyCrmDelta(d) });
/** Changes that never alter the choice; they are traced, not refused. */
export const crmChoiceIrrelevant = (field: string) => field === "histories" || field.startsWith("history.") || field === "ticket.ownerId";
const ticketChoice = (t: Record<string, unknown>) => ({ ...(projectCrmEvidence("ticket", t) as Record<string, unknown>), ownerId: undefined, closedAt: t.stage === "closed" ? t.closedAt ?? null : null });
/** What the choice depends on: identity, links, the customer's tickets and their membership,
 * stage, closing date, subject and description. Digests only, no customer text. */
export function crmChoiceView(s: CrmSnapshot) {
    const tickets = [...new Map(Object.values(s.tickets).flat().map(t => [t.id, t])).values()].sort((a, b) => a.id.localeCompare(b.id));
    return { address: s.address, lookup: s.lookup.map(c => c.id).sort(), contacts: Object.keys(s.contacts).sort().map(id => projectCrmEvidence("contact", s.contacts[id])),
        associations: [...s.associations].map(a => savIntakeCanonicalEvidence(a)).sort(), membership: Object.keys(s.tickets).sort().map(id => [id, s.tickets[id].map(t => t.id).sort()]),
        tickets: tickets.map(t => ticketChoice(t as unknown as Record<string, unknown>)) };
}
export type CrmIgnoredChange = { fields: string[]; ticketIds: string[]; eventIds: string[] };
/** After a confirmed effect the choice is executed: the remaining actions finish on the same
 * target whatever else changed (Ugo, 27/10), unless the target is no longer among the
 * tickets of the contacts read. That is all this read proves: deleted, merged or moved to
 * another customer are not told apart, and none of them may receive this customer's mail.
 * Before any confirmed effect, only a choice change refuses. Everything else is traced. */
export function assertExecutionCrmUnchanged(baseline: CrmSnapshot, current: CrmSnapshot, effects: Effect[], continuation: ExecutionContinuation = {}): CrmIgnoredChange[] {
    const delta = snapshotDelta(baseline, current), hashes = { baselineHash: savIntakeEvidenceContentHash(baseline), currentHash: savIntakeEvidenceContentHash(current) };
    const stage = continuation.nextKind ?? "finalizing", committed = effects.some(e => e.state === "confirmed");
    if (committed) {
        const target = continuation.targetTicketId;
        if (target && !Object.values(current.tickets).flat().some(t => t.id === target))
            throw new IntakeCrmDeltaError(withClass({ stage, reason: "target_out_of_scope", ticketIds: crmIds([target], /^\d{1,30}$/), eventIds: [], fields: ["tickets", "ticket.out_of_scope"], ...hashes }));
    } else if (savIntakeCanonicalEvidence(crmChoiceView(baseline)) !== savIntakeCanonicalEvidence(crmChoiceView(current))) {
        const fields = delta.fields.filter(f => !crmChoiceIrrelevant(f));
        throw new IntakeCrmDeltaError(withClass({ stage, reason: "choice_changed", ticketIds: delta.ticketIds, eventIds: [], fields: fields.length ? fields : ["tickets"], fieldsKnown: true, ...hashes }));
    }
    return delta.fields.length ? [{ fields: delta.fields, ticketIds: delta.ticketIds, eventIds: delta.eventIds }] : [];
}
/** Named differences after our own confirmed effects were subtracted: what changed
 * that is not ours. Projections carry no customer text. */
function snapshotDelta(baseline: CrmSnapshot, clean: CrmSnapshot) {
    const fields = new Set<string>(), ticketIds: string[] = [], eventIds: string[] = [];
    if (baseline.address !== clean.address) fields.add("address");
    for (const field of crmProjectionFields("lookup", projectCrmEvidence("lookup", { address: baseline.address, contacts: baseline.lookup }), projectCrmEvidence("lookup", { address: clean.address, contacts: clean.lookup }))) fields.add(field).add("lookup");
    for (const id of new Set([...Object.keys(baseline.contacts), ...Object.keys(clean.contacts)]))
        for (const field of crmProjectionFields("contact", projectCrmEvidence("contact", baseline.contacts[id]), projectCrmEvidence("contact", clean.contacts[id]))) fields.add(field).add("contacts");
    if (savIntakeCanonicalEvidence(baseline.associations) !== savIntakeCanonicalEvidence(clean.associations)) fields.add("associations");
    const tickets = (s: CrmSnapshot) => [...new Map(Object.values(s.tickets).flat().map(t => [t.id, t])).values()];
    const before = tickets(baseline), after = tickets(clean);
    for (const field of crmProjectionFields("ticket_list", projectCrmEvidence("ticket_list", before), projectCrmEvidence("ticket_list", after))) fields.add(field).add("tickets");
    for (const t of [...before, ...after]) if (savIntakeCanonicalEvidence(before.find(b => b.id === t.id)) !== savIntakeCanonicalEvidence(after.find(a => a.id === t.id))) ticketIds.push(t.id);
    // Membership lists per contact: a ticket moved between contacts is a change too.
    if (savIntakeCanonicalEvidence(Object.fromEntries(Object.entries(baseline.tickets).map(([k, v]) => [k, v.map(t => t.id)])))
        !== savIntakeCanonicalEvidence(Object.fromEntries(Object.entries(clean.tickets).map(([k, v]) => [k, v.map(t => t.id)])))) fields.add("tickets").add("ticket.membership");
    for (const id of new Set([...Object.keys(baseline.histories), ...Object.keys(clean.histories)])) {
        // A history absent on one side (a ticket created or gone) compares as an empty list.
        const a = projectCrmEvidence("history", baseline.histories[id] ?? []), b = projectCrmEvidence("history", clean.histories[id] ?? []), changed = crmProjectionFields("history", a, b);
        if (!changed.length) continue;
        fields.add("histories"); ticketIds.push(id); eventIds.push(...historyIds(a, b));
        for (const field of changed) fields.add(field);
    }
    return { fields: [...fields].sort().slice(0, 20), ticketIds: crmIds(ticketIds, /^\d{1,30}$/), eventIds: crmIds(eventIds, /^(?:emails|notes):\d{1,30}$/), fieldsKnown: true, truncated: fields.size > 20 };
}

const PUBLIC_DELTA_STAGES = ["original", "stage_new", "ticket_create", "note_create", "note_associate", "email_create", "email_associate", "identity_send", "finalizing"];
const PUBLIC_DELTA_FIELD = /^(?:address|lookup|contacts|associations|tickets|histories|lookup\.(?:address|contacts)|contact\.(?:id|emails|missing)|ticket\.(?:id|ownerId|stage|contactIds|subject|content|createdAt|closedAt|added|removed|missing|out_of_scope|membership|receipt_missing)|history\.(?:id|kind|at|text|added_email|added_note|removed|missing|receipt_missing)|(?:associations|association|tickets|ticket_list|histories|history|contacts|contact|lookup)\.missing)$/;
const PUBLIC_EVIDENCE_ID = /^(?:email-lookup|association-search|(?:contact|ticket|history|identity-ticket|identity-history|ticket-search|identity-search|association)-\d{1,30})$/;
/** Allow-listed projection for admin DTOs: codes, numeric CRM ids, field names and
 * digests only. Older stored diagnostics (two reasons, no class) stay readable. */
export function publicIntakeCrmDelta(raw:unknown){
 if(!raw||typeof raw!=="object")return null;
 const d=raw as Record<string,unknown>;
 if(!PUBLIC_DELTA_STAGES.includes(String(d.stage))||!(CRM_DELTA_REASONS as readonly string[]).includes(String(d.reason)))return null;
 const ids=(raw:unknown,pattern:RegExp)=>Array.isArray(raw)?raw.filter((s):s is string=>typeof s==="string"&&pattern.test(s)).slice(0,20):[];
 const evidence=Array.isArray(d.evidence)?d.evidence.slice(0,20).flatMap(raw=>{const e=raw as Record<string,unknown>;
  return typeof e?.id==="string"&&PUBLIC_EVIDENCE_ID.test(e.id)&&Object.hasOwn(categoryField,String(e.category))&&["changed","missing"].includes(String(e.state))?[{id:e.id,category:String(e.category),state:String(e.state)}]:[];}):[];
 const fields=ids(d.fields,PUBLIC_DELTA_FIELD), reason=String(d.reason) as CrmDeltaDiagnostic["reason"], fieldsKnown=typeof d.fieldsKnown==="boolean"?d.fieldsKnown:null;
 return {stage:String(d.stage),reason,ticketIds:ids(d.ticketIds,/^\d{1,30}$/),eventIds:ids(d.eventIds,/^(?:emails|notes):\d{1,30}$/),fields,evidence,
  effect:typeof d.effect==="string"&&PUBLIC_DELTA_STAGES.includes(d.effect)?d.effect:null,fieldsKnown,truncated:d.truncated===true,
  classification:["business_change","unattributed_email","unknown"].includes(String(d.classification))?String(d.classification) as CrmDeltaClass:classifyCrmDelta({reason,fields,fieldsKnown:fieldsKnown??undefined}),
  baselineHash:typeof d.baselineHash==="string"&&/^[A-Za-z0-9_-]{43}$/.test(d.baselineHash)?d.baselineHash:null,
  currentHash:typeof d.currentHash==="string"&&/^[A-Za-z0-9_-]{43}$/.test(d.currentHash)?d.currentHash:null};
}
