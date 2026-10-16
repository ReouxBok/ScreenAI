import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PGlite } from "@electric-sql/pglite";
import type { requireDb } from "../src/db";
import * as schema from "../src/db/schema";

export function validateSavNativeTestTarget(value: string, token: string | undefined) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || Number(url.port) < 49152
    || !/^\/codex_sav_[a-z0-9]+$/.test(url.pathname) || url.username !== "codex_test" || url.search || url.hash
    || !token || !/^[a-f0-9]{32,64}$/.test(token)) throw new Error("SAV_NATIVE_TEST_TARGET_REFUSED");
}

/** A dedicated native instance only; never falls back to DATABASE_URL. */
export async function createSavNativeTestDb(value: string, token: string | undefined) {
  validateSavNativeTestTarget(value, token);
  const sql = postgres(value, { max: 4, prepare: false, connect_timeout: 5, onnotice: () => {},
    connection: { application_name: "codex_sav_validation", statement_timeout: 10000, lock_timeout: 5000 } });
  try {
    const [identity] = await sql<{ token: string }[]>`select current_setting('codex.test_token', true) as token`;
    if (identity?.token !== token) throw new Error("SAV_NATIVE_TEST_INSTANCE_REFUSED");
    const columns = await sql<{ column_name: string }[]>`select column_name from information_schema.columns
      where table_schema='sav' and table_name='learning_admission_attempts' and column_name in ('comparison_lease_token','comparison_lease_until')`;
    if (columns.length !== 2) throw new Error("SAV_NATIVE_TEST_MIGRATION_REQUIRED");
    const convert = <T>(result: postgres.RowList<postgres.Row[]>) => ({ rows: [...result] as T[],
      fields: (result.columns ?? []).map(column => ({ name: column.name, dataTypeID: column.type })), affectedRows: result.count });
    const client: Pick<PGlite, "exec" | "query" | "close"> = {
      exec: async query => {
        const result = await sql.unsafe(query);
        const results = "command" in result ? [result] : result as unknown as postgres.RowList<postgres.Row[]>[];
        return results.map(result => convert<Record<string, unknown>>(result));
      },
      query: async <T>(query: string, params?: unknown[]) => convert<T>(await sql.unsafe(query, params as Parameters<typeof sql.unsafe>[1])),
      close: async () => { await sql.end({ timeout: 2 }); },
    };
    return { client, db: drizzle(sql, { schema }) as unknown as ReturnType<typeof requireDb> };
  } catch (error) {
    await sql.end({ timeout: 2 });
    throw error;
  }
}
