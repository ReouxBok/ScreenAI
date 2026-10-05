import { z } from "zod";

const label = z.string().trim().min(1).max(500);
const text = z.string().trim().max(5_000);
const list = z.array(label).max(50).default([]);
export const semanticStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,199}$/),
  userLabel: label,
  objective: label,
  instruction: z.string().trim().min(3).max(2_000),
  location: z.string().trim().max(200).default(""),
  prerequisites: list,
  expectedResult: text,
  exceptions: list,
  escalation: text,
  variants: z.array(z.object({ roles: list, productVersion: z.string().trim().max(100), instruction: z.string().trim().min(3).max(2_000), expectedResult: text }).strict()).max(20).default([]),
}).strict();
export type SemanticStep = z.infer<typeof semanticStepSchema>;
export const canonicalKnowledgeSchema = z.object({
  schemaVersion: z.literal(1),
  objective: label,
  applicability: z.enum(["shared", "sav_only", "onboarding_only", "not_applicable"]),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  productVersion: z.string().trim().max(100).default(""),
  validUntil: z.iso.date().optional(),
  prerequisites: list,
  expectedResult: text,
  exceptions: list,
  escalation: text,
  steps: z.array(semanticStepSchema).max(50),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.steps.map((step) => step.id)).size !== value.steps.length) ctx.addIssue({ code: "custom", message: "SEMANTIC_STEP_IDS_MUST_BE_UNIQUE", path: ["steps"] });
});
export type CanonicalKnowledge = z.infer<typeof canonicalKnowledgeSchema>;

/** Do not spread metadata here: the support projection is an explicit allowlist. */
export function supportProcedure(document: CanonicalKnowledge, context: { role?: string; productVersion?: string } = {}) {
  const parsed = canonicalKnowledgeSchema.parse(document);
  if (["onboarding_only", "not_applicable"].includes(parsed.applicability)) throw new Error("KNOWLEDGE_NOT_APPLICABLE_TO_SAV");
  if (parsed.validUntil && parsed.validUntil < new Date().toISOString().slice(0, 10)) throw new Error("KNOWLEDGE_EXPIRED");
  return parsed.steps.map((step) => {
    const applicable = step.variants.filter((variant) => (!variant.roles.length || (context.role && variant.roles.includes(context.role)))
      && (!variant.productVersion || variant.productVersion === context.productVersion));
    if (applicable.length > 1) throw new Error("KNOWLEDGE_VARIANT_AMBIGUOUS");
    if (step.variants.length && !applicable.length) throw new Error("KNOWLEDGE_VARIANT_CONTEXT_REQUIRED");
    return { id: step.id, userLabel: step.userLabel, instruction: applicable[0]?.instruction ?? step.instruction,
      location: step.location, prerequisites: step.prerequisites, expectedResult: applicable[0]?.expectedResult ?? step.expectedResult,
      exceptions: step.exceptions, escalation: step.escalation };
  });
}

export function assertKnowledgeUgoApproval(actorEmail: string) {
  if (actorEmail.trim().toLowerCase() !== "ugo@limova.ai") throw new Error("KNOWLEDGE_UGO_APPROVAL_REQUIRED");
}

/** Keep legacy Studio publication permissions; only SAV/new shared projections require Ugo. */
export function requiresKnowledgeUgoApproval(agentKey: string, metadata?: { sourceMetadata?: Record<string, unknown> }) {
  return agentKey === "sav" || Boolean(metadata?.sourceMetadata?.canonicalRevisionId);
}
