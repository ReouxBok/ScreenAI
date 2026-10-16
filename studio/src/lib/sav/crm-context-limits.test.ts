import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSavHubspotContext } from "./hubspot";
const state = vi.hoisted(() => ({ match: vi.fn() }));
vi.mock("./ticket-routing-model", () => ({ matchSavTicketsByContent: state.match }));
const ticket = (id: string, open = false) => ({ id, createdAt: "2026-10-01T00:00:00Z", properties: { subject: `Incident ${id}`, content: "Problème produit", hs_pipeline: "0", hs_pipeline_stage: open ? "1" : "4", closed_date: "2026-10-01T00:00:00Z", hubspot_owner_id: "owner" } });
beforeEach(() => {
  vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "fixture-token");
  delete (globalThis as unknown as { __savClosedHubspotStages?: unknown }).__savClosedHubspotStages;
  state.match.mockImplementation(async input => ({ selection: { kind: "matched", ticket: input.tickets.find((t: { status: string }) => t.status === "open"), reason: "semantic_same_issue" }, matching: { revision: "fixture", model: "fixture", inputHash: "fixture", durationMs: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, errorCode: null, assessments: [], limitations: {} } }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe("CRM identity and bounded complete context", () => {
  it("checks an exact secondary address without inferring identity from broad search", async () => {
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("contacts/search")) {
        const body = JSON.parse(init!.body as string);
        return Response.json({ results: body.query ? [{ id: "secondary", properties: { email: "primary@example.invalid", hs_additional_emails: "other@example.invalid;client@example.invalid" } }] : [] });
      }
      return Response.json({ results: [] });
    }); vi.stubGlobal("fetch", network);
    expect(await readSavHubspotContext({ email: "client@example.invalid", subject: "Support" })).toMatchObject({ contactFound: true, contactId: "secondary" });
    const searches = network.mock.calls.filter(([url]) => url.endsWith("contacts/search")); expect(searches).toHaveLength(2);
  });
  it("does not select a broad query hit with only similar text or another address", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => Response.json({ results: url.endsWith("contacts/search") && JSON.parse(init!.body as string).query ? [{ id: "wrong", properties: { email: "not-client@example.invalid", hs_additional_emails: "client@example.invalid.other" } }] : [] })));
    expect(await readSavHubspotContext({ email: "client@example.invalid", subject: "Support" })).toMatchObject({ contactFound: false });
  });
  it("rejects multiple identity hits instead of choosing the first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ id: "a", properties: {} }, { id: "b", properties: {} }] })));
    await expect(readSavHubspotContext({ email: "client@example.invalid", subject: "Support" })).rejects.toThrow("SAV_HUBSPOT_IDENTITY_AMBIGUOUS");
  });
  it("paginates beyond100, compares one shortlist and preserves an evidenced active match", async () => {
    let pages = 0;
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("contacts/search")) return Response.json({ results: [{ id: "contact", properties: { email: "client@example.invalid" } }] });
      if (url.endsWith("tickets/search")) { pages++; const after = JSON.parse(init!.body as string).after; return Response.json(after ? { results: [ticket("active", true)] } : { results: Array.from({ length: 100 }, (_, i) => ticket(String(i))), paging: { next: { after: "100" } } }); }
      return Response.json({ results: [{ id: "0", stages: [{ id: "4", metadata: { isClosed: true } }] }] });
    }); vi.stubGlobal("fetch", network);
    const result = await readSavHubspotContext({ email: "client@example.invalid", subject: "Autre titre", body: "Le produit ne fonctionne plus" });
    expect(pages).toBe(2); expect(result.tickets).toHaveLength(101); expect(result.limitations).toMatchObject({ total: 101, shown: 12, paginationComplete: true });
    expect(result.routing).toMatchObject({ kind: "matched", ticketId: "active", returnOperation: "keep" }); expect(state.match).toHaveBeenCalledOnce();
  });
  it("retains visible candidates but abstains when pagination repeats or is incomplete", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("contacts/search")) return Response.json({ results: [{ id: "contact", properties: {} }] });
      if (url.endsWith("tickets/search")) return Response.json({ results: [ticket("one", true)], paging: { next: { after: "100" } } });
      return Response.json({ results: [] });
    }));
    const result = await readSavHubspotContext({ email: "client@example.invalid", subject: "Support", body: "Problème" });
    expect(result).toMatchObject({ errorCode: "SAV_HUBSPOT_TICKETS_TRUNCATED", limitations: { paginationComplete: false }, routing: { kind: "ambiguous" } });
    expect(result.tickets).toHaveLength(1); expect(state.match).not.toHaveBeenCalled();
  });
});
