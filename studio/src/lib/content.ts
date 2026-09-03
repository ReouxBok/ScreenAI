import { z } from "zod";
import { AGENTS } from "./agents";

export const CATEGORIES = [
  ["bien-demarrer", "Bien démarrer"],
  ["super-pouvoirs", "Super-pouvoirs"],
  ["agents", "Agents"],
  ["integrations", "Intégrations"],
  ["compte-equipe", "Compte et équipe"],
  ["facturation", "Facturation"],
  ["depannage", "Dépannage"],
  ["securite-confidentialite", "Sécurité et confidentialité"],
] as const;

const nonEmptyString = z.string().trim().min(1).max(500);
const stringList = z.array(nonEmptyString).max(50).default([]);
const agentKey = z.enum(AGENTS.map((agent) => agent.key) as ["charly", "elio", "john", "lou", "tom", "sav", "common"]);

export const articleMetadataSchema = z.object({
  intents: stringList,
  limovaPaths: stringList,
  prerequisites: stringList,
  expectedResult: z.string().trim().max(5000).default(""),
  troubleshooting: z.string().trim().max(10000).default(""),
  sourceMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const learnedActionStepSchema = z.object({
  order: z.number().int().min(1).max(100),
  action: z.enum(["click", "input", "external_popup"]),
  path: z.string().trim().min(1).max(1000),
  label: z.string().trim().min(1).max(500),
  confidence: z.enum(["strong", "medium", "weak"]),
  target: z.object({
    controlType: z.string().trim().max(60).optional(),
    tag: z.string().trim().max(30).optional(),
    role: z.string().trim().max(50).optional(),
    domId: z.string().trim().max(120).optional(),
    testId: z.string().trim().max(120).optional(),
    hrefPath: z.string().trim().max(300).optional(),
    zone: z.string().trim().max(40).optional(),
    section: z.string().trim().max(160).optional(),
    ariaLabel: z.string().trim().max(160).optional(),
    title: z.string().trim().max(160).optional(),
    occurrence: z.number().int().min(1).max(100).optional(),
  }).optional(),
  preconditions: z.array(z.string().trim().min(1).max(180)).max(10).default([]),
  expected: z.object({
    path: z.string().trim().max(1000).optional(),
    popup: z.literal("opened_then_closed").optional(),
    pageMarkers: z.array(z.string().trim().min(1).max(180)).max(10).default([]),
    network: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
    fieldFilled: z.boolean().optional(),
  }),
});

export const onboardingMetadataSchema = z.object({
  objective: nonEmptyString,
  proposalSignals: stringList,
  qualificationQuestions: stringList,
  expectedPages: stringList,
  successCriteria: stringList,
  branches: z.array(z.object({ condition: nonEmptyString, next: nonEmptyString })).max(30).default([]),
  fallbacks: stringList,
  actionSteps: z.array(learnedActionStepSchema).max(50).default([]),
});

export const contentInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("article"),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160),
    locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
    title: nonEmptyString,
    summary: z.string().trim().min(1).max(1000),
    categorySlug: nonEmptyString,
    visibility: z.enum(["charly_only", "charly_and_help"]),
    agentKey,
    ownerEmail: z.email(),
    bodyMarkdown: z.string().trim().min(20).max(200_000),
    changeNote: z.string().trim().min(3).max(1000),
    metadata: articleMetadataSchema,
  }),
  z.object({
    type: z.literal("onboarding"),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160),
    locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
    title: nonEmptyString,
    summary: z.string().trim().min(1).max(1000),
    categorySlug: nonEmptyString,
    visibility: z.literal("charly_only"),
    agentKey,
    ownerEmail: z.email(),
    bodyMarkdown: z.string().trim().min(20).max(200_000),
    changeNote: z.string().trim().min(3).max(1000),
    metadata: onboardingMetadataSchema,
  }),
]);

export const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(2).max(2000),
  path: z.string().trim().max(1000).optional().default(""),
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).default("fr-FR"),
  contentTypes: z.array(z.enum(["article", "onboarding"])).min(1).max(2).default(["article", "onboarding"]),
  scope: z.enum(["extension", "sav"]).default("extension"),
  limit: z.number().int().min(1).max(10).default(5),
});

const dangerousHtml = /<\s*(script|iframe|object|embed|style|form|input|button|svg|math)\b/i;
const anyHtml = /<\/?[a-z][^>]*>/i;
const dangerousLink = /\]\(\s*(?:javascript|data|vbscript):/i;

export function assertSafeMarkdown(markdown: string) {
  if (dangerousHtml.test(markdown) || anyHtml.test(markdown)) {
    throw new Error("HTML_NOT_ALLOWED");
  }
  if (dangerousLink.test(markdown)) throw new Error("UNSAFE_LINK");

  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].trim().split(/\s+/)[0];
    if (!target || target.startsWith("#") || target.startsWith("/") || target.startsWith("mailto:")) continue;
    try {
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error("UNSAFE_LINK");
    } catch {
      throw new Error("INVALID_LINK");
    }
  }
}

export type ContentInput = z.infer<typeof contentInputSchema>;

export function parseContentInput(input: unknown): ContentInput {
  const parsed = contentInputSchema.parse(input);
  assertSafeMarkdown(parsed.bodyMarkdown);
  return parsed;
}
