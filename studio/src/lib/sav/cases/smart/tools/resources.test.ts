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

  it("autorise uniquement les URL exactes enregistrées", () => {
    for (const { url } of SAV_SMART_RESOURCES) {
      expect(isSmartResourceUrlAllowed(url)).toBe(true);
      expect(isSmartResourceUrlAllowed(url + "?redirect=example.com")).toBe(false);
    }
    expect(isSmartResourceUrlAllowed("https://academy.limova.ai.evil.example")).toBe(false);
    expect(isSmartResourceUrlAllowed("https://academy.limova.ai/tutoriels")).toBe(false);
  });
});
