import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import * as schema from "./schema";
import { encryptMemory } from "./crypto";
import { exportMemory } from "./export";
import { POST } from "@/app/api/internal/memory/export/route";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("./client", () => ({ requireMemoryDb: () => holder.db }));
let client: PGlite;
let queries: string[];
const own = `v1:${"a".repeat(43)}`, other = `v1:${"b".repeat(43)}`;
const token = "test-service-token-with-at-least-thirty-two-characters";

beforeEach(async () => {
  vi.stubEnv("MEMORY_ENCRYPTION_KEY_V1", "test-encryption-key-with-at-least-thirty-two-characters");
  vi.stubEnv("MEMORY_SERVICE_TOKEN", token);
  client = new PGlite({ extensions: { vector } });
  for (const file of ["0000_charly_memory.sql", "0001_supreme_valeria_richards.sql"]) {
    await client.exec(await readFile(new URL(`../../memory-drizzle/${file}`, import.meta.url), "utf8"));
  }
  queries = [];
  holder.db = drizzle(client, { schema, logger: { logQuery: query => { queries.push(query); } } });
}, 20_000);
afterEach(async () => { await client?.close(); vi.unstubAllEnvs(); });

async function seed(userKey: string, marker: string) {
  const db = drizzle(client, { schema });
  await db.insert(schema.copilotUsers).values({ identityKey: userKey, memoryEnabled: false, profileCiphertext: encryptMemory({ firstName: marker }) });
  const sessions = await db.insert(schema.conversationSessions).values([
    { userKey, status: "closed", adkStateCiphertext: encryptMemory({ marker }), startedAt: new Date("2020-01-01") },
    { userKey, status: "active" },
  ]).returning();
  const messages = await db.insert(schema.conversationMessages).values(Array.from({ length: 30 }, (_, n) => ({
    userKey, sessionId: sessions[n % 2].id, role: "user", source: "text", ciphertext: encryptMemory({ content: `${marker}-${n}` }),
    characterCount: 10, idempotencyKey: String(n),
  }))).returning();
  await db.insert(schema.conversationSummaries).values(sessions.map(session => ({ userKey, sessionId: session.id, version: 1, ciphertext: encryptMemory({ text: marker }) })));
  await db.insert(schema.copilotMemories).values(Array.from({ length: 10 }, (_, n) => ({
    userKey, type: "preference", ciphertext: encryptMemory({ statement: marker }), fingerprint: `memory-${n}`,
    confidence: 800, importance: 700, embedding: Array(768).fill(0), status: n === 0 ? "forgotten" : "active",
    expiresAt: n === 1 ? new Date("2020-01-01") : null, sourceMessageId: messages[0].id,
  })));
  await db.insert(schema.copilotGoals).values(Array.from({ length: 6 }, (_, n) => ({
    userKey, titleCiphertext: encryptMemory({ text: marker }), nextStepCiphertext: encryptMemory({ text: "next" }),
    blockerCiphertext: encryptMemory({ text: "blocker" }), fingerprint: `goal-${n}`, status: n === 0 ? "abandoned" : "open",
  })));
  await db.insert(schema.memoryTombstones).values({ userKey, fingerprint: "memory-0" });
  await db.insert(schema.copilotRuns).values({ userKey, sessionId: sessions[0].id, stateCiphertext: encryptMemory({ marker }), callId: marker,
    toolName: "click", contextVersion: 1, actionCount: 1, expiresAt: new Date("2020-01-01") });
  await db.insert(schema.memoryAuditEvents).values({ userKey, action: "forgotten", entityType: "memory" });
}

async function snapshot() {
  const tables = ["copilot_users", "conversation_sessions", "conversation_messages", "conversation_summaries", "copilot_memories", "copilot_goals", "memory_tombstones", "copilot_runs", "memory_audit_events"];
  return Promise.all(tables.map(table => client.query(`SELECT * FROM charly_memory.${table} ORDER BY 1`)));
}

describe("complete retained memory export", () => {
  it("exports all nine tables for a disabled identity without modifying records or including another user", async () => {
    await seed(own, "OWN_DATA"); await seed(other, "OTHER_PRIVATE_DATA");
    const before = await snapshot();
    const exported = await exportMemory(own);
    expect(exported).toMatchObject({ schemaVersion: 2, complete: true, replayAllowed: false, identityMapping: "unverified", user: { memoryEnabled: false, profile: { firstName: "OWN_DATA" } } });
    expect(exported.sessions).toHaveLength(2);
    expect(exported.messages).toHaveLength(30);
    expect(exported.summaries).toHaveLength(2);
    expect(exported.memories).toHaveLength(10);
    expect(exported.goals).toHaveLength(6);
    expect(exported.tombstones).toHaveLength(1);
    expect(exported.runs).toHaveLength(1);
    expect(exported.auditEvents).toHaveLength(1);
    expect(exported.memories.some(row => row.status === "forgotten")).toBe(true);
    expect(exported.memories.some(row => row.expiresAt instanceof Date && row.expiresAt.getFullYear() === 2020)).toBe(true);
    expect(JSON.stringify(exported)).not.toMatch(/OTHER_PRIVATE_DATA|Ciphertext|ciphertext/);
    expect(await snapshot()).toEqual(before);
    expect(queries.join("\n")).toMatch(/repeatable read.*read only/i);
    expect(queries.some(query => /^(insert|update|delete)/i.test(query))).toBe(false);
  }, 20_000);

  it("does not create an unknown identity and preserves retained audit records after deletion", async () => {
    const db = drizzle(client, { schema });
    await db.insert(schema.memoryAuditEvents).values({ userKey: own, action: "deleted", entityType: "user" });
    const exported = await exportMemory(own);
    expect(exported.user).toBeNull(); expect(exported.messages).toEqual([]);
    expect(exported.auditEvents).toHaveLength(1);
    expect((await db.select().from(schema.copilotUsers))).toEqual([]);
    await expect(exportMemory("invalid")).rejects.toThrow("INVALID_MEMORY_EXPORT_IDENTITY");
  });

  it("keeps service authentication and returns a generic failure on corrupt ciphertext instead of a partial archive", async () => {
    await seed(own, "PRIVATE_VALUE");
    const request = (authorization?: string) => new Request("https://studio.test/api/internal/memory/export", {
      method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ userKey: own }),
    });
    queries.length = 0;
    expect((await POST(request())).status).toBe(401); expect(queries).toEqual([]);
    const response = await POST(request(`Bearer ${token}`));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).messages).toHaveLength(30);
    await client.exec("UPDATE charly_memory.conversation_messages SET ciphertext = 'corrupt'");
    const failed = await POST(request(`Bearer ${token}`));
    expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: "memory_unavailable" });
  }, 20_000);
});
