import "dotenv/config";

import { eq } from "drizzle-orm";
import { closeDb, requireDb } from "../src/db/client";
import { contentItems } from "../src/db/schema";
import { inferAgentKey } from "../src/lib/agents";
import { publish } from "../src/lib/workflow";

const actorEmail = process.env.KNOWLEDGE_IMPORT_OWNER ?? "studio@limova.ai";
const db = requireDb();
const items = await db.select().from(contentItems);

const grouped: Record<string, number> = {};
for (const item of items) {
  const agentKey = inferAgentKey(item.slug, item.title);
  grouped[agentKey] = (grouped[agentKey] ?? 0) + 1;
  await db.update(contentItems).set({ agentKey, visibility: "charly_only" }).where(eq(contentItems.id, item.id));
}

const published: string[] = [];
const alreadyPublished: string[] = [];
const failed: Array<{ slug: string; error: string }> = [];
for (const item of items) {
  if (item.status === "published" && item.publishedVersionId === item.currentDraftVersionId) {
    alreadyPublished.push(item.slug);
    continue;
  }
  try {
    await publish(item.id, actorEmail, item.status === "in_review" ? {} : {
      emergency: true,
      reason: "Validation initiale de la base de connaissances existante",
    });
    published.push(item.slug);
    console.log(`[published ${published.length}/${items.length}] ${item.slug}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failed.push({ slug: item.slug, error: message });
    console.error(`[failed] ${item.slug}: ${message}`);
  }
}

console.log(JSON.stringify({ total: items.length, grouped, published: published.length, alreadyPublished: alreadyPublished.length, failed }, null, 2));
await closeDb();
if (failed.length) process.exitCode = 1;
