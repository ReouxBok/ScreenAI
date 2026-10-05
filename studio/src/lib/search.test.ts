import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../test/sav-db";
import { eq } from "drizzle-orm";
import { activeKnowledge, knowledgeRevisions, contentItems, contentVersions, contentChunks } from "@/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown, embed: vi.fn(async () => [new Array(768).fill(1)]) }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));
vi.mock("./embeddings", () => ({ embedTexts: state.embed }));

import { searchKnowledge } from "./search";

let fixture: Awaited<ReturnType<typeof createSavTestDb>>;

describe("SAV knowledge freshness", () => {
  beforeAll(async () => {
    fixture = await createSavTestDb();
    state.db = fixture.db;
    const embedding = `[${new Array(768).fill(0).join(",")}]`;
    await fixture.client.exec(`
      INSERT INTO content_items (id, slug, type, locale, title, owner_email, status, agent_key, ai_enabled)
      VALUES ('30000000-0000-4000-8000-000000000001', 'invalid-legacy-date', 'article', 'fr-FR', 'Article SAV ancien', 'ops@example.com', 'published', 'sav', true);
      INSERT INTO content_versions (id, item_id, version, body_markdown, metadata, change_note, author_email)
      VALUES (
        '30000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000001',
        1,
        'Procédure ancienne',
        '{"resolution":{"validUntil":"2027-02-31"}}',
        'Import historique',
        'ops@example.com'
      );
      UPDATE content_items SET published_version_id = '30000000-0000-4000-8000-000000000002'
      WHERE id = '30000000-0000-4000-8000-000000000001';
      INSERT INTO content_chunks (item_id, version_id, ordinal, content, embedding)
      VALUES (
        '30000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002',
        0,
        'Procédure ancienne',
        '${embedding}'::vector
      );
    `);
  }, 30_000);

  afterAll(async () => { await fixture?.client.close(); });

  it("excludes a malformed legacy expiry date without failing the search", async () => {
    await expect(searchKnowledge({ query: "procédure", scope: "sav" })).resolves.toEqual({
      revision: "kb_empty",
      results: [],
    });
  });
  it("keeps distinct SAV sources with identical titles and their exact published versions", async () => {
    const expected: string[] = [];
    for (const slug of ["same-title-one", "same-title-two"]) {
      const [item] = await fixture.db.insert(contentItems).values({ slug, type: "article", locale: "fr-FR", title: "Retrouver les factures", ownerEmail: "ugo@limova.ai", status: "published", agentKey: "sav", aiEnabled: true }).returning();
      const [version] = await fixture.db.insert(contentVersions).values({ itemId: item.id, version: 1, bodyMarkdown: "Ouvrez Paramètres puis Facturation", metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "Factures visibles", troubleshooting: "Revue humaine", resolution: { symptoms: ["Factures introuvables"], steps: ["Ouvrez Paramètres puis Facturation"], exceptions: [], escalation: "Revue humaine", productVersion: "", supersedes: [], conflictsWith: [] } }, changeNote: "Fixture", authorEmail: "ugo@limova.ai" }).returning();
      await fixture.db.update(contentItems).set({ publishedVersionId: version.id }).where(eq(contentItems.id, item.id));
      await fixture.db.insert(contentChunks).values({ itemId: item.id, versionId: version.id, ordinal: 0, content: "Ouvrez Paramètres puis Facturation", embedding: new Array(768).fill(1) });
      expected.push(version.id);
    }
    const found = await searchKnowledge({ query: "factures", scope: "sav" });
    expect(found.results).toHaveLength(2);
    expect(found.results.map((source) => source.contentVersionId).sort()).toEqual(expected.sort());
  });

  async function preparePublicationRace(scope: "extension" | "sav") {
    const [item] = await fixture.db.insert(contentItems).values({ slug: `${scope}-publication-race`, type: "article", locale: "fr-FR", title: "Parcours historique", ownerEmail: "ugo@limova.ai", status: "published", agentKey: scope === "extension" ? "charly" : "sav", aiEnabled: true }).returning();
    const [version] = await fixture.db.insert(contentVersions).values({ itemId: item.id, version: 1, bodyMarkdown: "Ouvrez Paramètres puis Facturation", metadata: { intents: [], limovaPaths: [], prerequisites: [], expectedResult: "Factures visibles", troubleshooting: "Revue humaine", resolution: { symptoms: ["Factures introuvables"], steps: ["Ouvrez Paramètres puis Facturation"], exceptions: [], escalation: "Revue humaine", productVersion: "", supersedes: [], conflictsWith: [] } }, changeNote: "Fixture isolée", authorEmail: "ugo@limova.ai" }).returning();
    await fixture.db.update(contentItems).set({ publishedVersionId: version.id }).where(eq(contentItems.id, item.id));
    await fixture.db.insert(contentChunks).values({ itemId: item.id, versionId: version.id, ordinal: 0, content: "Ouvrez Paramètres puis Facturation", embedding: new Array(768).fill(1) });
    const before = `kb_${scope}_before`;
    const after = `kb_${scope}_after`;
    await fixture.db.insert(knowledgeRevisions).values([before, after].map((id) => ({ id, actorEmail: "ugo@limova.ai" })));
    await fixture.db.insert(activeKnowledge).values({ singleton: true, revisionId: before }).onConflictDoUpdate({ target: activeKnowledge.singleton, set: { revisionId: before } });
    state.embed.mockImplementationOnce(async () => {
      await fixture.db.update(activeKnowledge).set({ revisionId: after }).where(eq(activeKnowledge.singleton, true));
      return [new Array(768).fill(1)];
    });
    return { item, after };
  }

  it("preserves the installed extension's default search during a concurrent publication", async () => {
    const { item, after } = await preparePublicationRace("extension");
    // The installed proxy omits scope; the historical default is extension.
    const found = await searchKnowledge({ query: "factures", contentTypes: ["article"] });
    expect(found.revision).toBe(after);
    expect(found.results).toEqual([expect.objectContaining({ id: item.id, content: "Ouvrez Paramètres puis Facturation" })]);
  });

  it("still refuses mixed knowledge revisions for a SAV proposal", async () => {
    await preparePublicationRace("sav");
    await expect(searchKnowledge({ query: "factures", scope: "sav", contentTypes: ["article"] })).rejects.toThrow("KNOWLEDGE_REVISION_CHANGED_DURING_SEARCH");
  });
});
