/** Test helper for a guard test that needs one sav.sync_state row (a schema marker) gone while it runs, on a database shared with
 * other files. The row is captured whole (every column, as jsonb: timestamps keep their microseconds), removed, and after the body
 * put back exactly as it was, only if it existed: a row absent before stays absent, nothing is invented (no status, no now()).
 * Every other row is untouched. A failed restore is never silent and never hides the body's own failure. */
type SyncStateClient = { query<T>(sqlText: string, params?: unknown[]): Promise<{ rows: T[] }> };

const read = async (client: SyncStateClient, key: string) =>
  (await client.query<{ row: string }>("SELECT to_jsonb(s)::text AS row FROM sav.sync_state s WHERE s.key = $1", [key])).rows[0]?.row;

async function restore(client: SyncStateClient, key: string, original: string | undefined) {
  if (original === undefined) {
    if (await read(client, key) !== undefined) throw Error(`SAV_SYNC_STATE_ROW_APPEARED:${key}`);
    return;
  }
  await client.query("INSERT INTO sav.sync_state SELECT * FROM jsonb_populate_record(NULL::sav.sync_state, $1::jsonb)", [original]);
  if (await read(client, key) !== original) throw Error(`SAV_SYNC_STATE_ROW_NOT_RESTORED:${key}`);
}

export async function withoutSyncStateRow<T>(client: SyncStateClient, key: string, body: () => Promise<T>): Promise<T> {
  const original = await read(client, key);
  await client.query("DELETE FROM sav.sync_state WHERE key = $1", [key]);
  let result: T;
  try { result = await body(); }
  catch (failure) {
    try { await restore(client, key, original); }
    catch (restoreFailure) { throw new AggregateError([failure, restoreFailure], `SAV_SYNC_STATE_RESTORE_FAILED after the body failed: ${String(failure)}`); }
    throw failure;
  }
  await restore(client, key, original);
  return result;
}
