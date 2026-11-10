import postgres from "postgres";

// Probes for the native concurrency tests (two or more overlapping connections). The probes run on their OWN single-connection client, never on the pool the test
// reserves from: a test that reserves most of its pool and then probes through it starves, and a failed test must not leave its connections busy for the next one.
export type NativeHandle = { conn: postgres.ReservedSql; pid: number };

export const openNativeObserver = (url: string) => postgres(url, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {},
  connection: { application_name: "codex_sav_observer", statement_timeout: 5000 } });

export async function openNativeHandle(pool: postgres.Sql): Promise<NativeHandle> {
  const conn = await pool.reserve();
  const [{ pid }] = await conn.unsafe("SELECT pg_backend_pid() AS pid");
  return { conn, pid: pid as number };
}

const snapshot = (observer: postgres.Sql) => observer.unsafe(
  "SELECT pid, state, wait_event_type AS wait, pg_blocking_pids(pid)::text AS blockers, left(query, 60) AS query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle' ORDER BY pid");
const give = async (observer: postgres.Sql, what: string): Promise<never> => { throw new Error(`${what}:${JSON.stringify([...await snapshot(observer)])}`); };
const pause = () => new Promise(resolve => setTimeout(resolve, 50));

/** The statement of `pid` is waiting for a lock (not merely slow). */
export async function waitingOnLock(observer: postgres.Sql, pid: number) {
  for (let i = 0; i < 100; i++) {
    const [row] = await observer.unsafe("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid]);
    if (row?.wait_event_type === "Lock") return;
    await pause();
  }
  return give(observer, "NOT_BLOCKED");
}

/**
 * At least `count` backends wait behind `holder`, directly or through the queue. Row locks queue: the first waiter on a row waits for the holder's transaction,
 * the second waits for the FIRST waiter's tuple lock (pg_blocking_pids names only that waiter), so a direct count would never reach two. The chain is walked.
 */
export async function blockedBehind(observer: postgres.Sql, holder: number, count: number) {
  for (let i = 0; i < 100; i++) {
    const [row] = await observer.unsafe(`WITH RECURSIVE waits AS (SELECT pid, unnest(pg_blocking_pids(pid)) AS blocker FROM pg_stat_activity WHERE datname = current_database()),
      reach AS (SELECT pid FROM waits WHERE blocker = $1 UNION SELECT w.pid FROM waits w JOIN reach r ON w.blocker = r.pid) SELECT count(*)::int AS n FROM reach`, [holder]);
    if ((row?.n as number) >= count) return;
    await pause();
  }
  return give(observer, `NOT_BLOCKED_BEHIND_${holder}_X${count}`);
}

/** The end of every path, a failure included: cancel a statement still waiting on a lock, end the transaction, only then give the connection back. */
export async function finishNativeHandle(observer: postgres.Sql, handle: NativeHandle) {
  await observer.unsafe("SELECT pg_cancel_backend($1)", [handle.pid]);
  await handle.conn.unsafe("ROLLBACK");
  handle.conn.release();
}
