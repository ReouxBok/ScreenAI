import { expect, it } from "vitest";
import { parseHistory, previousEntry, replaceCurrent, safeStudioHref, visit } from "./navigation-history";

const list = "/studio/sav/intake?view=to_validate&page=3&q=facture";
const dossier = "/studio/sav/intake/10000000-0000-4000-8000-000000000001";

it("Retour targets the page visited just before, with its filter, page and anchor", () => {
  let trail = visit([], "/studio");
  trail = visit(trail, list);
  trail = replaceCurrent(trail, `${list}#dossier-10000000-0000-4000-8000-000000000001`);
  trail = visit(trail, dossier);
  expect(previousEntry(trail, dossier)).toBe(`${list}#dossier-10000000-0000-4000-8000-000000000001`);
});

it("a browser back shrinks the trail instead of looping between two pages", () => {
  let trail = visit(visit(visit([], "/studio"), list), dossier);
  trail = visit(trail, list);
  expect(trail).toEqual(["/studio", list]);
  expect(previousEntry(trail, list)).toBe("/studio");
});

it("direct arrival (new tab, shared link) has no previous page, so the fallback is used", () => {
  expect(previousEntry(visit([], dossier), dossier)).toBeNull();
  expect(previousEntry(visit(visit([], "/studio"), list), dossier)).toBeNull();
});

it("only same-origin Studio paths are accepted, from storage or input", () => {
  for (const bad of ["https://evil.example/studio", "//evil.example/studio", "/connexion", "/studio\\..", "javascript:alert(1)", 42, null]) expect(safeStudioHref(bad)).toBeNull();
  expect(parseHistory(JSON.stringify(["/studio", "https://evil.example", "/aide", list]))).toEqual(["/studio", list]);
  expect(parseHistory("{not json")).toEqual([]);
  expect(visit(["/studio"], "//evil.example")).toEqual(["/studio"]);
});

it("the trail stays bounded", () => {
  let trail: string[] = [];
  for (let i = 0; i < 80; i++) trail = visit(trail, `/studio/contenus/${i}`);
  expect(trail).toHaveLength(50);
  expect(trail.at(-1)).toBe("/studio/contenus/79");
});
