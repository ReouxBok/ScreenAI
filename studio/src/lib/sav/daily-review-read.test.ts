import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn(), admin: vi.fn() }));
vi.mock("@/db", () => ({ requireDb: () => db }));
vi.mock("./intake/execution-policy", () => ({ executionAdministrator: db.admin }));
import { PgDialect } from "drizzle-orm/pg-core";
import { readDailyReviewSnapshot, dailyReviewConsoleSummary, dailyReviewDatabasePorts, type DailyReviewReadPorts } from "./daily-review-read";
import { buildDailyReview, classifyStage } from "./daily-review";
import { createSavTestDb } from "../../../test/sav-db";
import { savCases } from "@/db/schema";

const now = new Date("2026-11-10T12:00:00.000Z"), at = "2026-11-10T11:00:00.000Z";
const id = "10000000-0000-4000-8000-000000000001", id2 = "10000000-0000-4000-8000-000000000002";
const row = (extra = {}) => ({ id, requestedAt: at, paused: false, uncertain: false, effectAt: null, ...extra });
const monitor = (extra = {}) => ({ observedAt: now.toISOString(), complete: true, issues: [], ...extra });
const ports = (extra: Partial<DailyReviewReadPorts> = {}): DailyReviewReadPorts => ({ authorize: vi.fn().mockResolvedValue({}), now: () => now,
  dossiers: vi.fn().mockResolvedValue([row()]), monitor: vi.fn().mockResolvedValue(monitor()), ...extra });
beforeEach(() => { vi.clearAllMocks(); db.admin.mockResolvedValue({ role: "admin" }); });

describe("SAV-16 branchable read model", () => {
  it("authenticates before parsing or touching data", async () => {
    const p = ports({ authorize: vi.fn().mockRejectedValue(Error("denied")) });
    await expect(readDailyReviewSnapshot({ limit: 999 }, p)).rejects.toThrow("denied");
    expect(p.dossiers).not.toHaveBeenCalled(); expect(p.monitor).not.toHaveBeenCalled();
  });
  it.each([{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { body: "secret" }, { from: at, to: "2026-11-11T12:00:00.000Z" },
    { from: "2026-11-01T00:00:00.000Z" }, { from: at, to: "2026-11-10T10:00:00.000Z" }])("rejects invalid/unbounded windows without collection", async raw => {
    const p = ports(); await expect(readDailyReviewSnapshot(raw, p)).rejects.toThrow(); expect(p.dossiers).not.toHaveBeenCalled();
  });
  it("requests limit+1, trims, deduplicates and declares truncation without claiming completeness", async () => {
    const p = ports({ dossiers: vi.fn().mockResolvedValue([row(), row({ id: id2 })]) });
    const s = await readDailyReviewSnapshot({ limit: 1 }, p);
    expect(p.dossiers).toHaveBeenCalledWith("v1", s.window, 2);
    expect(s.coverage).toMatchObject({ state: "partial", truncated: true });
    expect(s.missing).toEqual(expect.arrayContaining(["v1_truncated", "v2_truncated", "worker_start_telemetry"]));
    expect(s.report.coverage.dossiers).toBe(2); expect(s.report.coverage.unknown).toBe(2);
    expect(s.report.tasks).toEqual([]); expect(s.report.groups.some(g => g.cause === "no_pulse")).toBe(false);
  });
  it("keeps absence of telemetry unknown even after a confirmed client effect", async () => {
    const s = await readDailyReviewSnapshot({}, ports({ dossiers: async () => [row({ effectAt: at })] }));
    expect(s.report.groups[0].cause).toBe("unknown"); expect(s.coverage.state).toBe("partial");
    expect(s.missing).toContain("worker_finish_telemetry");
  });
  it("preserves human pauses and uncertain effects, including overlap, without repair tasks", async () => {
    const s = await readDailyReviewSnapshot({}, ports({ dossiers: async engine => engine === "v1" ? [row({ paused: true })] : [row({ paused: true, uncertain: true })] }));
    expect(s.coverage).toMatchObject({ humanHolds: 2, uncertainEffects: 1 });
    expect(s.report.groups.map(g => g.cause)).toEqual(["effect_uncertain", "paused_by_human"]); expect(s.report.tasks).toEqual([]);
  });
  it.each([null, { ...monitor(), observedAt: "2026-11-10T10:00:00.000Z" }, { ...monitor(), observedAt: "2026-11-11T10:00:00.000Z" }, { ...monitor(), complete: false }])("makes absent, stale, future and partial monitor evidence explicit", async value => {
    const s = await readDailyReviewSnapshot({}, ports({ monitor: async () => value }));
    expect(s.report.monitor.state).not.toBe("complete"); expect(s.coverage.state).toBe("partial");
    expect(s.missing.some(x => x.startsWith("monitor_"))).toBe(true);
    expect(s.coverage.monitorObservedAt).toBe(value?.observedAt ?? null);
  });
  it("isolates failed sources and strips invalid/free-text/sensitive rows and monitor extras", async () => {
    const s = await readDailyReviewSnapshot({}, ports({ dossiers: async engine => {
      if (engine === "v1") throw Error("SECRET provider customer@example.invalid");
      return [row({ body: "SECRET" }), row({ id: id2 }), row({ id: id2 })];
    }, monitor: async () => ({ ...monitor(), token: "SECRET" }) }));
    expect(s.coverage.sources.v1).toBe("unavailable"); expect(s.report.coverage.dossiers).toBe(1);
    expect(s.missing).toEqual(expect.arrayContaining(["v1_source_unavailable", "v2_invalid_row", "v2_duplicate_row"]));
    expect(JSON.stringify(s)).not.toMatch(/SECRET|customer@|token/);
  });
  it("returns unavailable rather than an empty healthy report when all dossier sources fail", async () => {
    const s = await readDailyReviewSnapshot({}, ports({ dossiers: async () => { throw Error("db unavailable"); } }));
    expect(s.coverage.state).toBe("unknown"); expect(dailyReviewConsoleSummary(s)).toMatchObject({ state: "unavailable", coverage: "unknown" });
  });
  it("is deterministic for unchanged exports and never records corrected/tested status", async () => {
    const p = ports(), a = await readDailyReviewSnapshot({}, p), b = await readDailyReviewSnapshot({}, p);
    expect(a).toEqual(b); expect(a.report.status).toEqual({ patched: false, tested: false, reviewed: false, published: false, deployed: false });
    expect(dailyReviewConsoleSummary(a)).toMatchObject({ state: "available", coverage: "partial", observedAt: now.toISOString() });
  });
  it("does not call missing expected client effects a failure", () => {
    const s = { requestedAt: at, workerStartedAt: at, workerFinishedAt: at, effectAt: null, outcome: "succeeded" as const, errorCode: null };
    expect(classifyStage(s)).toBe("unknown"); expect(classifyStage({ ...s, effectExpected: true })).toBe("effect_missing");
    expect(classifyStage({ ...s, outcome: "pending" })).toBe("unknown");
    expect(buildDailyReview({ window: { from: at, to: now.toISOString() }, monitor: null, dossiers: [{ id, engine: "v1", stage: s }] }).tasks).toEqual([]);
  });
  it("real database ports issue only bounded SELECTs in read-only transactions and never select ciphertext or contacts", async () => {
    db.transaction.mockImplementation(async (fn, options) => { expect(options).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" }); return fn({ execute: db.execute }); });
    db.execute.mockResolvedValue([]);
    for (const engine of ["v1", "v2"] as const) await dailyReviewDatabasePorts.dossiers(engine, { from: at, to: now.toISOString() }, 2);
    await dailyReviewDatabasePorts.monitor();
    const queries = db.execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query));
    expect(queries).toHaveLength(6);
    for (const q of queries) { expect(q.sql.trim()).toMatch(/^select /i); expect(q.sql).not.toMatch(/insert |update |delete |ciphertext|from_email|subject|phone/i); }
    expect(queries[1].params).toContain(2); expect(queries[3].params).toContain(2);
    expect(queries[1].sql).toContain("r.is_current"); expect(queries[3].sql).toContain("sav.cases");
  });
  it("executes the production SELECTs against the migrated test database without starting a worker", async () => {
    const fixture = await createSavTestDb();
    db.transaction.mockImplementation((...args) => Reflect.apply(fixture.db.transaction, fixture.db, args));
    try {
      await fixture.db.insert(savCases).values([
        { id, ticketId: "101", owner: "human", phase: "human_owned", contractRevision: "synthetic", payloadCiphertext: "synthetic", createdAt: new Date(at) },
        { id: id2, ticketId: "102", owner: "human", phase: "human_owned", contractRevision: "synthetic", payloadCiphertext: "synthetic", createdAt: new Date("2026-11-01T00:00:00.000Z") },
      ]);
      expect(await dailyReviewDatabasePorts.dossiers("v1", { from: at, to: now.toISOString() }, 2)).toEqual([]);
      expect(await dailyReviewDatabasePorts.dossiers("v2", { from: at, to: now.toISOString() }, 2)).toEqual([row({ paused: true })]);
      expect(await dailyReviewDatabasePorts.monitor()).toBeNull();
      expect(await fixture.db.select({ id: savCases.id }).from(savCases)).toHaveLength(2);
    } finally { await fixture.client.close(); }
  }, 30000);
});
