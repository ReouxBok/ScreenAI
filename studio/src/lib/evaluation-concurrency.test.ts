import { createHash, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { getTableColumns, getTableName } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";
let db: PostgresJsDatabase<typeof schema>;
vi.mock("@/db", () => ({ requireDb: () => db }));
import { appendEvaluationEvent, completeEvaluation } from "./evaluations";

const socket = process.env.STUDIO_TEST_PG_SOCKET;
const enabled = socket?.startsWith("/tmp/studio-evidence-pg-") === true;
describe.skipIf(!enabled)("PostgreSQL evaluation concurrency", () => {
  let sql: ReturnType<typeof postgres>;
  const namespace = `evaluation_test_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    sql = postgres({ host: socket, database: "postgres", user: userInfo().username, max: 8, connection: { search_path: namespace } });
    await sql.unsafe(`CREATE SCHEMA "${namespace}"`);
    db = drizzle(sql, { schema });
    await sql.unsafe(`CREATE TYPE content_type AS ENUM ('article', 'onboarding'); CREATE TYPE content_status AS ENUM ('draft', 'in_review', 'published', 'archived'); CREATE TYPE content_visibility AS ENUM ('charly_only', 'charly_and_help');`);
    const tables = [schema.contentItems, schema.contentVersions, schema.evaluationSuites, schema.evaluationCases, schema.evaluationRuns, schema.evaluationEvents];
    for (const table of tables) {
      const columns = Object.values(getTableColumns(table)).map(column => {
        const suffix = column.name === "id" ? " PRIMARY KEY DEFAULT gen_random_uuid()"
          : ["created_at", "updated_at"].includes(column.name) ? " DEFAULT now()" : "";
        return `"${column.name}" ${column.getSQLType()}${suffix}`;
      });
      await sql.unsafe(`CREATE TABLE "${getTableName(table)}" (${columns.join(",")})`);
    }
  });
  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await sql.end();
    }
  });

  async function run() {
    const itemId = randomUUID(), versionId = randomUUID(), suiteId = randomUUID(), caseId = randomUUID(), runId = randomUUID();
    const token = randomUUID();
    await db.insert(schema.contentItems).values({ id: itemId, slug: itemId, type: "onboarding", title: "Test", ownerEmail: "fixture@example.test", currentDraftVersionId: versionId });
    await sql`INSERT INTO content_versions (id,item_id) VALUES (${versionId},${itemId})`;
    await db.insert(schema.evaluationSuites).values({ id: suiteId, itemId, versionId, createdBy: "fixture", threshold: 80 });
    await db.insert(schema.evaluationCases).values({ id: caseId, suiteId, ordinal: 1, kind: "live_action", title: "Test", prompt: "Test", critical: true,
      expectation: { startPath: "/", objective: "Test", expectedPages: [], successCriteria: ["Test"], requiredTools: [] } });
    await db.insert(schema.evaluationRuns).values({ id: runId, suiteId, caseId, tokenHash: createHash("sha256").update(token).digest("hex"), status: "running", expiresAt: new Date(Date.now() + 60_000), createdBy: "fixture" });
    return { token, runId };
  }

  it("assigns unique ordinals to concurrent appends through the real service", async () => {
    const { token, runId } = await run();
    const results = await Promise.all(Array.from({ length: 12 }, () => appendEvaluationEvent(token, { kind: "response", status: "ok" })));
    expect(results.every(Boolean)).toBe(true);
    const rows = await sql`SELECT ordinal FROM evaluation_events WHERE run_id = ${runId} ORDER BY ordinal`;
    expect(rows.map(row => row.ordinal)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("finalizes once, rejects late events and scores only ordered complete evidence", async () => {
    const { token, runId } = await run();
    await appendEvaluationEvent(token, { kind: "tool_result", toolName: "click_element", status: "ok" });
    await appendEvaluationEvent(token, { kind: "tool_result", toolName: "verify_expected_result", status: "ok" });
    await appendEvaluationEvent(token, { kind: "response", status: "ok" });
    const results = await Promise.all([completeEvaluation(token, "correct"), completeEvaluation(token, "correct")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.run.status).toBe("passed");
    expect(await appendEvaluationEvent(token, { kind: "response", status: "ok" })).toBeNull();
    expect((await sql`SELECT count(*)::int AS count FROM evaluation_events WHERE run_id = ${runId}`)[0].count).toBe(3);
  });
});
