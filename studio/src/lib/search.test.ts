import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../test/sav-db";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => state.db }));

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
});
