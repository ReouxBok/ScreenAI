import "server-only";

import { and, asc, eq, inArray, isNotNull, max, ne } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import {
  activeKnowledge,
  activeOnboardingTemplate,
  auditLogs,
  contentItems,
  contentVersions,
  knowledgeRevisions,
  onboardingTemplateVersions,
  type OnboardingMetadata,
  type OnboardingTemplateDefinition,
} from "@/db/schema";

const templateNodeSchema = z.object({
  id: z.string().min(1).max(80),
  contentItemId: z.string().uuid(),
  depth: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  trigger: z.string().trim().min(3).max(300),
  optional: z.boolean(),
});

export const onboardingTemplateSchema = z.object({
  name: z.string().trim().min(3).max(120),
  openingPrompt: z.string().trim().min(10).max(1_000),
  fallbackPrompt: z.string().trim().min(10).max(1_000),
  nodes: z.array(templateNodeSchema).min(1).max(40),
}).superRefine((definition, context) => {
  const ids = new Set<string>();
  definition.nodes.forEach((node, index) => {
    if (ids.has(node.id)) context.addIssue({ code: "custom", path: ["nodes", index, "id"], message: "Identifiant dupliqué" });
    ids.add(node.id);
    if (index === 0 && node.depth !== 0) context.addIssue({ code: "custom", path: ["nodes", index, "depth"], message: "La première étape doit être principale" });
    if (index > 0 && node.depth > definition.nodes[index - 1].depth + 1) {
      context.addIssue({ code: "custom", path: ["nodes", index, "depth"], message: "Une branche ne peut pas sauter un niveau" });
    }
  });
});

function revisionId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "_");
  return `kb_${date}_${Date.now().toString(36)}`;
}

async function assertPublishedReferences(definition: OnboardingTemplateDefinition) {
  const ids = [...new Set(definition.nodes.map((node) => node.contentItemId))];
  const rows = await requireDb().select({ id: contentItems.id }).from(contentItems)
    .where(and(
      inArray(contentItems.id, ids),
      isNotNull(contentItems.publishedVersionId),
      ne(contentItems.status, "archived"),
      eq(contentItems.aiEnabled, true),
    ));
  if (rows.length !== ids.length) throw new Error("TEMPLATE_CONTENT_NOT_PUBLISHED");
}

export async function listTemplateContentOptions() {
  return requireDb().select({
    id: contentItems.id,
    title: contentItems.title,
    summary: contentItems.summary,
    type: contentItems.type,
    agentKey: contentItems.agentKey,
  }).from(contentItems)
    .where(and(
      isNotNull(contentItems.publishedVersionId),
      ne(contentItems.status, "archived"),
      eq(contentItems.aiEnabled, true),
    ))
    .orderBy(asc(contentItems.type), asc(contentItems.title));
}

export async function getOnboardingTemplateEditorData() {
  const db = requireDb();
  const [state] = await db.select().from(activeOnboardingTemplate).where(eq(activeOnboardingTemplate.singleton, true)).limit(1);
  const [draft] = state?.draftVersionId
    ? await db.select().from(onboardingTemplateVersions).where(eq(onboardingTemplateVersions.id, state.draftVersionId)).limit(1)
    : [];
  const [published] = state?.publishedVersionId
    ? await db.select().from(onboardingTemplateVersions).where(eq(onboardingTemplateVersions.id, state.publishedVersionId)).limit(1)
    : [];
  const history = await db.select().from(onboardingTemplateVersions).orderBy(asc(onboardingTemplateVersions.version));
  return { state: state ?? null, draft: draft ?? null, published: published ?? null, history };
}

export async function saveOnboardingTemplateDraft(rawDefinition: unknown, actorEmail: string, changeNote: string) {
  const definition = onboardingTemplateSchema.parse(rawDefinition);
  if (changeNote.trim().length < 3) throw new Error("CHANGE_NOTE_REQUIRED");
  await assertPublishedReferences(definition);
  const db = requireDb();
  return db.transaction(async (tx) => {
    const [{ latest }] = await tx.select({ latest: max(onboardingTemplateVersions.version) }).from(onboardingTemplateVersions);
    const [version] = await tx.insert(onboardingTemplateVersions).values({
      version: (latest ?? 0) + 1,
      definition,
      changeNote: changeNote.trim(),
      authorEmail: actorEmail,
    }).returning();
    await tx.insert(activeOnboardingTemplate).values({ singleton: true, draftVersionId: version.id })
      .onConflictDoUpdate({ target: activeOnboardingTemplate.singleton, set: { draftVersionId: version.id, updatedAt: new Date() } });
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "onboarding_template_draft_saved",
      entityType: "onboarding_template",
      entityId: version.id,
      technicalMetadata: { version: version.version, nodeCount: definition.nodes.length },
    });
    return version;
  });
}

export async function publishOnboardingTemplate(versionId: string, actorEmail: string) {
  const db = requireDb();
  const [version] = await db.select().from(onboardingTemplateVersions).where(eq(onboardingTemplateVersions.id, versionId)).limit(1);
  if (!version) throw new Error("TEMPLATE_VERSION_NOT_FOUND");
  const definition = onboardingTemplateSchema.parse(version.definition);
  await assertPublishedReferences(definition);
  const revision = revisionId();
  await db.transaction(async (tx) => {
    await tx.insert(activeOnboardingTemplate).values({ singleton: true, draftVersionId: version.id, publishedVersionId: version.id, publishedAt: new Date() })
      .onConflictDoUpdate({ target: activeOnboardingTemplate.singleton, set: { draftVersionId: version.id, publishedVersionId: version.id, publishedAt: new Date(), updatedAt: new Date() } });
    await tx.insert(knowledgeRevisions).values({ id: revision, actorEmail });
    await tx.insert(activeKnowledge).values({ singleton: true, revisionId: revision }).onConflictDoUpdate({
      target: activeKnowledge.singleton,
      set: { revisionId: revision, updatedAt: new Date() },
    });
    await tx.insert(auditLogs).values({
      actorEmail,
      action: "onboarding_template_published",
      entityType: "onboarding_template",
      entityId: version.id,
      technicalMetadata: { version: version.version, revision, nodeCount: definition.nodes.length },
    });
  });
  return { revision, version: version.version };
}

export type PublishedOnboardingStep = {
  id: string;
  contentItemId: string;
  name: string;
  depth: 0 | 1 | 2;
  trigger: string;
  optional: boolean;
  description: string;
  expectedUrls: string[];
  kbQueries: string[];
  successCriteria: string[];
  completionHint: string;
};

export async function getPublishedOnboardingTemplate() {
  const db = requireDb();
  const [state] = await db.select().from(activeOnboardingTemplate).where(eq(activeOnboardingTemplate.singleton, true)).limit(1);
  if (!state?.publishedVersionId) return null;
  const [version] = await db.select().from(onboardingTemplateVersions).where(eq(onboardingTemplateVersions.id, state.publishedVersionId)).limit(1);
  if (!version) return null;
  const definition = onboardingTemplateSchema.parse(version.definition);
  const ids = [...new Set(definition.nodes.map((node) => node.contentItemId))];
  const rows = await db.select({ item: contentItems, version: contentVersions }).from(contentItems)
    .innerJoin(contentVersions, eq(contentVersions.id, contentItems.publishedVersionId))
    .where(and(
      inArray(contentItems.id, ids),
      isNotNull(contentItems.publishedVersionId),
      ne(contentItems.status, "archived"),
      eq(contentItems.aiEnabled, true),
    ));
  const byId = new Map(rows.map((row) => [row.item.id, row]));
  const steps: PublishedOnboardingStep[] = definition.nodes.flatMap((node) => {
    const row = byId.get(node.contentItemId);
    if (!row) return [];
    const metadata = row.version.metadata as Partial<OnboardingMetadata> & { intents?: string[]; limovaPaths?: string[]; expectedResult?: string };
    const completion = metadata.successCriteria?.length
      ? metadata.successCriteria.join(" ; ")
      : metadata.expectedResult || `L’objectif « ${row.item.title} » est atteint ou l’utilisateur choisit une autre direction.`;
    return [{
      id: node.id,
      contentItemId: node.contentItemId,
      name: row.item.title,
      depth: node.depth,
      trigger: node.trigger,
      optional: node.optional,
      description: `${row.item.summary}\n\n${row.version.bodyMarkdown}`.slice(0, 8_000),
      expectedUrls: metadata.expectedPages ?? metadata.limovaPaths ?? [],
      kbQueries: metadata.proposalSignals ?? metadata.intents ?? [row.item.title],
      successCriteria: metadata.successCriteria ?? (metadata.expectedResult ? [metadata.expectedResult] : []),
      completionHint: completion,
    }];
  });
  if (!steps.length) return null;
  return {
    revision: `onboarding_v${version.version}`,
    version: version.version,
    name: definition.name,
    openingPrompt: definition.openingPrompt,
    fallbackPrompt: definition.fallbackPrompt,
    steps,
    publishedAt: state.publishedAt?.toISOString() ?? null,
  };
}
