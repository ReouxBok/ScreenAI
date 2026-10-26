import { expect, it, vi } from "vitest";
import { request as playwrightRequest, type Page, type Route } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchServerActionInFull } from "../../tests/helpers/server-action";
it("passes UTF-8 Flight bytes to Chromium without charset guessing or replaying the action", async () => {
  const bytes = Buffer.from('1:T6,ééé\n2:["Import préparé","Réponse reçue"]', "utf8");
  const response = { headers: () => ({ "content-type": "text/x-component", "content-encoding": "gzip", "content-length": "17", "transfer-encoding": "chunked", "x-action-redirect": "/done;push" }), body: vi.fn(async () => bytes) };
  const route = { request: () => ({ headers: () => ({ "next-action": "synthetic-action", "content-type": "multipart/form-data; boundary=fixture" }) }), fetch: vi.fn(async () => response), fulfill: vi.fn(async (options: { response: unknown; headers: Record<string, string>; body: Buffer }) => { expect(options.body).toEqual(bytes); }), fallback: vi.fn() };
  let handler!: (route: Route) => Promise<void>;
  const page = { url: () => "http://127.0.0.1:3100/studio/review?result=old", route: vi.fn(async (_pattern: string, callback: (route: Route) => Promise<void>) => { handler = callback; }), unroute: vi.fn(async () => {}) };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true);
  await handler(route as unknown as Route); await action.settled();
  expect(route.fetch).toHaveBeenCalledTimes(1);
  expect(route.fetch).toHaveBeenCalledWith({ maxRedirects: 0, maxRetries: 0, timeout: 90_000, headers: { "next-action": "synthetic-action", "content-type": "multipart/form-data; boundary=fixture", connection: "close" } });
  expect(route.fulfill).toHaveBeenCalledExactlyOnceWith({ response, headers: { "content-type": "text/x-component; charset=utf-8", "x-action-redirect": "/done;push" }, body: bytes });
  expect(route.fulfill.mock.calls[0][0].body.toString("utf8")).toContain("Import préparé");
  await action.dispose(); expect(page.unroute).toHaveBeenCalledTimes(1);
});

it("runs the race barrier after the single POST response and before Chromium receives its bytes", async () => {
  const events: string[] = [], bytes = Buffer.from("réponse");
  const response = { headers: () => ({ "content-type": "text/x-component", "content-encoding": "gzip", "content-length": "17", "transfer-encoding": "chunked", "x-action-redirect": "/done;push" }), body: vi.fn(async () => { events.push("body"); return bytes; }) };
  const route = { request: () => ({ headers: () => ({ "next-action": "synthetic-action", "content-type": "multipart/form-data; boundary=fixture" }) }), fetch: vi.fn(async () => { events.push("fetch"); return response; }), fulfill: vi.fn(async () => { events.push("fulfill"); }), fallback: vi.fn(async () => {}) };
  let handler!: (route: Route) => Promise<void>;
  const page = { url: () => "http://127.0.0.1:3100/studio/review?result=old", route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }), unroute: vi.fn(async () => {}) };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true, async () => { events.push("context"); });
  await handler(route as unknown as Route); await action.settled();
  await handler(route as unknown as Route);
  expect(events).toEqual(["fetch", "body", "context", "fulfill"]);
  expect(route.fetch).toHaveBeenCalledExactlyOnceWith({ maxRedirects: 0, maxRetries: 0, timeout: 90_000, headers: { "next-action": "synthetic-action", "content-type": "multipart/form-data; boundary=fixture", connection: "close" } });
  expect(route.fallback).toHaveBeenCalledTimes(1);
  await action.dispose();
});

it("surfaces a failed race barrier without retrying the POST or delivering a false result", async () => {
  const failure = new Error("CONTEXT_NOT_OBSERVED");
  const route = { request: () => ({ headers: () => ({ "next-action": "synthetic-action", "content-type": "multipart/form-data; boundary=fixture" }) }), fetch: vi.fn(async () => ({ headers: () => ({}), body: async () => Buffer.from("response") })), fulfill: vi.fn(), fallback: vi.fn() };
  let handler!: (route: Route) => Promise<void>;
  const page = { url: () => "http://127.0.0.1:3100/studio/review?result=old", route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }), unroute: vi.fn(async () => {}) };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true, async () => { throw failure; });
  const rejected = expect(action.settled()).rejects.toBe(failure);
  await handler(route as unknown as Route); await rejected;
  expect(route.fetch).toHaveBeenCalledTimes(1);
  expect(route.fulfill).not.toHaveBeenCalled();
  await action.dispose();
});


it("keeps non-Flight response metadata while removing stale wire encoding", async () => {
  const bytes = Buffer.from("plain response");
  const response = { headers: () => ({ "content-type": "text/plain; charset=utf-8", "content-encoding": "br", "content-length": "99", "x-action-revalidated": "1" }), body: async () => bytes };
  const route = { request: () => ({ headers: () => ({ "next-action": "synthetic-action", "content-type": "multipart/form-data; boundary=fixture" }) }), fetch: vi.fn(async () => response), fulfill: vi.fn(async () => {}), fallback: vi.fn() };
  let handler!: (route: Route) => Promise<void>;
  const page = { url: () => "http://127.0.0.1:3100/studio/review?result=old", route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }), unroute: vi.fn(async () => {}) };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true);
  await handler(route as unknown as Route); await action.settled();
  expect(route.fulfill).toHaveBeenCalledExactlyOnceWith({ response, headers: { "content-type": "text/plain; charset=utf-8", "x-action-revalidated": "1" }, body: bytes });
  expect(route.fetch).toHaveBeenCalledTimes(1);
  await action.dispose();
});


it("scopes interception and disposal to the invoking page, never its rendering assets", async () => {
  const page = {
    url: () => "http://127.0.0.1:3100/studio/review?result=old",
    route: vi.fn(async () => {}), unroute: vi.fn(async () => {}),
  };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true);
  const [pattern, handler] = page.route.mock.calls[0] as unknown as [RegExp, unknown];
  expect(pattern).toBeInstanceOf(RegExp);
  for (const url of ["http://127.0.0.1:3100/studio/review", "http://127.0.0.1:3100/studio/review?result=new&returnTo=/studio"]) {
    expect(pattern.test(url), url).toBe(true);
  }
  for (const url of ["http://127.0.0.1:3100/_next/static/css/app/layout.css?v=1", "http://127.0.0.1:3100/_next/static/chunks/app.js", "http://127.0.0.1:3100/studio/review-other", "http://127.0.0.2:3100/studio/review"]) {
    expect(pattern.test(url), url).toBe(false);
  }
  await action.dispose();
  expect(page.unroute).toHaveBeenCalledExactlyOnceWith(pattern, handler);
});


it("does not reuse a POST socket that the local server resets on its next request", async () => {
  const sockets = new Map<object, number>();
  let posts = 0;
  const server = createServer((req, res) => {
    posts++;
    const uses = (sockets.get(req.socket) ?? 0) + 1;
    sockets.set(req.socket, uses);
    // Deterministic stand-in for a dev server closing a reused keep-alive socket.
    if (uses > 1) { req.socket.destroy(); return; }
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end("Décision enregistrée"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport = await playwrightRequest.newContext();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/review`;
  try {
    for (let n = 0; n < 3; n++) {
      let handler!: (route: Route) => Promise<void>;
      const page = { url: () => url, route: async (_pattern: unknown, callback: typeof handler) => { handler = callback; }, unroute: async () => {} };
      const action = await fetchServerActionInFull(page as unknown as Page, () => true);
      const route = {
        request: () => ({ headers: () => ({ "next-action": "synthetic-action" }) }),
        fetch: vi.fn((options: Parameters<Route["fetch"]>[0]) => transport.fetch(url, { ...options, method: "POST", data: "once" })),
        fulfill: vi.fn(async (options: { body: Buffer }) => { expect(options.body.toString("utf8")).toBe("Décision enregistrée"); }), fallback: vi.fn(),
      };
      try { await Promise.all([handler(route as unknown as Route), action.settled()]); }
      finally { await action.dispose(); }
      expect(route.fetch).toHaveBeenCalledTimes(1);
      expect(route.fulfill).toHaveBeenCalledTimes(1);
    }
    expect(posts).toBe(3);
    expect(sockets.size).toBe(3);
    expect([...sockets.values()]).toEqual([1, 1, 1]);
  } finally {
    await transport.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("propagates an uncertain connection reset without replaying the POST", async () => {
  const failure = new Error("read ECONNRESET");
  let handler!: (route: Route) => Promise<void>;
  const page = { url: () => "http://127.0.0.1:3100/review", route: async (_pattern: unknown, callback: typeof handler) => { handler = callback; }, unroute: async () => {} };
  const route = { request: () => ({ headers: () => ({}) }), fetch: vi.fn(async () => { throw failure; }), fulfill: vi.fn(), fallback: vi.fn() };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true);
  const rejected = expect(action.settled()).rejects.toBe(failure);
  await handler(route as unknown as Route); await rejected; await action.dispose();
  expect(route.fetch).toHaveBeenCalledTimes(1);
  expect(route.fulfill).not.toHaveBeenCalled();
});
