import { describe, expect, it } from "vitest";
import { articleMetadataFromForm } from "./article-form";

const now = new Date("2026-10-09T12:00:00Z");
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({ agentKey: "sav", savResolution: "on", savAudience: "lead",
    savResponseTemplate: "Bonjour, consultez le formulaire de démonstration fictif : https://example.invalid/demo.",
    savSymptoms: "Demande de découverte produit avant achat", savSteps: "Orienter vers le formulaire fictif",
    savEscalation: "Qualifier humainement en cas de doute", savSourceReference: "Modèle fictif fourni pour la recette", savSourceDate: "2026-10-08" })) data.set(key, value);
  return data;
}
describe("Staff SAV article metadata", () => {
  it("records authenticated staff provenance without accepting hidden CRM provenance", () => {
    const data = form(); data.set("sourceMetadata", '{"importKind":"hubspot","ticketId":"invented"}');
    const metadata = articleMetadataFromForm(data, "staff@example.invalid", {}, now);
    expect(metadata.resolution).toMatchObject({ audience: "lead", steps: ["Orienter vers le formulaire fictif"] });
    expect(metadata.sourceMetadata).toEqual({ editorialSource: { kind: "staff_supplied", reference: "Modèle fictif fourni pour la recette",
      suppliedOn: "2026-10-08", recordedBy: "staff@example.invalid", recordedAt: now.toISOString() } });
  });
  it("preserves database-owned source identities and conflict relationships during edits", () => {
    const metadata = articleMetadataFromForm(form(), "staff@example.invalid", { sourceMetadata: { importKind: "hubspot", ticketId: "real-fixture", canonicalRevisionId: "canonical-fixture" },
      semanticSteps: [{ id: "fixture.step-1", userLabel: "Étape fictive", objective: "Objectif fictif", instruction: "Instruction fictive à préserver", expectedResult: "Résultat fictif", escalation: "Qualification humaine" }],
      resolution: { supersedes: ["older-fixture"], conflictsWith: ["conflict-fixture"] } }, now);
    expect(metadata.sourceMetadata).toMatchObject({ ticketId: "real-fixture", canonicalRevisionId: "canonical-fixture" });
    expect(metadata.semanticSteps?.[0]).toMatchObject({ id: "fixture.step-1", instruction: "Instruction fictive à préserver" });
    expect(metadata.resolution).toMatchObject({ supersedes: ["older-fixture"], conflictsWith: ["conflict-fixture"] });
  });
  it("preserves an existing resolution when an older generic form does not submit its fields", () => {
    const metadata = articleMetadataFromForm(form(), "staff@example.invalid", {}, now);
    const oldForm = new FormData(); oldForm.set("agentKey", "sav");
    expect(articleMetadataFromForm(oldForm, "staff@example.invalid", metadata, now).resolution).toEqual(metadata.resolution);
  });
  it.each(["savSymptoms", "savSteps", "savSourceReference", "savSourceDate", "savEscalation", "savResponseTemplate"])("rejects missing required field %s server-side", key => {
    const data = form(); data.delete(key);
    expect(() => articleMetadataFromForm(data, "staff@example.invalid", {}, now)).toThrow();
  });
  it("rejects future source dates and another agent scope", () => {
    const data = form(); data.set("savSourceDate", "2026-10-10");
    expect(() => articleMetadataFromForm(data, "staff@example.invalid", {}, now)).toThrow("SAV_KNOWLEDGE_SOURCE_DATE_IN_FUTURE");
    data.set("agentKey", "charly");
    expect(() => articleMetadataFromForm(data, "staff@example.invalid", {}, now)).toThrow("SAV_KNOWLEDGE_SCOPE_REQUIRED");
  });
  it.each(["Bonjour, voici le formulaire fictif.\n\nCharly", "Bonjour, voici le formulaire fictif.\n\nL’équipe Limova", "Bonjour, voici le formulaire fictif.\n\n**Charly+**", "Bonjour, réponse préparée avec une IA.", "<script>alert(1)</script>"])("rejects a signed or unsafe lead template", template => {
    const data = form(); data.set("savResponseTemplate", template);
    expect(() => articleMetadataFromForm(data, "staff@example.invalid", {}, now)).toThrow();
  });
  it("keeps extension articles free of SAV fields", () => {
    const data = new FormData(); data.set("agentKey", "charly"); data.set("intents", "Invitation équipe");
    expect(articleMetadataFromForm(data, "staff@example.invalid", {}, now)).toMatchObject({ intents: ["Invitation équipe"] });
    expect(articleMetadataFromForm(data, "staff@example.invalid", {}, now).resolution).toBeUndefined();
  });
});
