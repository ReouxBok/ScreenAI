import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeDb, requireDb } from "../src/db/client";
import {
  activeKnowledge,
  activeOnboardingTemplate,
  categories,
  contentItems,
  contentVersions,
  knowledgeRevisions,
  onboardingTemplateVersions,
  reviewEvents,
  testCases,
} from "../src/db/schema";

const outputFlag = process.argv.indexOf("--out");
if (outputFlag < 0 || !process.argv[outputFlag + 1]) throw new Error("Usage: npm run kb:backup -- --out /explicit/output/directory");
const outputDirectory = path.resolve(process.argv[outputFlag + 1]);
await mkdir(outputDirectory, { recursive: true });
const db = requireDb();
const [
  categoryRows,
  itemRows,
  versionRows,
  reviewRows,
  testRows,
  templateRows,
  templateState,
  revisions,
  knowledgeState,
] = await Promise.all([
  db.select().from(categories),
  db.select().from(contentItems),
  db.select().from(contentVersions),
  db.select().from(reviewEvents),
  db.select().from(testCases),
  db.select().from(onboardingTemplateVersions),
  db.select().from(activeOnboardingTemplate),
  db.select().from(knowledgeRevisions),
  db.select().from(activeKnowledge),
]);
const backup = {
  format: "charly-knowledge-backup-v1",
  exportedAt: new Date().toISOString(),
  counts: {
    categories: categoryRows.length,
    contentItems: itemRows.length,
    contentVersions: versionRows.length,
    reviews: reviewRows.length,
    tests: testRows.length,
    onboardingTemplates: templateRows.length,
  },
  categories: categoryRows,
  contentItems: itemRows,
  contentVersions: versionRows,
  reviewEvents: reviewRows,
  testCases: testRows,
  onboardingTemplateVersions: templateRows,
  activeOnboardingTemplate: templateState,
  knowledgeRevisions: revisions,
  activeKnowledge: knowledgeState,
};
const file = path.join(outputDirectory, "knowledge-backup.json");
await writeFile(file, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, file, counts: backup.counts }));
await closeDb();
