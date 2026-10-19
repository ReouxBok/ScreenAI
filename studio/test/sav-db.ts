import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/db/schema";
import type { requireDb } from "../src/db";

/** PGlite applies migrations; a native instance must already have passed the real migrator. */
export async function createSavTestDb() {
  const nativeUrl = process.env.SAV_TEST_POSTGRES_URL;
  if (nativeUrl) return (await import("./sav-native-db")).createSavNativeTestDb(nativeUrl, process.env.SAV_TEST_POSTGRES_TOKEN);
  const client = new PGlite({ extensions: { vector } });
  const directory = new URL("../drizzle/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const migration = await readFile(new URL(file, directory), "utf8");
    // Match the real migrator's atomic DDL transaction (including LOCK TABLE).
    await client.exec("BEGIN");
    try {
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.exec(statement);
      }
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      await client.close();
      throw error;
    }
  }
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof requireDb> };
}
