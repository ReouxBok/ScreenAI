import { describe, expect, it } from "vitest";
import { canonicalKnowledgeSchema } from "./contracts";
import { assertSavSupportDelivery, projectSavSupportDelivery, savDeliveryGroups, serializeSavDeliveryGroups, renderSavProcedureGroup, type SavSupportDelivery } from "./support-delivery";
import { createSavDeliveryEnvelope, readSavDeliveryEnvelope, savDeliveryHash } from "./delivery-envelope";
const document = canonicalKnowledgeSchema.parse({ schemaVersion: 1, objective: "Régler un panneau fictif", applicability: "sav_only", locale: "fr-FR", prerequisites: ["Accéder au panneau fictif."], exceptions: ["Option indisponible pour un lecteur."], expectedResult: "Nom visible.", escalation: "Contacter le support si le nom ne change pas.", steps: [
  { id: "panel.open", userLabel: "Ouvrir", objective: "Accéder", instruction: "Ouvrir le panneau fictif.", expectedResult: "Panneau affiché.", escalation: "" },
  { id: "panel.save", userLabel: "Enregistrer", objective: "Terminer", instruction: "Saisir le nom puis enregistrer.", expectedResult: "Nom enregistré.", escalation: "" },
  { id: "team.note", userLabel: "Consigne équipe", objective: "Suivi interne", instruction: "Ajouter une note dans le dossier interne.", expectedResult: "", escalation: "" },
] });
const delivery: SavSupportDelivery = { version: 1, mode: "procedure", internalStepIds: ["team.note"], groups: [{ id: "panel.rename", label: "Renommer le panneau", stepIds: ["panel.open", "panel.save"], requiresHuman: false, prerequisiteIndexes: [0], exceptionIndexes: [0], includeExpectedResult: true, includeEscalation: true }] };
describe("qualified support delivery", () => {
  it("renders every selected source step and context, excluding internal instructions", () => {
    const [group] = savDeliveryGroups(projectSavSupportDelivery(document, delivery));
    const text = renderSavProcedureGroup(group, "fr");
    for (const s of document.steps.slice(0, 2)) { expect(text).toContain(s.instruction); expect(text).toContain(s.expectedResult); }
    for (const s of [...document.prerequisites, ...document.exceptions, document.expectedResult, document.escalation]) expect(text).toContain(s);
    expect(text).not.toContain(document.steps[2].instruction);
  });
  it("requires explicit classification and valid complete step references", () => {
    expect(() => projectSavSupportDelivery(document, { version: 1, mode: "unclassified" })).toThrow("REVIEW_REQUIRED");
    expect(() => assertSavSupportDelivery(document, { ...delivery, internalStepIds: [] })).toThrow("STEP_UNCLASSIFIED");
    expect(() => assertSavSupportDelivery(document, { ...delivery, internalStepIds: ["panel.open", "team.note"] })).toThrow("REFERENCE_INVALID");
    expect(() => assertSavSupportDelivery(document, { ...delivery, groups: [{ ...delivery.groups[0], prerequisiteIndexes: [3] }] })).toThrow("REFERENCE_INVALID");
    expect(() => assertSavSupportDelivery(document, { version: 1, mode: "diagnostic" })).toThrow("DIAGNOSTIC_REQUIRED");
  });
  it("rejects unqualified variants and obsolete generated graphs in a procedure", () => {
    const changed = structuredClone(document); changed.steps[0].variants = [{ roles: ["reader"], productVersion: "", instruction: "Autre instruction fictive", expectedResult: "" }];
    expect(() => assertSavSupportDelivery(changed, delivery)).toThrow("VARIANT_REQUIRES_REVIEW");
    expect(() => assertSavSupportDelivery({ ...document, diagnostic: { requiredFacts: [], knownCauses: [], checks: [] } }, delivery)).toThrow("PROCEDURE_HAS_DIAGNOSTIC");
  });
  it("hashes JSONB key order consistently and rejects any changed reviewed document", () => {
    const envelope = createSavDeliveryEnvelope(document, delivery);
    const reordered = Object.fromEntries(Object.entries(document).reverse());
    expect(savDeliveryHash(reordered)).toBe(savDeliveryHash(document));
    expect(readSavDeliveryEnvelope(document, envelope).qualification).toEqual(delivery);
    expect(() => readSavDeliveryEnvelope({ ...document, objective: "Autre objectif fictif" }, envelope)).toThrow("DOCUMENT_CHANGED");
    expect(projectSavSupportDelivery(document, { version: 1, mode: "internal" }).groups).toEqual([]);
    // Canonical v1 remains unchanged and readable by the previous release.
    expect(canonicalKnowledgeSchema.parse(document)).toEqual(document);
  });
});

it("serializes shared steps once, keeps human-only instructions out of runtime and retains their review preview", () => {
  const repeated = { ...document, steps: document.steps.map(s => ({ ...s, instruction: "Consigne fictive longue. ".repeat(70) })) };
  const base = { ...delivery.groups[0], stepIds: repeated.steps.map(s => s.id) };
  const qualification = { ...delivery, internalStepIds: [], groups: [base, { ...base, id: "panel.other" }, { ...base, id: "panel.sensitive", requiresHuman: true }] };
  const projected = projectSavSupportDelivery(repeated, qualification);
  expect(projected.steps).toHaveLength(3);
  expect(projected.groups[2].stepIds).toEqual([]);
  const expanded = savDeliveryGroups(projected);
  expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(expanded).length);
  expect(savDeliveryGroups(projectSavSupportDelivery(repeated, qualification, true))[2].steps).toHaveLength(3);
  expect(serializeSavDeliveryGroups("procedure", expanded)).toEqual(projected);
});
