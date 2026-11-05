import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { withoutSyncStateRow } from "../../../../test/sav-sync-state-row";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
// The registry holds no provider: importing a HubSpot module from it fails the file.
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
import { callsForCaseInWindow, markSavCaseCallDispatched, releaseSavCaseCall, reserveSavCaseCall, settleSavCaseCall } from "./case-calls";
import { openCaseEvent } from "./case-store";
import { caseDedupeKey } from "./case-types";

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 7_600_000;
const T0 = new Date("2026-10-31T09:00:00.000Z"), at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
async function newCase() {
  const gmail = `gm-calls-${randomUUID()}`;
  const qualification = { requests: [{ requestId: "r1", family: "access" as const, provenance: { kind: "human" as const, staffUserId: "20000000-0000-4000-8000-000000000001", at: T0.toISOString() } }],
    identity: { status: "confirmed" as const, source: { type: "hubspot_object" as const, id: "contact-1" } }, crmContext: "complete" as const, teamSignals: [] };
  const { case: c } = await openCaseEvent({ ticketId: String(++ticketSeq), threadId: randomUUID(), admission: { policy: null, qualification },
    kind: "inbound_confirmed", dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: T0.toISOString() });
  return c.caseId;
}
/** B's keys (CONTRACTS_FOR_A_20261030 §2): subjectKey = sav-case:<caseId>:<inputKey>, callKey = <subjectKey>:call<n>. */
const keys = (caseId: string, input = "in:gm-1", n = 1) => ({ caseId, subjectKey: `sav-case:${caseId}:${input}`, callKey: `sav-case:${caseId}:${input}:call${n}` });
const reserve = (k: ReturnType<typeof keys>, now = T0, extra: Partial<Parameters<typeof reserveSavCaseCall>[0]> = {}) =>
  reserveSavCaseCall({ ...k, caseVersion: 1, purpose: "decision", holder: "pole-b-runner", leaseSeconds: 60, now, ...extra });

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-fixture-key-only-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("reserveSavCaseCall: the same callKey is paid at most once (contract v9 §6)", () => {
  it("never hands out a key again once dispatched: a crash after the mark is uncertain, and only its token settles it", async () => {
    const k = keys(await newCase());
    const first = await reserve(k);
    expect(first).toMatchObject({ status: "reserved", token: expect.any(String) });
    const token = (first as { token: string }).token;
    expect(await reserve(k, at(10))).toEqual({ status: "busy", retryAt: at(60).toISOString() });
    expect(await markSavCaseCallDispatched({ callKey: k.callKey, token })).toEqual({ dispatched: true });
    // The worker dies after the provider call: long after the lease, nobody may call again.
    for (const later of [at(10), at(61), at(86_400)]) expect(await reserve(k, later)).toEqual({ status: "uncertain" });
    await expect(settleSavCaseCall({ callKey: k.callKey, token: randomUUID(), result: { status: "ok", output: { text: "x" } } })).rejects.toThrow("SAV_CASE_CALL_TOKEN_MISMATCH");
    await expect(releaseSavCaseCall({ callKey: k.callKey, token })).rejects.toThrow("SAV_CASE_CALL_DISPATCHED");
    expect(await settleSavCaseCall({ callKey: k.callKey, token, result: { status: "ok", output: { proposal: "synthétique" } } })).toEqual({ settled: true });
    expect(await settleSavCaseCall({ callKey: k.callKey, token, result: { status: "ok", output: { proposal: "synthétique" } } })).toEqual({ settled: true });
    await expect(settleSavCaseCall({ callKey: k.callKey, token, result: { status: "failed", uncertain: false } })).rejects.toThrow("SAV_CASE_CALL_SETTLED");
    expect(await reserve(k, at(120))).toEqual({ status: "known", result: { status: "ok", output: { proposal: "synthétique" } } });
  });
  it("gives a key back after a crash before the mark (nothing was sent), with a new token the old holder cannot use", async () => {
    const k = keys(await newCase());
    const old = (await reserve(k)) as { token: string };
    const again = await reserve(k, at(61), { holder: "pole-b-runner-2" });
    expect(again).toMatchObject({ status: "reserved" });
    expect((again as { token: string }).token).not.toBe(old.token);
    await expect(markSavCaseCallDispatched({ callKey: k.callKey, token: old.token })).rejects.toThrow("SAV_CASE_CALL_TOKEN_MISMATCH");
    expect(await markSavCaseCallDispatched({ callKey: k.callKey, token: (again as { token: string }).token })).toEqual({ dispatched: true });
    expect(await reserve(k, at(200))).toEqual({ status: "uncertain" });
  });
  it("lets exactly one of concurrent reservations of a key through, and caps distinct keys per input", async () => {
    const caseId = await newCase(), k = keys(caseId);
    const raced = await Promise.all(Array.from({ length: 6 }, () => reserve(k)));
    expect(raced.filter(r => r.status === "reserved")).toHaveLength(1);
    expect(raced.filter(r => r.status === "busy")).toHaveLength(5);
    const subject = await Promise.all([2, 3, 4, 5].map(n => reserve(keys(caseId, "in:gm-1", n))));
    expect(subject.map(r => r.status).sort()).toEqual(["reserved", "reserved", "subject_exhausted", "subject_exhausted"]);
    // Another input of the same case has its own cap: the case budget is a signal, not a block.
    expect(await reserve(keys(caseId, "in:gm-2", 1))).toMatchObject({ status: "reserved" });
    expect(await callsForCaseInWindow({ caseId, since: T0 })).toEqual({ reserved: 4, dispatched: 0, settled: 0, total: 4 });
  });
  it("releases a key nothing was sent for: it no longer counts and can be reserved again", async () => {
    const caseId = await newCase();
    const tokens = [];
    for (const n of [1, 2, 3]) tokens.push(((await reserve(keys(caseId, "in:gm-1", n))) as { token: string }).token);
    expect(await reserve(keys(caseId, "in:gm-1", 4))).toEqual({ status: "subject_exhausted" });
    expect(await releaseSavCaseCall({ callKey: keys(caseId, "in:gm-1", 3).callKey, token: tokens[2]! })).toEqual({ released: true });
    expect(await releaseSavCaseCall({ callKey: keys(caseId, "in:gm-1", 3).callKey, token: tokens[2]! })).toEqual({ released: true });
    await expect(markSavCaseCallDispatched({ callKey: keys(caseId, "in:gm-1", 3).callKey, token: tokens[2]! })).rejects.toThrow("SAV_CASE_CALL_RELEASED");
    expect(await callsForCaseInWindow({ caseId, since: T0 })).toMatchObject({ total: 2 });
    expect(await reserve(keys(caseId, "in:gm-1", 4))).toMatchObject({ status: "reserved" });
    expect(await reserve(keys(caseId, "in:gm-1", 3))).toEqual({ status: "subject_exhausted" });
  });
  it("returns a known failure as known, an uncertain failure as uncertain, and never re-opens either", async () => {
    const caseId = await newCase();
    for (const [n, uncertain, expected] of [[1, false, { status: "known", result: { status: "failed", uncertain: false } }], [2, true, { status: "uncertain" }]] as const) {
      const k = keys(caseId, "in:gm-1", n), { token } = (await reserve(k)) as { token: string };
      await markSavCaseCallDispatched({ callKey: k.callKey, token });
      await settleSavCaseCall({ callKey: k.callKey, token, result: { status: "failed", uncertain } });
      expect(await reserve(k, at(3600))).toEqual(expected);
    }
    expect(await callsForCaseInWindow({ caseId, since: T0 })).toEqual({ reserved: 0, dispatched: 0, settled: 2, total: 2 });
  });
  it("refuses a malformed key, a key reused for another purpose, and writes nothing while recording is off or the schema is missing", async () => {
    const caseId = await newCase(), other = await newCase();
    await expect(reserve({ ...keys(caseId), callKey: `sav-case:${caseId}:in:gm-1:retry` })).rejects.toThrow("SAV_CASE_CALL_KEY_INVALID");
    await expect(reserve({ ...keys(caseId), caseId: other })).rejects.toThrow("SAV_CASE_CALL_KEY_INVALID");
    await expect(reserve({ ...keys(caseId), subjectKey: `sav-case:${caseId}:in:gm-2` })).rejects.toThrow("SAV_CASE_CALL_KEY_INVALID");
    await reserve(keys(caseId));
    await expect(reserve(keys(caseId), at(120), { purpose: "resolution_check" })).rejects.toThrow("SAV_CASE_CALL_KEY_CONFLICT");
    vi.stubEnv("SAV_CASE_RECORDING", "off");
    await expect(reserve(keys(caseId, "back:ev-9"))).rejects.toThrow("SAV_CASE_CALL_RECORDING_OFF");
    vi.stubEnv("SAV_CASE_RECORDING", "on");
    await withoutSyncStateRow(f.client, "sav-case-schema-v5", () => expect(reserve(keys(caseId, "back:ev-9"))).rejects.toThrow("SAV_CASE_CALL_SCHEMA_MISSING"));
  });
  it("is enforced by the database too: no dispatched key back to reserved, no settled change, no delete", async () => {
    const k = keys(await newCase()), { token } = (await reserve(k)) as { token: string };
    await expect(f.client.query(`UPDATE sav.case_calls SET state = 'settled', settled_at = now(), result_status = 'failed', result_uncertain = false WHERE call_key = $1`, [k.callKey])).rejects.toThrow(/SAV_CASE_CALL_NOT_DISPATCHED|sav_case_calls_dispatched/);
    await markSavCaseCallDispatched({ callKey: k.callKey, token });
    await expect(f.client.query(`UPDATE sav.case_calls SET state = 'reserved', dispatched_at = NULL, lease_until = now() WHERE call_key = $1`, [k.callKey])).rejects.toThrow("SAV_CASE_CALL_DISPATCHED");
    await expect(f.client.query(`UPDATE sav.case_calls SET state = 'released', dispatched_at = NULL WHERE call_key = $1`, [k.callKey])).rejects.toThrow("SAV_CASE_CALL_DISPATCHED");
    await expect(f.client.query(`DELETE FROM sav.case_calls WHERE call_key = $1`, [k.callKey])).rejects.toThrow("SAV_CASE_CALL_IMMUTABLE");
    await settleSavCaseCall({ callKey: k.callKey, token, result: { status: "failed", uncertain: true } });
    await expect(f.client.query(`UPDATE sav.case_calls SET result_uncertain = false WHERE call_key = $1`, [k.callKey])).rejects.toThrow("SAV_CASE_CALL_SETTLED");
  });
});

// The two guard tests above remove a schema marker from a database other files share: withoutSyncStateRow (test/sav-sync-state-row.ts)
// puts back exactly the row that was there, every column with its microseconds, and only if it was there. Synthetic keys only below.
describe("withoutSyncStateRow: a removed marker comes back exactly as it was, an absent one stays absent", () => {
  const table = async () => (await f.client.query<{ key: string; row: string }>("SELECT key, to_jsonb(s)::text AS row FROM sav.sync_state s ORDER BY key")).rows;
  const row = async (key: string) => (await f.client.query<{ row: string }>("SELECT to_jsonb(s)::text AS row FROM sav.sync_state s WHERE key = $1", [key])).rows[0]?.row;
  const synKey = () => `sav-a-syn-marker-${randomUUID()}`;
  const putSyn = (key: string, cursor = "syn-cursor") => f.client.query(`INSERT INTO sav.sync_state(key, cursor, status, processed_count, last_error, started_at, completed_at, updated_at)
    VALUES ($1, $2, 'syn-status', 7, 'syn-error', '2026-10-31 10:00:00.123456+00', '2026-10-31 10:00:01.654321+00', '2026-10-31 10:00:02.000001+00')`, [key, cursor]);
  const dropSyn = async (...keys: string[]) => { for (const key of keys) await f.client.query("DELETE FROM sav.sync_state WHERE key = $1", [key]); };

  it("leaves an absent row absent and every other row unchanged", async () => {
    const key = synKey(), before = await table();
    expect(await withoutSyncStateRow(f.client, key, async () => { expect(await row(key)).toBeUndefined(); return "body-result"; })).toBe("body-result");
    expect(await row(key)).toBeUndefined();
    expect(await table()).toEqual(before);
  });
  it("puts the whole original row back (every column, microseconds), and foreign rows sharing its prefix never move", async () => {
    const key = synKey(), foreign = [`${key}:foreign`, `${key}-foreign`];
    try {
      for (const k of [key, ...foreign]) await putSyn(k, `cursor-of-${k}`);
      const before = await table(), original = await row(key);
      expect(original).toMatch(/"updated_at": "\d{4}-\d\d-\d\dT\d\d:\d\d:02\.000001[+-]\d\d:\d\d"/);
      await withoutSyncStateRow(f.client, key, async () => {
        expect(await row(key)).toBeUndefined();
        for (const k of foreign) expect(await row(k)).toBe(before.find(r => r.key === k)!.row);
      });
      expect(await row(key)).toBe(original);
      expect(await table()).toEqual(before);
    } finally { await dropSyn(key, ...foreign); }
  });
  it("restores the real migrator's case markers byte for byte around both store guards, whatever their content", async () => {
    const before = await table();
    expect(before.map(r => r.key)).toEqual(expect.arrayContaining(["sav-case-schema-v4", "sav-case-schema-v5"]));
    await withoutSyncStateRow(f.client, "sav-case-schema-v4", () => expect(newCase()).rejects.toThrow("SAV_CASE_SCHEMA_MISSING"));
    const caseId = await newCase();
    await withoutSyncStateRow(f.client, "sav-case-schema-v5", () => expect(reserve(keys(caseId, "back:syn-marker"))).rejects.toThrow("SAV_CASE_CALL_SCHEMA_MISSING"));
    expect(await table()).toEqual(before);
  });
  it("rethrows the body's own failure after restoring the row", async () => {
    const key = synKey();
    try {
      await putSyn(key); const original = await row(key);
      await expect(withoutSyncStateRow(f.client, key, async () => { throw Error("SYN_BODY_FAILED"); })).rejects.toThrow("SYN_BODY_FAILED");
      expect(await row(key)).toBe(original);
    } finally { await dropSyn(key); }
  });
  it("never lets a failed restore hide the body's failure, nor pass silently after a passing body", async () => {
    const key = synKey();
    try {
      await putSyn(key);
      // The body writes the key itself, so putting the original back collides: both failures are reported, the body's first.
      const both = await withoutSyncStateRow(f.client, key, async () => { await putSyn(key, "written-by-body"); throw Error("SYN_BODY_FAILED"); }).catch(e => e);
      expect(both).toBeInstanceOf(AggregateError);
      expect(both.message).toContain("SYN_BODY_FAILED");
      expect((both as AggregateError).errors.map(e => String(e))).toEqual([expect.stringContaining("SYN_BODY_FAILED"), expect.stringMatching(/duplicate key value/)]);
      await dropSyn(key); await putSyn(key);
      await expect(withoutSyncStateRow(f.client, key, () => putSyn(key, "written-by-body"))).rejects.toThrow(/duplicate key value/);
      expect(await row(key)).toContain('"cursor": "written-by-body"');
    } finally { await dropSyn(key); }
  });
  it("reports, and does not delete, a row the body created where none existed", async () => {
    const key = synKey();
    try {
      await expect(withoutSyncStateRow(f.client, key, () => putSyn(key, "written-by-body"))).rejects.toThrow(`SAV_SYNC_STATE_ROW_APPEARED:${key}`);
      expect(await row(key)).toContain('"cursor": "written-by-body"');
    } finally { await dropSyn(key); }
  });
});
