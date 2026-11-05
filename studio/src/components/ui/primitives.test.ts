import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const nav = vi.hoisted(() => ({ back: vi.fn() }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/studio/sav/intake/x", useSearchParams: () => new URLSearchParams(), useRouter: () => nav }));
import { Badge, Button, Count, EmptyState, ErrorState, PageHeader, Status, ViewTabs } from "./primitives";
import { BackLink } from "./back-link";
import { uiTokens } from "./tokens";

it("tokens are the Paper mockup values, defined once in the scoped theme", () => {
  const css = readFileSync(path.join(__dirname, "ui.module.css"), "utf8");
  for (const [name, value] of [["--ui-canvas", uiTokens.color.canvas], ["--ui-sidebar", uiTokens.color.sidebar], ["--ui-ink", uiTokens.color.ink],
    ["--ui-accent-bg", uiTokens.color.accentBg], ["--ui-accent-ink", uiTokens.color.accentInk], ["--ui-danger-ink", uiTokens.color.dangerInk]] as const) expect(css).toContain(`${name}: ${value};`);
  expect(css).toContain(`--ui-font-sans: ${uiTokens.font.sans};`);
  // Existing pages inherit the mockup typeface through the variables they already read.
  expect(css).toContain("--font-body: var(--ui-font-sans); --font-display: var(--ui-font-display);");
});

const luminance = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

it("text and badge colours reach WCAG AA (4.5:1) on every background they use", () => {
  const { color: c } = uiTokens;
  for (const [fg, bg] of [[c.ink, c.canvas], [c.inkSecondary, c.sidebar], [c.inkTertiary, c.canvas], [c.inkTertiary, c.sidebar], [c.inkTertiary, c.surfaceMuted],
    [c.accentInk, c.accentBg], [c.dangerInk, c.dangerBg], [c.warningInk, "#fdf0e1"], [c.successInk, "#edf6e4"]]) expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
});

it("a count is shown only when the server gave a number", () => {
  expect(renderToStaticMarkup(createElement(Count, { value: undefined, label: "dossiers" }))).toBe("");
  expect(renderToStaticMarkup(createElement(Count, { value: null, label: "dossiers" }))).toBe("");
  expect(renderToStaticMarkup(createElement(Count, { value: 0, label: "dossiers" }))).toContain('aria-label="0 dossiers"');
  const tabs = renderToStaticMarkup(createElement(ViewTabs, { label: "Vues", current: "a", tabs: [{ key: "a", label: "À valider", href: "/studio/sav/intake?view=to_validate", count: 12 }, { key: "b", label: "Terminés", href: "/studio/sav/intake?view=completed" }] }));
  expect(tabs).toContain('aria-current="page"'); expect(tabs).toContain(">12<"); expect(tabs).not.toMatch(/Terminés<\/span><span/);
});

it("status always carries words, buttons default to type=button, states have no invented action", () => {
  expect(renderToStaticMarkup(Status({ tone: "warning", children: "Vérification nécessaire" }))).toContain("Vérification nécessaire");
  expect(renderToStaticMarkup(Badge({ tone: "accent", children: "À relire" }))).toContain("À relire");
  expect(renderToStaticMarkup(createElement(Button, null, "Réessayer"))).toContain('type="button"');
  expect(renderToStaticMarkup(createElement(EmptyState, { title: "Aucun dossier" }))).not.toContain("<a");
  const error = renderToStaticMarkup(createElement(ErrorState, { title: "Indisponible" }));
  expect(error).toContain('role="alert"');
  expect(renderToStaticMarkup(createElement(PageHeader, { title: "Demandes" }))).toContain("<h1>Demandes</h1>");
});

it("Retour renders a real link to the fallback list when the tab has no history", () => {
  const html = renderToStaticMarkup(createElement(BackLink, { fallback: "/studio/sav/intake?view=to_validate&page=2" }));
  expect(html).toContain('href="/studio/sav/intake?view=to_validate&amp;page=2"');
  expect(html).toContain("Retour");
  expect(renderToStaticMarkup(createElement(BackLink, { fallback: "https://evil.example" }))).toContain('href="/studio"');
});
