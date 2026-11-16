import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { openSavReplayReadOnlyDatabase, savReplayDatabaseTarget, SAV_REPLAY_READ_ONLY_CONNECTION } from "./replay-database";

// Synthetic URLs only: no real host, no credential.
const URL_FULL = "postgresql://syn_user:syn_secret@db.example.invalid:6543/sav_syn";
const exact = { host: "db.example.invalid", port: "6543", database: "sav_syn" };

describe("review batch 3 (B2): the replay's database target is named in full", () => {
  it("accepts only the exact host, port and database name of DATABASE_URL", () => {
    expect(savReplayDatabaseTarget(URL_FULL, exact)).toEqual({ ok: true, target: exact });
    // Same host, another database or port of the same cluster: refused (the gap of the review).
    expect(savReplayDatabaseTarget(URL_FULL, { ...exact, database: "sav_other" })).toEqual({ ok: false, problem: "database_name_mismatch" });
    expect(savReplayDatabaseTarget(URL_FULL, { ...exact, port: "5432" })).toEqual({ ok: false, problem: "database_port_mismatch" });
    expect(savReplayDatabaseTarget(URL_FULL, { ...exact, host: "db.example.invalid." })).toEqual({ ok: false, problem: "database_host_mismatch" });
    expect(savReplayDatabaseTarget(URL_FULL, { host: exact.host, database: exact.database })).toEqual({ ok: false, problem: "database_port_mismatch" });
    // A URL without a port is Postgres's 5432, which must still be repeated.
    expect(savReplayDatabaseTarget("postgres://u:p@localhost/sav_syn", { host: "localhost", port: "5432", database: "sav_syn" })).toMatchObject({ ok: true });
    expect(savReplayDatabaseTarget("postgres://u:p@localhost/sav_syn", { host: "localhost", database: "sav_syn" })).toEqual({ ok: false, problem: "database_port_mismatch" });
  });

  it("refuses a missing, unreadable or non-Postgres URL, and a URL without a database name", () => {
    expect(savReplayDatabaseTarget(undefined, exact)).toEqual({ ok: false, problem: "database_url_unreadable" });
    expect(savReplayDatabaseTarget("pglite:./syn", exact)).toEqual({ ok: false, problem: "database_scheme_refused" });
    expect(savReplayDatabaseTarget("mysql://u:p@db.example.invalid:6543/sav_syn", exact)).toEqual({ ok: false, problem: "database_scheme_refused" });
    expect(savReplayDatabaseTarget("postgres://u:p@db.example.invalid:6543/", { ...exact, database: "" })).toEqual({ ok: false, problem: "database_url_unreadable" });
  });
});

describe("review batch 3 (B2): the replay's session is read only", () => {
  const fakeSql = (row: Record<string, string> | null) => {
    const end = vi.fn(async () => undefined);
    const sql = Object.assign(vi.fn(async () => (row ? [row] : [])), { end, options: { parsers: {}, serializers: {} } }) as unknown as postgres.Sql;
    return { sql, end };
  };

  it("opens its own connection with default_transaction_read_only=on as a startup parameter, and proves it on the server before any read", async () => {
    const { sql, end } = fakeSql({ readOnly: "on", database: "sav_syn" });
    const factory = vi.fn(() => sql);
    const opened = await openSavReplayReadOnlyDatabase(URL_FULL, exact, factory);
    expect(factory).toHaveBeenCalledWith(URL_FULL, expect.objectContaining({ max: 1, connection: expect.objectContaining({ default_transaction_read_only: true }) }));
    expect(SAV_REPLAY_READ_ONLY_CONNECTION.default_transaction_read_only).toBe(true);
    expect(end).not.toHaveBeenCalled();
    await opened.close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("closes the connection and reads nothing when the server is not read only or is another database", async () => {
    for (const [row, error] of [[{ readOnly: "off", database: "sav_syn" }, "SAV_REPLAY_DATABASE_NOT_READ_ONLY"], [{ readOnly: "on", database: "sav_other" }, "SAV_REPLAY_DATABASE_NAME_MISMATCH"],
      [null, "SAV_REPLAY_DATABASE_NOT_READ_ONLY"]] as const) {
      const { sql, end } = fakeSql(row);
      await expect(openSavReplayReadOnlyDatabase(URL_FULL, exact, () => sql)).rejects.toThrow(error);
      expect(end).toHaveBeenCalledTimes(1);
    }
  });

  it("Postgres itself refuses a write in a session whose default transaction is read only (PGlite, same engine)", async () => {
    const db = new PGlite();
    try {
      await db.exec("create table replay_probe (id int)");
      await db.exec("set default_transaction_read_only = on");
      expect((await db.query<{ ro: string }>("select current_setting('transaction_read_only') as ro")).rows[0]!.ro).toBe("on");
      await expect(db.exec("insert into replay_probe values (1)")).rejects.toThrow(/read-only transaction/);
      await expect(db.exec("update replay_probe set id = 2")).rejects.toThrow(/read-only transaction/);
      await expect(db.exec("delete from replay_probe")).rejects.toThrow(/read-only transaction/);
      expect((await db.query<{ n: number }>("select count(*)::int as n from replay_probe")).rows[0]!.n).toBe(0);
    } finally { await db.close(); }
  });

  // Native Postgres only (the CI's sav-native instance): the very opener, its startup parameter, then a write refused by the server.
  it.skipIf(!process.env.SAV_TEST_POSTGRES_URL)("native: a connection opened by the replay cannot write", async () => {
    const url = process.env.SAV_TEST_POSTGRES_URL!, parsed = new URL(url);
    const target = { host: parsed.hostname, port: parsed.port || "5432", database: decodeURIComponent(parsed.pathname.slice(1)) };
    const opened = await openSavReplayReadOnlyDatabase(url, target);
    try {
      await expect(opened.db.execute("create temporary table replay_probe (id int)")).rejects.toThrow(/read-only transaction/);
    } finally { await opened.close(); }
  });
});
