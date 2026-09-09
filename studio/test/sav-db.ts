import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/db/schema";
import type { requireDb } from "../src/db";

/** Production migrations against an isolated, in-memory PostgreSQL engine. */
export async function createSavTestDb() {
  const client = new PGlite({ extensions: { vector } });
  const directory = new URL("../drizzle/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const migration = await readFile(new URL(file, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  return { client, db: drizzle(client, { schema }) as unknown as ReturnType<typeof requireDb> };
}
