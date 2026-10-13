import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../test/sav-db";
import { contentItems, contentVersions, onboardingTemplateVersions, activeOnboardingTemplate } from "@/db/schema";
import { eq } from "drizzle-orm";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
import { getPublishedOnboardingTemplate } from "./onboarding-template";

let fixture: Awaited<ReturnType<typeof createSavTestDb>>;
beforeAll(async () => {
  fixture = await createSavTestDb();
  state.db = fixture.db;
  const nodes = [];
  const metadata = { objective: "Help the user", proposalSignals: [], qualificationQuestions: [], expectedPages: [], successCriteria: [], branches: [], fallbacks: [] };
  for (const agentKey of ["charly", "sav"]) {
    const [item] = await fixture.db.insert(contentItems).values({
      slug: `test-${agentKey}`, type: "onboarding", locale: "fr-FR", title: agentKey,
      ownerEmail: "staff@example.test", status: "published", agentKey, aiEnabled: true,
    }).returning();
    const [version] = await fixture.db.insert(contentVersions).values({
      itemId: item.id, version: 1, bodyMarkdown: `${agentKey} published procedure`,
      metadata, changeNote: "test", authorEmail: "staff@example.test",
    }).returning();
    await fixture.db.update(contentItems).set({ publishedVersionId: version.id }).where(eq(contentItems.id, item.id));
    await fixture.db.insert(contentVersions).values({
      itemId: item.id, version: 2, bodyMarkdown: "UNPUBLISHED PRIVATE DRAFT",
      metadata, changeNote: "draft", authorEmail: "staff@example.test",
    });
    nodes.push({ id: agentKey, contentItemId: item.id, depth: 0 as const, trigger: "user asks", optional: false });
  }
  const [template] = await fixture.db.insert(onboardingTemplateVersions).values({
    version: 1, definition: { name: "Published guide", openingPrompt: "Welcome to the guide", fallbackPrompt: "Ask how we can help", nodes },
    changeNote: "test", authorEmail: "staff@example.test",
  }).returning();
  await fixture.db.insert(activeOnboardingTemplate).values({ singleton: true, publishedVersionId: template.id })
    .onConflictDoUpdate({ target: activeOnboardingTemplate.singleton, set: { publishedVersionId: template.id } });
}, 30_000);
afterAll(async () => { await fixture?.client.close(); });

it("MCP guidance excludes SAV references and reads the published content version", async () => {
  const guidance = await getPublishedOnboardingTemplate({ excludeSav: true });
  expect(guidance?.steps.map(step => step.id)).toEqual(["charly"]);
  expect(guidance?.steps[0].description).toContain("charly published procedure");
  expect(JSON.stringify(guidance)).not.toContain("UNPUBLISHED PRIVATE DRAFT");
  expect((await getPublishedOnboardingTemplate())?.steps.map(step => step.id)).toEqual(["charly", "sav"]);
});
