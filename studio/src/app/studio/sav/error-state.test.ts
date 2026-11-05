import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: (props: ComponentProps<"a">) => createElement("a", props) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/studio/sav/pilote", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ back: vi.fn(), refresh: vi.fn() }) }));
import SavError from "./error";

// SAV-49 states: the old dossier, the pilot lab and the other SAV pages without
// their own error state show a real failure, never an empty or confirmed result.
it("says nothing was modified or confirmed, offers retry and the way back to the console", () => {
  const reset = vi.fn();
  const html = renderToStaticMarkup(createElement(SavError, { reset }));
  for (const text of ['role="alert"', "Cette page SAV n’est pas disponible", "Rien n’a été modifié", "aucun dossier, compteur ni résultat vide", "Réessayer", 'href="/studio/sav/intake"']) expect(html).toContain(text);
  expect(html).not.toMatch(/Aucun dossier\b|0 dossier/);
  expect(reset).not.toHaveBeenCalled();
});
