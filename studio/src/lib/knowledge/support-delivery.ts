import { z } from "zod";
import type { CanonicalKnowledge } from "./contracts";

const stepId = z.string().min(3).max(200);
const indexes = z.array(z.number().int().nonnegative()).max(50);
const group = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/), label: z.string().trim().min(3).max(200),
  stepIds: z.array(stepId).min(1).max(50), requiresHuman: z.boolean(),
  prerequisiteIndexes: indexes, exceptionIndexes: indexes,
  includeExpectedResult: z.boolean(), includeEscalation: z.boolean(),
}).strict();
export const savSupportDeliverySchema = z.discriminatedUnion("mode", [
  z.object({ version: z.literal(1), mode: z.literal("unclassified") }).strict(),
  z.object({ version: z.literal(1), mode: z.literal("internal") }).strict(),
  z.object({ version: z.literal(1), mode: z.literal("diagnostic") }).strict(),
  z.object({ version: z.literal(1), mode: z.literal("procedure"), groups: z.array(group).min(1).max(20), internalStepIds: z.array(stepId).max(50) }).strict(),
]);
export type SavSupportDelivery = z.infer<typeof savSupportDeliverySchema>;
export const unclassifiedSavDelivery: SavSupportDelivery = { version: 1, mode: "unclassified" };

export function assertSavSupportDelivery(document: CanonicalKnowledge, raw: unknown): SavSupportDelivery {
  const delivery = savSupportDeliverySchema.parse(raw);
  if (delivery.mode === "diagnostic" && !document.diagnostic?.checks.length) throw new Error("SAV_DELIVERY_DIAGNOSTIC_REQUIRED");
  if (delivery.mode === "procedure") {
    if (document.diagnostic) throw new Error("SAV_DELIVERY_PROCEDURE_HAS_DIAGNOSTIC");
    const ids = new Set(document.steps.map(step => step.id));
    const unique = (values: unknown[]) => new Set(values).size === values.length;
    if (!unique(delivery.groups.map(g => g.id)) || !unique(delivery.internalStepIds) || delivery.internalStepIds.some(id => !ids.has(id))) throw new Error("SAV_DELIVERY_REFERENCE_INVALID");
    for (const g of delivery.groups) {
      if (!unique(g.stepIds) || g.stepIds.some(id => !ids.has(id) || delivery.internalStepIds.includes(id))
        || !unique(g.prerequisiteIndexes) || !unique(g.exceptionIndexes)
        || g.prerequisiteIndexes.some(i => i >= document.prerequisites.length) || g.exceptionIndexes.some(i => i >= document.exceptions.length)) throw new Error("SAV_DELIVERY_REFERENCE_INVALID");
      if (g.stepIds.some(id => document.steps.find(step => step.id === id)!.variants.length)) throw new Error("SAV_DELIVERY_VARIANT_REQUIRES_REVIEW");
    }
    const classified = new Set([...delivery.internalStepIds, ...delivery.groups.flatMap(g => g.stepIds)]);
    if (document.steps.some(step => !classified.has(step.id))) throw new Error("SAV_DELIVERY_STEP_UNCLASSIFIED");
  }
  return delivery;
}

const lines = z.array(z.string().max(500)).max(50);
const projectedStep = z.object({ id: stepId, userLabel: z.string().max(500), instruction: z.string().min(3).max(2000), expectedResult: z.string().max(5000), location: z.string().max(200).optional(),
  prerequisites: lines, exceptions: lines, escalation: z.string().max(5000) }).strict();
const projectedGroup = z.object({ id: z.string().min(2).max(80), label: z.string().min(3).max(200), requiresHuman: z.boolean(),
  prerequisites: lines, exceptions: lines, expectedResult: z.string().max(5000), escalation: z.string().max(5000) });
export const savProcedureGroupsSchema = z.array(projectedGroup.extend({ steps: z.array(projectedStep).max(50) }).strict()).max(20);
export const savSupportDeliveryProjectionSchema = z.object({ version: z.literal(1), mode: z.enum(["internal", "procedure", "diagnostic"]),
  steps: z.array(projectedStep).max(50), groups: z.array(projectedGroup.extend({ stepIds: z.array(stepId).max(50) }).strict()).max(20),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.steps.map(s => s.id));
  if (ids.size !== value.steps.length || new Set(value.groups.map(g => g.id)).size !== value.groups.length
    || (value.mode === "procedure") !== (value.groups.length > 0)
    || value.groups.some(g => (!g.requiresHuman && !g.stepIds.length) || new Set(g.stepIds).size !== g.stepIds.length || g.stepIds.some(id => !ids.has(id)))) ctx.addIssue({ code: "custom", message: "SAV_DELIVERY_REFERENCE_INVALID" });
});
export type SavSupportDeliveryProjection = z.infer<typeof savSupportDeliveryProjectionSchema>;
export type SavProcedureGroup = z.infer<typeof savProcedureGroupsSchema>[number];
export function savDeliveryGroups(raw: unknown): SavProcedureGroup[] {
  const projection = savSupportDeliveryProjectionSchema.parse(raw);
  return projection.groups.map(({ stepIds, ...g }) => ({ ...g, steps: stepIds.map(id => projection.steps.find(s => s.id === id)!) }));
}
// Shared source steps are serialized once, even when several alternatives use them.
export function serializeSavDeliveryGroups(mode: SavSupportDeliveryProjection["mode"], groups: SavProcedureGroup[]) {
  return savSupportDeliveryProjectionSchema.parse({ version: 1, mode,
    steps: [...new Map(groups.flatMap(g => g.steps).map(s => [s.id, s])).values()],
    groups: groups.map(({ steps, ...g }) => ({ ...g, stepIds: steps.map(s => s.id) })),
  });
}

export function projectSavSupportDelivery(document: CanonicalKnowledge, raw: unknown, reviewHumanInstructions = false) {
  const delivery = assertSavSupportDelivery(document, raw);
  if (delivery.mode === "unclassified") throw new Error("SAV_DELIVERY_REVIEW_REQUIRED");
  return serializeSavDeliveryGroups(delivery.mode, delivery.mode === "procedure" ? delivery.groups.map(source => {
      // The model only needs the purpose of a human-only objective. Its full
      // source remains available in the explicit review preview.
      const g = source.requiresHuman && !reviewHumanInstructions ? { ...source, stepIds: [], prerequisiteIndexes: [], exceptionIndexes: [], includeExpectedResult: false, includeEscalation: false } : source;
      return ({ id: g.id, label: g.label, requiresHuman: g.requiresHuman,
      steps: g.stepIds.map(id => { const s = document.steps.find(step => step.id === id)!; return { id, userLabel: s.userLabel, instruction: s.instruction, expectedResult: s.expectedResult, location: s.location, prerequisites: s.prerequisites, exceptions: s.exceptions, escalation: s.escalation }; }),
      prerequisites: g.prerequisiteIndexes.map(i => document.prerequisites[i]), exceptions: g.exceptionIndexes.map(i => document.exceptions[i]),
      expectedResult: g.includeExpectedResult ? document.expectedResult : "", escalation: g.includeEscalation ? document.escalation : "" }); }) : []);
}

export function renderSavProcedureGroup(group: SavProcedureGroup, language: "fr" | "en") {
  const en = language === "en";
  return [...group.prerequisites.map(s => `${en ? "Before you start" : "Avant de commencer"} : ${s}`),
    ...group.steps.map(s => [s.userLabel, ...(s.location ? [`${en ? "Location" : "Emplacement"} : ${s.location}`] : []), ...s.prerequisites, s.instruction,
      ...(s.expectedResult ? [`${en ? "Expected result to check" : "Résultat à vérifier"} : ${s.expectedResult}`] : []), ...s.exceptions, ...(s.escalation ? [s.escalation] : [])].join("\n")),
    ...group.exceptions, ...(group.expectedResult ? [`${en ? "Expected result to check" : "Résultat à vérifier"} : ${group.expectedResult}`] : []), ...(group.escalation ? [group.escalation] : []),
  ].join("\n\n");
}
