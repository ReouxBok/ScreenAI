import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateSavNativeTestTarget } from "../../../../test/sav-native-db";
import { finishNativeHandle, openNativeHandle, openNativeObserver, waitingOnLock } from "../../../../test/sav-native-locks";

// Real concurrency on the effect ledger's parents (0050) and the reply validations (0051): two connections that truly overlap,
// which PGlite (one connection) cannot show. Runs only on the CI's isolated native instance (SAV_TEST_POSTGRES_URL, migrated by the
// real migrator first); skipped everywhere else. Synthetic rows with fresh ids: the job's database is shared and nothing here is deleted.
const URL_ = process.env.SAV_TEST_POSTGRES_URL, TOKEN = process.env.SAV_TEST_POSTGRES_TOKEN;
type Conn = postgres.ReservedSql;

describe.skipIf(!URL_)("native Postgres: 0050 parent locks and 0051 revocation against the marker, on two connections", () => {
  let sql: postgres.Sql, observer: postgres.Sql;
  const ids = { staff: randomUUID(), policy: randomUUID(), case: randomUUID() };
  const exec = (q: string, params: unknown[] = []) => sql.unsafe(q, params as never[]);
  const open = () => openNativeHandle(sql);
  // Proof that the second statement is really waiting on the first transaction's lock, not merely slow (observed on its own connection, never through the test pool).
  const blocked = (pid: number) => waitingOnLock(observer, pid);
  const done = (...handles: Awaited<ReturnType<typeof open>>[]) => Promise.all(handles.map(handle => finishNativeHandle(observer, handle)));
  const caseExecution = async () => {
    const id = randomUUID();
    await exec("INSERT INTO sav.case_effect_executions(id, case_id, reply_key, thread_id, policy_id, policy_hash, payload_ciphertext) VALUES ($1, $2, $3, gen_random_uuid(), $4, 'h', 'c')",
      [id, ids.case, `sav-case-reply:${ids.case}:${id}`, ids.policy]);
    return { id, key: `sav-case-reply:${ids.case}:${id}` };
  };
  const approved = async (key: string, execution: string | null) => {
    const [{ id }] = await exec("INSERT INTO sav.case_reply_validations(case_id, reply_key, payload_hash, case_version, recipient, proposal_ciphertext) VALUES ($1, $2, $3, 1, 'customer@example.invalid', 'c') RETURNING id",
      [ids.case, key, randomUUID().replace(/-/g, "").repeat(2)]);
    await exec("UPDATE sav.case_reply_validations SET state = 'approved', decided_by = $2, decided_at = now(), authorization_basis = 'native-fixture', execution_id = $3 WHERE id = $1", [id, ids.staff, execution]);
    return id as string;
  };
  const revoke = (conn: Conn | postgres.Sql, id: string) => conn.unsafe("UPDATE sav.case_reply_validations SET state = 'revoked', revoked_by = $2, revoked_at = now(), revocation_basis = 'native-fixture' WHERE id = $1", [id, ids.staff]);
  const effect = (conn: Conn | postgres.Sql, execution: string, key: string) => conn.unsafe("INSERT INTO sav.intake_effects(business_key, execution_id, kind, permission, intent_hash, intent_ciphertext) VALUES ($1, $2, 'reply_send', 'native-fixture', 'h', 'c')", [key, execution]);

  beforeAll(async () => {
    validateSavNativeTestTarget(URL_!, TOKEN);
    observer = openNativeObserver(URL_!);
    sql = postgres(URL_!, { max: 4, prepare: false, connect_timeout: 5, onnotice: () => {}, connection: { application_name: "codex_sav_validation", statement_timeout: 10000, lock_timeout: 8000 } });
    const [identity] = await sql`select current_setting('codex.test_token', true) as token`;
    if (identity?.token !== TOKEN) throw new Error("SAV_NATIVE_TEST_INSTANCE_REFUSED");
    await exec("INSERT INTO public.staff_users(id, clerk_id, email, role) VALUES ($1, $2, $3, 'admin')", [ids.staff, `native-${ids.staff}`, `native-${ids.staff}@example.invalid`]);
    await exec("INSERT INTO sav.intake_execution_policies(id, revision, state, administrator_id, policy_hash, payload_ciphertext) VALUES ($1, 'native-fixture', 'approved', $2, 'h', 'c')", [ids.policy, ids.staff]);
    await exec("INSERT INTO sav.cases(id, ticket_id, owner, phase, contract_revision, payload_ciphertext) VALUES ($1, $2, 'human', 'human_owned', 'native-fixture', 'native-fixture')", [ids.case, BigInt(`0x${ids.case.replace(/-/g, "").slice(0, 24)}`).toString()]);
  });
  afterAll(async () => { await sql?.end({ timeout: 2 }); await observer?.end({ timeout: 2 }); });

  it("a revocation waits for the marker's transaction, then is refused: the send may have started", async () => {
    const execution = await caseExecution(), validation = await approved(execution.key, execution.id);
    await effect(sql, execution.id, execution.key);
    const marker = await open(), revoker = await open();
    try {
      await marker.conn.unsafe("BEGIN");
      await marker.conn.unsafe("SELECT state FROM sav.case_reply_validations WHERE id = $1 FOR SHARE", [validation]);
      await marker.conn.unsafe("UPDATE sav.intake_effects SET state = 'dispatched', dispatch_token = gen_random_uuid(), dispatched_at = now() WHERE business_key = $1", [execution.key]);
      const revoking = revoke(revoker.conn, validation).then(() => "revoked", (error: Error) => error.message);
      await blocked(revoker.pid);
      await marker.conn.unsafe("COMMIT");
      expect(await revoking).toBe("case reply validation cannot be revoked once the send started");
    } finally { await done(marker, revoker); }
  });

  it("a revocation committed first is what the marker's transaction reads: no marker on a revoked approval", async () => {
    const execution = await caseExecution(), validation = await approved(execution.key, execution.id);
    await effect(sql, execution.id, execution.key);
    const marker = await open(), revoker = await open();
    try {
      await revoker.conn.unsafe("BEGIN");
      await revoke(revoker.conn, validation);
      await marker.conn.unsafe("BEGIN");
      // A postgres.js query is lazy: it is only sent once executed, awaited or chained. Send it now, so that there is a statement to observe waiting.
      const reading = marker.conn.unsafe("SELECT state FROM sav.case_reply_validations WHERE id = $1 FOR SHARE", [validation]).execute()
        .then(rows => ({ rows: [...rows] }), (error: Error) => ({ error: error.message }));
      await blocked(marker.pid);
      await revoker.conn.unsafe("COMMIT");
      expect(await reading).toEqual({ rows: [{ state: "revoked" }] });
      await marker.conn.unsafe("ROLLBACK");
    } finally { await done(marker, revoker); }
  });

  it("two approvals of one trigger at once: the second waits, then is refused by the one-approval index", async () => {
    const key = `sav-case-reply:${ids.case}:${randomUUID()}`;
    const [p1, p2] = await Promise.all([1, 2].map(async () => (await exec("INSERT INTO sav.case_reply_validations(case_id, reply_key, payload_hash, case_version, recipient, proposal_ciphertext) VALUES ($1, $2, $3, 1, 'customer@example.invalid', 'c') RETURNING id",
      [ids.case, key, randomUUID().replace(/-/g, "").repeat(2)]))[0].id as string));
    const first = await open(), second = await open();
    const approve = (conn: Conn, id: string) => conn.unsafe("UPDATE sav.case_reply_validations SET state = 'approved', decided_by = $2, decided_at = now(), authorization_basis = 'native-fixture' WHERE id = $1", [id, ids.staff]);
    try {
      await first.conn.unsafe("BEGIN");
      await approve(first.conn, p1);
      const racing = approve(second.conn, p2).then(() => "approved", (error: Error) => error.message);
      await blocked(second.pid);
      await first.conn.unsafe("COMMIT");
      expect(await racing).toContain("case_reply_validations_one_approved");
    } finally { await done(first, second); }
  });

  it("an effect inserted while its parent is being deleted waits, then is refused: no orphan", async () => {
    const parent = await caseExecution(), deleter = await open(), writer = await open();
    try {
      await deleter.conn.unsafe("BEGIN");
      await deleter.conn.unsafe("DELETE FROM sav.case_effect_executions WHERE id = $1", [parent.id]);
      const inserting = effect(writer.conn, parent.id, parent.key).then(() => "inserted", (error: Error) => error.message);
      await blocked(writer.pid);
      await deleter.conn.unsafe("COMMIT");
      expect(await inserting).toBe("effect parent execution missing");
    } finally { await done(deleter, writer); }
  });

  it("a parent deleted while an effect is being inserted under it waits, then is refused: still referenced", async () => {
    const parent = await caseExecution(), deleter = await open(), writer = await open();
    try {
      await writer.conn.unsafe("BEGIN");
      await effect(writer.conn, parent.id, parent.key);
      const deleting = deleter.conn.unsafe("DELETE FROM sav.case_effect_executions WHERE id = $1", [parent.id]).then(() => "deleted", (error: Error) => error.message);
      await blocked(deleter.pid);
      await writer.conn.unsafe("COMMIT");
      expect(await deleting).toBe("effect parent execution still referenced");
    } finally { await done(deleter, writer); }
  });
});
