import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../test/sav-db";
import { savWebhookReceipts } from "@/db/schema";
import { acceptHubspotWebhook, loadSavHubspotTicketEmails, processPendingHubspotReceipts } from "./hubspot";
const state = vi.hoisted(() => ({ db: null as unknown, refresh: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./observations", () => ({ hasSavTicketObservation: async () => true, refreshSavTicketObservations: state.refresh }));
let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => { fixture = await createSavTestDb(); state.db = fixture.db; }, 30000);
afterAll(async () => { await fixture.client.close(); });
beforeEach(async () => { await fixture.db.delete(savWebhookReceipts); state.refresh.mockResolvedValue(undefined); vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "fixture"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });
const events = [1, 2, 3].map(i => ({ eventId: i, objectId: 900, occurredAt: i, subscriptionType: "ticket.propertyChange", propertyName: "hs_pipeline_stage", propertyValue: String(i) }));
describe("lossless bounded webhook grouping", () => {
  it("reads the shared current snapshot once while marking every original event", async () => {
    await acceptHubspotWebhook(events); const results = await processPendingHubspotReceipts(20);
    expect(state.refresh).toHaveBeenCalledTimes(1); expect(results).toHaveLength(3);
    const rows = await fixture.db.select().from(savWebhookReceipts);
    expect(rows.every(r => r.status === "processed")).toBe(true); expect(rows.map(r => r.payload)).toEqual(expect.arrayContaining(events));
  });
  it("keeps all events recoverable after one failed shared read", async () => {
    await acceptHubspotWebhook(events); state.refresh.mockRejectedValue(new Error("SAV_HUBSPOT_READ_UNAVAILABLE"));
    const results = await processPendingHubspotReceipts(20); expect(results).toHaveLength(3);
    const rows = await fixture.db.select().from(savWebhookReceipts);
    expect(rows.every(r => r.status === "failed")).toBe(true); expect(rows.map(r => r.payload)).toEqual(expect.arrayContaining(events));
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});
describe("batch email reads", () => {
  it("uses two read batches for200 emails and preserves association order", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => String(i));
    const network = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ results: JSON.parse(init!.body as string).inputs.map((row: { id: string }) => ({ id: row.id, properties: {} })).reverse() }));
    vi.stubGlobal("fetch", network);
    const emails = await loadSavHubspotTicketEmails({ id: "ticket", properties: {}, associations: { emails: { results: ids.map(id => ({ id })) } } });
    expect(network).toHaveBeenCalledTimes(2); expect(emails.map(e => e.id)).toEqual(ids);
    expect(network.mock.calls.every(([url]) => url.endsWith("/emails/batch/read"))).toBe(true);
  });
  it("refuses missing or unrelated batch records instead of claiming a complete transcript", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ id: "wrong", properties: {} }] })));
    await expect(loadSavHubspotTicketEmails({ id: "ticket", properties: {}, associations: { emails: { results: [{ id: "expected" }] } } })).rejects.toThrow("SAV_HUBSPOT_EMAIL_BATCH_INCOMPLETE");
  });
});
