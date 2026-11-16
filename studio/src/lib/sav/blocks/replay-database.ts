import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";

/*
 * SAV-92 harness (review batch 3, B2): the database a replay reads, named in full and opened READ ONLY.
 *   - The target is never implicit: the caller repeats the host, the port and the database name of DATABASE_URL, each exactly (a port the URL
 *     leaves out is Postgres's 5432). Two databases on one host (localhost, one cluster) are therefore told apart. `pglite:` and any other
 *     scheme are refused.
 *   - The session is read only from its first statement: `default_transaction_read_only` (on) is a startup parameter of the connection (it
 *     survives a reconnection of the pool, unlike a `SET` sent once), then checked on the server (`transaction_read_only` must read `on`) and the
 *     server's own database name must be the one named. Any write the replay might reach is refused by Postgres itself
 *     (`cannot execute INSERT in a read-only transaction`), whatever the code path.
 * No credential is printed or returned: only the host, port and database name.
 */

export type SavReplayDatabaseTarget = Readonly<{ host: string; port: string; database: string }>;
export type SavReplayDatabaseTargetProblem = "database_url_unreadable" | "database_scheme_refused" | "database_host_mismatch" | "database_port_mismatch" | "database_name_mismatch";

/** The target DATABASE_URL names, only when the caller repeated its host, port and database name exactly. */
export function savReplayDatabaseTarget(url: string | undefined, given: Readonly<{ host?: string; port?: string; database?: string }>):
  { ok: true; target: SavReplayDatabaseTarget } | { ok: false; problem: SavReplayDatabaseTargetProblem } {
  let parsed: URL;
  try { parsed = new URL(url ?? ""); } catch { return { ok: false, problem: "database_url_unreadable" }; }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return { ok: false, problem: "database_scheme_refused" };
  let database: string;
  try { database = decodeURIComponent(parsed.pathname.replace(/^\//, "")); } catch { return { ok: false, problem: "database_url_unreadable" }; }
  const target = { host: parsed.hostname, port: parsed.port || "5432", database };
  if (!target.host || !target.database) return { ok: false, problem: "database_url_unreadable" };
  if (given.host !== target.host) return { ok: false, problem: "database_host_mismatch" };
  if (given.port !== target.port) return { ok: false, problem: "database_port_mismatch" };
  if (given.database !== target.database) return { ok: false, problem: "database_name_mismatch" };
  return { ok: true, target };
}

/** The read-only connection parameters: sent at connection start, so every session of the pool begins read only. */
export const SAV_REPLAY_READ_ONLY_CONNECTION = Object.freeze({ application_name: "sav_block_replay_read_only", default_transaction_read_only: true });

type SqlFactory = (url: string, options: postgres.Options<Record<string, postgres.PostgresType>>) => postgres.Sql;

/**
 * Opens the replay's own connection (never the shared pool of DATABASE_URL), read only, and proves it before any read: the server must report
 * `transaction_read_only = on` and the database named. Otherwise the connection is closed and nothing is read.
 */
export async function openSavReplayReadOnlyDatabase(url: string, target: SavReplayDatabaseTarget, factory: SqlFactory = postgres) {
  const sql = factory(url, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 20, onnotice: () => {}, connection: { ...SAV_REPLAY_READ_ONLY_CONNECTION } });
  try {
    const [row] = await sql<{ readOnly: string; database: string }[]>`select current_setting('transaction_read_only') as "readOnly", current_database() as "database"`;
    if (row?.readOnly !== "on") throw new Error("SAV_REPLAY_DATABASE_NOT_READ_ONLY");
    if (row.database !== target.database) throw new Error("SAV_REPLAY_DATABASE_NAME_MISMATCH");
  } catch (error) {
    await sql.end({ timeout: 5 }).catch(() => undefined);
    throw error;
  }
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}
