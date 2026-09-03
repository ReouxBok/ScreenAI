import { describe, expect, it } from "vitest";
import { compileLearnedActionSteps, learnedActionsMarkdown } from "./action-trace";
import type { TrainingEventShape } from "./training-events";

const event = (kind: string, label: string, path: string, payload: TrainingEventShape["payload"] = {}): TrainingEventShape => ({ kind, label, path, payload });

describe("learned action trace", () => {
  it("compile une cible stable et son résultat sans conserver les valeurs saisies", () => {
    const steps = compileLearnedActionSteps([
      event("page_context", "Structure de page observée", "https://new.limova.ai/integrations/catalog", {
        context: '[main]\n  h1: "Intégrations"\n  [7] input(search) "Rechercher des intégrations..."',
      }),
      event("input", "Rechercher des intégrations...", "https://new.limova.ai/integrations/catalog", {
        tag: "input", inputType: "search", elementId: "integration-search", section: "Catalogue", filled: true,
      }),
      event("click", "Connecter HubSpot", "https://new.limova.ai/integrations/catalog", {
        gestureId: "gesture-1", controlType: "bouton", tag: "button", role: "button", elementId: "connectHubspot",
        testId: "connect-hubspot", section: "HubSpot", zone: "main", occurrence: 1,
      }),
      event("page_context", "Résultat après clic · Connecter HubSpot", "https://new.limova.ai/integrations/catalog", {
        phase: "after_click", gestureId: "gesture-1", context: '[modal]\n  h2: "Connecter HubSpot"',
        networkSummary: "POST /api/integrations/connect status:200 143ms",
      }),
    ]);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ action: "input", expected: { fieldFilled: true } });
    expect(steps[1]).toMatchObject({
      action: "click",
      confidence: "strong",
      target: { domId: "connectHubspot", testId: "connect-hubspot", section: "HubSpot", occurrence: 1 },
      expected: { pageMarkers: ["[modal]", 'h2: "Connecter HubSpot"'], network: ["POST /api/integrations/connect status:200"] },
    });
    expect(JSON.stringify(steps)).not.toContain("valeur privée");
  });

  it("fusionne le cycle d’une autorisation externe", () => {
    const steps = compileLearnedActionSteps([
      event("page_context", "Fenêtre d’autorisation externe ouverte", "https://new.limova.ai/integrations/catalog", { phase: "opened" }),
      event("page_context", "Fenêtre d’autorisation externe fermée", "https://new.limova.ai/integrations/catalog", { phase: "closed", popupCount: 2 }),
    ]);
    expect(steps).toEqual([expect.objectContaining({ action: "external_popup", expected: expect.objectContaining({ popup: "opened_then_closed" }) })]);
  });

  it("produit des repères lisibles sans sélecteur CSS", () => {
    const markdown = learnedActionsMarkdown(compileLearnedActionSteps([
      event("click", "Connecter Gmail", "/integrations", { controlType: "contrôle cliquable", testId: "gmail-card", section: "Gmail" }),
    ]));
    expect(markdown).toContain("Repères techniques appris");
    expect(markdown).toContain("test-id=gmail-card");
    expect(markdown).toContain("zone=Gmail");
    expect(markdown).not.toContain("querySelector");
  });
});
