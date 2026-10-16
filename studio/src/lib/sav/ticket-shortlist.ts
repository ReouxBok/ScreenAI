import type { SavTicketCandidate } from "./ticket-routing";
type Candidate = SavTicketCandidate & { description?: string };
/** Retrieval rank only: overlap never authorizes a CRM association. */
export function shortlistSavTickets<T extends Candidate>(tickets: T[], text: string, currentTicketId?: string | null, limit = 12) {
  const terms = new Set((text.slice(0, 16000).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).slice(0, 50));
  const score = (ticket: T) => [...terms].filter(term => `${ticket.subject} ${ticket.description ?? ""}`.toLowerCase().includes(term)).length;
  const scores = new Map(tickets.map(t => [t.id, score(t)]));
  const ranked = [...tickets].sort((a, b) => Number(b.id === currentTicketId) - Number(a.id === currentTicketId)
    || Number(b.status === "open") - Number(a.status === "open") || scores.get(b.id)! - scores.get(a.id)!);
  const selected = ranked.slice(0, limit);
  const omitted = tickets.filter(t => !selected.some(s => s.id === t.id));
  return { selected, omitted, limits: { total: tickets.length, shown: selected.length, omittedOpen: omitted.filter(t => t.status === "open").length, omittedClosed: omitted.filter(t => t.status === "closed").length } };
}
/** An unseen active ticket forbids certainty. An older closed ticket cannot
 * displace a unique current open match or a strictly newer closed match. */
export function savSubsetMatchIsComplete(selection: { kind: string; ticket?: SavTicketCandidate }, omitted: Candidate[]) {
  if (!omitted.length) return true;
  if (selection.kind !== "matched" || !selection.ticket || omitted.some(t => t.status === "open")) return false;
  if (selection.ticket.status === "open") return true;
  const closedAt = Date.parse(selection.ticket.closedAt ?? "");
  return Number.isFinite(closedAt) && omitted.every(t => Number.isFinite(Date.parse(t.closedAt ?? "")) && Date.parse(t.closedAt!) < closedAt);
}
