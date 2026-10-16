import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavHubspotTransport, isSavHubspotRead } from "./hubspot-transport";
const summarize = (status: number) => `HUBSPOT_HTTP_${status}`;
beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("classified CRM reads", () => {
  it.each(["/crm/v3/objects/contacts/search", "/crm/v3/objects/tickets/search", "/crm/v3/objects/emails/batch/read"])("allows retry only for the read POST %s", path => expect(isSavHubspotRead(path, "POST")).toBe(true));
  it.each(["/crm/v3/objects/tickets", "/crm/v3/objects/notes", "/crm/v3/objects/emails", "/crm/v3/objects/contacts/batch/create", "/crm/v3/objects/emails/batch/update"])("never retries a mutation %s", async path => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    await expect(createSavHubspotTransport(network)(path, { method: "POST" }, summarize)).rejects.toThrow("HUBSPOT_HTTP_503");
    expect(network).toHaveBeenCalledOnce();
  });
  it("honors Retry-After and spaces Search starts below five per second", async () => {
    vi.useFakeTimers(); const starts: number[] = [];
    const network = vi.fn<typeof fetch>().mockImplementationOnce(async () => { starts.push(Date.now()); return new Response("", { status: 429, headers: { "Retry-After": "2" } }); })
      .mockImplementation(async () => { starts.push(Date.now()); return Response.json({ results: [] }); });
    const transport = createSavHubspotTransport(network);
    const result = transport("/crm/v3/objects/contacts/search", { method: "POST" }, summarize);
    await vi.advanceTimersByTimeAsync(1999); expect(network).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(101); await result; expect(network).toHaveBeenCalledTimes(2);
    const second = transport("/crm/v3/objects/tickets/search", { method: "POST" }, summarize);
    await vi.advanceTimersByTimeAsync(250); await second;
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(2000); expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(250);
  });
  it("never exceeds three concurrent reads and releases each slot", async () => {
    let active = 0, peak = 0; const releases: Array<() => void> = [];
    const network = vi.fn<typeof fetch>(() => new Promise(resolve => { active++; peak = Math.max(peak, active); releases.push(() => { active--; resolve(Response.json({ ok: true })); }); }));
    const transport = createSavHubspotTransport(network);
    const pending = Array.from({ length: 6 }, () => transport("/crm/v3/pipelines/tickets", {}, summarize));
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(3));
    for (let i = 0; i < 6; i++) { await vi.waitFor(() => expect(releases[i]).toBeTypeOf("function")); releases[i](); }
    await Promise.all(pending); expect(peak).toBe(3); expect(active).toBe(0);
  });
  it("does not leak provider body, URL IDs or credentials to metrics", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-body customer@invalid.test", { status: 403 }));
    await expect(createSavHubspotTransport(network)("/crm/v3/objects/tickets/private-ticket-id", { headers: { Authorization: "Bearer private-key" } }, summarize)).rejects.toThrow("HUBSPOT_HTTP_403");
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/private|customer@/);
  });
});
