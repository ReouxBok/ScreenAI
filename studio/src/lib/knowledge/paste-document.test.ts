import { describe, expect, it } from "vitest";
import { parsePastedKnowledge } from "./paste-document";
import type { CanonicalKnowledge } from "./contracts";

const base: CanonicalKnowledge = {
  schemaVersion: 1, applicability: "shared", locale: "fr-FR", productVersion: "2", validUntil: "2027-01-01",
  objective: "Consulter le dossier.", expectedResult: "Dossier visible.", exceptions: [], prerequisites: [], escalation: "",
  onboardingContext: { entryPoint: "Accueil", sourceNotes: ["Tutoriel vérifié"] },
  steps: [{ id: "step.original", userLabel: "Ouvrir", objective: "Afficher le dossier", instruction: "Ouvrez le dossier.", location: "Accueil", expectedResult: "", prerequisites: [], exceptions: [], escalation: "", variants: [] }],
};

describe("collage d’une fiche de connaissances", () => {
  it("préserve l’identité des étapes lors d’une insertion et les champs non représentés", () => {
    const { title, document } = parsePastedKnowledge("# Fiche 22 — Dossier\n## Procédure proposée\n1. Consultez [le guide](https://example.invalid/guide).\n2. **Ouvrez le dossier.**\nRésultat de l’étape : Dossier visible.", base);
    expect(title).toBe("Dossier"); expect(document.steps[0].instruction).toContain("https://example.invalid/guide");
    expect(document.steps[1]).toEqual({ ...base.steps[0], expectedResult: "Dossier visible." });
    expect(document.onboardingContext).toEqual(base.onboardingContext);
    expect(document.validUntil).toBe(base.validUntil);
  });
  it("conserve la qualification pour un collage inchangé", () => {
    expect(parsePastedKnowledge("## Objectif\n" + base.objective, base).document).toBe(base);
  });
  it("conserve les paragraphes de réponse et les sources du tutoriel", () => {
    const { document } = parsePastedKnowledge("## Exemple de réponse à adapter\nBonjour,\n\nMerci.\n## Point d’entrée\nÉcran initial", base);
    expect(document.supportContext?.responseTemplate).toBe("Bonjour,\n\nMerci.");
    expect(document.onboardingContext).toEqual({ ...base.onboardingContext, entryPoint: "Écran initial" });
  });
  it("refuse la suppression implicite d’une étape à conditions", () => {
    expect(() => parsePastedKnowledge("## Procédure proposée\n1. Remplacez le dossier.", { ...base, steps: [{ ...base.steps[0], prerequisites: ["Accès autorisé"] }] })).toThrow("conditions");
  });
  it.each(["## Inconnue\nTexte", "## Objectif\nUn\n## Objectif\nDeux", "## Procédure proposée\nNote sans numéro", "Texte sans rubrique"])("signale un format incomplet sans modifier le document initial", text => {
    const before = JSON.stringify(base);
    expect(() => parsePastedKnowledge(text, base)).toThrow();
    expect(JSON.stringify(base)).toBe(before);
  });
});
