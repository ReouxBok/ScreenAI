import { describe, expect, it } from "vitest";
import { assertKnowledgeUgoApproval, canonicalKnowledgeSchema, supportProcedure } from "./contracts";
const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Retrouver ses factures", applicability: "shared", locale: "fr-FR", expectedResult: "Liste des factures visible", escalation: "Contacter le support si le menu manque.", steps: [{ id: "billing.open-settings", userLabel: "Paramètres", objective: "Ouvrir les paramètres", instruction: "Ouvrez Paramètres en bas à gauche.", location: "en bas à gauche", expectedResult: "Paramètres visibles", escalation: "Vérifier les droits." }, { id: "billing.list-invoices", userLabel: "Factures", objective: "Consulter les factures", instruction: "Ouvrez Facturation, puis Factures.", expectedResult: "Liste des factures visible", escalation: "Contacter le support." }] });
describe("shared semantic steps", () => {
  it("provides the written navigation with no execution details", () => {
    const result = supportProcedure(document);
    expect(result.map((step) => step.instruction)).toEqual(["Ouvrez Paramètres en bas à gauche.", "Ouvrez Facturation, puis Factures."]);
    expect(JSON.stringify(result)).not.toMatch(/testId|domId|selector|path|network/);
  });
  it("rejects DOM fields instead of silently mixing projections", () => {
    expect(() => canonicalKnowledgeSchema.parse({ ...document, steps: [{ ...document.steps[0], testId: "settings" }] })).toThrow();
    expect(() => canonicalKnowledgeSchema.parse({ ...document, steps: [document.steps[0], document.steps[0]] })).toThrow("SEMANTIC_STEP_IDS_MUST_BE_UNIQUE");
  });
  it("requires known roles/versions for variations rather than choosing a path", () => {
    const varied = { ...document, steps: [{ ...document.steps[0], variants: [{ roles: ["admin"], productVersion: "2026.10", instruction: "Ouvrez Facturation équipe.", expectedResult: "Factures équipe visibles" }] }] };
    expect(() => supportProcedure(varied)).toThrow("KNOWLEDGE_VARIANT_CONTEXT_REQUIRED");
    expect(supportProcedure(varied, { role: "admin", productVersion: "2026.10" })[0].instruction).toBe("Ouvrez Facturation équipe.");
  });
  it("requires Ugo for knowledge publication, including emergency paths", () => {
    expect(() => assertKnowledgeUgoApproval("reouven@limova.ai")).toThrow("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
    expect(() => assertKnowledgeUgoApproval(" UGO@limova.ai ")).not.toThrow();
  });
});
