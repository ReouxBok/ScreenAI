import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readFile } from "node:fs/promises";
import { readLegacyMemoryInventory } from "./inventory";

let db: PGlite | undefined;
afterEach(async () => { await db?.close(); db = undefined; });
async function database(migrate = true) {
  db = new PGlite({ extensions: { vector } });
  if (migrate) {
    for (const file of ["0000_charly_memory.sql", "0001_supreme_valeria_richards.sql"]) {
      await db.exec(await readFile(new URL(`../../memory-drizzle/${file}`, import.meta.url), "utf8"));
    }
  }
  return db;
}

describe("legacy memory migration inventory", () => {
  it("counts the migrated schema without decrypting or returning identities and content", async () => {
    const client = await database();
    await client.exec(`
      INSERT INTO charly_memory.copilot_users (identity_key, profile_ciphertext, memory_enabled) VALUES
        ('v1:private-identity-one', 'SECRET_PROFILE', false), ('v1:private-identity-two', NULL, true);
      INSERT INTO charly_memory.conversation_sessions (id, user_key) VALUES
        ('11111111-1111-4111-8111-111111111111', 'v1:private-identity-one');
      INSERT INTO charly_memory.conversation_messages (user_key, session_id, role, source, ciphertext, character_count, idempotency_key)
        VALUES ('v1:private-identity-one', '11111111-1111-4111-8111-111111111111', 'user', 'text', 'SECRET_MESSAGE', 14, 'message-1');
      INSERT INTO charly_memory.copilot_memories (user_key, type, ciphertext, fingerprint, confidence, importance, embedding, expires_at)
        VALUES ('v1:private-identity-one', 'preference', 'SECRET_MEMORY', 'm1', 800, 800, array_fill(0::real, ARRAY[768])::vector, NULL),
        ('v1:private-identity-two', 'preference', 'EXPIRED', 'm2', 800, 800, array_fill(0::real, ARRAY[768])::vector, now() - interval '1 day');
      INSERT INTO charly_memory.memory_tombstones (user_key, fingerprint) VALUES ('v1:private-identity-one', 'forgotten-memory');
    `);
    await client.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const report = await readLegacyMemoryInventory(async statement => (await client.query<Record<string, unknown>>(statement)).rows);
    await client.exec("COMMIT");
    expect(report.complete).toBe(true);
    expect(report.tables.copilot_users).toMatchObject({ rows: "2", identities: "2", ciphertextBytes: "14" });
    expect(report.tables.conversation_messages).toMatchObject({ rows: "1", identities: "1", ciphertextBytes: "14" });
    expect(report.eligibility).toEqual({ disabledUsers: "1", activeMemories: "1", expiredMemories: "1", activeRuns: "0", effectiveTombstones: "1" });
    expect(report.identityMapping).toBe("unverified");
    expect(report.contentDecrypted).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/SECRET_|private-identity|forgotten-memory/);
    expect((await client.query("SELECT count(*)::int AS count FROM charly_memory.conversation_sessions")).rows).toEqual([{ count: 1 }]);
  }, 20_000);

  it("reports missing tables explicitly and never creates the schema", async () => {
    const client = await database(false);
    const report = await readLegacyMemoryInventory(async statement => (await client.query<Record<string, unknown>>(statement)).rows);
    expect(report.complete).toBe(false);
    expect(report.eligibility).toBeNull();
    expect(Object.values(report.tables).every(table => !table.present && table.rows === undefined)).toBe(true);
    expect((await client.query("SELECT to_regnamespace('charly_memory') IS NULL AS absent")).rows).toEqual([{ absent: true }]);
  });

  it("fails on an invalid count instead of silently declaring the inventory empty", async () => {
    await expect(readLegacyMemoryInventory(async statement => statement.includes("to_regclass")
      ? [{ present: true }] : [{ rows: "unknown", identities: "0", ciphertext_bytes: "0" }])).rejects.toThrow("INVALID_INVENTORY_COUNT");
  });
});
