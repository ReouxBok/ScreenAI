import "server-only";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, type SQL } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";
import { withStudioDatabase } from "@/db";
import { reanalysisHash } from "./reanalysis-contract";

const dialect = new PgDialect();
/** Defence in depth: this runtime can mutate only its own audit envelopes. */
export function guardReanalysisDatabase<T extends object>(db: T): T {
  return new Proxy(db, { get(target, key) {
    const method: unknown = Reflect.get(target, key);
    if (key === "delete" || key === "$client") return () => { throw new Error("SAV_REANALYSIS_DB_WRITE_REFUSED"); };
    if (typeof method !== "function") return method;
    if (key === "transaction") return (work: (tx: unknown) => unknown, options: unknown) => Reflect.apply(method, target, [(tx: object) => work(guardReanalysisDatabase(tx)), options]);
    if (key === "execute") return (query: SQL) => {
      const text = dialect.sqlToQuery(query).sql;
      if (!/^\s*(?:select|with)\b/i.test(text) || /\b(?:insert|update|delete|alter|drop|create|grant|revoke|truncate|copy|call|do)\b/i.test(text))
        throw new Error("SAV_REANALYSIS_DB_RAW_WRITE_REFUSED");
      return Reflect.apply(method, target, [query]);
    };
    if (key === "insert" || key === "update") return (table: unknown) => {
      if (table !== schema.auditLogs) throw new Error("SAV_REANALYSIS_DB_WRITE_REFUSED");
      const builder = Reflect.apply(method, target, [table]) as object;
      if (key === "update") return { set(input: Record<string, unknown>) {
        if (Object.keys(input).some(name => name !== "technicalMetadata")) throw new Error("SAV_REANALYSIS_AUDIT_REFUSED");
        const query = Reflect.apply(Reflect.get(builder, "set"), builder, [input]);
        // No executable builder escapes before a mandatory, server-owned filter.
        return { where(condition: SQL) { return query.where(and(condition, eq(schema.auditLogs.actorEmail, "ugo@limova.ai"),
          eq(schema.auditLogs.action, "sav_reanalysis_claim"), eq(schema.auditLogs.entityType, "sav_reanalysis_message"))); } };
      } };
      const protectInsert = (query: object): object => new Proxy(query, { get(value, property) {
        if (property === "onConflictDoUpdate") return () => { throw new Error("SAV_REANALYSIS_AUDIT_REFUSED"); };
        const fn = Reflect.get(value, property);
        if (property === "onConflictDoNothing" || property === "returning") return (...args: unknown[]) => protectInsert(Reflect.apply(fn, value, args));
        return typeof fn === "function" ? fn.bind(value) : fn;
      } });
      return new Proxy(builder, { get(value, property) {
        const fn = Reflect.get(value, property);
        if (property === "values") return (input: Record<string, unknown> | Record<string, unknown>[]) => {
          for (const row of Array.isArray(input) ? input : [input]) {
            if (row.actorEmail !== "ugo@limova.ai" || typeof row.action !== "string" || !row.action.startsWith("sav_reanalysis_")
              || typeof row.entityType !== "string" || !row.entityType.startsWith("sav_reanalysis_")) throw new Error("SAV_REANALYSIS_AUDIT_REFUSED");
          }
          return protectInsert(Reflect.apply(fn, value, [input]));
        };
        return typeof fn === "function" ? fn.bind(value) : fn;
      } });
    };
    return typeof method === "function" ? method.bind(target) : method;
  } });
}

export function reanalysisServerIdentity(env: Record<string, string | undefined> = process.env) {
  const url = new URL(env.DATABASE_URL ?? "invalid:");
  const codeRevision = env.VERCEL_GIT_COMMIT_SHA;
  // VERCEL_ORG_ID is a CLI variable, not a guaranteed runtime system variable.
  // The project/team pin is deployment configuration, independently rechecked
  // against the platform artifact before the operator authorizes a cohort.
  const projectId = "prj_uVRT3wH5tI3cfHtTktG15pG2IzQz", teamId = "team_a0bCGlwGCTwVrN5sFhCE8ju8";
  if (env.NODE_ENV !== "production" || env.VERCEL_ENV !== "production" || env.SAV_RELEASE_STAGE !== "v0" || env.SAV_PILOT_MODE !== "false"
    || env.SAV_TEST_MODE === "true" || !/^[a-f0-9]{40}$/.test(codeRevision ?? "")
    || env.SAV_CODE_REVISION && env.SAV_CODE_REVISION !== codeRevision
    || env.VERCEL_PROJECT_ID !== projectId || env.VERCEL_ORG_ID && env.VERCEL_ORG_ID !== teamId
    || !["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.endsWith(".neon.tech") || url.hash
    || !env.SAV_ENCRYPTION_KEY_V1 || !env.SAV_GEMINI_API_KEY) throw new Error("SAV_REANALYSIS_RUNTIME_REFUSED");
  return { projectId, teamId, codeRevision: codeRevision!,
    databaseHash: reanalysisHash({ host: url.hostname, port: url.port || "5432", database: url.pathname }) };
}

/** Dedicated verified TLS client, scoped to this request. Normal application pool stays unchanged. */
export async function withReanalysisDatabase<T>(work: () => Promise<T>): Promise<T> {
  reanalysisServerIdentity();
  const source = new URL(process.env.DATABASE_URL!);
  // The explicit ssl option is authoritative in postgres.js. Retain no URL
  // options that could change role, search_path, startup options or transport.
  source.search = "";
  const client = postgres(source.href, { max: 1, prepare: false, ssl: { rejectUnauthorized: true }, connect_timeout: 10, idle_timeout: 10,
    connection: { application_name: "sav_reanalysis_candidate", statement_timeout: 20_000, lock_timeout: 2_000, timezone: "UTC" }, onnotice: () => {} });
  try { return await withStudioDatabase(guardReanalysisDatabase(drizzle(client, { schema })), work); }
  finally { await client.end({ timeout: 2 }); }
}
