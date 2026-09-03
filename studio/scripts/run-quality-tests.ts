import "dotenv/config";

import { eq } from "drizzle-orm";
import { closeDb, requireDb } from "../src/db/client";
import { contentItems, testCases } from "../src/db/schema";
import { GOLDEN_QUERIES } from "../src/lib/golden-queries";
import { searchKnowledge } from "../src/lib/search";

const db = requireDb();
const content = await db.select({ id: contentItems.id, slug: contentItems.slug }).from(contentItems);
const idsBySlug = new Map(content.map((item) => [item.slug, item.id]));
const existingTests = await db.select().from(testCases);
for (const golden of GOLDEN_QUERIES) {
  const expectedItemId = idsBySlug.get(golden.slug);
  if (!expectedItemId) continue;
  const existing = existingTests.find((test) => test.expectedItemId === expectedItemId);
  if (existing) await db.update(testCases).set({ query: golden.query, path: golden.path }).where(eq(testCases.id, existing.id));
  else await db.insert(testCases).values({ query: golden.query, path: golden.path, locale: "fr-FR", expectedItemId });
}
const tests = await db.select().from(testCases).where(eq(testCases.enabled, true));
let passed = 0;
const failures: Array<{ query: string; status: string; rank: number | null; results?: string[]; error?: string }> = [];

for (const [index, test] of tests.entries()) {
  try {
    const result = await searchKnowledge({ query: test.query, path: test.path ?? "", locale: test.locale, contentTypes: ["article", "onboarding"], limit: 10 });
    const rank = result.results.findIndex((item) => item.id === test.expectedItemId);
    const status = rank >= 0 && rank < 3 ? "passed" : "failed";
    if (status === "passed") passed += 1;
    else failures.push({ query: test.query, status, rank: rank >= 0 ? rank + 1 : null, results: result.results.map((item) => `${item.source} (${item.score})`) });
    await db.update(testCases).set({ lastStatus: status, lastResult: { rank: rank >= 0 ? rank + 1 : null, resultIds: result.results.map((item) => item.id) }, lastRunAt: new Date() }).where(eq(testCases.id, test.id));
    console.log(`[${index + 1}/${tests.length}] ${status} ${test.query}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ query: test.query, status: "error", rank: null, error: message });
    await db.update(testCases).set({ lastStatus: "error", lastResult: { rank: null, resultIds: [], error: message }, lastRunAt: new Date() }).where(eq(testCases.id, test.id));
  }
}

console.log(JSON.stringify({ total: tests.length, passed, rate: tests.length ? passed / tests.length : 0, failures }, null, 2));
await closeDb();
if (failures.length) process.exitCode = 1;
