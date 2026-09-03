import "server-only";

import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import {
  activeKnowledge,
  auditLogs,
  categories,
  contentChunks,
  contentItems,
  contentVersions,
  knowledgeRevisions,
  activeOnboardingTemplate,
  onboardingTemplateVersions,
  reviewEvents,
  testCases,
} from "@/db/schema";
import { chunkMarkdown } from "./chunking";
import { hasPassingEvaluation } from "./evaluations";
import { parseContentInput } from "./content";
import { embedTexts } from "./embeddings";

function revisionId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replaceAll("-", "_");
  return `kb_${date}_${now.getTime().toString(36)}`;
}

export async function saveDraft(rawInput: unknown, actorEmail: string, itemId?: string) {
  const input = parseContentInput(rawInput);
  const db = requireDb();
  const [category] = await db.select().from(categories).where(eq(categories.slug, input.categorySlug)).limit(1);
  if (!category) throw new Error("CATEGORY_NOT_FOUND");

  return db.transaction(async (tx) => {
    let item;
    if (itemId) {
      [item] = await tx.select().from(contentItems).where(eq(contentItems.id, itemId)).limit(1);
      if (!item) throw new Error("CONTENT_NOT_FOUND");
      [item] = await tx.update(contentItems).set({
        title: input.title,
        summary: input.summary,
        categoryId: category.id,
        visibility: input.visibility,
        agentKey: input.agentKey,
        status: "draft",
        updatedAt: new Date(),
      }).where(eq(contentItems.id, itemId)).returning();
    } else {
      [item] = await tx.insert(contentItems).values({
        slug: input.slug,
        type: input.type,
        locale: input.locale,
        title: input.title,
        summary: input.summary,
        categoryId: category.id,
        visibility: input.visibility,
        ownerEmail: input.ownerEmail,
        agentKey: input.agentKey,
      }).returning();
    }

    const [{ nextVersion }] = await tx.select({ nextVersion: max(contentVersions.version) }).from(contentVersions).where(eq(contentVersions.itemId, item.id));
    const [version] = await tx.insert(contentVersions).values({
      itemId: item.id,
      version: (nextVersion ?? 0) + 1,
      bodyMarkdown: input.bodyMarkdown,
      metadata: input.metadata,
      changeNote: input.changeNote,
      authorEmail: actorEmail,
    }).returning();
    await tx.update(contentItems).set({ currentDraftVersionId: version.id }).where(eq(contentItems.id, item.id));
    await tx.insert(auditLogs).values({ actorEmail, action: "draft_saved", entityType: "content", entityId: item.id, technicalMetadata: { version: version.version } });
    return { item, version };
  });
}

export async function submitForReview(itemId: string, actorEmail: string, comment: string) {
  const db = requireDb();
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, itemId)).limit(1);
  if (!item?.currentDraftVersionId) throw new Error("DRAFT_NOT_FOUND");
  if (item.type === "onboarding" && !await hasPassingEvaluation(item.id, item.currentDraftVersionId)) {
    throw new Error("REAL_EVALUATION_REQUIRED");
  }
  await db.transaction(async (tx) => {
    await tx.update(contentItems).set({ status: "in_review", updatedAt: new Date() }).where(eq(contentItems.id, itemId));
    await tx.insert(reviewEvents).values({ itemId, versionId: item.currentDraftVersionId, action: "submitted", actorEmail, comment });
  });
}

export async function rejectReview(itemId: string, actorEmail: string, comment: string) {
  if (comment.trim().length < 3) throw new Error("COMMENT_REQUIRED");
  const db = requireDb();
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, itemId)).limit(1);
  if (!item?.currentDraftVersionId || item.status !== "in_review") throw new Error("CONTENT_NOT_IN_REVIEW");
  await db.transaction(async (tx) => {
    await tx.update(contentItems).set({ status: "draft", updatedAt: new Date() }).where(eq(contentItems.id, itemId));
    await tx.insert(reviewEvents).values({ itemId, versionId: item.currentDraftVersionId, action: "rejected", actorEmail, comment });
  });
}

async function prepareVersion(itemId: string) {
  const db = requireDb();
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, itemId)).limit(1);
  if (!item?.currentDraftVersionId) throw new Error("DRAFT_NOT_FOUND");
  const [version] = await db.select().from(contentVersions).where(eq(contentVersions.id, item.currentDraftVersionId)).limit(1);
  if (!version) throw new Error("VERSION_NOT_FOUND");
  const chunks = chunkMarkdown(version.bodyMarkdown);
  if (!chunks.length) throw new Error("EMPTY_CHUNKS");
  const intents = "intents" in version.metadata ? version.metadata.intents : version.metadata.proposalSignals;
  const limovaPaths = "limovaPaths" in version.metadata ? version.metadata.limovaPaths : version.metadata.expectedPages;
  const embeddings = await embedTexts(
    chunks.map((chunk) => `${item.title}\n${chunk.heading}\n${chunk.content}`),
    "RETRIEVAL_DOCUMENT",
    { scope: item.agentKey === "sav" ? "sav" : "extension" },
  );

  const candidateTests = await db.select().from(testCases).where(and(eq(testCases.expectedItemId, itemId), eq(testCases.enabled, true)));
  const normalized = `${item.title} ${item.summary} ${version.bodyMarkdown}`.toLocaleLowerCase("fr");
  const failed = candidateTests.filter((test) => {
    const terms = test.query.toLocaleLowerCase("fr").match(/[\p{L}\p{N}]{4,}/gu) ?? [];
    return terms.length > 0 && !terms.some((term) => normalized.includes(term));
  });
  if (failed.length) throw new Error(`QUALITY_TESTS_FAILED:${failed.map((test) => test.id).join(",")}`);
  return { item, version, chunks, embeddings, intents, limovaPaths };
}

export async function publish(itemId: string, actorEmail: string, options: { emergency?: boolean; reason?: string } = {}) {
  const prepared = await prepareVersion(itemId);
  if (options.emergency && (!options.reason || options.reason.trim().length < 10)) throw new Error("EMERGENCY_REASON_REQUIRED");
  if (!options.emergency && prepared.item.status !== "in_review") throw new Error("CONTENT_NOT_IN_REVIEW");
  const db = requireDb();
  const revision = revisionId();

  await db.transaction(async (tx) => {
    await tx.delete(contentChunks).where(eq(contentChunks.versionId, prepared.version.id));
    await tx.insert(contentChunks).values(prepared.chunks.map((chunk, index) => ({
      itemId,
      versionId: prepared.version.id,
      ordinal: chunk.ordinal,
      heading: chunk.heading,
      content: chunk.content,
      intents: prepared.intents,
      limovaPaths: prepared.limovaPaths,
      embedding: prepared.embeddings[index],
    })));
    await tx.update(contentItems).set({
      publishedVersionId: prepared.version.id,
      status: "published",
      verifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(contentItems.id, itemId));
    await tx.insert(knowledgeRevisions).values({ id: revision, actorEmail });
    await tx.insert(activeKnowledge).values({ singleton: true, revisionId: revision }).onConflictDoUpdate({
      target: activeKnowledge.singleton,
      set: { revisionId: revision, updatedAt: new Date() },
    });
    await tx.insert(reviewEvents).values({
      itemId,
      versionId: prepared.version.id,
      action: options.emergency ? "emergency_published" : "approved",
      actorEmail,
      comment: options.reason ?? "Publication validée",
    });
    await tx.insert(auditLogs).values({ actorEmail, action: "published", entityType: "content", entityId: itemId, technicalMetadata: { revision } });
  });
  return { revision };
}

export async function rollback(itemId: string, versionId: string, actorEmail: string, reason: string) {
  if (reason.trim().length < 10) throw new Error("ROLLBACK_REASON_REQUIRED");
  const db = requireDb();
  const [version] = await db.select().from(contentVersions).where(and(eq(contentVersions.id, versionId), eq(contentVersions.itemId, itemId))).limit(1);
  if (!version) throw new Error("VERSION_NOT_FOUND");
  const [indexed] = await db.select({ id: contentChunks.id }).from(contentChunks).where(eq(contentChunks.versionId, versionId)).limit(1);
  if (!indexed) throw new Error("VERSION_NOT_INDEXED");
  const revision = revisionId();
  await db.transaction(async (tx) => {
    await tx.update(contentItems).set({ currentDraftVersionId: version.id, publishedVersionId: version.id, status: "published", updatedAt: new Date() }).where(eq(contentItems.id, itemId));
    await tx.insert(knowledgeRevisions).values({ id: revision, actorEmail });
    await tx.insert(activeKnowledge).values({ singleton: true, revisionId: revision }).onConflictDoUpdate({ target: activeKnowledge.singleton, set: { revisionId: revision, updatedAt: new Date() } });
    await tx.insert(reviewEvents).values({ itemId, versionId, action: "rolled_back", actorEmail, comment: reason });
    await tx.insert(auditLogs).values({ actorEmail, action: "rolled_back", entityType: "content", entityId: itemId, technicalMetadata: { revision, version: version.version } });
  });
  return { revision };
}

export async function archiveContent(itemId: string, actorEmail: string, reason: string) {
  if (reason.trim().length < 3) throw new Error("ARCHIVE_REASON_REQUIRED");
  const db = requireDb();
  const revision = revisionId();
  await db.transaction(async (tx) => {
    const [item] = await tx.update(contentItems).set({ status: "archived", updatedAt: new Date() }).where(eq(contentItems.id, itemId)).returning();
    if (!item) throw new Error("CONTENT_NOT_FOUND");
    await tx.insert(knowledgeRevisions).values({ id: revision, actorEmail });
    await tx.insert(activeKnowledge).values({ singleton: true, revisionId: revision }).onConflictDoUpdate({ target: activeKnowledge.singleton, set: { revisionId: revision, updatedAt: new Date() } });
    await tx.insert(reviewEvents).values({ itemId, versionId: item.publishedVersionId, action: "archived", actorEmail, comment: reason });
  });
}

export async function deleteContent(itemId: string, actorEmail: string) {
  const db = requireDb();
  const revision = revisionId();
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(contentItems).where(eq(contentItems.id, itemId)).limit(1);
    if (!item) throw new Error("CONTENT_NOT_FOUND");

    // The template stores content ids inside versioned JSON. Protect both the
    // active draft and active published template from dangling references.
    const [templateState] = await tx.select().from(activeOnboardingTemplate)
      .where(eq(activeOnboardingTemplate.singleton, true)).limit(1);
    const activeVersionIds = [templateState?.draftVersionId, templateState?.publishedVersionId]
      .filter((id): id is string => Boolean(id));
    if (activeVersionIds.length) {
      const activeVersions = await tx.select({ definition: onboardingTemplateVersions.definition })
        .from(onboardingTemplateVersions)
        .where(inArray(onboardingTemplateVersions.id, activeVersionIds));
      const isReferenced = activeVersions.some(({ definition }) =>
        definition.nodes.some((node) => node.contentItemId === itemId)
      );
      if (isReferenced) throw new Error("CONTENT_USED_IN_ONBOARDING_TEMPLATE");
    }

    await tx.insert(auditLogs).values({
      actorEmail,
      action: "content_deleted",
      entityType: "content",
      entityId: itemId,
      technicalMetadata: { previousStatus: item.status, versioned: Boolean(item.currentDraftVersionId) },
    });
    await tx.delete(contentItems).where(eq(contentItems.id, itemId));
    await tx.insert(knowledgeRevisions).values({ id: revision, actorEmail });
    await tx.insert(activeKnowledge).values({ singleton: true, revisionId: revision }).onConflictDoUpdate({
      target: activeKnowledge.singleton,
      set: { revisionId: revision, updatedAt: new Date() },
    });
    return { item, revision };
  });
}

export async function setContentAiEnabled(itemId: string, enabled: boolean, actorEmail: string) {
  const db = requireDb();
  const revision = revisionId();
  return db.transaction(async (tx) => {
    const [item] = await tx.update(contentItems).set({ aiEnabled: enabled, updatedAt: new Date() })
      .where(eq(contentItems.id, itemId)).returning();
    if (!item) throw new Error("CONTENT_NOT_FOUND");
    await tx.insert(auditLogs).values({
      actorEmail,
      action: enabled ? "ai_content_enabled" : "ai_content_disabled",
      entityType: "content",
      entityId: itemId,
      technicalMetadata: { inProduction: Boolean(item.publishedVersionId) },
    });
    if (item.publishedVersionId) {
      await tx.insert(knowledgeRevisions).values({ id: revision, actorEmail });
      await tx.insert(activeKnowledge).values({ singleton: true, revisionId: revision }).onConflictDoUpdate({
        target: activeKnowledge.singleton,
        set: { revisionId: revision, updatedAt: new Date() },
      });
    }
    return item;
  });
}

export async function listContent() {
  const db = requireDb();
  return db.select({ item: contentItems, category: categories, stale: sql<boolean>`${contentItems.verifiedAt} IS NULL OR ${contentItems.verifiedAt} < now() - interval '90 days'` }).from(contentItems).leftJoin(categories, eq(contentItems.categoryId, categories.id)).orderBy(desc(contentItems.updatedAt));
}

export async function getContentDetail(itemId: string) {
  const db = requireDb();
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, itemId)).limit(1);
  if (!item) return null;
  const versions = await db.select().from(contentVersions).where(eq(contentVersions.itemId, itemId)).orderBy(desc(contentVersions.version));
  const [category] = item.categoryId ? await db.select().from(categories).where(eq(categories.id, item.categoryId)).limit(1) : [];
  return { item, versions, category };
}

export async function ensureCategories() {
  const { CATEGORIES } = await import("./content");
  const db = requireDb();
  await db.insert(categories).values(CATEGORIES.map(([slug, label], position) => ({ slug, label, position }))).onConflictDoNothing();
}
