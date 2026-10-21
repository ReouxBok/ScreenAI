import { createHash } from "node:crypto";
import { z } from "zod";
import { savIntakeCanonicalEvidence, savIntakeEvidenceContentHash } from "./engine";
import type { CrmSnapshot, Effect, EffectIntent, EffectAck } from "./execution-types";
import type { IntakePlan, IntakeAdapters, ReadResult } from "./engine-types";
import type { IntakeRuntimeConfig } from "./runtime-contract";
import { decryptSavPayload } from "../crypto";
const fault = (): never => { throw Error("SAV_INTAKE_EXECUTION_CRM_CHANGED"); };
const value = <T>(r: ReadResult<T>): T => {
    if (r.status !== "complete")
        return fault();
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
        return fault();
    const texts = [current.currentText ?? "", ...(i.conversation?.data ?? []).filter(m => m.direction === "inbound" && m.fromEmail === current.fromEmail).map(m => m.currentText)];
    const candidates = [current.fromEmail, ...texts.flatMap(t => t.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? [])].map(e => e.toLowerCase());
    const source = plan.decision.evidence.find(e => e.id === "email-lookup")?.sourceId;
    const matches = [...new Set(candidates)].filter(e => z.email().safeParse(e).success && source === `lookup-${createHash("sha256").update(e).digest("base64url")}`);
    if (matches.length !== 1)
        return fault();
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
        return fault();
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
export function assertOriginalExecutionCrm(plan: IntakePlan, s: CrmSnapshot) {
    const tickets = Object.values(s.tickets).flat();
    for (const e of plan.decision.evidence) {
        let data: unknown;
        let compare = true;
        if (e.id === "email-lookup")
            data = {
                address: s.address, status: "complete", contacts: s.lookup, reconstructedAsOf: undefined
            };
        else if (e.id === "association-search")
            data = [...s.associations].sort((a, b) => savIntakeCanonicalEvidence(a).localeCompare(savIntakeCanonicalEvidence(b)));
        else if (e.source === "crm_contact" && e.id.startsWith("contact-"))
            data = s.contacts[e.sourceId];
        else if (e.source === "crm_ticket" && /^(?:ticket|identity)-search-/.test(e.id))
            data = s.tickets[e.sourceId.replace(/^search-/, "")];
        else if (e.source === "crm_ticket")
            data = tickets.find(t => t.id === e.sourceId);
        else if (e.source === "crm_event")
            data = s.histories[e.sourceId];
        else if (e.source === "contact_association") {
            data = s.associations.find(a => `${a.fromContactId}:${a.toContactId}:${a.typeId}` === e.sourceId);
        }
        else
            compare = false;
        if (compare && (data === undefined || savIntakeEvidenceContentHash(data) !== e.contentHash))
            return fault();
    }
}
/** Only previously attributed, confirmed effects are removed for comparison.
 * All other contact/ticket/history changes require reinvestigation. */
export function assertExecutionCrmUnchanged(baseline: CrmSnapshot, current: CrmSnapshot, effects: Effect[]) {
    const clean = JSON.parse(JSON.stringify(current)) as CrmSnapshot;
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
                return fault();
            const history = clean.histories[i.ticketId ?? ""];
            const observed = history?.find(e => e.id === proof.observedHistory!.id);
            if (savIntakeCanonicalEvidence(observed) !== savIntakeCanonicalEvidence(proof.observedHistory))
                return fault();
            clean.histories[i.ticketId!] = history.filter(e => e.id !== proof.observedHistory!.id);
        }
        if (effect.kind === "stage_new" && i.ticketId) {
            const old = Object.values(baseline.tickets).flat().find(t => t.id === i.ticketId);
            if (old)
                for (const rows of Object.values(clean.tickets)) {
                    const t = rows.find(t => t.id === i.ticketId);
                    if (!t || t.stage !== "new")
                        return fault();
                    t.stage = old.stage;
                }
        }
    }
    for (const effect of effects.filter(e => e.state === "confirmed" && e.kind === "ticket_create")) {
        const a = ack(effect), proof = effect.verificationCiphertext ? decryptSavPayload<{
            observedTicket?: unknown;
        }>(effect.verificationCiphertext) : {};
        if (!a?.id || !proof.observedTicket)
            return fault();
        const matches = Object.values(clean.tickets).flat().filter(t => t.id === a.id);
        if (!matches.length || matches.some(t => savIntakeCanonicalEvidence(t) !== savIntakeCanonicalEvidence(proof.observedTicket)) || !clean.histories[a.id] || clean.histories[a.id].length)
            return fault();
        for (const id of Object.keys(clean.tickets))
            clean.tickets[id] = clean.tickets[id].filter(t => t.id !== a.id);
        delete clean.histories[a.id];
    }
    if (savIntakeCanonicalEvidence(clean) !== savIntakeCanonicalEvidence(JSON.parse(JSON.stringify(baseline))))
        return fault();
}
