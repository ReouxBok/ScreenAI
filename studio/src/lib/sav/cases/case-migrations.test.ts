import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

// The V2 case migrations come after MCP 0045. Drizzle applies a migration only when its `when`
// is greater than the last one recorded, so a V2 `when` before MCP's would be skipped silently.
type Entry = { idx: number; when: number; tag: string };
const MIGRATIONS = new URL("../../../../drizzle/", import.meta.url);
const MCP = "0045_studio_mcp_tokens", V2 = ["0046_sav_cases", "0047_sav_case_admission", "0048_sav_case_relay_claim_timers", "0049_sav_case_calls", "0050_sav_case_effects", "0051_sav_case_reply_validations", "0052_sav_case_handoff_notice", "0053_sav_case_ticket_stage"];
const LAST = V2.at(-1)!;
const STAFF = "30000000-0000-4000-8000-000000000001", TOKEN = "30000000-0000-4000-8000-000000000002", CASE = "30000000-0000-4000-8000-000000000003";
/** Same pins as test/sav73-native-migration.ts: tags and whens of 0000..0045 as applied in production, 0045 as drizzle hashes it. */
const HISTORY_PREFIX_SHA256 = "83a4c3e1c41adfc94332bf7211600e05e3626324efc76e0b101a9feec4a2417e", MCP0045_SHA256 = "48df7d72bdad68140488aad3c5fb22fefd5b556bef63be39e82600e3950879e9";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const readJournal = async () => JSON.parse(await readFile(new URL("meta/_journal.json", MIGRATIONS), "utf8")) as { entries: Entry[] };

/** A migrations folder holding the journal up to `lastTag`, optionally with rewritten whens. */
async function folderUpTo(root: string, lastTag: string, whens: Record<string, number> = {}) {
  const journal = await readJournal(), entries = journal.entries.slice(0, journal.entries.findIndex(e => e.tag === lastTag) + 1);
  const folder = await mkdtemp(path.join(root, "step-"));
  await mkdir(path.join(folder, "meta"));
  for (const e of entries) await copyFile(new URL(`${e.tag}.sql`, MIGRATIONS), path.join(folder, `${e.tag}.sql`));
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: entries.map(e => ({ ...e, when: whens[e.tag] ?? e.when })) }));
  return folder;
}

async function withDb(run: (client: PGlite, root: string) => Promise<void>) {
  const client = new PGlite({ extensions: { vector } }), root = await mkdtemp(path.join(tmpdir(), "sav-case-migrations-"));
  try { await run(client, root); } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
}
const one = async <T>(client: PGlite, sql: string) => (await client.query<T>(sql)).rows[0];
const applied = (client: PGlite) => one<{ n: number }>(client, "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations").then(r => r.n);
const exists = (client: PGlite, table: string) => one<{ ok: boolean }>(client, `SELECT to_regclass('${table}') IS NOT NULL AS ok`).then(r => r.ok);
const state = async (client: PGlite) => JSON.stringify([
  (await client.query("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows,
  (await client.query("SELECT id, email FROM public.staff_users ORDER BY id")).rows,
  (await client.query("SELECT id, staff_id, token_hash, revoked_at FROM public.studio_mcp_tokens ORDER BY id")).rows,
  (await client.query("SELECT key, status FROM sav.sync_state WHERE key LIKE 'sav-case-schema-%' ORDER BY key")).rows,
  (await client.query("SELECT id, version, owner, phase FROM sav.cases ORDER BY id")).rows,
  (await client.query("SELECT call_key, state, token FROM sav.case_calls ORDER BY call_key")).rows,
  (await exists(client, "sav.case_reply_validations") ? (await client.query("SELECT id, reply_key, state FROM sav.case_reply_validations ORDER BY id")).rows : null),
]);

describe("V2 case migrations after MCP 0045", () => {
  it("keep one journal order: unique numbers, increasing whens, MCP 0045 then the V2 migrations last", async () => {
    const { entries } = await readJournal(), tags = entries.map(e => e.tag);
    expect(entries.map(e => e.idx)).toEqual(entries.map((_, i) => i));
    for (let i = 1; i < entries.length; i++) expect(entries[i].when).toBeGreaterThan(entries[i - 1].when);
    expect(tags.slice(-1 - V2.length)).toEqual([MCP, ...V2]);
    expect(new Set(tags.map(t => t.slice(0, 4))).size).toBe(tags.length);
    // The applied history is frozen up to MCP 0045, which need not stay last.
    const mcp = tags.indexOf(MCP);
    expect(sha256(JSON.stringify(entries.slice(0, mcp + 1).map(e => [e.tag, e.when])))).toBe(HISTORY_PREFIX_SHA256);
    expect(sha256(await readFile(new URL(`${MCP}.sql`, MIGRATIONS), "utf8"))).toBe(MCP0045_SHA256);
    // The PGlite test database applies the .sql files sorted by name: same order as the journal.
    expect((await readdir(MIGRATIONS)).filter(f => f.endsWith(".sql")).sort()).toEqual(tags.map(t => `${t}.sql`));
  });

  it("upgrades a populated 0044 database to MCP 0045 then to V2, and a second migrate changes nothing", async () => {
    await withDb(async (client, root) => {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: await folderUpTo(root, "0044_sav_operator_command_indexes") });
      expect(await applied(client)).toBe(39);
      await client.query(`INSERT INTO public.staff_users(id, clerk_id, email) VALUES ('${STAFF}', 'fixture-clerk', 'fixture@example.invalid')`);

      await migrate(db, { migrationsFolder: await folderUpTo(root, MCP) });
      expect(await applied(client)).toBe(40);
      expect(await exists(client, "sav.cases")).toBe(false);
      expect(await one<{ hash: string }>(client, "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1")).toEqual({ hash: MCP0045_SHA256 });
      await client.query(`INSERT INTO public.studio_mcp_tokens(id, staff_id, name, token_hash, prefix, expires_at) VALUES ('${TOKEN}', '${STAFF}', 'fixture', 'fixture-hash', 'fx', now() + interval '1 day')`);

      const full = await folderUpTo(root, LAST);
      await migrate(db, { migrationsFolder: full });
      expect(await applied(client)).toBe(48);
      for (const table of ["sav.cases", "sav.case_events", "sav.case_timers", "sav.case_calls", "sav.case_effect_executions", "sav.case_reply_validations"]) expect(await exists(client, table)).toBe(true);
      expect((await client.query("SELECT key FROM sav.sync_state WHERE key LIKE 'sav-case-schema-%' AND status = 'installed' ORDER BY key")).rows)
        .toEqual([{ key: "sav-case-schema-v2" }, { key: "sav-case-schema-v3" }, { key: "sav-case-schema-v4" }, { key: "sav-case-schema-v5" }, { key: "sav-case-schema-v6" }, { key: "sav-case-schema-v7" }, { key: "sav-case-schema-v8" }, { key: "sav-case-schema-v9" }]);
      expect((await client.query("SELECT tgname FROM pg_trigger WHERE tgname LIKE 'sav\\_%' AND NOT tgisinternal AND tgname IN ('sav_case_events_append_only', 'sav_case_timers_guard', 'sav_case_calls_guard', 'sav_intake_effects_parent', 'sav_intake_effect_journal_parent', 'sav_intake_executions_effect_children', 'sav_case_effect_executions_effect_children', 'sav_case_reply_validations_guard', 'sav_intake_effects_parent_kind') ORDER BY tgname")).rows.map(r => (r as { tgname: string }).tgname))
        .toEqual(["sav_case_calls_guard", "sav_case_effect_executions_effect_children", "sav_case_events_append_only", "sav_case_reply_validations_guard", "sav_case_timers_guard", "sav_intake_effect_journal_parent", "sav_intake_effects_parent", "sav_intake_effects_parent_kind", "sav_intake_executions_effect_children"]);
      await client.query(`INSERT INTO sav.cases(id, ticket_id, owner, phase, contract_revision, payload_ciphertext) VALUES ('${CASE}', '42', 'human', 'human_owned', 'fixture', 'fixture')`);
      await client.query(`INSERT INTO sav.case_calls(call_key, subject_key, case_id, case_version, purpose, state, token, holder, dispatched_at) VALUES ('sav-case:${CASE}:in:gm-1:call1', 'sav-case:${CASE}:in:gm-1', '${CASE}', 1, 'decision', 'dispatched', '${TOKEN}', 'fixture', now())`);
      await client.query(`INSERT INTO sav.case_reply_validations(case_id, reply_key, payload_hash, case_version, recipient, proposal_ciphertext) VALUES ('${CASE}', 'fixture-reply-key', '${"a".repeat(64)}', 1, 'customer@example.invalid', 'c')`);

      const before = await state(client);
      await migrate(db, { migrationsFolder: full });
      await migrate(db, { migrationsFolder: full });
      expect(await applied(client)).toBe(48);
      expect(await state(client)).toBe(before);
    });
  }, 60_000);

  it("0050 keeps both sides of the effect ledger's parent check once its two foreign keys are gone (C's case effects, A's review)", async () => {
    await withDb(async (client, root) => {
      await migrate(drizzle(client), { migrationsFolder: await folderUpTo(root, LAST) });
      const ids = { policy: "30000000-0000-4000-8000-000000000011", intake: "30000000-0000-4000-8000-000000000012", caseEffect: "30000000-0000-4000-8000-000000000013", bare: "30000000-0000-4000-8000-000000000014" };
      await client.query(`INSERT INTO public.staff_users(id, clerk_id, email, role) VALUES ('${STAFF}', 'fixture-clerk', 'fixture@example.invalid', 'admin')`);
      await client.query(`INSERT INTO sav.intake_execution_policies(id, revision, state, administrator_id, policy_hash, payload_ciphertext) VALUES ('${ids.policy}', 'fixture', 'approved', '${STAFF}', 'h', 'c')`);
      await client.query(`INSERT INTO sav.intake_executions(id, message_id, thread_id, run_version, policy_id, policy_hash, payload_ciphertext) VALUES ('${ids.intake}', gen_random_uuid(), gen_random_uuid(), 1, '${ids.policy}', 'h', 'c')`);
      await client.query(`INSERT INTO sav.cases(id, ticket_id, owner, phase, contract_revision, payload_ciphertext) VALUES ('${CASE}', '42', 'human', 'human_owned', 'fixture', 'fixture')`);
      for (const id of [ids.caseEffect, ids.bare]) await client.query(`INSERT INTO sav.case_effect_executions(id, case_id, reply_key, thread_id, policy_id, policy_hash, payload_ciphertext) VALUES ('${id}', '${CASE}', 'reply-key-${id}', gen_random_uuid(), '${ids.policy}', 'h', 'c')`);
      const effect = (execution: string, key: string) => client.query(`INSERT INTO sav.intake_effects(business_key, execution_id, kind, permission, intent_hash, intent_ciphertext) VALUES ('${key}', '${execution}', 'note_create', 'append_ticket_note', 'h', 'c')`);
      // Child side: either parent is accepted, no parent is refused, for the ledger and its journal alike.
      await effect(ids.intake, "v1-effect");
      await effect(ids.caseEffect, "case-effect");
      await expect(effect("30000000-0000-4000-8000-0000000000ff", "orphan")).rejects.toThrow("effect parent execution missing");
      await client.query(`INSERT INTO sav.intake_effect_journal(execution_id, kind, payload_ciphertext) VALUES ('${ids.intake}', 'planned', 'c')`);
      await expect(client.query(`INSERT INTO sav.intake_effect_journal(execution_id, kind, payload_ciphertext) VALUES ('30000000-0000-4000-8000-0000000000ff', 'planned', 'c')`)).rejects.toThrow("effect parent execution missing");
      await expect(client.query(`UPDATE sav.intake_effects SET execution_id = '30000000-0000-4000-8000-0000000000ff' WHERE business_key = 'case-effect'`)).rejects.toThrow("effect parent execution missing");
      // Parent side, as the dropped keys (NO ACTION) did: a referenced execution is neither deleted nor renumbered; other changes and unreferenced rows are free.
      await expect(client.query(`DELETE FROM sav.case_effect_executions WHERE id = '${ids.caseEffect}'`)).rejects.toThrow("effect parent execution still referenced");
      await expect(client.query(`DELETE FROM sav.intake_executions WHERE id = '${ids.intake}'`)).rejects.toThrow("effect parent execution still referenced");
      await expect(client.query(`UPDATE sav.intake_executions SET id = gen_random_uuid() WHERE id = '${ids.intake}'`)).rejects.toThrow("effect parent execution still referenced");
      await client.query(`UPDATE sav.intake_executions SET state = 'running', id = id WHERE id = '${ids.intake}'`);
      await client.query(`DELETE FROM sav.case_effect_executions WHERE id = '${ids.bare}'`);
      expect((await client.query("SELECT business_key FROM sav.intake_effects ORDER BY business_key")).rows).toEqual([{ business_key: "case-effect" }, { business_key: "v1-effect" }]);
      // 0051: what each parent may host. A case execution: reply_send and the two note kinds only; an intake execution: every V1 kind, never reply_send.
      const kinded = (execution: string, key: string, kind: string) => client.query(`INSERT INTO sav.intake_effects(business_key, execution_id, kind, permission, intent_hash, intent_ciphertext) VALUES ('${key}', '${execution}', '${kind}', 'fixture', 'h', 'c')`);
      for (const kind of ["reply_send", "note_associate", "handoff_notify", "ticket_stage"]) await kinded(ids.caseEffect, `case-${kind}`, kind);
      for (const kind of ["ticket_create", "email_create", "email_associate", "stage_new", "identity_send", "owner_assign"]) {
        await expect(kinded(ids.caseEffect, `case-${kind}`, kind)).rejects.toThrow(`effect kind ${kind} cannot belong to a case execution`);
        await kinded(ids.intake, `v1-${kind}`, kind);
      }
      await expect(kinded(ids.intake, "v1-reply", "reply_send")).rejects.toThrow("reply_send can only belong to a case execution");
      // 0052: the Slack handoff notice is a case-side kind like reply_send, and nothing else changed.
      await expect(kinded(ids.intake, "v1-notice", "handoff_notify")).rejects.toThrow("handoff_notify can only belong to a case execution");
      await expect(client.query(`UPDATE sav.intake_effects SET kind = 'handoff_notify' WHERE business_key = 'v1-effect'`)).rejects.toThrow("handoff_notify can only belong to a case execution");
      await expect(client.query(`UPDATE sav.intake_effects SET execution_id = '${ids.intake}' WHERE business_key = 'case-handoff_notify'`)).rejects.toThrow("handoff_notify can only belong to a case execution");
      // 0053: the ticket stage is a case-side kind too, and the V1 side is unchanged.
      await expect(kinded(ids.intake, "v1-stage", "ticket_stage")).rejects.toThrow("ticket_stage can only belong to a case execution");
      await expect(client.query(`UPDATE sav.intake_effects SET kind = 'ticket_stage' WHERE business_key = 'v1-effect'`)).rejects.toThrow("ticket_stage can only belong to a case execution");
      // Moving an effect or changing its kind is checked the same way; an orphan stays the parent check's refusal.
      await expect(client.query(`UPDATE sav.intake_effects SET execution_id = '${ids.intake}' WHERE business_key = 'case-reply_send'`)).rejects.toThrow("reply_send can only belong to a case execution");
      await expect(client.query(`UPDATE sav.intake_effects SET execution_id = '${ids.caseEffect}' WHERE business_key = 'v1-ticket_create'`)).rejects.toThrow("cannot belong to a case execution");
      await expect(client.query(`UPDATE sav.intake_effects SET kind = 'stage_new' WHERE business_key = 'case-effect'`)).rejects.toThrow("effect kind stage_new cannot belong to a case execution");
      await expect(client.query(`UPDATE sav.intake_effects SET kind = 'reply_send' WHERE business_key = 'v1-effect'`)).rejects.toThrow("reply_send can only belong to a case execution");
      await expect(kinded("30000000-0000-4000-8000-0000000000ff", "orphan-reply", "reply_send")).rejects.toThrow("effect parent execution missing");
    });
  }, 60_000);

  it("0051 keeps a reply validation durable: born a proposal, one approval per trigger, decision and payload frozen, revocation only before the marker, never deleted", async () => {
    await withDb(async (client, root) => {
      // An empty database, straight to the last migration.
      await migrate(drizzle(client), { migrationsFolder: await folderUpTo(root, LAST) });
      expect(await applied(client)).toBe(48);
      const ids = { policy: "30000000-0000-4000-8000-000000000021", exec1: "30000000-0000-4000-8000-000000000022", exec2: "30000000-0000-4000-8000-000000000023" };
      const [k1, k2] = [`sav-case-reply:${CASE}:event-1`, `sav-case-reply:${CASE}:event-2`], h = (c: string) => c.repeat(64), APPROVER = STAFF;
      await client.query(`INSERT INTO public.staff_users(id, clerk_id, email, role) VALUES ('${STAFF}', 'fixture-clerk', 'fixture@example.invalid', 'admin')`);
      await client.query(`INSERT INTO sav.intake_execution_policies(id, revision, state, administrator_id, policy_hash, payload_ciphertext) VALUES ('${ids.policy}', 'fixture', 'approved', '${STAFF}', 'h', 'c')`);
      await client.query(`INSERT INTO sav.cases(id, ticket_id, owner, phase, contract_revision, payload_ciphertext) VALUES ('${CASE}', '42', 'human', 'human_owned', 'fixture', 'fixture')`);
      for (const [id, key] of [[ids.exec1, k1], [ids.exec2, k2]]) await client.query(`INSERT INTO sav.case_effect_executions(id, case_id, reply_key, thread_id, policy_id, policy_hash, payload_ciphertext) VALUES ('${id}', '${CASE}', '${key}', gen_random_uuid(), '${ids.policy}', 'h', 'c')`);
      const propose = (key: string, hash: string, extra = { columns: "", values: "" }) => client.query<{ id: string }>(`INSERT INTO sav.case_reply_validations(case_id, reply_key, payload_hash, case_version, recipient, proposal_ciphertext${extra.columns}) VALUES ('${CASE}', '${key}', '${hash}', 3, 'customer@example.invalid', 'c'${extra.values}) RETURNING id`).then(r => r.rows[0]!.id);
      const decide = (id: string, to: "approved" | "declined") => client.query(`UPDATE sav.case_reply_validations SET state = '${to}', decided_by = '${APPROVER}', decided_at = now(), authorization_basis = 'fixture-port' WHERE id = '${id}'`);
      const row = (id: string) => one<Record<string, unknown>>(client, `SELECT state, execution_id, decided_by, revoked_by FROM sav.case_reply_validations WHERE id = '${id}'`);

      // Born a proposal: an approval, a decision or an execution cannot be inserted, only decided on a stored row (A's review of C's proposal).
      await expect(propose(k1, h("f"), { columns: ", state, decided_by, decided_at, authorization_basis", values: `, 'approved', '${APPROVER}', now(), 'forged'` })).rejects.toThrow("case reply validation starts as a proposal");
      await expect(propose(k1, h("f"), { columns: ", execution_id", values: `, '${ids.exec1}'` })).rejects.toThrow("case reply validation starts as a proposal");
      // Idempotence: one row per (trigger, content); a second content for the same trigger is another row.
      const p1 = await propose(k1, h("a")), p2 = await propose(k1, h("b"));
      await expect(propose(k1, h("a"))).rejects.toThrow("case_reply_validations_trigger_payload_unique");
      // A decision has its shape; at most one approval per trigger.
      await expect(client.query(`UPDATE sav.case_reply_validations SET state = 'approved', decided_at = now() WHERE id = '${p1}'`)).rejects.toThrow("case_reply_validations_decision_shape");
      await decide(p1, "approved");
      await expect(decide(p2, "approved")).rejects.toThrow("case_reply_validations_one_approved");
      await client.query(`UPDATE sav.case_reply_validations SET state = 'superseded', decided_at = now() WHERE id = '${p2}'`);
      // Frozen: payload, decision, transitions, and no delete.
      await expect(client.query(`UPDATE sav.case_reply_validations SET recipient = 'other@example.invalid' WHERE id = '${p1}'`)).rejects.toThrow("case reply validation payload is immutable");
      await expect(client.query(`UPDATE sav.case_reply_validations SET case_version = 4 WHERE id = '${p1}'`)).rejects.toThrow("case reply validation payload is immutable");
      await expect(client.query(`UPDATE sav.case_reply_validations SET decided_by = gen_random_uuid() WHERE id = '${p1}'`)).rejects.toThrow("case reply validation decision is immutable");
      await expect(client.query(`UPDATE sav.case_reply_validations SET state = 'proposed', decided_by = NULL, decided_at = NULL, authorization_basis = NULL WHERE id = '${p1}'`)).rejects.toThrow("case reply validation transition refused");
      await expect(decide(p2, "approved")).rejects.toThrow("case reply validation transition refused");
      await expect(client.query(`DELETE FROM sav.case_reply_validations WHERE id = '${p2}'`)).rejects.toThrow("case reply validation is never deleted");
      // The execution: only on an approval, once, never moved.
      await expect(client.query(`UPDATE sav.case_reply_validations SET execution_id = '${ids.exec2}' WHERE id = '${p2}'`)).rejects.toThrow("case_reply_validations_execution_needs_approval");
      await client.query(`UPDATE sav.case_reply_validations SET execution_id = '${ids.exec1}' WHERE id = '${p1}'`);
      await expect(client.query(`UPDATE sav.case_reply_validations SET execution_id = '${ids.exec2}' WHERE id = '${p1}'`)).rejects.toThrow("case reply validation execution is immutable");
      // Postgres keeps 63 characters of drizzle's 64-character name, as for the older keys of this schema (a command naming it is truncated the same way).
      await expect(client.query(`DELETE FROM sav.case_effect_executions WHERE id = '${ids.exec1}'`)).rejects.toThrow('violates foreign key constraint "case_reply_validations_execution_id_case_effect_executions_id_f"');
      // Revocation: possible while the reply effect is planned, once; refused once it left planned (a marker exists).
      const revoke = (id: string, basis = "fixture-port") => client.query(`UPDATE sav.case_reply_validations SET state = 'revoked', revoked_by = '${APPROVER}', revoked_at = now(), revocation_basis = '${basis}' WHERE id = '${id}'`);
      await client.query(`INSERT INTO sav.intake_effects(business_key, execution_id, kind, permission, intent_hash, intent_ciphertext) VALUES ('${k1}', '${ids.exec1}', 'reply_send', 'fixture', 'h', 'c')`);
      await revoke(p1);
      await expect(client.query(`UPDATE sav.case_reply_validations SET revocation_basis = 'other' WHERE id = '${p1}'`)).rejects.toThrow("case reply validation revocation is immutable");
      await expect(decide(p1, "approved")).rejects.toThrow("case reply validation transition refused");
      const p3 = await propose(k2, h("c"));
      await decide(p3, "approved");
      await client.query(`UPDATE sav.case_reply_validations SET execution_id = '${ids.exec2}' WHERE id = '${p3}'`);
      await client.query(`INSERT INTO sav.intake_effects(business_key, execution_id, kind, permission, intent_hash, intent_ciphertext, state, dispatch_token, dispatched_at) VALUES ('${k2}', '${ids.exec2}', 'reply_send', 'fixture', 'h', 'c', 'dispatched', gen_random_uuid(), now())`);
      await expect(revoke(p3)).rejects.toThrow("case reply validation cannot be revoked once the send started");
      expect([await row(p1), await row(p2), await row(p3)]).toEqual([
        { state: "revoked", execution_id: ids.exec1, decided_by: APPROVER, revoked_by: APPROVER },
        { state: "superseded", execution_id: null, decided_by: null, revoked_by: null },
        { state: "approved", execution_id: ids.exec2, decided_by: APPROVER, revoked_by: null },
      ]);
    });
  }, 60_000);

  it("upgrades 0044 straight to V2 in one migrate, MCP 0045 included", async () => {
    await withDb(async (client, root) => {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: await folderUpTo(root, "0044_sav_operator_command_indexes") });
      await migrate(db, { migrationsFolder: await folderUpTo(root, LAST) });
      expect(await applied(client)).toBe(48);
      expect(await exists(client, "public.studio_mcp_tokens")).toBe(true);
      expect(await exists(client, "sav.case_calls")).toBe(true);
    });
  }, 60_000);

  it("control: with the former V2 whens (26-27/10, before MCP's), a database at MCP 0045 skips V2 silently", async () => {
    await withDb(async (client, root) => {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: await folderUpTo(root, MCP) });
      const former = { [V2[0]]: 1793044800000, [V2[1]]: 1793131200000, [V2[2]]: 1793134800000 };
      await migrate(db, { migrationsFolder: await folderUpTo(root, V2[2], former) });
      expect(await applied(client)).toBe(40);
      expect(await exists(client, "sav.cases")).toBe(false);
    });
  }, 60_000);
});
