/** Only the explicitly isolated, empty CI service; never uses DATABASE_URL. */
import assert from "node:assert/strict";
import postgres from "postgres";
import { validateSavNativeTestTarget } from "./sav-native-db";

const value = process.env.SAV_TEST_POSTGRES_URL ?? "";
const token = process.env.SAV_TEST_POSTGRES_TOKEN;
validateSavNativeTestTarget(value, token);
assert.equal(process.env.CI, "true", "Explicit CI service required");
assert.equal(new URL(value).pathname, "/codex_sav_ci");
const sql = postgres(value, { max: 1, prepare: false });
try {
  const [state] = await sql`select current_database() as name, current_user as role,
    (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%') as relations`;
  assert.equal(state.name, "codex_sav_ci");
  assert.equal(state.role, "codex_test");
  assert.equal(state.relations, 0, "Empty service required before attaching the test marker");
  // Validator limits the token to hex. Database is a fixed identifier, never user SQL.
  await sql.unsafe(`ALTER DATABASE codex_sav_ci SET codex.test_token = '${token}'`);
  console.log("SAV_NATIVE_CI_EMPTY_SERVICE_MARKED");
} finally { await sql.end(); }
