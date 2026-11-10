import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
import { Card, Checkbox, Collapsible, Field, OverflowMenu, RadioCard, Select, TextArea, TextInput, describedBy } from "./forms";
import { Button } from "./primitives";

it("wrapped controls keep the caller's name, value and hidden fields untouched", () => {
  const html = renderToStaticMarkup(createElement("form", { action: "/x" },
    createElement("input", { type: "hidden", name: "commandKey", value: "k-1" }),
    TextInput({ name: "reason", minLength: 10, required: true, id: "reason" }),
    TextArea({ name: "information", defaultValue: "a" }),
    createElement(Select, { name: "contactId", defaultValue: "c2" }, createElement("option", { value: "c1" }, "Un"), createElement("option", { value: "c2" }, "Deux")),
    RadioCard({ name: "choice", value: "existing", label: "Fiche existante", defaultChecked: true }),
    Checkbox({ name: "confirm", value: "yes", label: "Je confirme" })));
  expect(html).toMatch(/<input type="radio" name="choice" checked="" value="existing"\/>/);
  for (const text of ['name="commandKey" value="k-1"', 'name="reason"', 'minLength="10"', "required", 'name="information"', 'name="contactId"', 'value="c2" selected', 'type="checkbox" name="confirm" value="yes"']) expect(html).toContain(text);
});

it("labels, hints and errors are tied to their control", () => {
  const html = renderToStaticMarkup(Field({ id: "reason", label: "Raison", hint: "10 caractères minimum", error: "Trop court", children: TextInput({ id: "reason", "aria-describedby": describedBy("reason", { hint: 1, error: 1 }), "aria-invalid": true }) }));
  for (const text of ['for="reason"', 'id="reason-hint"', 'id="reason-error"', 'role="alert"', 'aria-describedby="reason-hint reason-error"', 'aria-invalid="true"']) expect(html).toContain(text);
  expect(describedBy("x", {})).toBeUndefined();
});

it("busy and unavailable buttons say so, and cannot be pressed twice", () => {
  const busy = renderToStaticMarkup(createElement(Button, { busy: true, type: "submit" }, "Enregistrement…"));
  expect(busy).toContain('aria-busy="true"'); expect(busy).toContain("disabled");
  const unavailable = renderToStaticMarkup(createElement(Button, { id: "pause", disabledReason: "Réservé aux administrateurs" }, "Mettre en pause"));
  for (const text of ["disabled", 'aria-describedby="pause-reason"', 'id="pause-reason"', "Réservé aux administrateurs"]) expect(unavailable).toContain(text);
});

it("card, disclosure and overflow menu render real content only", () => {
  expect(renderToStaticMarkup(Card({ title: "Contexte", children: "x" }))).toContain("<h2>Contexte</h2>");
  const disclosure = renderToStaticMarkup(Collapsible({ summary: "Historique", children: "Lignes" }));
  expect(disclosure).toContain("<summary>Historique</summary>"); expect(disclosure).toContain("Lignes"); expect(disclosure).not.toContain("open");
  expect(renderToStaticMarkup(createElement(OverflowMenu, { label: "Autres vues", links: [] }))).toBe("");
  const menu = renderToStaticMarkup(createElement(OverflowMenu, { label: "Autres vues", current: "other", links: [{ key: "other", label: "Autres", href: "/studio/sav/intake?view=other" }, { key: "learning", label: "Apprentissage", href: "/studio/sav/intake?view=learning" }] }));
  expect(menu).toContain("Autres vues · Autres"); expect(menu.match(/aria-current="page"/g)).toHaveLength(1); expect(menu).not.toMatch(/>\d+</);
});

it("controls reach 44 px on touch screens", () => {
  const css = readFileSync(path.join(__dirname, "ui.module.css"), "utf8");
  expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.button, \.tab, \.backLink, \.input, \.check, \.disclosure > summary, \.menuList a \{ min-height: 44px; \}/);
});
