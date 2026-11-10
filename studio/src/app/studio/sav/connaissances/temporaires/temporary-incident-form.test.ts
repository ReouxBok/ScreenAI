// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
const save = vi.hoisted(() => vi.fn());
vi.mock("../workspace-actions", () => ({ saveKnowledgeProposalAction: save }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never) }));
import { TemporaryIncidentForm } from "./temporary-incident-form";
beforeEach(() => { save.mockReset(); });
async function form() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"), root = createRoot(container);
  await act(async () => root.render(createElement(TemporaryIncidentForm)));
  const values = ["syn-routine-delay", "SYN routine en retard", "Routines", "2026-11-10T08:00:00Z", "2026-11-12T08:00:00Z", "Signalement interne SYN à vérifier"];
  await act(async () => {
    [...container.querySelectorAll("input")].forEach((field, i) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, values[i]); field.dispatchEvent(new Event("input", { bubbles: true })); });
    const field = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "L’équipe examine le retard de cette routine."); field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = (label: RegExp) => [...container.querySelectorAll("button")].find(value => label.test(value.textContent ?? ""))!;
  return { container, root, button, close: async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); } };
}
it("previews and saves one new draft despite double click, with a truthful unsubmitted state", async () => {
  const f = await form();
  let resolve!: (value: unknown) => void;
  save.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  try {
    await act(async () => f.button(/Prévisualiser/).click());
    expect(f.container.querySelector('[aria-label="Aperçu de l’incident proposé"]')).not.toBeNull();
    await act(async () => { f.button(/Enregistrer/).click(); f.button(/Enregistr/).click(); });
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0][0]).toMatchObject({ mode: "new", sources: [], document: { temporaryIncident: { id: "syn-routine-delay" } } });
    await act(async () => resolve({ draft: { id: "10000000-0000-4000-8000-000000000001", status: "draft" } }));
    expect(f.container.textContent).toContain("non soumis, non publié, non activé");
    expect(f.button(/Enregistrer/).disabled).toBe(true);
  } finally { await f.close(); }
});
it.each(["transport", "server"])("keeps an unconfirmed save protected instead of retrying creation (%s)", async failure => {
  const f = await form();
  if (failure === "transport") save.mockRejectedValueOnce(Error("network unknown"));
  else save.mockResolvedValueOnce({ draft: null, error: "Action non confirmée" });
  try {
    await act(async () => f.button(/Prévisualiser/).click());
    await act(async () => f.button(/Enregistrer/).click());
    expect(f.container.textContent).toContain("Résultat d’enregistrement non confirmé");
    expect(f.button(/Enregistrer/).disabled).toBe(true);
    await act(async () => f.button(/Enregistrer/).click()); expect(save).toHaveBeenCalledTimes(1);
    expect(f.container.querySelector('a[href="/studio/sav/connaissances?tab=proposals"]')).not.toBeNull();
  } finally { await f.close(); }
});
