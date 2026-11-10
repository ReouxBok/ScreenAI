import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createSavTestDb } from "../../../../test/sav-db";
import { withoutSyncStateRow } from "../../../../test/sav-sync-state-row";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
vi.mock("../hubspot", () => { throw Error("HUBSPOT_IMPORTED"); });
vi.mock("../hubspot-transport", () => { throw Error("HUBSPOT_IMPORTED"); });
import {
  CaseVersionStaleError, appendCaseEvent, listCaseEvents, listCaseTimers, lockCaseForWrite, openCaseEvent, readCase, scheduleCaseTimer, updateCaseRecord, type CaseTx,
} from "./case-store";
import { caseDedupeKey, type CaseAdmissionQualification } from "./case-types";

/*
 * Lot 3, SYN on PGlite: the four A functions inside ONE caller transaction (C's receipt), against the
 * same functions without it. PGlite runs one connection: it proves the logical order and the rollback,
 * not native PG concurrency (native bench out of this brief).
 */

let f: Awaited<ReturnType<typeof createSavTestDb>>, ticketSeq = 7_900_000;
const AT = "2026-10-27T09:00:00.000Z", RECEIVED = "2026-10-27T08:00:00.000Z", SENT = "2026-10-28T08:00:00.000Z", DUE = "2026-10-29T09:00:00.000Z";
const STAFF = "20000000-0000-4000-8000-000000000001";
const POLICY = { revision: "policy-r1", admittedFamilies: ["access", "usage"], qualifiedRules: [], approvedBy: STAFF, approvedAt: AT };
const qualification: CaseAdmissionQualification = {
  requests: [{ requestId: "r1", family: "access", provenance: { kind: "human", staffUserId: STAFF, at: AT } }],
  identity: { status: "confirmed", source: { type: "hubspot_object", id: "contact-1" } }, crmContext: "complete", teamSignals: [],
};
const rows = async (sqlText: string, params: unknown[] = []) => (await f.client.query<Record<string, unknown>>(sqlText, params)).rows;
const markers = () => rows("SELECT to_jsonb(s)::text AS row FROM sav.sync_state s ORDER BY key");
/** Everything this file's writers can leave for one case: its row, journal and timers. */
const footprint = async (caseId: string) => ({
  case: await rows("SELECT version, phase, contract_revision FROM sav.cases WHERE id=$1", [caseId]),
  events: await rows("SELECT dedupe_key, case_version FROM sav.case_events WHERE case_id=$1 ORDER BY case_version", [caseId]),
  timers: await rows("SELECT id, state FROM sav.case_timers WHERE case_id=$1 ORDER BY id", [caseId]),
});

async function admittedCase() {
  const ticketId = String(++ticketSeq), gmail = `gm-tx-${ticketId}`;
  const { case: c } = await openCaseEvent({ ticketId, threadId: randomUUID(), admission: { policy: POLICY, qualification }, kind: "inbound_confirmed",
    dedupeKey: caseDedupeKey.inbound(gmail), sourceRef: { type: "email", id: gmail }, occurredAt: RECEIVED });
  expect(c.owner).toBe("agent");
  return c;
}

/** C's receipt as it will run: lock (ticket → case), then event, question, J2, all in `tx`. Idempotent:
 * the event key, the question's effect and the timer key make a replay write nothing. */
async function receipt(tx: CaseTx, caseId: string, effect: string) {
  const locked = await lockCaseForWrite(tx, caseId);
  const event = await appendCaseEvent({ caseId, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: caseDedupeKey.outbound(`gm-out-${effect}`),
    sourceRef: { type: "email", id: `gm-out-${effect}` }, occurredAt: SENT }, tx);
  let current = (await readCase(caseId, tx))!;
  expect(current.version).toBe(event.version);
  if (!current.body.questions.some(question => question.askedInEffect === effect)) {
    current = await updateCaseRecord({ caseId, expectedVersion: current.version, actor: { type: "agent" },
      body: { ...current.body, questions: [...current.body.questions, { id: `q-${effect}`, text: "Question fictive", factKeys: [], askedAt: SENT, askedInEffect: effect }] } }, tx);
  }
  const timer = await scheduleCaseTimer({ caseId, expectedVersion: current.version, currentPolicyRevision: "policy-r1", reasonCode: "j2_question",
    timer: { id: randomUUID(), questionEffectId: effect, sentAt: SENT, dueAt: DUE } }, tx);
  return { locked, event, timer };
}

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.stubEnv("SAV_ENCRYPTION_KEY_V1", "case-store-tx-fixture-key-32-characters"); vi.stubEnv("SAV_CASE_RECORDING", "on"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("one caller transaction: event, question and J2 commit or roll back together", () => {
  it("a forced rollback AFTER the event, the question and the timer leaves no row of its own, and every marker as it was", async () => {
    const c = await admittedCase(), before = await footprint(c.caseId), beforeMarkers = await markers();
    let reached = false;
    await expect(f.db.transaction(async tx => {
      const done = await receipt(tx, c.caseId, "effect-rollback");
      expect(done.event).toMatchObject({ appended: true });
      expect(done.timer).toMatchObject({ scheduled: true, case: { phase: "awaiting_customer" } });
      reached = true;
      throw Error("SYNTHETIC_FORCED_ROLLBACK");
    })).rejects.toThrow("SYNTHETIC_FORCED_ROLLBACK");
    expect(reached).toBe(true);
    expect(await footprint(c.caseId)).toEqual(before);
    expect(await markers()).toEqual(beforeMarkers);
  });

  it("a committed receipt writes once; replayed in a second transaction it writes nothing", async () => {
    const c = await admittedCase();
    const first = await f.db.transaction(tx => receipt(tx, c.caseId, "effect-twice"));
    expect(first.event.appended).toBe(true);
    expect(first.timer).toMatchObject({ scheduled: true });
    const after = await footprint(c.caseId);
    expect(after.case).toEqual([{ version: c.version + 3, phase: "awaiting_customer", contract_revision: expect.any(String) }]);
    expect(after.timers).toHaveLength(1);
    const second = await f.db.transaction(tx => receipt(tx, c.caseId, "effect-twice"));
    expect(second.event.appended).toBe(false);
    expect(second.timer).toMatchObject({ scheduled: false, reason: "already_exists" });
    expect(await footprint(c.caseId)).toEqual(after);
  });

  it("opens no nested transaction: the caller's is the only one, and the writers never call tx.transaction", async () => {
    const c = await admittedCase();
    const outer = vi.spyOn(f.db, "transaction");
    await f.db.transaction(async tx => {
      const nested = vi.spyOn(tx, "transaction");
      await receipt(tx, c.caseId, "effect-nested");
      expect(nested).not.toHaveBeenCalled();
    });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("a stale expectedVersion after the event throws and rolls the event back too", async () => {
    const c = await admittedCase(), before = await footprint(c.caseId);
    await expect(f.db.transaction(async tx => {
      await appendCaseEvent({ caseId: c.caseId, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: caseDedupeKey.outbound("gm-out-stale"),
        sourceRef: { type: "email", id: "gm-out-stale" }, occurredAt: SENT }, tx);
      await updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: c.body }, tx);
    })).rejects.toBeInstanceOf(CaseVersionStaleError);
    expect(await footprint(c.caseId)).toEqual(before);
  });

  it("readCase with tx sees the transaction's own writes; without tx the committed state", async () => {
    const c = await admittedCase();
    let inside = 0;
    await expect(f.db.transaction(async tx => {
      await appendCaseEvent({ caseId: c.caseId, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: caseDedupeKey.outbound("gm-out-read"),
        sourceRef: { type: "email", id: "gm-out-read" }, occurredAt: SENT }, tx);
      inside = (await readCase(c.caseId, tx))!.version;
      throw Error("SYNTHETIC_FORCED_ROLLBACK");
    })).rejects.toThrow("SYNTHETIC_FORCED_ROLLBACK");
    expect(inside).toBe(c.version + 1);
    expect((await readCase(c.caseId))!.version).toBe(c.version);
  });
});

describe("guards unchanged inside a caller transaction", () => {
  it("an unknown case refuses, and the caller's earlier writes roll back", async () => {
    const c = await admittedCase(), before = await footprint(c.caseId);
    await expect(f.db.transaction(async tx => {
      await appendCaseEvent({ caseId: c.caseId, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: caseDedupeKey.outbound("gm-out-unknown"),
        sourceRef: { type: "email", id: "gm-out-unknown" }, occurredAt: SENT }, tx);
      await lockCaseForWrite(tx, randomUUID());
    })).rejects.toThrow("SAV_CASE_NOT_FOUND");
    await expect(f.db.transaction(tx => lockCaseForWrite(tx, "not-a-uuid"))).rejects.toThrow("SAV_CASE_NOT_FOUND");
    expect(await footprint(c.caseId)).toEqual(before);
  });

  it("recording off refuses before any read, with or without tx", async () => {
    const c = await admittedCase();
    vi.stubEnv("SAV_CASE_RECORDING", "off");
    await expect(f.db.transaction(tx => lockCaseForWrite(tx, c.caseId))).rejects.toThrow("SAV_CASE_RECORDING_OFF");
    await expect(f.db.transaction(tx => updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: c.body }, tx))).rejects.toThrow("SAV_CASE_RECORDING_OFF");
    await expect(updateCaseRecord({ caseId: c.caseId, expectedVersion: c.version, actor: { type: "agent" }, body: c.body })).rejects.toThrow("SAV_CASE_RECORDING_OFF");
  });

  it("a missing schema marker refuses inside the transaction, read through that transaction", async () => {
    const c = await admittedCase(), before = await footprint(c.caseId);
    await withoutSyncStateRow(f.client, "sav-case-schema-v4", async () => {
      await expect(f.db.transaction(tx => scheduleCaseTimer({ caseId: c.caseId, expectedVersion: c.version, currentPolicyRevision: "policy-r1", reasonCode: "j2_question",
        timer: { id: randomUUID(), questionEffectId: "effect-x", sentAt: SENT, dueAt: DUE } }, tx))).rejects.toThrow("SAV_CASE_SCHEMA_MISSING");
      await expect(f.db.transaction(tx => lockCaseForWrite(tx, c.caseId))).rejects.toThrow("SAV_CASE_SCHEMA_MISSING");
    });
    expect(await footprint(c.caseId)).toEqual(before);
  });

  it("the marker read uses the caller's transaction: a marker removed inside it refuses there", async () => {
    const c = await admittedCase(), beforeMarkers = await markers();
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`DELETE FROM sav.sync_state WHERE key = 'sav-case-schema-v4'`);
      await appendCaseEvent({ caseId: c.caseId, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: caseDedupeKey.outbound("gm-out-marker"),
        sourceRef: { type: "email", id: "gm-out-marker" }, occurredAt: SENT }, tx);
    })).rejects.toThrow("SAV_CASE_SCHEMA_MISSING");
    expect(await markers()).toEqual(beforeMarkers);
  });
});

describe("lockCaseForWrite: ticket then case, and a stale read throws instead of committing", () => {
  it("returns the locked snapshot; a matching expectedVersion passes", async () => {
    const c = await admittedCase();
    const locked = await f.db.transaction(tx => lockCaseForWrite(tx, c.caseId, { expectedVersion: c.version }));
    expect(locked).toMatchObject({ caseId: c.caseId, ticketId: c.ticketId, version: c.version, owner: "agent" });
  });
  it("an older row rewritten under the lock is rolled back with the caller when the version is stale", async () => {
    const c = await admittedCase();
    await rows("UPDATE sav.cases SET contract_revision='sav-case-2026-10-27.v4' WHERE id=$1", [c.caseId]);
    await expect(f.db.transaction(tx => lockCaseForWrite(tx, c.caseId, { expectedVersion: c.version + 7 }))).rejects.toBeInstanceOf(CaseVersionStaleError);
    expect(await rows("SELECT contract_revision, version FROM sav.cases WHERE id=$1", [c.caseId])).toEqual([{ contract_revision: "sav-case-2026-10-27.v4", version: c.version }]);
    await f.db.transaction(tx => lockCaseForWrite(tx, c.caseId, { expectedVersion: c.version }));
    expect(await rows("SELECT contract_revision, version FROM sav.cases WHERE id=$1", [c.caseId])).toEqual([{ contract_revision: "sav-case-2026-10-27.v10", version: c.version }]);
  });
});

describe("without tx: the historical wrappers behave as before", () => {
  it("each writer commits on its own, in its own transaction", async () => {
    const c = await admittedCase();
    const outer = vi.spyOn(f.db, "transaction");
    const event = await appendCaseEvent({ caseId: c.caseId, kind: "outbound_observed", direction: "agent_outbound", dedupeKey: caseDedupeKey.outbound("gm-out-solo"),
      sourceRef: { type: "email", id: "gm-out-solo" }, occurredAt: SENT });
    const current = (await readCase(c.caseId))!;
    const asked = await updateCaseRecord({ caseId: c.caseId, expectedVersion: current.version, actor: { type: "agent" },
      body: { ...current.body, questions: [{ id: "q-solo", text: "Question fictive", factKeys: [], askedAt: SENT, askedInEffect: "effect-solo" }] } });
    const timer = await scheduleCaseTimer({ caseId: c.caseId, expectedVersion: asked.version, currentPolicyRevision: "policy-r1", reasonCode: "j2_question",
      timer: { id: randomUUID(), questionEffectId: "effect-solo", sentAt: SENT, dueAt: DUE } });
    expect(outer).toHaveBeenCalledTimes(3);
    expect(event).toEqual({ appended: true, version: c.version + 1 });
    expect(timer).toMatchObject({ scheduled: true, case: { version: c.version + 3 } });
    // openCaseEvent recorded the admission with the first mail; this file's writer added one event.
    expect((await listCaseEvents(c.caseId)).map(e => e.kind)).toEqual(["inbound_confirmed", "admission_decided", "outbound_observed"]);
    expect(await listCaseTimers(c.caseId)).toHaveLength(1);
  });
});
