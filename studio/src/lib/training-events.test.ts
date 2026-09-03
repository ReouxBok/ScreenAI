import { describe, expect, it } from "vitest";
import { compactTrainingEvents, type TrainingEventShape } from "./training-events";

const event = (kind: string, label: string, path = "/integrations", payload: TrainingEventShape["payload"] = {}): TrainingEventShape => ({ kind, label, path, payload });

describe("compactTrainingEvents", () => {
  it("fusionne les boucles de navigation, clics, champs et fenêtres OAuth", () => {
    const result = compactTrainingEvents([
      event("navigation", "Catalogue"),
      event("page_context", "Structure de page observée"),
      event("click", "Intégrations", "/"),
      event("click", "Intégrations"),
      event("input", "Rechercher des intégrations..."),
      event("input", "Rechercher des intégrations..."),
      event("page_context", "Fenêtre d’autorisation externe ouverte"),
      event("page_context", "Fenêtre d’autorisation externe fermée", "/", { popupCount: 1 }),
      event("page_context", "Fenêtre d’autorisation externe ouverte"),
      event("page_context", "Fenêtre d’autorisation externe fermée", "/", { popupCount: 3 }),
      event("voice_note", "Sélectionnez le compte HubSpot."),
      event("page_context", "Résultat après clic · Connecter HubSpot", "/integrations", { phase: "after_click", gestureId: "g-1" }),
    ]);

    expect(result.map(item => item.label)).toEqual([
      "Catalogue",
      "Intégrations",
      "Rechercher des intégrations...",
      "Fenêtre d’autorisation externe ouverte",
      "Fenêtre d’autorisation externe fermée",
      "Sélectionnez le compte HubSpot.",
      "Résultat après clic · Connecter HubSpot",
    ]);
    expect(result[4].payload).toEqual({ popupCount: 3 });
  });
});
