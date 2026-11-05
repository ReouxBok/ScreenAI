// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { emptyKnowledgeDocument } from "./knowledge-editor";
import { PasteEditor } from "./paste-editor";

it("reads a local file for preview and only changes the document after explicit application", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const apply = vi.fn();
  const pending = vi.fn();
  try {
    await act(async () => root.render(createElement(PasteEditor, {
      title: "", document: emptyKnowledgeDocument, onApply: apply, onPendingChange: pending,
    })));
    const text = "# Une procédure fictive\n## Objectif\nRetrouver la maquette\n## Procédure proposée\n1. Ouvrir la liste des maquettes.";
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = { size: text.length, text: async () => text };
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("textarea")?.value).toBe(text);
    expect(pending).toHaveBeenLastCalledWith(true);
    const button = (label: string) => [...container.querySelectorAll("button")].find(value => value.textContent === label)!;
    await act(async () => button("Prévisualiser le texte collé").click());
    expect(container.querySelector('[aria-label="Aperçu du texte collé"]')).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
    await act(async () => button("Appliquer au formulaire").click());
    expect(apply.mock.calls[0][0].document.steps[0].instruction).toBe("Ouvrir la liste des maquettes.");
    expect(pending).toHaveBeenLastCalledWith(false);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
