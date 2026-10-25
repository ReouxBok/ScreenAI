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
  it("cancels a queued read promptly without consuming or leaking a slot", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const network = vi.fn<typeof fetch>(() => new Promise(resolve => { releases.push(() => resolve(Response.json({ ok: true }))); }));
    const transport = createSavHubspotTransport(network);
    const occupied = Array.from({ length: 3 }, () => transport("/crm/v3/pipelines/tickets", {}, summarize));
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    let cancelled = false;
    const queued = transport("/crm/v3/pipelines/tickets", { signal: controller.signal }, summarize)
      .catch(error => { expect(error.message).toBe("SAV_HUBSPOT_READ_CANCELLED"); cancelled = true; });
    const next = transport("/crm/v3/pipelines/tickets", {}, summarize);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    // The history deadline must not wait behind unrelated in-flight requests.
    expect(cancelled).toBe(true);
    expect(network).toHaveBeenCalledTimes(3);
    releases[0](); await vi.advanceTimersByTimeAsync(0);
    expect(network).toHaveBeenCalledTimes(4);
    releases[1](); releases[2](); releases[3]();
    await Promise.all([...occupied, queued, next]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not queue or dispatch a read whose signal already expired", async () => {
    const network = vi.fn<typeof fetch>();
    await expect(createSavHubspotTransport(network)("/crm/v3/pipelines/tickets", { signal: AbortSignal.abort() }, summarize))
      .rejects.toThrow("SAV_HUBSPOT_READ_CANCELLED");
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["backoff", "search spacing"])("cancels during %s and transfers exactly one slot", async phase => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const network = vi.fn<typeof fetch>(async url => {
      if (String(url).includes("/cancel/")) return new Response("", { status: 429, headers: { "Retry-After": "12" } });
      if (String(url).endsWith("/search")) return Response.json({ results: [] });
      return new Promise(resolve => releases.push(() => resolve(Response.json({ ok: true }))));
    });
    const transport = createSavHubspotTransport(network);
    if (phase === "search spacing") await transport("/crm/v3/objects/contacts/search", { method: "POST" }, summarize);
    const occupied = Array.from({ length: 2 }, () => transport("/crm/v3/pipelines/tickets", {}, summarize));
    const controller = new AbortController();
    let cancelled = false;
    const cancelledRead = transport(phase === "backoff" ? "/cancel/read" : "/crm/v3/objects/tickets/search", { signal: controller.signal }, summarize)
      .catch(error => { expect(error.message).toBe("SAV_HUBSPOT_READ_CANCELLED"); cancelled = true; });
    await vi.advanceTimersByTimeAsync(0);
    const waiting = Array.from({ length: 2 }, () => transport("/crm/v3/pipelines/tickets", {}, summarize));
    await vi.advanceTimersByTimeAsync(phase === "backoff" ? 8000 : 100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
    expect(releases).toHaveLength(3);
    releases[0](); await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(4);
    releases[1](); releases[2](); releases[3]();
    await Promise.all([...occupied, ...waiting, cancelledRead]);
    expect(network.mock.calls.filter(([url]) => String(url).includes("/cancel/")).length).toBe(phase === "backoff" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not leak provider body, URL IDs or credentials to metrics", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-body customer@invalid.test", { status: 403 }));
    await expect(createSavHubspotTransport(network)("/crm/v3/objects/tickets/private-ticket-id", { headers: { Authorization: "Bearer private-key" } }, summarize)).rejects.toThrow("HUBSPOT_HTTP_403");
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(/private|customer@/);
  });
});
it("preserves a local authority failure without retrying it as a network outage", async () => {
  const network = vi.fn(async () => { throw Error("SAV_INTAKE_RUNTIME_REVALIDATION_FAILED"); });
  const request = createSavHubspotTransport(network);
  await expect(request("/crm/v3/objects/tickets/batch/read", { method: "POST" }, status => `HUBSPOT_HTTP_${status}`))
    .rejects.toThrow("SAV_INTAKE_RUNTIME_REVALIDATION_FAILED");
  expect(network).toHaveBeenCalledTimes(1);
});

it("distinguishes a successful HTTP response with invalid JSON",async()=>{
 const network=vi.fn(async()=>new Response("invalid",{status:200}));
 await expect(createSavHubspotTransport(network)("/read",{},summarize)).rejects.toMatchObject({diagnostic:{origin:"response",status:200,attempts:1,code:"SAV_HUBSPOT_INVALID_RESPONSE"}});expect(network).toHaveBeenCalledTimes(1);
});
it("does not retain the HTTP status of an earlier attempt after a network failure",async()=>{
 const network=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null,{status:502})).mockRejectedValueOnce(new TypeError("synthetic connection failure"));
 await expect(createSavHubspotTransport(network)("/read",{},summarize)).rejects.toMatchObject({diagnostic:{origin:"transport",status:0,attempts:2,code:"SAV_HUBSPOT_READ_UNAVAILABLE"}});
});
it.each([true,false])("distinguishes planner deadline from explicit cancellation (%s)",async deadline=>{
 vi.useFakeTimers();const controller=new AbortController(),network=vi.fn<typeof fetch>(async(_url,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener("abort",()=>reject(init!.signal!.reason),{once:true})));
 const promise=createSavHubspotTransport(network)("/read",{signal:controller.signal},summarize);
 const assertion=expect(promise).rejects.toMatchObject({diagnostic:{origin:deadline?"deadline":"transport",attempts:1,status:0,code:deadline?"SAV_HUBSPOT_READ_TIMEOUT":"SAV_HUBSPOT_READ_CANCELLED"}});
 await vi.advanceTimersByTimeAsync(10000);controller.abort(Error(deadline?"SAV_INTAKE_STEP_DEADLINE":"synthetic cancel"));await assertion;expect(network).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
});
