import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ request: vi.fn(async (_event: { propertyName?: string }, _options: unknown) => ({ status: "off" })), mark: vi.fn(), refresh: vi.fn() }));
vi.mock("./cases/owner-handover", () => ({ requestOwnerHandover: f.request }));
vi.mock("./service", () => ({ claimWebhookReceipt: async (id: string) => ({ id, payload: { subscriptionType: "ticket.propertyChange", objectId: "880", propertyName: id === "owner" ? "hubspot_owner_id" : "hs_pipeline_stage", occurredAt: id === "owner" ? 1000 : 2000 } }), markWebhookReceipt: f.mark }));
vi.mock("./observations", () => ({ hasSavTicketObservation: async () => true, refreshSavTicketObservations: f.refresh }));
import { processHubspotReceiptGroup } from "./hubspot";
beforeEach(() => { vi.clearAllMocks(); });
it("mixed owner and stage receipts read BOTH events, refresh once and mark both", async () => {
  expect(await processHubspotReceiptGroup(["stage", "owner"])).toEqual(["stage", "owner"]);
  expect(f.request.mock.calls.map(call => (call[0] as { propertyName: string }).propertyName)).toEqual(["hubspot_owner_id", "hs_pipeline_stage"]);
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.mark).toHaveBeenCalledTimes(2);
});

it("owner workflow start failure never fails the legitimate stage receipt", async () => {
  const trace = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockRejectedValueOnce(Error("SAV_OWNER_HANDOVER_START_FAILED"));
  try {
    expect(await processHubspotReceiptGroup(["owner", "stage"])).toEqual(["owner", "stage"]);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith("880");
    expect(f.mark.mock.calls).toEqual([["owner", "processed"], ["stage", "processed"]]);
    expect(trace).toHaveBeenCalledWith("sav_v2_owner_handover_request_failed", { ticketId: "880", code: "SAV_OWNER_HANDOVER_REQUEST_FAILED" });
  } finally { trace.mockRestore(); }
});

import { afterEach } from "vitest";
import { readOwnerHandoverTicket } from "./hubspot";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("reads current CRM owner, pipeline and latest email direction without a mutation", async () => {
  vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "synthetic-token");
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/tickets/880?")) return Response.json({ id: "880", properties: { hubspot_owner_id: "902", hs_pipeline: "0" } });
    if (url.includes("/associations/emails")) return Response.json({ results: [{ toObjectId: "77" }, { toObjectId: "78" }] });
    expect(init?.method).toBe("POST");
    expect(url).toContain("/emails/batch/read");
    return Response.json({ results: [{ id: "77", properties: { hs_timestamp: "2026-11-16T10:00:00Z", hs_email_direction: "INCOMING_EMAIL" } }, { id: "78", properties: { hs_timestamp: "2026-11-16T10:01:00Z", hs_email_direction: "EMAIL" } }] });
  });
  vi.stubGlobal("fetch", network);
  expect(await readOwnerHandoverTicket("880")).toEqual({ owner: "902", pipeline: "0", lastDirection: "team", lastEmailAt: Date.parse("2026-11-16T10:01:00Z") });
  expect(network).toHaveBeenCalledTimes(3);
});
it("incomplete CRM associations fail closed", async () => {
  vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "synthetic-token");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("/tickets/880?") ? { id: "880", properties: {} } : { results: [], paging: { next: { after: "200" } } })));
  await expect(readOwnerHandoverTicket("880")).rejects.toThrow("SAV_OWNER_HANDOVER_HISTORY_INCOMPLETE");
});
