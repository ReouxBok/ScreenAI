import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { nextMonitorState, monitorWebhook, monitorStateSchema, monitorSlackText, type MonitorState, type MonitorSnapshot } from "./monitor-contract";
const at = "2026-10-22T09:00:00.000Z";
const previous = (): MonitorState => ({ revision: 1, owner: randomUUID(), leaseUntil: at, observedAt: null, issues: [], events: [], delivery: { state: "idle", hash: null, attempts: 0, at: null } });
const snapshot = (overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot => ({ observedAt: at, complete: true, codeRevision: "a".repeat(40), runtimeMode: "off", executionMode: "off", issues: [], metrics: {}, ...overrides });
describe("server monitoring incident lifecycle", () => {
  it("opens an incident once and remains silent for an unchanged snapshot", () => {
    const s = snapshot({ issues: [{ code: "effect_uncertain", count: 1, severity: "critical" }] });
    const first = nextMonitorState(previous(), s);
    expect(first.events).toMatchObject([{ change: "opened", code: "effect_uncertain", count: 1 }]);
    expect(nextMonitorState({ ...first, events: [] }, s).events).toEqual([]);
  });
  it("reports aggravation, quietly records a decrease and reports complete recovery", () => {
    const first = nextMonitorState(previous(), snapshot({ issues: [{ code: "analysis_delayed", count: 2, severity: "warning" }] }));
    const second = nextMonitorState({ ...first, events: [] }, snapshot({ issues: [{ code: "analysis_delayed", count: 3, severity: "critical" }] }));
    expect(second.events[0].change).toBe("worsened");
    const third = nextMonitorState({ ...second, events: [] }, snapshot({ issues: [{ code: "analysis_delayed", count: 1, severity: "warning" }] }));
    expect(third.events).toEqual([]);
    expect(nextMonitorState(third, snapshot()).events).toMatchObject([{ code: "analysis_delayed", change: "recovered", count: 0 }]);
  });
  it("never turns a partial collection into a recovery", () => {
    const first = nextMonitorState(previous(), snapshot({ issues: [{ code: "effect_uncertain", count: 1, severity: "critical" }] }));
    const second = nextMonitorState({ ...first, events: [] }, snapshot({ complete: false, issues: [{ code: "collection_failed", count: 1, severity: "critical" }] }));
    expect(second.issues.map(i => i.code)).toEqual(["effect_uncertain", "collection_failed"]);
    expect(second.events.some(e => e.change === "recovered")).toBe(false);
  });
  it("coalesces queued updates for an incident and validates stored bounds", () => {
    const first = nextMonitorState(previous(), snapshot({ issues: [{ code: "quarantine", count: 1, severity: "warning" }] }));
    expect(nextMonitorState(first, snapshot()).events).toHaveLength(1);
    expect(monitorStateSchema.safeParse({ ...first, owner: "invalid" }).success).toBe(false);
    expect(monitorStateSchema.safeParse({ ...first, arbitraryText: "private" }).success).toBe(false);
  });
});
describe("server Slack transport boundary", () => {
  it("accepts only dedicated HTTPS Slack incoming webhook endpoints", () => {
    expect(monitorWebhook("https://hooks.slack.com/services/T123/B456/abcdefgh")).not.toBeNull();
    for (const value of [undefined, "https://evil.invalid/services/T1/B2/abc", "http://hooks.slack.com/services/T1/B2/abc", "https://hooks.slack.com.evil.invalid/services/T1/B2/abc", "https://hooks.slack.com/services/T1/B2/abc?secret=1", "https://user:pass@hooks.slack.com/services/T1/B2/abc", "https://hooks.slack.com:444/services/T1/B2/abc", "https://hooks.slack.com/services/T1/B2/abc#x"])
      expect(monitorWebhook(value)).toBeNull();
  });
  it("renders fixed incident codes without customer bodies, URLs or raw errors", () => {
    const s = snapshot({ codeRevision: "not-a-sha?secret=private", complete: false, metrics: { pending: 2 } });
    const text = monitorSlackText(s, [{ code: "effect_uncertain", count: 2, severity: "critical", change: "opened", at }]);
    expect(text).toContain("non vérifié"); expect(text).toContain("collecte partielle"); expect(text).toContain("effect_uncertain");
    expect(text).not.toContain("private"); expect(text).not.toContain("secret");
  });
});
