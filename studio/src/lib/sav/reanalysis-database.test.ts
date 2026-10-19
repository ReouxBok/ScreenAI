import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { auditLogs, savActions, savAgentRuns, savDecisions, savMessages, savThreads } from "@/db/schema";
import { guardReanalysisDatabase, reanalysisServerIdentity } from "./reanalysis-database";
afterEach(() => vi.unstubAllEnvs());
describe("reanalysis database boundary", () => {
  it("permits SELECT and own audit envelopes, refuses every operational write", async () => {
    const insert = vi.fn((table: unknown) => ({ table, values: vi.fn(input => input) })), update = vi.fn((table: unknown) => ({ table, set: vi.fn(input => input) }));
    const native = { select: vi.fn(), insert, update, delete: vi.fn(), execute: vi.fn((query: unknown) => query), transaction: async (fn: (tx: unknown) => unknown) => fn(native) };
    const db = guardReanalysisDatabase(native);
    db.execute(sql`select 1`); expect(native.execute).toHaveBeenCalledOnce();
    for (const table of [savActions, savAgentRuns, savDecisions, savMessages, savThreads]) {
      expect(() => db.insert(table)).toThrow("WRITE_REFUSED"); expect(() => db.update(table)).toThrow("WRITE_REFUSED");
    }
    expect(() => db.delete()).toThrow("WRITE_REFUSED");
    expect(() => (db as unknown as { with(): unknown }).with()).toThrow("WRITE_REFUSED");
    for (const query of [sql`update sav.messages set subject='changed'`, sql`with changed as (delete from sav.actions returning *) select * from changed`])
      expect(() => db.execute(query)).toThrow("RAW_WRITE_REFUSED");
    expect(() => db.insert(auditLogs).values({ action: "other", actorEmail: "ugo@limova.ai", entityType: "sav_reanalysis_message" })).toThrow("AUDIT_REFUSED");
    db.insert(auditLogs).values({ action: "sav_reanalysis_claim", actorEmail: "ugo@limova.ai", entityType: "sav_reanalysis_message" });
    expect(() => db.update(auditLogs).set({ action: "overwritten" })).toThrow("AUDIT_REFUSED");
    expect(() => db.update(auditLogs).set({ technicalMetadata: { state: "ready" } })).not.toThrow();
    await db.transaction(async (tx: unknown) => { expect(() => (tx as typeof db).insert(savMessages)).toThrow("WRITE_REFUSED"); });
  });
  it("requires a production Studio artifact and exposes only a database fingerprint", () => {
    const env = { NODE_ENV: "production", VERCEL_ENV: "production", SAV_RELEASE_STAGE: "v0", SAV_PILOT_MODE: "false", VERCEL_PROJECT_ID: "prj_uVRT3wH5tI3cfHtTktG15pG2IzQz",
      VERCEL_GIT_COMMIT_SHA: "a".repeat(40), DATABASE_URL: "postgres://fixture:private@test.neon.tech/db?sslmode=require", SAV_ENCRYPTION_KEY_V1: "fixture", SAV_GEMINI_API_KEY: "fixture" };
    const identity = reanalysisServerIdentity(env);
    expect(identity.databaseHash).toHaveLength(64); expect(JSON.stringify(identity)).not.toContain("private");
    for (const patch of [{ VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "other" }, { VERCEL_ORG_ID: "other" }, { SAV_PILOT_MODE: "true" }, { SAV_CODE_REVISION: "b".repeat(40) }, { SAV_GEMINI_API_KEY: "" }])
      expect(() => reanalysisServerIdentity({ ...env, ...patch })).toThrow("RUNTIME_REFUSED");
  });
});
