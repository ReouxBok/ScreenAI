import "dotenv/config";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle as pgliteDrizzle } from "drizzle-orm/pglite";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { drizzle as postgresDrizzle } from "drizzle-orm/postgres-js";
import { migrate as postgresMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
const url=process.env.DATABASE_URL;
if(!url) throw new Error("DATABASE_URL is required");
if(url.startsWith("pglite:")){
  if(process.env.NODE_ENV==="production") throw new Error("PGlite is test-only");
  const client=new PGlite(url.replace(/^pglite:/,"file:"),{extensions:{vector}});
  await pgliteMigrate(pgliteDrizzle(client),{migrationsFolder:"drizzle"}); await client.close();
}else{
  const client=postgres(url,{max:1,prepare:false}); await postgresMigrate(postgresDrizzle(client),{migrationsFolder:"drizzle"}); await client.end();
}
console.log("Studio database migrated.");
