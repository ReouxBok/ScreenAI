import "dotenv/config";
import { drizzle as postgresDrizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.MEMORY_DATABASE_URL;
if (!url) throw new Error("MEMORY_DATABASE_URL is required");
if (url.startsWith("pglite:")) throw new Error("Use a PostgreSQL/Neon database for memory migrations");
const client = postgres(url, { max: 1, prepare: false });
await migrate(postgresDrizzle(client), { migrationsFolder: "memory-drizzle" });
await client.end();
console.log("Charly memory database migrated.");
