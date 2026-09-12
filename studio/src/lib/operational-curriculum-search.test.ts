import { describe, expect, it } from "vitest";
import { searchOperationalCurriculum } from "./operational-curriculum-search";

describe("operational curriculum search", () => {
  it("returns the complete organization runbook for an exact request", () => {
    const [result] = searchOperationalCurriculum("Créer et configurer son organisation", "/organizations/new");
    expect(result.title).toBe("Créer et configurer son organisation");
    expect(result.source).toBe("curriculum/creer-et-configurer-son-organisation");
    expect(result.content).toContain("Saisir le nom de l’entreprise");
    expect(result.content).toContain("## Vérification de réussite");
  });

  it("finds a channel-specific journey from natural wording", () => {
    const results = searchOperationalCurriculum("Aide-moi à connecter et diagnostiquer WhatsApp", "/organizations/acme/workspaces/demo/agents");
    expect(results[0]?.title).toBe("Connecter et diagnostiquer WhatsApp");
  });

  it("does not answer an unrelated request from the curriculum", () => {
    expect(searchOperationalCurriculum("prévisions météorologiques à Tokyo")).toEqual([]);
  });
});
