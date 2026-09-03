import "server-only";

import { PGlite } from "@electric-sql/pglite";
import { vector as pgliteVector } from "@electric-sql/pglite-pgvector";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type MemoryDb = PostgresJsDatabase<typeof schema>;
const globalForMemory = globalThis as typeof globalThis & { __charlyMemoryDb?: MemoryDb };
let cached = globalForMemory.__charlyMemoryDb ?? null;

export function isMemoryConfigured() {
  return Boolean(process.env.MEMORY_DATABASE_URL && process.env.MEMORY_ENCRYPTION_KEY_V1);
}

export function getMemoryDb() {
  if (cached) return cached;
  const url = process.env.MEMORY_DATABASE_URL;
  if (!url) return null;
  if (url.startsWith("pglite:")) {
    if (process.env.NODE_ENV === "production") throw new Error("PGLITE_FORBIDDEN_IN_PRODUCTION");
    const client = new PGlite(url.replace(/^pglite:/, "file:"), { extensions: { vector: pgliteVector } });
    cached = drizzlePglite(client, { schema }) as unknown as MemoryDb;
  } else {
    const client = postgres(url, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10 });
    cached = drizzle(client, { schema });
  }
  globalForMemory.__charlyMemoryDb = cached;
  return cached;
}

export function requireMemoryDb() {
  const db = getMemoryDb();
  if (!db) throw new Error("MEMORY_DATABASE_URL_MISSING");
  return db;
}
