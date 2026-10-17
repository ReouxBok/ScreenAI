import { afterEach, describe, expect, it, vi } from "vitest";
import { readSavHubspotContext } from "./hubspot";
const match = vi.hoisted(() => vi.fn());
vi.mock("./ticket-routing-model", () => ({ matchSavTicketsByContent: match }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });
function fixtures() {
  vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "fixture");
  const tickets = [1, 2, 3].map(id => ({ id: String(id), createdAt: `2026-10-${16-id}T00:00:00Z`, properties: { subject: `Incident ${id}`, content: "Issue", hs_pipeline: "0", hs_pipeline_stage: "1" } }));
  match.mockImplementation(async ({ tickets: candidates }) => ({ selection: { kind: "matched", ticket: candidates.find((t: { id: string }) => t.id === "3"), reason: "semantic_same_issue" }, matching: { revision: "fixture" } }));
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("contacts/search")) return Response.json({ results: [{ id: "42", properties: {} }] });
    if (url.endsWith("tickets/search")) return Response.json({ results: tickets });
    if (url.includes("/tickets/3?")) return Response.json({ ...tickets[2], associations: { contacts: { results: [{ id: "42" }] } } });
    if (url.includes("/associations/notes")) return Response.json({ results: [{ toObjectId: Number(url.match(/tickets\/(\d+)/)?.[1]) + 100 }] });
    if (url.includes("/associations/emails")) return Response.json({ results: [] });
    if (url.endsWith("notes/batch/read")) {
      const id = JSON.parse(String(init?.body)).inputs[0].id;
      return Response.json({ status: "COMPLETE", results: [{ id, updatedAt: "2026-10-14T00:00:00Z", properties: { hs_timestamp: "2026-10-14T00:00:00Z", hs_note_body: "Version déjà confirmée" } }] });
    }
    return Response.json({ results: [{ id: "0", stages: [] }] });
  });
  vi.stubGlobal("fetch", network); return network;
}
describe("history of the selected CRM issue", () => {
  it("reserves a bounded read for the third selected ticket before understanding", async () => {
    const network = fixtures();
    const context = await readSavHubspotContext({ email: "fixture@example.invalid", subject: "Question", body: "Le même problème", includeHistory: true });
    expect(context.history?.relevantTicketId).toBe("3");
    expect(context.history?.events).toContainEqual(expect.objectContaining({ ticketId: "3", text: "Version déjà confirmée" }));
    expect(network.mock.calls.some(([url]) => url.includes("tickets/3/associations/notes"))).toBe(true);
    expect(network.mock.calls.every(([url, init]) => !init?.method || init.method === "GET" || url.endsWith("/search") || url.endsWith("/batch/read"))).toBe(true);
  });
  it("reads the explicit human-selected target and checks its contact association", async () => {
    fixtures();
    const context = await readSavHubspotContext({ email: "fixture@example.invalid", subject: "Question", body: "Suite", includeHistory: true, skipSemanticMatch: true, historyTicketId: "3" });
    expect(match).not.toHaveBeenCalled(); expect(context.history?.relevantTicketId).toBe("3");
    expect(context.history?.events.some(e => e.ticketId === "3")).toBe(true);
  });
});
