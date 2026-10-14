import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const action = vi.hoisted(() => vi.fn());
vi.mock("./open-email-actions", () => ({ recordSavDossierOpenedAction: action }));
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
import { SavDossierBackLink, SavDossierOpened } from "./dossier-opened";
afterEach(() => action.mockClear());
describe("SAV-55 opening client boundary", () => {
  it("does not mark read during server rendering or prefetch", () => {
    expect(renderToStaticMarkup(createElement(SavDossierOpened, { threadId: "10000000-0000-4000-8000-000000000001", messageId: "10000000-0000-4000-8000-000000000002" }))).toBe("");
    expect(action).not.toHaveBeenCalled();
  });
  it("renders a local return link with filters before browser hydration", () => {
    const html = renderToStaticMarkup(createElement(SavDossierBackLink, { threadId: "fixture", returnTo: "/studio/sav?view=completed&q=Téléphonie&page=2&sort=oldest" }));
    expect(html).toContain('href="/studio/sav?view=completed&amp;q=T%C3%A9l%C3%A9phonie&amp;page=2&amp;sort=oldest"');
    expect(action).not.toHaveBeenCalled();
  });
  it("rejects foreign return destinations without reading browser storage on the server", () => {
    const html = renderToStaticMarkup(createElement(SavDossierBackLink, { threadId: "fixture", returnTo: "https://example.invalid" }));
    expect(html).toContain('href="/studio/sav"');
  });
});
