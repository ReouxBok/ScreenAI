import "server-only";

export type SavTicketHistoryEvent = { sourceId: string; ticketId: string; kind: "note" | "email"; occurredAt: string;
  updatedAt: string | null; text: string; truncated: boolean };
export type SavTicketHistory = { events: SavTicketHistoryEvent[]; limitations: string[]; ticketIds: string[]; relevantTicketId: string | null };
type Read = <T>(path: string, init?: RequestInit) => Promise<T>;
type RecordObject = { id: string; updatedAt?: string; properties: Record<string, string | null> };
const properties = { notes: ["hs_note_body", "hs_timestamp"], emails: ["hs_email_text", "hs_email_html", "hs_email_subject", "hs_timestamp"] };
function text(html: string) { return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }
function time(value: string | null | undefined) { const n = /^\d{10,}$/.test(value ?? "") ? Number(value) : Date.parse(value ?? ""); return Number.isFinite(n) ? n : null; }

/** Only explicit ticket associations and CRM batch/read. Never starts observation or writes a note.
 * Selection is a hypothesis until the caller establishes the current issue link. */
export async function readSavTicketHistory(ticketIds: string[], at: Date, read: Read, signal?: AbortSignal): Promise<SavTicketHistory> {
  const selected = [...new Set(ticketIds.filter(id => /^\d{1,30}$/.test(id)))].slice(0, 2);
  const limitations: string[] = ticketIds.length > selected.length ? ["history_ticket_limit"] : [];
  const events: SavTicketHistoryEvent[] = [];
  if (!Number.isFinite(at.getTime())) return { events, limitations: ["history_time_invalid"], ticketIds: selected, relevantTicketId: null };
  const deadline = signal ?? AbortSignal.timeout(8000);
  const until = Math.min(at.getTime(), Date.now());
  await Promise.all(selected.map(async ticketId => {
    for (const type of ["notes", "emails"] as const) {
      try {
        const linked = await read<{ results?: Array<{ id?: string; toObjectId?: string | number }>; paging?: { next?: unknown } }>(`/crm/v4/objects/tickets/${ticketId}/associations/${type}?limit=20`, { signal: deadline });
        if (linked.paging?.next) limitations.push(`${type}_association_limit`);
        const allIds = [...new Set((linked.results ?? []).map(v => String(v.toObjectId ?? v.id ?? "")).filter(id => /^\d{1,30}$/.test(id)))];
        if (allIds.length > 20) limitations.push(`${type}_association_limit`);
        const ids = allIds.slice(0, 20);
        if (!ids.length) continue;
        const batch = await read<{ results?: RecordObject[]; errors?: unknown[]; status?: string }>(`/crm/v3/objects/${type}/batch/read`, { method: "POST", signal: deadline,
          body: JSON.stringify({ inputs: ids.map(id => ({ id })), properties: properties[type] }) });
        if (batch.errors?.length || batch.results?.length !== ids.length || batch.status && batch.status !== "COMPLETE") limitations.push(`${type}_partial_batch`);
        for (const record of batch.results ?? []) {
          if (!ids.includes(record.id)) { limitations.push(`${type}_unassociated_record`); continue; }
          const occurred = time(record.properties.hs_timestamp), updated = time(record.updatedAt);
          if (occurred === null || occurred > until || updated !== null && updated > until) { limitations.push(`${type}_outside_snapshot`); continue; }
          const original = text(type === "notes" ? record.properties.hs_note_body ?? "" : record.properties.hs_email_text || record.properties.hs_email_html || "");
          if (!original) continue;
          events.push({ sourceId: `hubspot:${type}:${record.id}`, ticketId, kind: type === "notes" ? "note" : "email", occurredAt: new Date(occurred).toISOString(),
            updatedAt: updated === null ? null : new Date(updated).toISOString(), text: original.slice(0, 1500), truncated: original.length > 1500 });
        }
      } catch { limitations.push(`${type}_unavailable`); }
    }
  }));
  let remaining = 6000;
  const bounded = events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.sourceId.localeCompare(b.sourceId)).slice(0, 12).flatMap(event => {
    const value = event.text.slice(0, remaining); remaining -= value.length;
    return value ? [{ ...event, text: value, truncated: event.truncated || value.length < event.text.length }] : [];
  });
  if (bounded.length < events.length || bounded.some(e => e.truncated)) limitations.push("history_content_limited");
  return { events: bounded, limitations: [...new Set(limitations)].sort(), ticketIds: selected, relevantTicketId: null };
}
