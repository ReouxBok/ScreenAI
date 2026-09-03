import { PGlite } from "@electric-sql/pglite";
import { vector as pgliteVector } from "@electric-sql/pglite-pgvector";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
type StudioDb = PostgresJsDatabase<typeof schema>;
const globalForDb = globalThis as typeof globalThis & {
  __charlyStudioDb?: StudioDb;
  __charlyStudioCloseDb?: () => Promise<void>;
};
let cachedDb:StudioDb|null=globalForDb.__charlyStudioDb ?? null;
let closeClient:(()=>Promise<void>)|null=globalForDb.__charlyStudioCloseDb ?? null;
export function isDatabaseConfigured(){return Boolean(process.env.DATABASE_URL)}
export function getDb(){
  if(cachedDb)return cachedDb;
  const url=process.env.DATABASE_URL;
  if(!url)return null;
  if(url.startsWith("pglite:")){
    if(process.env.NODE_ENV==="production")throw new Error("PGLITE_FORBIDDEN_IN_PRODUCTION");
    const client=new PGlite(url.replace(/^pglite:/,"file:"),{extensions:{vector:pgliteVector}});
    closeClient=()=>client.close();
    cachedDb=drizzlePglite(client,{schema}) as unknown as StudioDb;
  }else{
    const client=postgres(url,{max:1,prepare:false,idle_timeout:20,connect_timeout:10});
    closeClient=()=>client.end();
    cachedDb=drizzle(client,{schema});
  }
  globalForDb.__charlyStudioDb=cachedDb;
  if(closeClient) globalForDb.__charlyStudioCloseDb=closeClient;
  return cachedDb;
}
export function requireDb(){const db=getDb();if(!db)throw new Error("DATABASE_URL_MISSING");return db}
export async function closeDb(){if(closeClient)await closeClient();closeClient=null;cachedDb=null;delete globalForDb.__charlyStudioDb;delete globalForDb.__charlyStudioCloseDb}
