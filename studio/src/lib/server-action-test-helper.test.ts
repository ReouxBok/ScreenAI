import { expect, it, vi } from "vitest";
import type { Page, Route } from "@playwright/test";
import { fetchServerActionInFull } from "../../tests/helpers/server-action";
it("passes UTF-8 Flight bytes to Chromium without charset guessing or replaying the action", async () => {
  const bytes = Buffer.from('1:T6,ééé\n2:["Import préparé","Réponse reçue"]', "utf8");
  const response = { headers: () => ({ "content-type": "text/x-component", "content-encoding": "gzip", "content-length": "17", "transfer-encoding": "chunked", "x-action-redirect": "/done;push" }), body: vi.fn(async () => bytes) };
  const route = { request: () => ({}), fetch: vi.fn(async () => response), fulfill: vi.fn(async (options: { response: unknown; headers: Record<string, string>; body: Buffer }) => { expect(options.body).toEqual(bytes); }), fallback: vi.fn() };
  let handler!: (route: Route) => Promise<void>;
  const page = { route: vi.fn(async (_pattern: string, callback: (route: Route) => Promise<void>) => { handler = callback; }), unroute: vi.fn(async () => {}) };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true);
  await handler(route as unknown as Route); await action.settled();
  expect(route.fetch).toHaveBeenCalledTimes(1);
  expect(route.fetch).toHaveBeenCalledWith({ maxRedirects: 0, maxRetries: 0, timeout: 90_000 });
  expect(route.fulfill).toHaveBeenCalledExactlyOnceWith({ response, headers: { "content-type": "text/x-component; charset=utf-8", "x-action-redirect": "/done;push" }, body: bytes });
  expect(route.fulfill.mock.calls[0][0].body.toString("utf8")).toContain("Import préparé");
  await action.dispose(); expect(page.unroute).toHaveBeenCalledTimes(1);
});

it("runs the race barrier after the single POST response and before Chromium receives its bytes", async () => {
  const events: string[] = [], bytes = Buffer.from("réponse");
  const response = { headers: () => ({ "content-type": "text/x-component", "content-encoding": "gzip", "content-length": "17", "transfer-encoding": "chunked", "x-action-redirect": "/done;push" }), body: vi.fn(async () => { events.push("body"); return bytes; }) };
  const route = { request: () => ({}), fetch: vi.fn(async () => { events.push("fetch"); return response; }), fulfill: vi.fn(async () => { events.push("fulfill"); }), fallback: vi.fn(async () => {}) };
  let handler!: (route: Route) => Promise<void>;
  const page = { route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }), unroute: vi.fn(async () => {}) };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true, async () => { events.push("context"); });
  await handler(route as unknown as Route); await action.settled();
  await handler(route as unknown as Route);
  expect(events).toEqual(["fetch", "body", "context", "fulfill"]);
  expect(route.fetch).toHaveBeenCalledExactlyOnceWith({ maxRedirects: 0, maxRetries: 0, timeout: 90_000 });
  expect(route.fallback).toHaveBeenCalledTimes(1);
  await action.dispose();
});

it("surfaces a failed race barrier without retrying the POST or delivering a false result", async () => {
  const failure = new Error("CONTEXT_NOT_OBSERVED");
  const route = { request: () => ({}), fetch: vi.fn(async () => ({ headers: () => ({}), body: async () => Buffer.from("response") })), fulfill: vi.fn(), fallback: vi.fn() };
  let handler!: (route: Route) => Promise<void>;
  const page = { route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }), unroute: vi.fn(async () => {}) };
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
  const route = { request: () => ({}), fetch: vi.fn(async () => response), fulfill: vi.fn(async () => {}), fallback: vi.fn() };
  let handler!: (route: Route) => Promise<void>;
  const page = { route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }), unroute: vi.fn(async () => {}) };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true);
  await handler(route as unknown as Route); await action.settled();
  expect(route.fulfill).toHaveBeenCalledExactlyOnceWith({ response, headers: { "content-type": "text/plain; charset=utf-8", "x-action-revalidated": "1" }, body: bytes });
  expect(route.fetch).toHaveBeenCalledTimes(1);
  await action.dispose();
});
