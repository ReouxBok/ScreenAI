import { describe, expect, it, vi } from "vitest";
import { collectTicketCreationHistory, ticketCreationAssociations, verifyTicketCreationHistory } from "./ticket-creation-history";
import { createIntakeExecutorAdapters } from "./intake/execution-adapters";
import { executionProvider } from "../../../test/sav-intake-execution-provider";
import type { EffectIntent } from "./intake/execution-types";
const now = new Date("2026-11-09T12:00:00Z"), start = new Date(now.getTime() - 30 * 86400000).toISOString();
function source(rows: Array<{ id: string; at: string }>, pageSize = 500) {
  return vi.fn(async (path: string, body?: unknown) => {
    const url = new URL(path, "https://api.hubapi.com");
    if (path.includes("/labels")) return { results: [{ category: "HUBSPOT_DEFINED", typeId: 77, label: null }] };
    if (path.includes("/batch/read")) return { status: "COMPLETE", results: (body as { inputs: { id: string }[] }).inputs.map(({ id }) => ({ id, properties: { hs_timestamp: rows.find(r => r.id === id)!.at } })) };
    if (url.pathname.endsWith("/emails")) {
      const from = Number(url.searchParams.get("after") ?? 0), page = rows.slice(from, from + pageSize);
      return { results: page.map(row => ({ toObjectId: row.id })), ...(from + pageSize < rows.length ? { paging: { next: { after: String(from + pageSize) } } } : {}) };
    }
    return { results: [] };
  });
}
describe("mandatory new-ticket history", () => {
  it("uses all contact pages, inclusive 30-day boundary, excludes future/old, deduplicates IDs", async () => {
    const read = source([{ id: "1", at: start }, { id: "2", at: now.toISOString() }, { id: "1", at: start }, { id: "3", at: "2026-10-10T11:59:59Z" }, { id: "4", at: "2026-11-09T12:00:01Z" }], 2);
    const history = await collectTicketCreationHistory("101", read, now);
    expect(history.activities.map(a => a.id)).toEqual(["2", "1"]);
    expect(read.mock.calls.filter(([p]) => p.includes("/associations/emails?"))).toHaveLength(3);
    expect(ticketCreationAssociations(history)).toHaveLength(3);
  });
  it("allows an empty complete contact history", async () => {
    const history = await collectTicketCreationHistory("101", source([]), now);
    expect(history.activities).toEqual([]);
    expect(ticketCreationAssociations(history)).toEqual([{ to: { id: "101" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 16 }] }]);
  });
  it("rejects repeated pagination cursors", async () => {
    await expect(collectTicketCreationHistory("101", async () => ({ results: [], paging: { next: { after: "same" } } }), now)).rejects.toThrow("SAV_TICKET_HISTORY_INCOMPLETE");
  });
  it.each(["partial", "missing", "invalid timestamp"])("refuses %s batch evidence", async kind => {
    const base = source([{ id: "1", at: "bad" }]);
    const read = async (path: string, body?: unknown) => path.includes("batch/read") ? kind === "partial" ? { status: "PENDING", results: [] } : kind === "missing" ? { status: "COMPLETE", results: [] } : base(path, body) : base(path, body);
    await expect(collectTicketCreationHistory("101", read, now)).rejects.toThrow();
  });
  it("never silently truncates more than the 2,000 create-form limit", async () => {
    await expect(collectTicketCreationHistory("101", source(Array.from({ length: 2001 }, (_, i) => ({ id: String(i + 1), at: start }))), now)).rejects.toThrow("SAV_TICKET_HISTORY_LIMIT_EXCEEDED");
  });
  it("read-back requires all expected associations and can reconcile a later visible result without writes", async () => {
    const history = await collectTicketCreationHistory("101", source([{ id: "1", at: start }, { id: "2", at: start }]), now);
    expect(await verifyTicketCreationHistory("901", history, async () => ({ results: [{ toObjectId: "1" }] }))).toBe(false);
    const read = vi.fn(async (path: string) => path.includes("after=") ? { results: [{ toObjectId: "2" }] } : { results: [{ toObjectId: "1" }], paging: { next: { after: "next" } } });
    expect(await verifyTicketCreationHistory("901", history, read)).toBe(true);
    expect(read.mock.calls.every(([path]) => path.startsWith("/crm/v4/objects/tickets/901/associations/"))).toBe(true);
  });
  it("creates with all five activity types, persists original IDs and verifies partial then complete without re-creating", async () => {
    const p = executionProvider();
    const at = new Date().toISOString();
    for (const [i, type] of ["calls", "emails", "notes", "meetings", "tasks"].entries()) {
      const id = String(201 + i);
      p.objects[type][id] = { id, properties: { hs_timestamp: at } };
      p.links.set(`contacts:101:${type}`, [id]);
    }
    const a = createIntakeExecutorAdapters({ network: p.network, env: () => ({ HUBSPOT_ACCESS_TOKEN: "synthetic" }) });
    const signal = AbortSignal.timeout(5000);
    const history = await a.prepareTicketHistory!("101", signal);
    const intent: EffectIntent = { kind: "ticket_create", permission: "create_ticket", key: "synthetic", sourceMessageId: "synthetic", contactId: "101", marker: "synthetic", ticketHistory: history,
      properties: { subject: "Synthetic distinct request", content: "synthetic", hs_pipeline: "0", hs_pipeline_stage: "1" } };
    const ack = await a.dispatch(intent, signal);
    expect(history.activities).toHaveLength(5);
    expect(p.calls.find(c => c.method === "POST" && c.path.endsWith("/tickets"))!.body).toMatchObject({ associations: ticketCreationAssociations(history) });
    const saved = p.links.get(`tickets:${ack.id}:emails`)!;
    p.links.set(`tickets:${ack.id}:emails`, []);
    expect((await a.verify(intent, ack, new Date(at), signal)).confirmed).toBe(false);
    p.links.set(`tickets:${ack.id}:emails`, saved);
    expect((await a.verify(intent, ack, new Date(at), signal)).confirmed).toBe(true);
    expect(p.calls.filter(c => c.method === "POST" && c.path.endsWith("/tickets"))).toHaveLength(1);
    expect(p.calls.filter(c => c.method === "POST" && /\/(emails|notes)$/.test(c.path))).toHaveLength(0);
  });
  it("refuses dispatch without a prepared snapshot, before any ticket write", async () => {
    const p = executionProvider(), a = createIntakeExecutorAdapters({ network: p.network });
    await expect(a.dispatch({ kind: "ticket_create", permission: "create_ticket", key: "x", sourceMessageId: "x", contactId: "101" }, AbortSignal.timeout(500))).rejects.toThrow();
    expect(p.calls).toHaveLength(0);
  });
});
