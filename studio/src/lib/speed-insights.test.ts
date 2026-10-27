import { expect, it } from "vitest";
import { sanitizeStudioVital } from "./speed-insights";

it("keeps the route metric but strips query, fragment and unknown event fields", () => {
  const event = { type: "vital" as const, url: "https://studio.limova.ai/studio/sav/intake?q=private&returnTo=secret#case", route: "private", customer: "private" };
  expect(sanitizeStudioVital(event)).toEqual({ type: "vital", url: "https://studio.limova.ai/studio/sav/intake", route: "/studio/sav/intake" });
});

it.each(["sav/intake", "sav/connaissances", "sav", "contenus", "entrainements"])("redacts the identifier in %s in both URL and route", prefix => {
  expect(sanitizeStudioVital({ type: "vital", url: `https://studio.limova.ai/studio/${prefix}/12345678-1234-1234-1234-123456789abc?token=private` }))
    .toEqual({ type: "vital", url: `https://studio.limova.ai/studio/${prefix}/[id]`, route: `/studio/${prefix}/[id]` });
});

it.each(["/connexion", "/api/internal/knowledge/search", "/studio/unknown/private", "/studio/sav/intake/private@example.test", "/studio/sav/intake/%31%32%33", "/studio/sav/intake/private-id"])("drops unapproved path %s", path => {
  expect(sanitizeStudioVital({ type: "vital", url: `https://studio.limova.ai${path}` })).toBeNull();
});

it.each(["not a URL", "http://studio.limova.ai/studio", "https://preview.vercel.app/studio", "https://studio.limova.ai.evil.test/studio", "https://private@studio.limova.ai/studio", "https://studio.limova.ai:444/studio"])("drops malformed or non-production origin %s", url => {
  expect(sanitizeStudioVital({ type: "vital", url })).toBeNull();
});
