import { createHash } from "node:crypto";
import { z } from "zod";
import { savIntakeCanonicalEvidence, savIntakeEvidenceContentHash } from "./engine";
import type { CrmSnapshot, Effect, EffectIntent, EffectAck } from "./execution-types";
import type { IntakePlan, IntakeAdapters, ReadResult } from "./engine-types";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import { decryptSavPayload } from "../crypto";
import { isQualifiedCrmEmail, type QualifiedCrmEmail, type ContinuationSourceEmail } from "./crm-continuation";
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
    let fieldsKnown = true;
    for (const e of plan.decision.evidence) {
        const read = executionEvidenceValue(e, s);
        if (!read || read.value !== undefined && savIntakeEvidenceContentHash(read.value) === e.contentHash)
            continue;
        evidence.push({ id: e.id, category: read.category, state: read.value === undefined ? "missing" : "changed" });
        current.push(read.value ?? null);
        fields.add(categoryField[read.category]);
        if (["ticket", "ticket_list", "history"].includes(read.category)) ticketIds.push(read.category === "ticket_list" ? "" : e.sourceId);
        const known = original?.entries[e.id];
        if (known?.category !== read.category) { fieldsKnown = false; continue; }
        const now = projectCrmEvidence(read.category, read.value);
        for (const field of crmProjectionFields(read.category, known.projection, now)) fields.add(field);
        if (read.category === "history") eventIds.push(...historyIds(known.projection, now));
    }
    if (!evidence.length)
        return;
    throw new IntakeCrmDeltaError(withClass({ stage: "original", reason: "original_evidence_changed", ticketIds: crmIds(ticketIds, /^\d{1,30}$/), eventIds: crmIds(eventIds, /^(?:emails|notes):\d{1,30}$/),
        baselineHash: savIntakeEvidenceContentHash(evidence.map(e => plan.decision.evidence.find(x => x.id === e.id)!.contentHash)), currentHash: savIntakeEvidenceContentHash(current),
        fields: [...fields].sort().slice(0, 20), evidence: evidence.slice(0, 20), fieldsKnown, truncated: evidence.length > 20 || fields.size > 20 }));
}
/** Only previously attributed, confirmed effects are removed for comparison.
 * All other contact/ticket/history changes require reinvestigation. */
export type ExecutionContinuation = { finalizing?: boolean; nextKind?: EffectIntent["kind"]; sourceEmail?: ContinuationSourceEmail; qualifiedEmails?: QualifiedCrmEmail[] };
export const CRM_DELTA_REASONS = ["unrecognized_added_email", "snapshot_changed", "original_evidence_changed", "owned_effect_changed", "added_history_event"] as const;
/** business_change: a fact the decision relied on moved (owner, stage, content, identity,
 * a note, a removal, one of our own receipts). unattributed_email: only emails were added,
 * not yet attributed. unknown: the detail is not available. */
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
const ownedChange = (effect: Effect, fields: string[], extra: Partial<CrmDeltaDiagnostic>, baseline: CrmSnapshot, current: CrmSnapshot): never => {
    throw new IntakeCrmDeltaError(withClass({ stage: effect.kind, reason: "owned_effect_changed", effect: effect.kind as EffectIntent["kind"], ticketIds: [], eventIds: [],
        baselineHash: savIntakeEvidenceContentHash(baseline), currentHash: savIntakeEvidenceContentHash(current), fields, ...extra }));
};
/** Compare the entire envelope and body. Unknown incoming/outgoing mail must not
 * authorize a semantic status transition merely because it is an email. */
function sameKnownEmail(text: string, baseline: CrmSnapshot, ticketId: string) {
    const parse = (value: string) => {
        try { return z.object({ from: z.email(), to: z.string().min(1), direction: z.string(), subject: z.string(), body: z.string() }).parse(JSON.parse(value)); }
        catch { return null; }
    };
    const incoming = parse(text);
    if (!incoming) return false;
    const addresses = (s: string) => s.split(/[;,]/).map(v => v.trim().toLowerCase()).sort();
    const body = (s: string) => s.replace(/\r\n/g, "\n");
    return (baseline.histories[ticketId] ?? []).some(e => {
        const prior = e.kind === "email" ? parse(e.text) : null;
        return prior && incoming.from.toLowerCase() === prior.from.toLowerCase() && incoming.direction === prior.direction
            && JSON.stringify(addresses(incoming.to)) === JSON.stringify(addresses(prior.to))
            && incoming.subject === prior.subject && body(incoming.body) === body(prior.body);
    });
}
function assertExecutionCrmUnchangedCore(baseline: CrmSnapshot, current: CrmSnapshot, effects: Effect[], continuation: ExecutionContinuation = {}) {
    const clean = JSON.parse(JSON.stringify(current)) as CrmSnapshot;
    const concurrent: { ticketId: string; eventId: string; contentHash: string }[] = [];
    const ack = (e: Effect) => e.ackCiphertext ? decryptSavPayload<EffectAck>(e.ackCiphertext) : null;
    const intent = (e: Effect) => decryptSavPayload<EffectIntent>(e.intentCiphertext);
    // Remove an owned history delta only when its current bytes still match the
    // exact provider read kept in the receipt. A human edit never disappears.
    for (const effect of effects.filter(e => e.state === "confirmed")) {
        const i = intent(effect), proof = effect.verificationCiphertext ? decryptSavPayload<{
            observedTicket?: unknown;
            observedHistory?: {
                id: string;
            };
        }>(effect.verificationCiphertext) : {};
        if ((effect.kind === "note_associate" || effect.kind === "email_associate") && i.objectId) {
            if (!proof.observedHistory)
                return ownedChange(effect, ["history.receipt_missing"], { ticketIds: crmIds([i.ticketId ?? ""], /^\d{1,30}$/) }, baseline, current);
            const history = clean.histories[i.ticketId ?? ""];
            const observed = history?.find(e => e.id === proof.observedHistory!.id);
            if (savIntakeCanonicalEvidence(observed) !== savIntakeCanonicalEvidence(proof.observedHistory))
                return ownedChange(effect, observed ? crmProjectionFields("history", projectCrmEvidence("history", [proof.observedHistory]), projectCrmEvidence("history", [observed])) : ["history.removed"],
                    { ticketIds: crmIds([i.ticketId ?? ""], /^\d{1,30}$/), eventIds: crmIds([proof.observedHistory.id], /^(?:emails|notes):\d{1,30}$/) }, baseline, current);
            // Associating an already associated object is a no-op. Never remove
            // an event which was part of the original investigation.
            if (!baseline.histories[i.ticketId!]?.some(e => e.id === proof.observedHistory!.id))
                clean.histories[i.ticketId!] = history.filter(e => e.id !== proof.observedHistory!.id);
        }
        if (effect.kind === "stage_new" && i.ticketId) {
            const old = Object.values(baseline.tickets).flat().find(t => t.id === i.ticketId);
            const present = Object.values(clean.tickets).flat().filter(t => t.id === i.ticketId);
            if (!old || !present.length)
                return ownedChange(effect, ["ticket.missing"], { ticketIds: crmIds([i.ticketId], /^\d{1,30}$/) }, baseline, current);
            // A target may belong only to a directly linked contact. Empty
            // lists on other contacts stay intact for the final full comparison.
            for (const ticket of present) {
                if (ticket.stage !== "new")
                    return ownedChange(effect, ["ticket.stage"], { ticketIds: crmIds([i.ticketId], /^\d{1,30}$/) }, baseline, current);
                ticket.stage = old.stage;
            }
        }
    }
    const created = effects.filter(e => e.state === "confirmed" && e.kind === "ticket_create");
    // A newly logged email cannot undo an already committed ticket creation.
    // Its remaining association uses that exact ticket; set-New is allowed only
    // while the creation receipt still proves it is already New. For an existing
    // ticket, planned logging may continue, but a later set-New requires that
    // every added email is already known exactly. Notes/edits/removals, membership, owner, stage, identity
    // and the latest Gmail inbound still use their unchanged authoritative guards.
    const createdIds = new Set(created.map(e => ack(e)?.id).filter((id): id is string => Boolean(id)));
    const finalIds = new Set(effects.filter(e => e.state === "confirmed" && ["email_associate", "stage_new"].includes(e.kind)).map(e => intent(e).ticketId));
    const committedTargets = new Set(effects.filter(e => e.state === "confirmed" && ["note_create", "note_associate", "email_associate", "stage_new"].includes(e.kind)).map(e => intent(e).ticketId));
    for (const ticketId of Object.keys(clean.histories)) {
        const mayFinish = continuation.finalizing && finalIds.has(ticketId);
        const mayContinueCreated = createdIds.has(ticketId) && Boolean(continuation.nextKind) && continuation.nextKind !== "ticket_create";
        const mayContinueExisting = committedTargets.has(ticketId) && Boolean(continuation.nextKind) && continuation.nextKind !== "ticket_create";
        if (!mayFinish && !mayContinueCreated && !mayContinueExisting && !(continuation.finalizing && createdIds.has(ticketId))) continue;
        const known = new Set((baseline.histories[ticketId] ?? []).map(e => e.id));
        // Owned associated events have already been checked and removed above.
        const additions = clean.histories[ticketId].filter(e => !known.has(e.id));
        if (additions.some(e => e.kind !== "email"))
            throw new IntakeCrmDeltaError(withClass({ stage: continuation.nextKind ?? "finalizing", reason: "added_history_event", ticketIds: crmIds([ticketId], /^\d{1,30}$/),
                eventIds: crmIds(additions.map(e => e.id), /^(?:emails|notes):\d{1,30}$/), fields: ["histories", ...new Set(additions.map(e => `history.added_${e.kind === "note" ? "note" : "email"}`))].sort(),
                baselineHash: savIntakeEvidenceContentHash(baseline), currentHash: savIntakeEvidenceContentHash(current) }));
        // Completing already planned logging/associations does not decide a new
        // destination. Reopening an existing ticket DOES require known content.
        if (!createdIds.has(ticketId) && continuation.nextKind === "stage_new"
            && additions.some(e => !sameKnownEmail(e.text, baseline, ticketId)
              && !continuation.qualifiedEmails?.some(p=>isQualifiedCrmEmail(p)&&p.ticketId===ticketId&&p.eventId===e.id&&p.contentHash===savIntakeEvidenceContentHash(e))))
          throw new IntakeCrmDeltaError(withClass({stage:"stage_new",reason:"unrecognized_added_email",ticketIds:[ticketId],eventIds:additions.map(e=>e.id).filter(id=>/^emails:\d{1,30}$/.test(id)).slice(0,20),fields:["histories","history.added_email"],baselineHash:savIntakeEvidenceContentHash(baseline),currentHash:savIntakeEvidenceContentHash(current)}));
        for (const e of additions) concurrent.push({ ticketId, eventId: e.id, contentHash: savIntakeEvidenceContentHash(e) });
        clean.histories[ticketId] = clean.histories[ticketId].filter(e => known.has(e.id));
    }
    for (const effect of created) {
        const a = ack(effect), proof = effect.verificationCiphertext ? decryptSavPayload<{
            observedTicket?: unknown;
        }>(effect.verificationCiphertext) : {};
        if (!a?.id || !proof.observedTicket)
            return ownedChange(effect, ["ticket.receipt_missing"], {}, baseline, current);
        const matches = Object.values(clean.tickets).flat().filter(t => t.id === a.id), ids = { ticketIds: crmIds([a.id], /^\d{1,30}$/) };
        if (!matches.length) return ownedChange(effect, ["ticket.missing"], ids, baseline, current);
        const altered = matches.find(t => savIntakeCanonicalEvidence(t) !== savIntakeCanonicalEvidence(proof.observedTicket));
        if (altered) return ownedChange(effect, crmProjectionFields("ticket", projectCrmEvidence("ticket", proof.observedTicket), projectCrmEvidence("ticket", altered)), ids, baseline, current);
        if (!clean.histories[a.id]) return ownedChange(effect, ["history.missing"], ids, baseline, current);
        if (clean.histories[a.id].length)
            throw new IntakeCrmDeltaError(withClass({ stage: continuation.nextKind ?? "finalizing", reason: "added_history_event", ...ids, eventIds: crmIds(clean.histories[a.id].map(e => e.id), /^(?:emails|notes):\d{1,30}$/),
                fields: ["histories", ...new Set(clean.histories[a.id].map(e => `history.added_${e.kind === "note" ? "note" : "email"}`))].sort(), baselineHash: savIntakeEvidenceContentHash(baseline), currentHash: savIntakeEvidenceContentHash(current) }));
        for (const id of Object.keys(clean.tickets))
            clean.tickets[id] = clean.tickets[id].filter(t => t.id !== a.id);
        delete clean.histories[a.id];
    }
    if (savIntakeCanonicalEvidence(clean) !== savIntakeCanonicalEvidence(JSON.parse(JSON.stringify(baseline))))
        throw new IntakeCrmDeltaError(withClass({stage:continuation.nextKind??"finalizing",reason:"snapshot_changed",...snapshotDelta(baseline,clean),baselineHash:savIntakeEvidenceContentHash(baseline),currentHash:savIntakeEvidenceContentHash(current)}));
    return concurrent;
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
        const a = projectCrmEvidence("history", baseline.histories[id]), b = projectCrmEvidence("history", clean.histories[id]), changed = crmProjectionFields("history", a, b);
        if (!changed.length) continue;
        fields.add("histories"); ticketIds.push(id); eventIds.push(...historyIds(a, b));
        for (const field of changed) fields.add(field);
    }
    return { fields: [...fields].sort().slice(0, 20), ticketIds: crmIds(ticketIds, /^\d{1,30}$/), eventIds: crmIds(eventIds, /^(?:emails|notes):\d{1,30}$/), fieldsKnown: true, truncated: fields.size > 20 };
}

export function assertExecutionCrmUnchanged(baseline:CrmSnapshot,current:CrmSnapshot,effects:Effect[],continuation:ExecutionContinuation={}) {
 return assertExecutionCrmUnchangedCore(baseline,current,effects,continuation);
}
const PUBLIC_DELTA_STAGES = ["original", "stage_new", "ticket_create", "note_create", "note_associate", "email_create", "email_associate", "identity_send", "finalizing"];
const PUBLIC_DELTA_FIELD = /^(?:address|lookup|contacts|associations|tickets|histories|lookup\.(?:address|contacts)|contact\.(?:id|emails|missing)|ticket\.(?:id|ownerId|stage|contactIds|subject|content|createdAt|closedAt|added|removed|missing|membership|receipt_missing)|history\.(?:id|kind|at|text|added_email|added_note|removed|missing|receipt_missing)|(?:associations|association|tickets|ticket_list|histories|history|contacts|contact|lookup)\.missing)$/;
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
