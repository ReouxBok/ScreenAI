import type { IntakeHistory } from "./engine-types";

/** Counts only: no text, quote, address or identifier ever leaves this module.
 * It explains which part of a request filled the budget; it changes no input. */
export type IntakeContextBreakdown = {
  sections: Record<string, number>;
  catalogue: { entries: number; bySource: Record<string, number> };
  history?: { tickets: number; events: number; notes: number; emails: number; htmlEmails: number;
    duplicateEvents: number; duplicateBytes: number; nestedEvents: number; nestedBytes: number; quotedBytes: number; maxTicketHistoryBytes: number };
};
const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8");
// Source ids are `<kind>-<id>`; only the kind is kept.
const sourceKind = (sourceId: string) => /^(current|initial-request|identity-ticket|identity-history|ticket|history|contact|message|image)/.exec(sourceId)?.[1] ?? "other";
// Reply headers start a quoted earlier message in plain-text email bodies.
const replyHeader = /^(?:Le .{1,200} a écrit ?:|On .{1,200} wrote:|-{2,} ?(?:Original Message|Message d'origine) ?-{2,}|De ?: .{1,200})\s*$/mu;

function emailBody(text: string) {
  try { const parsed = JSON.parse(text) as { body?: unknown }; return typeof parsed.body === "string" ? parsed.body : text; }
  catch { return text; }
}
/** Bytes after the first reply header plus `>` lines before it: an estimate of
 * earlier messages repeated inside a body, not a judgement on their relevance. */
function quotedBytes(body: string) {
  const header = replyHeader.exec(body), head = header ? body.slice(0, header.index) : body;
  return (header ? bytes(body.slice(header.index)) : 0) + head.split("\n").filter(line => /^\s*>/.test(line)).reduce((sum, line) => sum + bytes(line) + 1, 0);
}

export function intakeContextBreakdown(data: Record<string, unknown>, histories?: IntakeHistory[]): IntakeContextBreakdown {
  // The catalogue section is named by role, never by its source-text key.
  const sections = Object.fromEntries(Object.entries(data).map(([key, value]) => [key === "citationCatalogue" ? "catalogue" : key, bytes(value)]));
  const entries = Array.isArray(data.citationCatalogue) ? data.citationCatalogue as { sourceId: string }[] : [];
  const bySource: Record<string, number> = {};
  for (const entry of entries) { const kind = sourceKind(entry.sourceId); bySource[kind] = (bySource[kind] ?? 0) + bytes(entry); }
  const result: IntakeContextBreakdown = { sections, catalogue: { entries: entries.length, bySource } };
  if (!histories) return result;
  const events = histories.flat(), bodies = events.map(e => e.kind === "email" ? emailBody(e.text) : e.text);
  const seen = new Set<string>(); let duplicateEvents = 0, duplicateBytes = 0, nestedEvents = 0, nestedBytes = 0, offset = 0;
  for (const history of histories) {
    const own = bodies.slice(offset, offset + history.length);
    for (const [index, body] of own.entries()) {
      if (seen.has(body)) { duplicateEvents++; duplicateBytes += bytes(history[index].text); continue; }
      seen.add(body);
      // Largest earlier body of the same ticket repeated verbatim inside this one (bounded: 100 events/ticket).
      const nested = own.slice(0, index).filter(other => other.length >= 200 && other !== body && body.includes(other)).reduce((max, other) => Math.max(max, bytes(other)), 0);
      if (nested) { nestedEvents++; nestedBytes += nested; }
    }
    offset += history.length;
  }
  result.history = { tickets: histories.length, events: events.length,
    notes: events.filter(e => e.kind === "note").length, emails: events.filter(e => e.kind === "email").length,
    htmlEmails: events.filter((e, i) => e.kind === "email" && /<(?:html|body|div|table|p)\b/i.test(bodies[i])).length,
    duplicateEvents, duplicateBytes, nestedEvents, nestedBytes,
    quotedBytes: bodies.reduce((sum, body, i) => sum + (events[i].kind === "email" ? quotedBytes(body) : 0), 0),
    maxTicketHistoryBytes: histories.reduce((max, h) => Math.max(max, h.reduce((sum, e) => sum + bytes(e.text), 0)), 0) };
  return result;
}
