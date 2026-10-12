import "server-only";
import { isHubspotOutboundDirection } from "./learning-extraction";
import { isSavAiAuthoredReply } from "./reply-format";
export type ObservationEvent = {
    sourceRef: string;
    kind: string;
    occurredAt: string;
    text: string;
    author: string | null;
    provenance: string;
    associationTicketId: string;
    remoteUpdatedAt: string | null;
    fullContentHash?: string;
    truncated?: boolean;
};
export type ObservationSnapshot = {
    ticketId: string;
    updatedAt: string;
    status: "open" | "closed" | "unknown";
    subject: string;
    events: ObservationEvent[];
    errors: string[];
};
type RecordObject = {
    id: string;
    updatedAt?: string;
    properties: Record<string, string | null>;
    propertiesWithHistory?: Record<string, Array<{
        value: string;
        timestamp: string;
        sourceType?: string;
        sourceId?: string;
    }>>;
};
function plain(v: string) { return v.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim().slice(0, 8000); }
function timestamp(v: string | null | undefined, fallback?: string) { const date = new Date(/^\d{10,}$/.test(v ?? "") ? Number(v) : v || fallback || ""); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }
/** Only GET and CRM batch/read endpoints are permitted in this collector. */
async function read<T>(path: string, ids?: string[], signal?: AbortSignal): Promise<T> {
    if (!process.env.HUBSPOT_ACCESS_TOKEN)
        throw new Error("TOKEN_MISSING");
    const response = await fetch(`https://api.hubapi.com${path}`, { method: ids ? "POST" : "GET", headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" }, ...(ids ? { body: JSON.stringify({ inputs: ids.map(id => ({ id })), properties: properties[path.split('/')[4]] }) } : {}), signal: signal ?? AbortSignal.timeout(12000) });
    if (!response.ok)
        throw new Error(`HTTP_${response.status}`);
    return response.json();
}
const properties: Record<string, string[]> = { emails: ["hs_email_text", "hs_email_html", "hs_email_subject", "hs_email_direction", "hs_email_status", "hs_email_from_email", "hs_timestamp", "hubspot_owner_id"], notes: ["hs_note_body", "hs_timestamp", "hubspot_owner_id"], tasks: ["hs_task_body", "hs_task_subject", "hs_task_status", "hs_timestamp", "hubspot_owner_id"] };
export async function collectSavObservationSources(ticketId: string): Promise<ObservationSnapshot> {
    if (!/^\d{1,30}$/.test(ticketId))
        throw new Error("SAV_OBSERVATION_TICKET_INVALID");
    const signal = AbortSignal.timeout(12000);
    const ticket = await read<RecordObject>(`/crm/v3/objects/tickets/${ticketId}?properties=subject,hs_pipeline,hs_pipeline_stage,hs_lastmodifieddate&propertiesWithHistory=hs_pipeline_stage`, undefined, signal);
    if (ticket.id !== ticketId)
        throw new Error("SAV_OBSERVATION_TICKET_INVALID");
    const errors: string[] = [];
    if ((ticket.propertiesWithHistory?.hs_pipeline_stage?.length ?? 0) > 100)
        errors.push("status:history_limit_100");
    const events: ObservationEvent[] = [];
    const updatedAt = timestamp(ticket.updatedAt || ticket.properties.hs_lastmodifieddate);
    if (!updatedAt)
        throw new Error("SAV_OBSERVATION_TIMESTAMP_MISSING");
    let status: ObservationSnapshot["status"] = "unknown";
    try {
        const pipeline = await read<{
            stages: Array<{
                id: string;
                metadata?: {
                    isClosed?: boolean | string;
                    ticketState?: string;
                };
            }>;
        }>(`/crm/v3/pipelines/tickets/${encodeURIComponent(ticket.properties.hs_pipeline || "")}`, undefined, signal);
        const stage = pipeline.stages.find(s => s.id === ticket.properties.hs_pipeline_stage);
        if (!stage)
            throw new Error("STAGE_UNKNOWN");
        if(stage.metadata?.isClosed===true || stage.metadata?.isClosed==="true" || stage.metadata?.ticketState==="CLOSED")status="closed";
        else if(stage.metadata?.isClosed===false || stage.metadata?.isClosed==="false" || stage.metadata?.ticketState==="OPEN")status="open";
        else throw new Error("STAGE_STATE_UNKNOWN");
    }
    catch (e) {
        errors.push(`pipeline:${e instanceof Error ? e.message : "unavailable"}`);
    }
    for (const history of (ticket.propertiesWithHistory?.hs_pipeline_stage ?? []).slice(-100)) {
        const at = timestamp(history.timestamp);
        if (at)
            events.push({ sourceRef: `hubspot:ticket:${ticketId}:stage:${at}`, kind: "status", occurredAt: at, text: history.value, author: history.sourceId ?? null, provenance: history.sourceType ?? "HubSpot history", associationTicketId: ticketId, remoteUpdatedAt: at });
    }
    events.push({ sourceRef: `hubspot:ticket:${ticketId}:current`, kind: "status", occurredAt: updatedAt, text: `${ticket.properties.hs_pipeline}:${ticket.properties.hs_pipeline_stage}:${status}`, author: null, provenance: "HubSpot ticket", associationTicketId: ticketId, remoteUpdatedAt: updatedAt });
    for (const type of ["emails", "notes", "tasks"] as const) {
        try {
            const association = await read<{
                results: Array<{
                    id?: string;
                    toObjectId?: number;
                }>;
                paging?: {
                    next?: unknown;
                };
            }>(`/crm/v4/objects/tickets/${ticketId}/associations/${type}?limit=100`, undefined, signal);
            if (association.paging?.next)
                errors.push(`${type}:association_limit_100`);
            const ids = [...new Set(association.results.map(a => String(a.toObjectId ?? a.id ?? "")).filter(id => /^\d+$/.test(id)))];
            if (!ids.length)
                continue;
            const batch = await read<{
                results: RecordObject[];
                errors?: unknown[];
                status?: string;
            }>(`/crm/v3/objects/${type}/batch/read`, ids, signal);
            if (batch.errors?.length || batch.results.length !== ids.length || (batch.status && batch.status !== "COMPLETE"))
                errors.push(`${type}:partial_batch`);
            for (const record of batch.results) {
                if (!ids.includes(record.id)) {
                    errors.push(`${type}:unassociated_record`);
                    continue;
                }
                const p = record.properties;
                const at = timestamp(type === "tasks" ? record.updatedAt : p.hs_timestamp, record.updatedAt);
                if (!at) {
                    errors.push(`${type}:timestamp_missing`);
                    continue;
                }
                const text = plain(type === "emails" ? (p.hs_email_text || p.hs_email_html || "") : type === "notes" ? (p.hs_note_body || "") : `${p.hs_task_subject || ""}\n${p.hs_task_body || ""}\nStatut enregistré : ${p.hs_task_status || "inconnu"}`);
                const original = type === "emails" ? (p.hs_email_text || p.hs_email_html || "") : type === "notes" ? (p.hs_note_body || "") : p.hs_task_body || "";
                if (original.length > 8000)
                    errors.push(`${type}:body_truncated`);
                const outbound = isHubspotOutboundDirection(p.hs_email_direction || "");
                const direction = (p.hs_email_direction || "").toUpperCase();
                if(type==="emails" && outbound && p.hs_email_status!=="SENT")errors.push("emails:delivery_unverified");
                events.push({ sourceRef: `hubspot:${type}:${record.id}`, kind: type === "emails" ? outbound ? (p.hs_email_status!=="SENT" ? "email_unverified" : isSavAiAuthoredReply(text) ? "ai_reply" : "human_reply") : direction === "INCOMING_EMAIL" ? "customer_reply" : "email_unknown" : type === "notes" ? "note" : "task", occurredAt: at, text, author: type==="emails" ? p.hs_email_from_email || null : p.hubspot_owner_id || null, provenance: `HubSpot ${type} / association explicite`, associationTicketId: ticketId, remoteUpdatedAt: timestamp(record.updatedAt) });
            }
        }
        catch (e) {
            errors.push(`${type}:${e instanceof Error ? e.message : "unavailable"}`);
        }
    }
    return { ticketId, updatedAt, status, subject: plain(ticket.properties.subject || "Sans objet"), events: events.sort((a, b) => `${a.occurredAt}:${a.sourceRef}`.localeCompare(`${b.occurredAt}:${b.sourceRef}`)), errors: [...new Set(errors)] };
}
