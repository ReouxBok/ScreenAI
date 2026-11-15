// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const actions = vi.hoisted(() => ({ verify: vi.fn(), save: vi.fn() }));
vi.mock("./workspace-actions", () => ({ verifyKnowledgeCardAction: actions.verify, saveKnowledgeProposalAction: actions.save, previewKnowledgeProposalAction: vi.fn(), submitKnowledgeProposalAction: vi.fn(), findKnowledgeAction: vi.fn(), loadKnowledgeTargetAction: vi.fn(), loadSavFactDictionaryAction: vi.fn(async () => []) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
import { KnowledgeProposalForm } from "./proposal-form";

it("« Vérifier ma fiche » sends the form as it is, lists every problem with its field, and saves nothing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  actions.verify.mockResolvedValue({ error: null, verification: { ok: false, errors: 2, warnings: 1, problems: [
    { field: "steps.0.instruction", fieldLabel: "Étape 1 · instruction", severity: "error", code: "unsafe_email", message: "Retirez : adresse e-mail." },
    { field: "delivery", fieldLabel: "Restitution", severity: "error", code: "delivery_unclassified", message: "Qualifier la restitution." },
    { field: "productVersion", fieldLabel: "Version produit", severity: "warning", code: "product_version_missing", message: "Version produit recommandée." },
  ] } });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(KnowledgeProposalForm, { initial: null })));
    const button = [...container.querySelectorAll("button")].find(value => value.textContent === "Vérifier ma fiche")!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
    expect(actions.verify).toHaveBeenCalledTimes(1);
    expect(actions.verify.mock.calls[0][0]).toMatchObject({ title: "", delivery: { mode: "unclassified" }, reason: "" });
    expect(actions.save).not.toHaveBeenCalled();
    const panel = container.querySelector('[aria-label="Vérification de la fiche"]')!;
    expect(panel.textContent).toContain("2 problèmes à corriger, 1 point à revoir.");
    expect([...panel.querySelectorAll("li")].map(item => item.textContent)).toEqual([
      "À corriger · Étape 1 · instruction : Retirez : adresse e-mail.",
      "À corriger · Restitution : Qualifier la restitution.",
      "À revoir · Version produit : Version produit recommandée.",
    ]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
