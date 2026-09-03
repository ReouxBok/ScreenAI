import { rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { categories } from "../src/db/schema";
import { CATEGORIES } from "../src/lib/content";
const target=path.resolve(process.env.STUDIO_E2E_DB_DIR ?? ".e2e-db");
try { await rename(target,path.join(os.tmpdir(),`limova-studio-e2e-backup-${Date.now()}`)); } catch (error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
const client=new PGlite(`file://${target}`,{extensions:{vector}});
const db=drizzle(client);
await migrate(db,{migrationsFolder:path.resolve("drizzle")});
await db.insert(categories).values(CATEGORIES.map(([slug,label],position)=>({slug,label,position}))).onConflictDoNothing();
await client.close();
console.log(`E2E database ready at ${target}`);
