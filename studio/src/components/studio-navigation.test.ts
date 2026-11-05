import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { StaffRole } from "@/lib/access";
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
import { isNavItemActive, studioNavigation } from "./studio-navigation";
import { StudioNav } from "./studio-nav";

const hrefs = (email: string, role: StaffRole) => studioNavigation({ email, role }).flatMap(group => group.items.map(item => item.href));
const labels = (email: string, role: StaffRole) => studioNavigation({ email, role }).flatMap(group => group.items.map(item => item.label));

// Visibility rules of the previous menu (f1da0fb), per profile of the SAV-49 matrix.
it("each profile sees the same destinations as before, plus SAV sections it can already open", () => {
  expect(hrefs("lea@limova.ai", "member")).toEqual(["/studio", "/studio/contenus", "/studio/entrainements", "/studio/tests"]);
  expect(hrefs("contact@limova.ai", "member")).toEqual(["/studio", "/studio/contenus", "/studio/entrainements", "/studio/tests", "/studio/sav", "/studio/sav/connaissances", "/studio/sav/evaluation"]);
  expect(hrefs("ugo@limova.ai", "admin")).toEqual(["/studio", "/studio/contenus", "/studio/entrainements", "/studio/trame", "/studio/validations", "/studio/tests",
    "/studio/sav", "/studio/sav/connaissances", "/studio/sav/evaluation", "/studio/sav/resolutions", "/studio/sante"]);
  expect(hrefs("reouven@limova.ai", "owner")).toEqual(hrefs("ugo@limova.ai", "admin"));
  // An admin outside the SAV directory keeps production links but no SAV entry.
  expect(hrefs("arnaud@limova.ai", "admin")).not.toContain("/studio/sav");
});

it("uses the validated wording: Entraînements, never Démonstrations; no invented counter", () => {
  const all = labels("ugo@limova.ai", "admin");
  expect(all).toContain("Entraînements");
  expect(all.join(" ")).not.toMatch(/Démonstration|SAV IA/);
  const html = renderToStaticMarkup(createElement(StudioNav, { groups: studioNavigation({ email: "ugo@limova.ai", role: "admin" }), pathname: "/studio/sav/intake" }));
  expect(html).not.toMatch(/>\d+</);
  expect(html).toContain("Extension Chrome");
  expect(html).toContain("Agent SAV");
});

it("marks exactly one current page for console, dossier and sibling sections", () => {
  const items = studioNavigation({ email: "ugo@limova.ai", role: "admin" }).flatMap(group => group.items);
  const current = (pathname: string) => items.filter(item => isNavItemActive(item, pathname)).map(item => item.key);
  expect(current("/studio")).toEqual(["overview"]);
  expect(current("/studio/sav")).toEqual(["requests"]);
  expect(current("/studio/sav/intake/10000000-0000-4000-8000-000000000001")).toEqual(["requests"]);
  expect(current("/studio/sav/10000000-0000-4000-8000-000000000001")).toEqual(["requests"]);
  expect(current("/studio/sav/connaissances/imports")).toEqual(["knowledge"]);
  expect(current("/studio/sav/evaluation")).toEqual(["evaluation"]);
  expect(current("/studio/entrainements/abc")).toEqual(["trainings"]);
  expect(current("/studio/sav/pilote")).toEqual([]);
  const html = renderToStaticMarkup(createElement(StudioNav, { groups: studioNavigation({ email: "ugo@limova.ai", role: "admin" }), pathname: "/studio/sav/connaissances" }));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
});
