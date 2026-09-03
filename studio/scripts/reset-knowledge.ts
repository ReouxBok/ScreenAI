import "dotenv/config";

import { count } from "drizzle-orm";
import { closeDb, requireDb } from "../src/db/client";
import {
  activeKnowledge,
  activeOnboardingTemplate,
  auditLogs,
  contentItems,
  contentVersions,
  knowledgeRevisions,
  onboardingTemplateVersions,
  trainingSessions,
} from "../src/db/schema";

const confirmation = process.argv.at(process.argv.indexOf("--confirm") + 1);
if (confirmation !== "DELETE_ALL_CHARLY_KNOWLEDGE") {
  throw new Error("Refusing destructive reset. Pass --confirm DELETE_ALL_CHARLY_KNOWLEDGE after creating a backup.");
}

const db = requireDb();
const before = await db.transaction(async (tx) => {
  const [[items], [versions], [templates], [trainings]] = await Promise.all([
    tx.select({ value: count() }).from(contentItems),
    tx.select({ value: count() }).from(contentVersions),
    tx.select({ value: count() }).from(onboardingTemplateVersions),
    tx.select({ value: count() }).from(trainingSessions),
  ]);

  // Demonstrations and their private recordings remain available. The FK is
  // ON DELETE SET NULL, so converted demonstrations return to an editable,
  // unlinked state instead of being destroyed with their generated content.
  await tx.delete(activeOnboardingTemplate);
  await tx.delete(onboardingTemplateVersions);
  await tx.delete(contentItems);
  await tx.delete(activeKnowledge);
  await tx.delete(knowledgeRevisions);
  await tx.insert(knowledgeRevisions).values({
    id: "kb_empty",
    actorEmail: "system@limova.ai",
  });
  await tx.insert(activeKnowledge).values({ singleton: true, revisionId: "kb_empty" });
  await tx.insert(auditLogs).values({
    actorEmail: "system@limova.ai",
    action: "knowledge_reset",
    entityType: "knowledge_base",
    entityId: "kb_empty",
    technicalMetadata: {
      deletedItems: items.value,
      deletedVersions: versions.value,
      deletedTemplates: templates.value,
      preservedTrainingSessions: trainings.value,
    },
  });
  return { items: items.value, versions: versions.value, templates: templates.value, trainings: trainings.value };
});

console.log(JSON.stringify({
  ok: true,
  revision: "kb_empty",
  deletedContentItems: before.items,
  deletedContentVersions: before.versions,
  deletedOnboardingTemplates: before.templates,
  preservedTrainingSessions: before.trainings,
}));
await closeDb();
