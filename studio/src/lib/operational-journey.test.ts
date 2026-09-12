import { describe, expect, it } from "vitest";
import { LIMOVA_CURRICULUM } from "./limova-curriculum";
import { buildOperationalJourney } from "./operational-journey";

describe("operational curriculum", () => {
  it("creates complete non-placeholder runbooks for every journey", () => {
    for (const entry of LIMOVA_CURRICULUM) {
      const result = buildOperationalJourney(entry);
      expect(result.bodyMarkdown, entry.title).not.toContain("À compléter par une démonstration");
      expect(result.bodyMarkdown, entry.title).toContain("## Étapes opérationnelles");
      expect(result.metadata.proposalSignals.length, entry.title).toBeGreaterThanOrEqual(3);
      expect(result.metadata.successCriteria.length, entry.title).toBeGreaterThanOrEqual(3);
      expect(result.metadata.branches.length, entry.title).toBeGreaterThanOrEqual(3);
      expect(result.metadata.fallbacks.length, entry.title).toBeGreaterThanOrEqual(4);
    }
  });

  it("describes organization creation end to end", () => {
    const entry = LIMOVA_CURRICULUM.find((item) => item.title === "Créer et configurer son organisation")!;
    const result = buildOperationalJourney(entry);
    expect(result.bodyMarkdown).toContain("Saisir le nom de l’entreprise");
    expect(result.bodyMarkdown).toContain("Créer le premier espace de travail");
  });
});
