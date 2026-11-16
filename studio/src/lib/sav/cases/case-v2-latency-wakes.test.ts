import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSavTestDb } from "../../../../test/sav-db";
import { auditLogs } from "@/db/schema";
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({ requireDb: () => { if (!state.db) throw Error("NO_DB_ALLOWED"); return state.db; } }));
import {
  type CaseSettleWakeStart, CASE_REPLY_SEND_MARK, CASE_SETTLE_WAKE_MARGIN_MS, CASE_SETTLE_WAKE_MARK, requestCaseReplySend, requestCaseSettleWake, runCaseReplySend, runCaseSettleWake,
} from "./case-v2-latency-wakes";
import { continueCaseAfterCommit } from "./v2-entry";
import type { CaseContinuationPoint } from "./v2-entry-binding";

/*
 * SAV-92 (16/11, latency), SYN: the two wakes on a real (synthetic) database. The workflow starter is the only double: it records what would be started.
 * Every id is random, every date is computed from a fixed synthetic clock; nothing reaches a provider or the workflow runtime.
 */
let f: Awaited<ReturnType<typeof createSavTestDb>>;
const PROD = { VERCEL_ENV: "production" };
const V2 = { ...PROD, SAV_V2_ENTRY: "on", SAV_CASE_RECORDING: "on" };
const NOW = new Date("2026-11-16T11:21:38.000Z");
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const marker = async (mark: { action: string; entityType: string }, id: string) =>
  (await f.db.select().from(auditLogs).where(and(eq(auditLogs.entityType, mark.entityType), eq(auditLogs.entityId, id), eq(auditLogs.action, mark.action))));

beforeAll(async () => { f = await createSavTestDb(); state.db = f.db; }, 60_000);
afterAll(async () => { state.db = null; await f.client.close(); });
beforeEach(() => { vi.restoreAllMocks(); vi.spyOn(console, "info").mockImplementation(() => {}); });

describe("settle wake: ONE durable wake per case when the inbound settle window ends", () => {
  it("off outside production or with the switch off: nothing reserved, nothing started", async () => {
    const start = vi.fn(async () => {}), caseId = randomUUID();
    expect(await requestCaseSettleWake(caseId, iso(300_000), { env: {}, start, now: NOW })).toEqual({ started: false, reason: "off" });
    expect(await requestCaseSettleWake(caseId, iso(300_000), { env: { VERCEL_ENV: "preview" }, start, now: NOW })).toEqual({ started: false, reason: "off" });
    expect(await requestCaseSettleWake(caseId, iso(300_000), { env: { ...PROD, SAV_V2_WAKE_WORKFLOWS: "off" }, start, now: NOW })).toEqual({ started: false, reason: "off" });
    expect(start).not.toHaveBeenCalled();
    expect(await marker(CASE_SETTLE_WAKE_MARK, caseId)).toEqual([]);
  });

  it("sleeps until retryAt + margin; concurrent and repeated refusals for the same window start ONE wake", async () => {
    const start = vi.fn<CaseSettleWakeStart>(async () => {}), caseId = randomUUID(), retryAt = iso(300_000);
    const results = await Promise.all([0, 1, 2, 3].map(() => requestCaseSettleWake(caseId, retryAt, { env: PROD, start, now: NOW })));
    expect(results.filter(result => result.started)).toHaveLength(1);
    expect(results.filter(result => !result.started).map(result => result.reason)).toEqual(["already_scheduled", "already_scheduled", "already_scheduled"]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(caseId, new Date(Date.parse(retryAt) + CASE_SETTLE_WAKE_MARGIN_MS).toISOString());
    // A later refusal (a new customer mail moved the window) while the first wake is still pending: no second wake; the pending one reschedules itself.
    expect(await requestCaseSettleWake(caseId, iso(400_000), { env: PROD, start, now: new Date(NOW.getTime() + 60_000) })).toEqual({ started: false, reason: "already_scheduled" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(await marker(CASE_SETTLE_WAKE_MARK, caseId)).toEqual([expect.objectContaining({ technicalMetadata: expect.objectContaining({ state: "scheduled", starts: 1 }) })]);
  });

  it("a date not ahead, too far or malformed starts nothing", async () => {
    const start = vi.fn(async () => {}), caseId = randomUUID();
    expect(await requestCaseSettleWake(caseId, iso(0), { env: PROD, start, now: NOW })).toMatchObject({ started: false, reason: "not_ahead" });
    expect(await requestCaseSettleWake(caseId, iso(2 * 3600_000), { env: PROD, start, now: NOW })).toMatchObject({ started: false, reason: "too_far" });
    expect(await requestCaseSettleWake(caseId, "demain", { env: PROD, start, now: NOW })).toMatchObject({ started: false, reason: "invalid" });
    expect(await requestCaseSettleWake("not-a-case", iso(300_000), { env: PROD, start, now: NOW })).toMatchObject({ started: false, reason: "invalid" });
    expect(start).not.toHaveBeenCalled();
  });

  it("a failed start is retried by the next refusal; a lost wake (past its grace) can be replaced by a later window", async () => {
    const caseId = randomUUID(), failing = vi.fn(async () => { throw Error("SYNTHETIC_START_DOWN"); }), start = vi.fn(async () => {});
    expect(await requestCaseSettleWake(caseId, iso(300_000), { env: PROD, start: failing, now: NOW })).toEqual({ started: false, reason: "start_failed" });
    expect(await requestCaseSettleWake(caseId, iso(300_000), { env: PROD, start, now: NOW })).toMatchObject({ started: true });
    // Pending and within its grace: a later window is refused (the pending wake reschedules itself).
    expect(await requestCaseSettleWake(caseId, iso(700_000), { env: PROD, start, now: new Date(NOW.getTime() + 310_000) })).toMatchObject({ started: false, reason: "already_scheduled" });
    // Never run (lost, past its grace): a strictly later window is accepted.
    expect(await requestCaseSettleWake(caseId, iso(900_000), { env: PROD, start, now: new Date(NOW.getTime() + 600_000) })).toMatchObject({ started: true });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("the wake continues THE case once (trigger settle_wake, its own deadline); still settling -> exactly one next wake, then the queued reply", async () => {
    const caseId = randomUUID(), start = vi.fn<CaseSettleWakeStart>(async () => {}), seen: Parameters<CaseContinuationPoint>[0][] = [];
    const answers = [{ status: "claim_refused", reason: "settling", retryAt: "" }, { status: "queued" }];
    const point: CaseContinuationPoint = async input => { seen.push(input); return answers.shift()!; };
    // First passage (the relay) refused while the mail settles: the wake is scheduled by continueCaseAfterCommit itself.
    const firstRetry = new Date(Date.now() + 300_000).toISOString();
    expect(await continueCaseAfterCommit(caseId, "relay", { env: V2, continuation: async input => { seen.push(input); return { status: "claim_refused", reason: "settling", retryAt: firstRetry }; }, settleWakeStart: start }))
      .toEqual({ status: "claim_refused", reason: "settling", retryAt: firstRetry });
    expect(start).toHaveBeenCalledTimes(1);
    const firstWake = start.mock.calls[0]![1];
    // A second relay of the same mail (webhook replayed) refused for the same window: no second wake.
    await continueCaseAfterCommit(caseId, "relay", { env: V2, continuation: async () => ({ status: "claim_refused", reason: "settling", retryAt: firstRetry }), settleWakeStart: start });
    expect(start).toHaveBeenCalledTimes(1);
    // The wake runs; a new mail arrived meanwhile, so it is refused again with a LATER window: one next wake.
    answers[0]!.retryAt = new Date(Date.now() + 400_000).toISOString();
    const deadlineMs = Date.now() + 240_000;
    expect(await runCaseSettleWake(caseId, firstWake, { env: V2, deadlineMs, continuation: point, settleWakeStart: start })).toEqual({ status: "claim_refused" });
    expect(seen.at(-1)).toMatchObject({ caseId, trigger: "settle_wake", deadlineMs });
    expect(start).toHaveBeenCalledTimes(2);
    // The second wake runs and the case is answered: no further wake.
    expect(await runCaseSettleWake(caseId, start.mock.calls[1]![1], { env: V2, deadlineMs, continuation: point, settleWakeStart: start })).toEqual({ status: "queued" });
    expect(start).toHaveBeenCalledTimes(2);
    expect(await marker(CASE_SETTLE_WAKE_MARK, caseId)).toEqual([expect.objectContaining({ technicalMetadata: expect.objectContaining({ state: "done", starts: 2 }) })]);
  });

  it("a wake that runs with V2 off continues nothing", async () => {
    const point = vi.fn<CaseContinuationPoint>(async () => ({ status: "queued" }));
    expect(await runCaseSettleWake(randomUUID(), iso(305_000), { env: PROD, deadlineMs: Date.now() + 240_000, continuation: point })).toEqual({ status: "v2_off" });
    expect(point).not.toHaveBeenCalled();
  });
});

describe("separate send: ONE dispatch per queued execution, sent in its own step", () => {
  it("concurrent and repeated passages (relay, sweeps) dispatch ONE workflow; off outside production", async () => {
    const start = vi.fn(async () => {}), executionId = randomUUID();
    expect(await requestCaseReplySend({ env: {}, executionId }, { start })).toEqual({ started: false, reason: "off" });
    const results = await Promise.all([0, 1, 2].map(() => requestCaseReplySend({ env: PROD, executionId }, { start })));
    expect(results.filter(result => result.started)).toHaveLength(1);
    expect(await requestCaseReplySend({ env: PROD, executionId }, { start })).toEqual({ started: false, reason: "already_dispatched" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(executionId);
  });

  it("a failed start may be dispatched again by a later passage, still once", async () => {
    const executionId = randomUUID(), start = vi.fn(async () => {});
    expect(await requestCaseReplySend({ env: PROD, executionId }, { start: async () => { throw Error("SYNTHETIC_START_DOWN"); } })).toEqual({ started: false, reason: "start_failed" });
    expect(await requestCaseReplySend({ env: PROD, executionId }, { start })).toEqual({ started: true, reason: "dispatched" });
    expect(await requestCaseReplySend({ env: PROD, executionId }, { start })).toEqual({ started: false, reason: "already_dispatched" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("the step sends with ITS OWN deadline (not the caller's) and returns a closed summary; a throwing sender never fails the step", async () => {
    const executionId = randomUUID(), deadlineMs = Date.now() + 240_000;
    const sendNow = vi.fn(async () => ({ pass: { skipped: null, recovery: [], supervised: [{ executionId, state: "confirmed", reason: null }], needsPerson: [] } }));
    await requestCaseReplySend({ env: PROD, executionId }, { start: async () => {} });
    expect(await runCaseReplySend(executionId, { env: PROD, deadlineMs, sendNow })).toEqual({ supervised: "confirmed" });
    expect(sendNow).toHaveBeenCalledWith({ env: PROD, executionId, callerDeadlineMs: deadlineMs });
    const other = randomUUID();
    await requestCaseReplySend({ env: PROD, executionId: other }, { start: async () => {} });
    expect(await runCaseReplySend(other, { env: PROD, deadlineMs, sendNow: async () => { throw Error("SYNTHETIC"); } })).toEqual({ failed: "SAV_V2_SEPARATE_SEND_THREW" });
  });
});

describe("review Astra (c08082e): the steps re-read the switch, and act only after consuming their own marker atomically", () => {
  const scheduled = async (caseId: string) => {
    const start = vi.fn<CaseSettleWakeStart>(async () => {});
    expect(await requestCaseSettleWake(caseId, new Date(Date.now() + 300_000).toISOString(), { env: PROD, start })).toMatchObject({ started: true });
    return start.mock.calls[0]![1];
  };
  const deadlineMs = () => Date.now() + 240_000;

  it("P1 settle: scheduled -> switch off (or not production) -> the wake runs: ZERO continuation, the marker stays for nobody", async () => {
    const caseId = randomUUID(), wakeAt = await scheduled(caseId), point = vi.fn<CaseContinuationPoint>(async () => ({ status: "queued" }));
    expect(await runCaseSettleWake(caseId, wakeAt, { env: { ...V2, SAV_V2_WAKE_WORKFLOWS: "off" }, deadlineMs: deadlineMs(), continuation: point })).toEqual({ status: "off" });
    expect(await runCaseSettleWake(caseId, wakeAt, { env: { ...V2, VERCEL_ENV: "preview" }, deadlineMs: deadlineMs(), continuation: point })).toEqual({ status: "off" });
    expect(point).not.toHaveBeenCalled();
  });

  it("P1 send: dispatched -> switch off (or not production) -> the step runs: ZERO send", async () => {
    const executionId = randomUUID(), sendNow = vi.fn(async () => ({ skipped: "never" }));
    await requestCaseReplySend({ env: PROD, executionId }, { start: async () => {} });
    expect(await runCaseReplySend(executionId, { env: { ...PROD, SAV_V2_WAKE_WORKFLOWS: "off" }, deadlineMs: deadlineMs(), sendNow })).toEqual({ skipped: "off" });
    expect(await runCaseReplySend(executionId, { env: {}, deadlineMs: deadlineMs(), sendNow })).toEqual({ skipped: "off" });
    expect(sendNow).not.toHaveBeenCalled();
  });

  it("P2 settle: the same wake run twice in sequence continues ONCE", async () => {
    const caseId = randomUUID(), wakeAt = await scheduled(caseId), point = vi.fn<CaseContinuationPoint>(async () => ({ status: "queued" }));
    expect(await runCaseSettleWake(caseId, wakeAt, { env: V2, deadlineMs: deadlineMs(), continuation: point })).toEqual({ status: "queued" });
    expect(await runCaseSettleWake(caseId, wakeAt, { env: V2, deadlineMs: deadlineMs(), continuation: point })).toEqual({ status: "not_consumed" });
    expect(point).toHaveBeenCalledTimes(1);
  });

  it("P2 settle: an old wake delayed past its replacement continues nothing; the replacing wake continues once", async () => {
    const caseId = randomUUID(), start = vi.fn<CaseSettleWakeStart>(async () => {}), point = vi.fn<CaseContinuationPoint>(async () => ({ status: "queued" }));
    const t0 = Date.now();
    await requestCaseSettleWake(caseId, new Date(t0 + 300_000).toISOString(), { env: PROD, start, now: new Date(t0) });
    // The first wake is lost past its grace; a later window replaces it.
    await requestCaseSettleWake(caseId, new Date(t0 + 900_000).toISOString(), { env: PROD, start, now: new Date(t0 + 600_000) });
    const [[, oldWake], [, newWake]] = start.mock.calls as [string, string][];
    expect(await runCaseSettleWake(caseId, oldWake!, { env: V2, deadlineMs: deadlineMs(), continuation: point })).toEqual({ status: "not_consumed" });
    expect(point).not.toHaveBeenCalled();
    expect(await runCaseSettleWake(caseId, newWake!, { env: V2, deadlineMs: deadlineMs(), continuation: point })).toEqual({ status: "queued" });
    expect(point).toHaveBeenCalledTimes(1);
  });

  it("P2 settle: a wake without any marker (never reserved) continues nothing", async () => {
    const point = vi.fn<CaseContinuationPoint>(async () => ({ status: "queued" }));
    expect(await runCaseSettleWake(randomUUID(), new Date(Date.now() + 5_000).toISOString(), { env: V2, deadlineMs: deadlineMs(), continuation: point })).toEqual({ status: "not_consumed" });
    expect(point).not.toHaveBeenCalled();
  });

  it("P2: an SQL error while consuming -> no continuation, no send; the marker is still open afterwards", async () => {
    const caseId = randomUUID(), wakeAt = await scheduled(caseId), executionId = randomUUID();
    await requestCaseReplySend({ env: PROD, executionId }, { start: async () => {} });
    const point = vi.fn<CaseContinuationPoint>(async () => ({ status: "queued" })), sendNow = vi.fn(async () => ({ skipped: "never" }));
    const real = state.db;
    state.db = { transaction: async () => { throw Error("SYNTHETIC_SQL_DOWN"); } };
    try {
      expect(await runCaseSettleWake(caseId, wakeAt, { env: V2, deadlineMs: deadlineMs(), continuation: point })).toEqual({ status: "not_consumed" });
      expect(await runCaseReplySend(executionId, { env: PROD, deadlineMs: deadlineMs(), sendNow })).toEqual({ skipped: "not_consumed" });
    } finally { state.db = real; }
    expect(point).not.toHaveBeenCalled();
    expect(sendNow).not.toHaveBeenCalled();
    expect(await marker(CASE_SETTLE_WAKE_MARK, caseId)).toEqual([expect.objectContaining({ technicalMetadata: expect.objectContaining({ state: "scheduled" }) })]);
    expect(await marker(CASE_REPLY_SEND_MARK, executionId)).toEqual([expect.objectContaining({ technicalMetadata: expect.objectContaining({ state: "dispatched" }) })]);
  });

  it("P2 send: the same dispatch's step run twice (in sequence or together) sends ONCE", async () => {
    const executionId = randomUUID(), sendNow = vi.fn(async () => ({ skipped: "synthetic" }));
    await requestCaseReplySend({ env: PROD, executionId }, { start: async () => {} });
    const results = await Promise.all([0, 1, 2].map(() => runCaseReplySend(executionId, { env: PROD, deadlineMs: deadlineMs(), sendNow })));
    expect(await runCaseReplySend(executionId, { env: PROD, deadlineMs: deadlineMs(), sendNow })).toEqual({ skipped: "not_consumed" });
    expect(results.filter(result => "skipped" in result && result.skipped === "not_consumed")).toHaveLength(2);
    expect(sendNow).toHaveBeenCalledTimes(1);
  });
});
