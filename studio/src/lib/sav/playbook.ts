import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { requireDb } from "@/db";
import { activeKnowledge, knowledgeRevisions, auditLogs, contentItems, contentVersions, savKnowledgeActivations } from "@/db/schema";
import { assertSavActor } from "./access";
import { assertSavPlaybookActor, defaultSavPlaybook, renderSavPlaybook, SAV_PLAYBOOK_SLUG, savPlaybookSchema, type SavActivePlaybook } from "./playbook-contract";

function playbookDocument(metadata: typeof contentVersions.$inferSelect.metadata) {
  if (metadata.sourceMetadata?.kind !== "sav_playbook") throw new Error("SAV_PLAYBOOK_VERSION_INVALID");
  return savPlaybookSchema.parse(metadata.sourceMetadata.playbook);
}
export async function getSavPlaybookWorkspace(actorEmail: string) {
  assertSavActor(actorEmail);
  const db = requireDb();
  const [item] = await db.select().from(contentItems).where(and(eq(contentItems.slug, SAV_PLAYBOOK_SLUG), eq(contentItems.locale, "fr-FR"), eq(contentItems.agentKey, "sav")));
  const versions = item ? await db.select().from(contentVersions).where(eq(contentVersions.itemId, item.id)).orderBy(desc(contentVersions.version)) : [];
  const [active] = item ? await db.select().from(savKnowledgeActivations).where(eq(savKnowledgeActivations.itemId, item.id)) : [];
  const reviews = item ? await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, item.id), eq(auditLogs.action, "sav_playbook_reviewed"))) : [];
  return { itemId: item?.id ?? null, draftId: item?.currentDraftVersionId ?? null, activeId: active?.versionId ?? null,
    versions: versions.map(v => ({ id: v.id, version: v.version, document: playbookDocument(v.metadata),
      author: v.authorEmail, createdAt: v.createdAt, reviewed: reviews.some(r => r.technicalMetadata?.versionId === v.id) })),
    fallback: defaultSavPlaybook };
}
export async function readActiveSavPlaybook(): Promise<SavActivePlaybook> {
  const db = requireDb();
  const [row] = await db.select({ version: contentVersions }).from(contentItems)
    .innerJoin(savKnowledgeActivations, eq(savKnowledgeActivations.itemId, contentItems.id))
    .innerJoin(contentVersions, and(eq(contentVersions.id, savKnowledgeActivations.versionId), eq(contentVersions.itemId, contentItems.id)))
    .where(and(eq(contentItems.slug, SAV_PLAYBOOK_SLUG), eq(contentItems.locale, "fr-FR"), eq(contentItems.agentKey, "sav")));
  return row ? { versionId: row.version.id, version: row.version.version, document: playbookDocument(row.version.metadata) }
    : { versionId: "existing-process-v1", version: 0, document: defaultSavPlaybook };
}
export async function saveSavPlaybook(input: { document: unknown; expectedDraftId: string | null }, actorEmail: string) {
  assertSavPlaybookActor(actorEmail);
  const document = savPlaybookSchema.parse(input.document);
  renderSavPlaybook({ versionId: "draft", version: 0, document }, ["seo", "integration", "account", "telephony", "billing_navigation", "general"]);
  return requireDb().transaction(async tx => {
    await tx.insert(contentItems).values({ slug: SAV_PLAYBOOK_SLUG, type: "article", locale: "fr-FR", agentKey: "sav", title: "Master prompt SAV", ownerEmail: actorEmail, aiEnabled: false }).onConflictDoNothing();
    const [item] = await tx.select().from(contentItems).where(and(eq(contentItems.slug, SAV_PLAYBOOK_SLUG), eq(contentItems.locale, "fr-FR"))).for("update");
    if (!item || item.agentKey !== "sav" || item.currentDraftVersionId !== input.expectedDraftId) throw new Error("SAV_PLAYBOOK_STALE");
    const [last] = await tx.select().from(contentVersions).where(eq(contentVersions.itemId, item.id)).orderBy(desc(contentVersions.version)).limit(1);
    const [version] = await tx.insert(contentVersions).values({ itemId: item.id, version: (last?.version ?? 0) + 1,
      bodyMarkdown: document.tone + "\n\n" + document.handling + "\n\n" + document.escalation,
      metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "", troubleshooting: "", sourceMetadata: { kind: "sav_playbook", playbook: document } },
      changeNote: "Brouillon du master prompt SAV", authorEmail: actorEmail }).returning();
    await tx.update(contentItems).set({ currentDraftVersionId: version.id, updatedAt: new Date() }).where(eq(contentItems.id, item.id));
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_playbook_saved", entityType: "content", entityId: item.id, technicalMetadata: { versionId: version.id } });
    return { versionId: version.id };
  });
}
export async function reviewSavPlaybook(input: { versionId: string }, actorEmail: string) {
  assertSavPlaybookActor(actorEmail);
  return requireDb().transaction(async tx => {
    const [item] = await tx.select().from(contentItems).where(and(eq(contentItems.slug, SAV_PLAYBOOK_SLUG), eq(contentItems.locale, "fr-FR"), eq(contentItems.agentKey, "sav"))).for("update");
    if (!item || item.currentDraftVersionId !== input.versionId) throw new Error("SAV_PLAYBOOK_STALE");
    const [version] = await tx.select().from(contentVersions).where(and(eq(contentVersions.itemId, item.id), eq(contentVersions.id, input.versionId)));
    if (!version) throw new Error("SAV_PLAYBOOK_VERSION_INVALID");
    renderSavPlaybook({ versionId: version.id, version: version.version, document: playbookDocument(version.metadata) }, ["seo", "integration", "account", "telephony", "billing_navigation", "general"]);
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_playbook_reviewed", entityType: "content", entityId: item.id,
      technicalMetadata: { versionId: version.id, validation: "deterministic-schema-budget-v1", semanticComparison: "not_requested" } });
  });
}
export async function activateSavPlaybook(input: { versionId: string; expectedActiveId: string | null }, actorEmail: string) {
  assertSavPlaybookActor(actorEmail);
  return requireDb().transaction(async tx => {
    const [item] = await tx.select().from(contentItems).where(and(eq(contentItems.slug, SAV_PLAYBOOK_SLUG), eq(contentItems.locale, "fr-FR"), eq(contentItems.agentKey, "sav"))).for("update");
    if (!item) throw new Error("SAV_PLAYBOOK_VERSION_INVALID");
    const [active] = await tx.select().from(savKnowledgeActivations).where(eq(savKnowledgeActivations.itemId, item.id));
    if ((active?.versionId ?? null) !== input.expectedActiveId) throw new Error("SAV_PLAYBOOK_STALE");
    const [version] = await tx.select().from(contentVersions).where(and(eq(contentVersions.id, input.versionId), eq(contentVersions.itemId, item.id)));
    const reviews = await tx.select().from(auditLogs).where(and(eq(auditLogs.entityId, item.id), eq(auditLogs.action, "sav_playbook_reviewed")));
    if (!version || !reviews.some(r => r.technicalMetadata?.versionId === version.id)) throw new Error("SAV_PLAYBOOK_REVIEW_REQUIRED");
    renderSavPlaybook({ versionId: version.id, version: version.version, document: playbookDocument(version.metadata) }, ["seo", "integration", "account", "telephony", "billing_navigation", "general"]);
    const values = { itemId: item.id, versionId: version.id, title: item.title, activatedBy: actorEmail, activatedAt: new Date() };
    await tx.insert(savKnowledgeActivations).values(values).onConflictDoUpdate({ target: savKnowledgeActivations.itemId, set: values });
    await tx.update(contentItems).set({ publishedVersionId: version.id, status: "published", aiEnabled: false, updatedAt: new Date() }).where(eq(contentItems.id, item.id));
    const revision = `kb_sav_playbook_${crypto.randomUUID()}`;
    await tx.insert(knowledgeRevisions).values({ id: revision, actorEmail });
    await tx.insert(activeKnowledge).values({ singleton: true, revisionId: revision }).onConflictDoUpdate({ target: activeKnowledge.singleton, set: { revisionId: revision, updatedAt: new Date() } });
    await tx.insert(auditLogs).values({ actorEmail, action: "sav_playbook_activated", entityType: "content", entityId: item.id,
      technicalMetadata: { versionId: version.id, previousVersionId: active?.versionId ?? null } });
  });
}
