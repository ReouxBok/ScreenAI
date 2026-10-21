/** Local synthetic proof: invoker triggers require explicit projection privileges. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { validateSavNativeTestTarget } from "./sav-native-db";
const value = process.env.SAV_TEST_POSTGRES_URL ?? "", token = process.env.SAV_TEST_POSTGRES_TOKEN;
validateSavNativeTestTarget(value, token);
const sql = postgres(value, { max: 1, prepare: false, onnotice: () => {} });
const role = `sav_fixture_${randomUUID().replaceAll("-", "")}`;
let created = false;
try {
  const [identity] = await sql`select current_setting('codex.test_token', true) as token`;
  assert.equal(identity.token, token);
  const [mailbox] = await sql`insert into sav.mailboxes(email) values ('role-fixture@example.invalid') returning id`;
  const [thread] = await sql`insert into sav.threads(mailbox_id,gmail_thread_id,customer_email) values (${mailbox.id},${role},'role-fixture@example.invalid') returning id`;
  const [message] = await sql`insert into sav.messages(thread_id,mailbox_id,direction,from_email,body_ciphertext,received_at) values (${thread.id},${mailbox.id},'inbound','role-fixture@example.invalid','synthetic-role-payload',now()) returning id`;
  await sql`create role ${sql(role)} nologin nosuperuser nocreatedb nocreaterole noinherit`;
  created = true;
  await sql`grant usage on schema sav to ${sql(role)}`;
  await sql`grant select on sav.threads to ${sql(role)}`;
  await sql`grant select, update on sav.messages to ${sql(role)}`;
  await sql`update sav.messages set analysis_status='intake_waiting' where id=${message.id}`;
  const intakeEpoch = async () => (await sql`select epoch::text from sav.intake_console where thread_id=${thread.id}`)[0].epoch;
  const beforeIntake = await intakeEpoch();
  const version = async () => (await sql`select version::text from sav.dashboard_projection where thread_id=${thread.id}`)[0].version;
  const before = await version();
  const change = () => sql.begin(async tx => {
    await tx`set local role ${tx(role)}`;
    await tx`update sav.messages set subject='Synthetic role update' where id=${message.id}`;
  });
  await assert.rejects(change, (error: unknown) => (error as { code?: string }).code === "42501");
  assert.equal(await version(), before, "Denied invalidation rolls back the business update");
  const [unchanged] = await sql`select subject from sav.messages where id=${message.id}`;
  assert.equal(unchanged.subject, "Sans objet");
  await sql`grant select, insert, update on sav.dashboard_projection to ${sql(role)}`;
  await assert.rejects(change, (error: unknown) => (error as { code?: string }).code === "42501");
  assert.equal(await version(), before, "Missing intake privileges must roll back dashboard invalidation too");
  assert.equal(await intakeEpoch(), beforeIntake);
  await sql`grant select, insert, update on sav.intake_console to ${sql(role)}`;
  await change();
  assert.equal(BigInt(await intakeEpoch()), BigInt(beforeIntake)+BigInt(1));
  assert.equal(BigInt(await version()), BigInt(before) + BigInt(1));
  const [functions] = await sql`select count(*)::int as total, count(*) filter(where prosecdef)::int as definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sav' and p.proname in ('invalidate_dashboard_source','invalidate_dashboard_thread','invalidate_dashboard_truncate')`;
  assert.deepEqual({ ...functions }, { total: 3, definer: 0 });
  const [intakeFunctions]=await sql`select count(*)::int as total,count(*) filter(where prosecdef)::int as definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sav' and p.proname in ('dirty_intake_console','dirty_intake_console_row','immutable_intake_human_event')`;
  assert.deepEqual({...intakeFunctions},{total:3,definer:0});
  await sql`delete from sav.mailboxes where id=${mailbox.id}`;
  console.log(JSON.stringify({ status: "pass", runtimeRole: "synthetic-restricted-nonowner", deniedWithoutProjectionPrivileges: true,
    sourceAndInvalidationRolledBackTogether: true, worksWithExplicitProjectionPrivileges: true, securityInvokerPreserved: true,
    intakeProjectionPrivilegesExplicit:true,productionRoleObserved: false }));
} finally {
  if (created) { await sql`drop owned by ${sql(role)}`; await sql`drop role ${sql(role)}`; }
  await sql.end();
}
