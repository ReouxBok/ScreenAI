import { expect, it, vi } from "vitest";
import type { Page, Route } from "@playwright/test";
import { fetchServerActionInFull } from "../../tests/helpers/server-action";
it("passes UTF-8 Flight bytes to Chromium without charset guessing or replaying the action", async () => {
  const bytes = Buffer.from('1:T6,ééé\n2:["Import préparé","Réponse reçue"]', "utf8");
  const response = { body: vi.fn(async () => bytes) };
  const route = { request: () => ({}), fetch: vi.fn(async () => response), fulfill: vi.fn(async (options: { response: unknown; body: Buffer }) => { expect(options.body).toEqual(bytes); }), fallback: vi.fn() };
  let handler!: (route: Route) => Promise<void>;
  const page = { route: vi.fn(async (_pattern: string, callback: (route: Route) => Promise<void>) => { handler = callback; }), unroute: vi.fn(async () => {}) };
  const action = await fetchServerActionInFull(page as unknown as Page, () => true);
  await handler(route as unknown as Route); await action.settled();
  expect(route.fetch).toHaveBeenCalledTimes(1);
  expect(route.fulfill).toHaveBeenCalledExactlyOnceWith({ response, body: bytes });
  expect(route.fulfill.mock.calls[0][0].body.toString("utf8")).toContain("Import préparé");
  await action.dispose(); expect(page.unroute).toHaveBeenCalledTimes(1);
});
