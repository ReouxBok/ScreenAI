import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let client: PGlite;

async function applyMigrations(from: number, through: number) {
  const directory = new URL("../../drizzle/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .slice(from, through + 1);
  for (const file of files) {
    const migration = await readFile(new URL(file, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
}

describe("SAV production migration upgrade", () => {
  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    await applyMigrations(0, 16);
    await client.exec(`
      INSERT INTO content_items (id, slug, type, title, owner_email, status, agent_key)
      VALUES ('10000000-0000-4000-8000-000000000001', 'legacy-sav', 'article', 'Legacy SAV', 'ops@example.com', 'published', 'sav');
      INSERT INTO content_versions (id, item_id, version, body_markdown, metadata, change_note, author_email)
      VALUES ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 1, 'Legacy', '{}', 'Legacy', 'ops@example.com');
      UPDATE content_items SET published_version_id = '10000000-0000-4000-8000-000000000002'
      WHERE id = '10000000-0000-4000-8000-000000000001';

      INSERT INTO sav.mailboxes (id, email)
      VALUES ('20000000-0000-4000-8000-000000000001', 'sav@example.com');
      INSERT INTO sav.threads (id, mailbox_id, gmail_thread_id, customer_email)
      VALUES ('20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'legacy-thread', 'customer@example.com');
      INSERT INTO sav.messages (id, mailbox_id, thread_id, direction, from_email, preview, body_ciphertext, received_at, processed_at)
      VALUES
        ('20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'inbound', 'customer@example.com', 'Écrire à client@example.com', 'ciphertext', now(), now()),
        ('20000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'inbound', 'customer@example.com', 'En attente', 'ciphertext', now(), NULL);
      INSERT INTO sav.actions (id, thread_id, message_id, kind, idempotency_key)
      VALUES ('20000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003', 'draft_reply', 'legacy-action');
      INSERT INTO sav.learning_candidates (id, thread_id, hubspot_ticket_id, proposed_patch, explanation, source_content_hash)
      VALUES ('20000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000002', 'ticket-42', '{}', 'Legacy', 'legacy-hash');
      INSERT INTO sav.resolution_evidence (id, item_id, version_id, hubspot_ticket_id, outcome)
      VALUES ('20000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'ticket-42', 'resolved');
      INSERT INTO sav.pilot_batches (id, target_size, created_by)
      VALUES ('20000000-0000-4000-8000-000000000008', 1, 'reviewer@example.com');
      INSERT INTO sav.pilot_items (id, batch_id, message_id)
      VALUES ('20000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000003');
      INSERT INTO sav.agent_runs (id, message_id, runtime, mode, status, model, prompt_revision, input_hash)
      VALUES ('20000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000003', 'rules', 'shadow', 'succeeded', 'rules', 'legacy-v1', 'hash');
    `);
    await applyMigrations(17, 24);
  }, 30_000);

  afterAll(async () => { await client?.close(); });

  it("backfills historical rows and preserves safe defaults", async () => {
    const learning = await client.query<{ source_ref: string; hubspot_ticket_id: string | null }>(
      "SELECT source_ref, hubspot_ticket_id FROM sav.learning_candidates WHERE id = '20000000-0000-4000-8000-000000000006'",
    );
    const evidence = await client.query<{ source_ref: string }>(
      "SELECT source_ref FROM sav.resolution_evidence WHERE id = '20000000-0000-4000-8000-000000000007'",
    );
    const messages = await client.query<{ id: string; preview: string; analysis_status: string; analysis_attempts: number }>(
      "SELECT id, preview, analysis_status, analysis_attempts FROM sav.messages ORDER BY id",
    );
    const actions = await client.query<{ attempt_count: number; priority: number }>(
      "SELECT attempt_count, priority FROM sav.actions WHERE id = '20000000-0000-4000-8000-000000000005'",
    );
    const run = await client.query<{ input_tokens: number; output_tokens: number; total_tokens: number }>(
      "SELECT input_tokens, output_tokens, total_tokens FROM sav.agent_runs WHERE id = '20000000-0000-4000-8000-000000000010'",
    );
    const pilot = await client.query<{ attempt_count: number; agent_run_id: string | null }>(
      "SELECT attempt_count, agent_run_id FROM sav.pilot_items WHERE id = '20000000-0000-4000-8000-000000000009'",
    );

    expect(learning.rows[0]).toEqual({ source_ref: "hubspot:ticket-42", hubspot_ticket_id: "ticket-42" });
    expect(evidence.rows[0]?.source_ref).toBe("hubspot:ticket-42");
    expect(messages.rows).toEqual([
      expect.objectContaining({ preview: "Écrire à [email masqué]", analysis_status: "done", analysis_attempts: 0 }),
      expect.objectContaining({ preview: "En attente", analysis_status: "pending", analysis_attempts: 0 }),
    ]);
    expect(actions.rows[0]).toEqual({ attempt_count: 0, priority: 50 });
    expect(run.rows[0]).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    expect(pilot.rows[0]).toEqual({ attempt_count: 0, agent_run_id: null });
  });

  it("accepts local learning sources after the nullable HubSpot migration", async () => {
    await expect(client.exec(`
      INSERT INTO sav.learning_candidates (thread_id, hubspot_ticket_id, source_ref, proposed_patch, explanation, source_content_hash)
      VALUES ('20000000-0000-4000-8000-000000000002', NULL, 'thread:legacy-thread', '{}', 'Correction humaine', 'local-hash')
    `)).resolves.toBeDefined();
  });
});
