import { describe, expect, it } from "vitest";
import { buildDailyReview, classifyStage, renderDailyReview } from "./daily-review";

const T = (m: number) => new Date(Date.UTC(2026, 10, 10, 6, m)).toISOString();
const st = (o: Partial<Parameters<typeof classifyStage>[0]>) => ({ requestedAt: T(0), workerStartedAt: null, workerFinishedAt: null, effectAt: null, workerTelemetryComplete: true, effectExpected: true, outcome: "pending" as const, errorCode: null, ...o });
const input = (dossiers: unknown[], monitor: unknown = null) => ({ window: { from: T(0), to: T(60) }, monitor, dossiers });

describe("SAV-16 daily review", () => {
  it("separates platform request, worker start, finish and client effect", () => {
    expect(classifyStage(st({}))).toBe("no_pulse");
    expect(classifyStage(st({ workerStartedAt: T(1) }))).toBe("worker_unfinished");
    expect(classifyStage(st({ workerStartedAt: T(1), workerFinishedAt: T(2), outcome: "failed", errorCode: "x" }))).toBe("worker_failed");
    expect(classifyStage(st({ workerStartedAt: T(1), workerFinishedAt: T(2), outcome: "succeeded" }))).toBe("effect_missing");
    expect(classifyStage(st({ workerStartedAt: T(1), workerFinishedAt: T(2), effectAt: T(3), outcome: "succeeded" }))).toBe("succeeded");
    expect(classifyStage(st({ workerStartedAt: T(1), outcome: "uncertain" }))).toBe("effect_uncertain");
    expect(classifyStage(st({ outcome: "paused_by_human" }))).toBe("paused_by_human");
  });
  it("never guesses: missing request or out-of-order stages are unknown", () => {
    expect(classifyStage(st({ requestedAt: null }))).toBe("unknown");
    expect(classifyStage(st({ workerStartedAt: T(5), workerFinishedAt: T(2) }))).toBe("unknown");
    expect(classifyStage(st({ effectAt: T(3), outcome: "succeeded" }))).toBe("unknown");
  });
  it("dedupes by cause and error code, measures V1 and V2 at the same level, exact coverage", () => {
    const fail = (id: string, engine: string, code: string) => ({ id, engine, stage: st({ workerStartedAt: T(1), workerFinishedAt: T(2), outcome: "failed", errorCode: code }) });
    const r = buildDailyReview(input([fail("a", "v1", "timeout"), fail("b", "v2", "timeout"), fail("c", "v2", "schema"),
      { id: "d", engine: "v1", stage: st({}) }, { id: "e", engine: "v2", stage: st({ requestedAt: null }) }]));
    expect(r.coverage).toEqual({ dossiers: 5, classified: 4, unknown: 1, byEngine: { v1: 2, v2: 3 } });
    const timeout = r.groups.find(g => g.errorCode === "timeout")!;
    expect(timeout).toMatchObject({ cause: "worker_failed", count: 2, byEngine: { v1: 1, v2: 1 }, oldestAgeSeconds: 3600, sampleIds: ["v1:a", "v2:b"] });
    expect(r.groups.map(g => g.cause)).toEqual(["worker_failed", "worker_failed", "no_pulse", "unknown"]);
    expect(r.tasks).toHaveLength(2);
    expect(r.tasks.every(t => t.stopIf.length === 4)).toBe(true);
    expect(r.status).toEqual({ patched: false, tested: false, reviewed: false, published: false, deployed: false });
  });
  it("never turns uncertain, unknown or paused causes into agent tasks", () => {
    const r = buildDailyReview(input([{ id: "u", engine: "v2", stage: st({ outcome: "uncertain" }) }, { id: "p", engine: "v1", stage: st({ outcome: "paused_by_human" }) }]));
    expect(r.tasks).toEqual([]);
  });
  it("rejects free text, emails, unknown fields and duplicate dossiers", () => {
    expect(() => buildDailyReview(input([{ id: "client@example.invalid", engine: "v1", stage: st({}) }]))).toThrow();
    expect(() => buildDailyReview(input([{ id: "a", engine: "v1", stage: st({}), body: "x" }]))).toThrow();
    expect(() => buildDailyReview(input([{ id: "a", engine: "v1", stage: st({ errorCode: "Free Text!" }) }]))).toThrow();
    expect(() => buildDailyReview(input([{ id: "a", engine: "v1", stage: st({}) }, { id: "a", engine: "v1", stage: st({}) }]))).toThrow("DAILY_REVIEW_DUPLICATE_DOSSIER");
  });
  it("reports a partial monitor snapshot without deducing recovery, and renders French text", () => {
    const r = buildDailyReview(input([], { observedAt: T(59), complete: false, issues: [{ code: "worker_stalled", count: 1, severity: "critical" }] }));
    expect(r.monitor).toEqual({ state: "partial", critical: ["worker_stalled:1"], warning: [] });
    const text = renderDailyReview(r);
    expect(text).toContain("collecte partielle, aucun rétablissement déduit");
    expect(text).toContain("non déployé");
  });
});
