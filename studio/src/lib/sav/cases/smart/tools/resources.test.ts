import { describe, expect, it } from "vitest";
import { isSmartResourceUrlAllowed, SAV_SMART_RESOURCES, SMART_RESOURCES_PROMPT } from "./resources";

describe("ressources à proposer en SAV", () => {
  it("expose les trois liens et leur usage dans un bloc court", () => {
    expect(SAV_SMART_RESOURCES).toHaveLength(3);
    for (const resource of SAV_SMART_RESOURCES) {
      expect(resource.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(resource.allowed).toBe(true);
      expect(SMART_RESOURCES_PROMPT).toContain(resource.url);
      expect(SMART_RESOURCES_PROMPT).toContain(resource.whenToOffer);
    }
    expect(SMART_RESOURCES_PROMPT).toContain("prise en main");
    expect(SMART_RESOURCES_PROMPT).toContain("tutoriel d’installation");
    expect(SMART_RESOURCES_PROMPT.split("\n")).toHaveLength(4);
  });

  it("retours d'Ugo du 20/11 : jamais de rendez-vous individuel, parcours d'une intégration, le délai seulement sur demande", () => {
    const [webinars, , academy] = SAV_SMART_RESOURCES;
    expect(webinars!.whenToOffer).toContain("Ne jamais proposer de rendez-vous individuel");
    expect(webinars!.whenToOffer).toContain("en haut à droite de l’écran « Nouvelle conversation »");
    expect(academy!.whenToOffer).toMatch(/d’abord dans Limova, menu Intégrations ; sinon dans l’Academy[^]*en cours d’ajout[^]*Proposer une intégration/);
    expect(academy!.whenToOffer).toContain("Ne donner un délai que si le client le demande");
    expect(academy!.whenToOffer).toContain("15 à 30 jours");
    expect(academy!.whenToOffer).toContain("jamais de token API");
    expect(academy!.whenToOffer).toContain("lien Academy de l’intégration");
  });

  it("autorise uniquement les URL exactes enregistrées", () => {
    for (const { url } of SAV_SMART_RESOURCES) {
      expect(isSmartResourceUrlAllowed(url)).toBe(true);
      expect(isSmartResourceUrlAllowed(url + "?redirect=example.com")).toBe(false);
    }
    expect(isSmartResourceUrlAllowed("https://academy.limova.ai.evil.example")).toBe(false);
    expect(isSmartResourceUrlAllowed("https://academy.limova.ai/tutoriels")).toBe(false);
  });
});
