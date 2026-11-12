import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelfSchedulerJobRecord, SelfSchedulerSignals } from "./self-scheduler-store";

// In-memory double of the store with the same contract: one claim at a time per key (the advisory lock), the decision
// sees the current record and signals, a run takes the lease. The PGlite test of the real store is self-scheduler-store.test.ts.
const s = vi.hoisted(() => ({
  records: new Map<string, SelfSchedulerJobRecord>(),
  signals: { pulse: null, monitorObservedAt: null, watchExpirations: [], catchUpPulseId: null } as SelfSchedulerSignals,
  chain: Promise.resolve() as Promise<unknown>,
  claims: 0, switchOn: true, beat: vi.fn(), pass: vi.fn(), v2: vi.fn(), monitor: vi.fn(), renew: vi.fn(), purge: vi.fn(),
}));
vi.mock("./self-scheduler-store", () => ({
  claimSelfSchedulerJob: (input: { job: string; owner: string; trigger: string; now: Date; leaseMs: number; pulseId?: string;
    decide: (r: SelfSchedulerJobRecord | null, g: SelfSchedulerSignals, n: number) => { run: boolean; reason?: string } }) => {
    s.claims++;
    const next = s.chain.then(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (!s.switchOn) return { run: false, reason: "switch_off" }; // the store re-reads the database switch at every claim
      const record = s.records.get(input.job) ?? null, decision = input.decide(record, s.signals, input.now.getTime());
      if (decision.run) s.records.set(input.job, { ...(record ?? { lastFinishedAt: null, lastStatus: null, lastPulseId: null }), owner: input.owner,
        leaseUntil: new Date(input.now.getTime() + input.leaseMs).toISOString(), lastStartedAt: input.now.toISOString(), lastTrigger: input.trigger,
        lastStatus: "running", ...(input.pulseId ? { lastPulseId: input.pulseId } : {}) });
      return decision;
    });
    s.chain = next.catch(() => undefined);
    return next;
  },
  finishSelfSchedulerJob: async (input: { job: string; owner: string; status: string; now: Date }) => {
    const record = s.records.get(input.job);
    if (record?.owner === input.owner) s.records.set(input.job, { ...record, leaseUntil: input.now.toISOString(), lastStatus: input.status });
  },
  beatSavHeartbeat: s.beat,
}));
vi.mock("./reconcile-pass", () => ({ runSavReconcilePass: s.pass }));
vi.mock("./v2-effects-pass", () => ({ runSavV2EffectsPass: s.v2 }));
vi.mock("./monitor", () => ({ runSavServerMonitor: s.monitor }));
vi.mock("./gmail", () => ({ renewActiveGmailWatches: s.renew }));
vi.mock("@/memory/service", () => ({ purgeExpiredMemory: s.purge }));
import { decideCatchUp, decideMonitor, decideRetention, decideV2Effects, decideWatchRenewal, maybeRenewGmailWatch, maybeRunCatchUp, maybeRunMemoryRetention,
  maybeRunMonitor, maybeRunV2Effects, runSavHeartbeatTick, runSavSelfSchedulerFromWebhook, savSelfSchedulerDisabled, SELF_SCHEDULER_TIMING } from "./self-scheduler";

const NOW = Date.parse("2026-11-11T12:00:00.000Z"), MIN = 60_000, HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const signals = (patch: Partial<SelfSchedulerSignals> = {}): SelfSchedulerSignals => ({ pulse: null, monitorObservedAt: null, watchExpirations: [], catchUpPulseId: null, ...patch });
const record = (patch: Partial<SelfSchedulerJobRecord> = {}): SelfSchedulerJobRecord => ({ owner: "o", leaseUntil: null, lastStartedAt: null, lastTrigger: null, lastPulseId: null, lastFinishedAt: null, lastStatus: null, ...patch });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); vi.stubEnv("VERCEL_ENV", "production");
  s.records.clear(); s.signals = signals(); s.chain = Promise.resolve(); s.claims = 0; s.switchOn = true;
  for (const fn of [s.beat, s.pass, s.v2, s.monitor, s.renew, s.purge]) fn.mockReset();
  s.v2.mockResolvedValue({ payload: { caseEffects: { status: "ok", durationMs: 0, data: {} } }, hasStepFailure: false, pulseId: "v" });
  s.pass.mockResolvedValue({ payload: {}, hasStepFailure: false, pulseId: "p" }); s.monitor.mockResolvedValue({ complete: true });
  s.renew.mockResolvedValue([{}]); s.purge.mockResolvedValue({ ok: true }); s.beat.mockResolvedValue({ alive: true });
  vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("staleness decisions", () => {
  it("catch-up: a pulse started less than 12 min ago keeps the fallback idle; older (or none) runs one pass", () => {
    expect(decideCatchUp(null, signals({ pulse: { id: "cron", startedAt: iso(NOW - 4 * MIN) } }), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideCatchUp(null, signals({ pulse: { id: "cron", startedAt: iso(NOW - 11 * MIN) } }), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideCatchUp(null, signals({ pulse: { id: "cron", startedAt: iso(NOW - 12 * MIN) } }), NOW)).toEqual({ run: true });
    expect(decideCatchUp(null, signals(), NOW)).toEqual({ run: true });
    // The fallback's own last start counts too, even if its pulse write was lost.
    expect(decideCatchUp(record({ lastStartedAt: iso(NOW - 2 * MIN) }), signals(), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideCatchUp(record({ leaseUntil: iso(NOW + MIN) }), signals(), NOW)).toEqual({ run: false, reason: "leased" });
  });
  it("monitor: a snapshot observed less than 10 min ago keeps it idle", () => {
    expect(decideMonitor(null, signals({ monitorObservedAt: iso(NOW - 5 * MIN) }), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideMonitor(null, signals({ monitorObservedAt: iso(NOW - 11 * MIN) }), NOW)).toEqual({ run: true });
  });
  it("watch: renews only when less than 48 h remain or the expiration is unknown, at most once an hour", () => {
    expect(decideWatchRenewal(null, signals({ watchExpirations: [iso(NOW + 6 * 24 * HOUR)] }), NOW)).toEqual({ run: false, reason: "watch_valid" });
    expect(decideWatchRenewal(null, signals({ watchExpirations: [iso(NOW + 49 * HOUR)] }), NOW)).toEqual({ run: false, reason: "watch_valid" });
    expect(decideWatchRenewal(null, signals({ watchExpirations: [iso(NOW + 47 * HOUR)] }), NOW)).toEqual({ run: true });
    expect(decideWatchRenewal(null, signals({ watchExpirations: [iso(NOW - HOUR)] }), NOW)).toEqual({ run: true });
    expect(decideWatchRenewal(null, signals({ watchExpirations: [iso(NOW + 6 * 24 * HOUR), null] }), NOW)).toEqual({ run: true });
    expect(decideWatchRenewal(null, signals({ watchExpirations: [] }), NOW)).toEqual({ run: true });
    expect(decideWatchRenewal(record({ lastStartedAt: iso(NOW - 30 * MIN) }), signals({ watchExpirations: [null] }), NOW)).toEqual({ run: false, reason: "attempted_within_hour" });
    expect(decideWatchRenewal(record({ lastStartedAt: iso(NOW - 61 * MIN) }), signals({ watchExpirations: [null] }), NOW)).toEqual({ run: true });
  });
  it("retention: idle while the cron's pulse is fresh; daily while the current pulse is stale or the fallback's own", () => {
    expect(decideRetention(null, signals({ pulse: { id: "cron", startedAt: iso(NOW - 3 * MIN) } }), NOW)).toEqual({ run: false, reason: "scheduler_healthy" });
    expect(decideRetention(null, signals({ pulse: { id: "cron", startedAt: iso(NOW - 30 * MIN) } }), NOW)).toEqual({ run: true });
    expect(decideRetention(null, signals({ pulse: { id: "mine", startedAt: iso(NOW - 3 * MIN) }, catchUpPulseId: "mine" }), NOW)).toEqual({ run: true });
    expect(decideRetention(record({ lastStartedAt: iso(NOW - 23 * HOUR) }), signals(), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideRetention(record({ lastStartedAt: iso(NOW - 25 * HOUR) }), signals(), NOW)).toEqual({ run: true });
  });
});

describe("5-min fallback cadence (12/11)", () => {
  const own = (pulseId: string, minutes: number) => ({ rec: record({ lastStartedAt: iso(NOW - minutes * MIN), lastPulseId: pulseId }),
    sig: signals({ pulse: { id: pulseId, startedAt: iso(NOW - minutes * MIN + 1000) }, catchUpPulseId: pulseId }) });
  it("timing: the fallback's own sav-reconcile pass every tick (4 min sleep), v2 every second tick, cron thresholds unchanged", () => {
    expect(SELF_SCHEDULER_TIMING).toMatchObject({ catchUpStaleMs: 12 * MIN, catchUpOwnIntervalMs: 3.5 * MIN, v2EffectsStaleMs: 12 * MIN,
      v2EffectsOwnIntervalMs: 7.5 * MIN, monitorStaleMs: 10 * MIN, heartbeatStaleMs: 15 * MIN });
    // One heartbeat tick is at least the 4 min sleep: the own interval is below one tick, two ticks clear the v2 one.
    expect(SELF_SCHEDULER_TIMING.catchUpOwnIntervalMs).toBeLessThan(4 * MIN);
    expect(SELF_SCHEDULER_TIMING.v2EffectsOwnIntervalMs).toBeGreaterThan(4 * MIN);
    expect(SELF_SCHEDULER_TIMING.v2EffectsOwnIntervalMs).toBeLessThan(8 * MIN);
  });
  it("catch-up: after its own pass the fallback runs again after 3.5 min (about every 5 min), not 12", () => {
    let o = own("mine", 3); expect(decideCatchUp(o.rec, o.sig, NOW)).toEqual({ run: false, reason: "fresh" });
    o = own("mine", 4); expect(decideCatchUp(o.rec, o.sig, NOW)).toEqual({ run: true });
    o = own("mine", 5); expect(decideCatchUp(o.rec, o.sig, NOW)).toEqual({ run: true });
    // Its own pulse recognised by the shared catch-up pulse id alone (record write lost) counts as its own, too.
    expect(decideCatchUp(null, signals({ pulse: { id: "mine", startedAt: iso(NOW - 4 * MIN) }, catchUpPulseId: "mine" }), NOW)).toEqual({ run: true });
    // The lease still forbids a second pass while one runs.
    expect(decideCatchUp(record({ leaseUntil: iso(NOW + MIN), lastStartedAt: iso(NOW - 10 * MIN), lastPulseId: "mine" }), own("mine", 10).sig, NOW)).toEqual({ run: false, reason: "leased" });
  });
  it("catch-up: a cron pulse younger than 12 min still keeps the fallback idle (no overlap with a healthy cron), even when the fallback's own pass is old", () => {
    const rec = record({ lastStartedAt: iso(NOW - 30 * MIN), lastPulseId: "mine" });
    expect(decideCatchUp(rec, signals({ pulse: { id: "cron", startedAt: iso(NOW - 4 * MIN) }, catchUpPulseId: "mine" }), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideCatchUp(rec, signals({ pulse: { id: "cron", startedAt: iso(NOW - 11 * MIN) }, catchUpPulseId: "mine" }), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideCatchUp(rec, signals({ pulse: { id: "cron", startedAt: iso(NOW - 12 * MIN) }, catchUpPulseId: "mine" }), NOW)).toEqual({ run: true });
  });
  it("v2-effects: its own pass again after 7.5 min (every second tick, about 10 min); a cron pulse under 12 min keeps it idle", () => {
    const mine = (minutes: number) => [record({ lastStartedAt: iso(NOW - minutes * MIN), lastPulseId: "v2-mine" }),
      signals({ v2EffectsPulse: { id: "v2-mine", startedAt: iso(NOW - minutes * MIN + 1000) } })] as const;
    expect(decideV2Effects(...mine(5), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideV2Effects(...mine(8), NOW)).toEqual({ run: true });
    expect(decideV2Effects(record({ lastStartedAt: iso(NOW - 30 * MIN), lastPulseId: "v2-mine" }), signals({ v2EffectsPulse: { id: "cron-v2", startedAt: iso(NOW - 9 * MIN) } }), NOW))
      .toEqual({ run: false, reason: "fresh" });
  });
  it("runs: two heartbeat ticks 5 min apart give two sav-reconcile passes; a concurrent claim while leased gives none", async () => {
    s.signals = signals();
    expect(await maybeRunCatchUp("heartbeat_workflow")).toMatchObject({ status: "ran" });
    const first = s.records.get("sav-reconcile")!;
    s.signals = signals({ pulse: { id: first.lastPulseId!, startedAt: first.lastStartedAt! }, catchUpPulseId: first.lastPulseId });
    vi.setSystemTime(NOW + 5 * MIN);
    expect(await maybeRunCatchUp("heartbeat_workflow")).toMatchObject({ status: "ran" });
    expect(s.pass).toHaveBeenCalledTimes(2);
    s.records.set("sav-reconcile", { ...s.records.get("sav-reconcile")!, leaseUntil: iso(NOW + 11 * MIN) });
    vi.setSystemTime(NOW + 10 * MIN);
    expect(await maybeRunCatchUp("heartbeat_workflow")).toEqual({ job: "sav-reconcile", status: "skipped", reason: "leased" });
    expect(s.pass).toHaveBeenCalledTimes(2);
  });
});

describe("runs", () => {
  it("fresh pulse: no pass; stale pulse: exactly one pass, with the fallback's trigger, budget and pulse id", async () => {
    s.signals = signals({ pulse: { id: "cron", startedAt: iso(NOW - 4 * MIN) } });
    expect(await maybeRunCatchUp("heartbeat_workflow")).toEqual({ job: "sav-reconcile", status: "skipped", reason: "fresh" });
    expect(s.pass).not.toHaveBeenCalled();
    s.signals = signals({ pulse: { id: "cron", startedAt: iso(NOW - 25 * MIN) } });
    expect(await maybeRunCatchUp("heartbeat_workflow")).toEqual({ job: "sav-reconcile", status: "ran", reason: "ok" });
    expect(s.pass).toHaveBeenCalledTimes(1);
    const [options] = s.pass.mock.calls[0];
    expect(options).toMatchObject({ trigger: "heartbeat_workflow", budgetMs: 270_000 });
    expect(s.records.get("sav-reconcile")).toMatchObject({ lastPulseId: options.pulseId, lastTrigger: "heartbeat_workflow", lastStatus: "ok", leaseUntil: iso(NOW) });
    expect(await maybeRunCatchUp("gmail_webhook")).toEqual({ job: "sav-reconcile", status: "skipped", reason: "fresh" });
    expect(s.pass).toHaveBeenCalledTimes(1);
  });
  it("single-flight: two concurrent triggers (webhook and heartbeat) give one pass", async () => {
    s.signals = signals({ pulse: { id: "cron", startedAt: iso(NOW - 25 * MIN) } });
    let release!: () => void;
    s.pass.mockImplementation(() => new Promise(resolve => { release = () => resolve({ payload: {}, hasStepFailure: false, pulseId: "p" }); }));
    const first = maybeRunCatchUp("gmail_webhook"), second = maybeRunCatchUp("heartbeat_workflow");
    expect(await second).toEqual({ job: "sav-reconcile", status: "skipped", reason: "leased" });
    release();
    expect(await first).toMatchObject({ status: "ran" });
    expect(s.claims).toBe(2); expect(s.pass).toHaveBeenCalledTimes(1);
    expect(s.pass.mock.calls[0][0]).toMatchObject({ trigger: "gmail_webhook", budgetMs: 250_000 });
  });
  it("kill switch: SAV_SELF_SCHEDULER_DISABLED=1 reads and runs nothing", async () => {
    vi.stubEnv("SAV_SELF_SCHEDULER_DISABLED", "1");
    expect(savSelfSchedulerDisabled()).toBe(true);
    for (const run of [maybeRunCatchUp, maybeRunV2Effects, maybeRenewGmailWatch, maybeRunMonitor, maybeRunMemoryRetention]) expect(await run("heartbeat_workflow")).toMatchObject({ status: "disabled" });
    expect(await runSavSelfSchedulerFromWebhook({ ensureHeartbeat: s.beat })).toEqual({ status: "disabled" });
    expect(await runSavHeartbeatTick("owner")).toEqual({ alive: false, reason: "disabled" });
    expect(s.claims).toBe(0);
    for (const fn of [s.beat, s.pass, s.v2, s.monitor, s.renew, s.purge]) expect(fn).not.toHaveBeenCalled();
    vi.stubEnv("SAV_SELF_SCHEDULER_DISABLED", "0"); expect(savSelfSchedulerDisabled()).toBe(false);
    vi.stubEnv("SAV_SELF_SCHEDULER_DISABLED", ""); expect(savSelfSchedulerDisabled()).toBe(false);
  });
  it("watch renewal: calls the cron's renewal only under the 48 h threshold", async () => {
    s.signals = signals({ watchExpirations: [iso(NOW + 5 * 24 * HOUR)] });
    expect(await maybeRenewGmailWatch("gmail_webhook")).toMatchObject({ status: "skipped", reason: "watch_valid" });
    s.signals = signals({ watchExpirations: [iso(NOW + 20 * HOUR)] });
    expect(await maybeRenewGmailWatch("gmail_webhook")).toEqual({ job: "gmail-watch", status: "ran", reason: "renewed_1" });
    expect(s.renew).toHaveBeenCalledTimes(1);
    s.signals = signals({ watchExpirations: [iso(NOW + 20 * HOUR)] }); // renewal failed to move it: not before an hour
    expect(await maybeRenewGmailWatch("heartbeat_workflow")).toMatchObject({ status: "skipped", reason: "attempted_within_hour" });
  });
  it("a failing job is logged, releases its lease and never throws", async () => {
    s.signals = signals({ watchExpirations: [null] });
    s.renew.mockRejectedValue(Error("GMAIL_HTTP_500"));
    expect(await maybeRenewGmailWatch("gmail_webhook")).toEqual({ job: "gmail-watch", status: "error", reason: "GMAIL_HTTP_500" });
    expect(s.records.get("gmail-watch")).toMatchObject({ lastStatus: "error", leaseUntil: iso(NOW) });
  });
  it("the webhook entry never rejects, even when every dependency throws", async () => {
    s.pass.mockRejectedValue(Error("boom")); s.v2.mockRejectedValue(Error("boom")); s.monitor.mockRejectedValue(Error("boom")); s.renew.mockRejectedValue(Error("boom")); s.purge.mockRejectedValue(Error("boom"));
    const result = await runSavSelfSchedulerFromWebhook({ ensureHeartbeat: async () => { throw Error("workflow down"); } });
    expect(result.status).toBe("checked");
    expect(s.pass).toHaveBeenCalledTimes(1); expect(s.v2).toHaveBeenCalledTimes(1); expect(s.monitor).toHaveBeenCalledTimes(1);
  });
  it("heartbeat tick: a superseded run stops without running anything; a live one runs the light checks", async () => {
    s.beat.mockResolvedValue({ alive: false, reason: "superseded" });
    expect(await runSavHeartbeatTick("old-owner")).toEqual({ alive: false, reason: "superseded" });
    expect(s.claims).toBe(0);
    s.beat.mockResolvedValue({ alive: true });
    s.signals = signals({ pulse: { id: "cron", startedAt: iso(NOW - MIN) }, monitorObservedAt: iso(NOW - MIN), watchExpirations: [iso(NOW + 6 * 24 * HOUR)] });
    expect(await runSavHeartbeatTick("owner")).toEqual({ alive: true, results: [
      { job: "gmail-watch", status: "skipped", reason: "watch_valid" }, { job: "sav-monitor", status: "skipped", reason: "fresh" },
      { job: "memory-retention", status: "skipped", reason: "scheduler_healthy" }] });
    expect(s.pass).not.toHaveBeenCalled(); expect(s.monitor).not.toHaveBeenCalled(); expect(s.renew).not.toHaveBeenCalled(); expect(s.purge).not.toHaveBeenCalled();
  });
  it("webhook pass budget counts from the request start: 250 s minus elapsed, none under a minute", async () => {
    s.signals = signals({ pulse: { id: "cron", startedAt: iso(NOW - 25 * MIN) } });
    expect(await maybeRunCatchUp("gmail_webhook", { requestStartedAt: NOW - 30_000 })).toMatchObject({ status: "ran" });
    expect(s.pass.mock.calls[0][0]).toMatchObject({ budgetMs: 220_000 });
    s.records.clear();
    expect(await maybeRunCatchUp("gmail_webhook", { requestStartedAt: NOW - 200_000 })).toEqual({ job: "sav-reconcile", status: "skipped", reason: "insufficient_budget" });
    expect(s.pass).toHaveBeenCalledTimes(1);
  });
  it("outside production (preview, local) the webhook path and the heartbeat do nothing, not even a claim", async () => {
    for (const value of ["preview", "development", ""]) {
      vi.stubEnv("VERCEL_ENV", value);
      expect(await runSavSelfSchedulerFromWebhook({ ensureHeartbeat: s.beat })).toEqual({ status: "not_production" });
      expect(await maybeRunCatchUp("gmail_webhook")).toMatchObject({ status: "not_production" });
      expect(await maybeRunV2Effects("gmail_webhook")).toMatchObject({ status: "not_production" });
      expect(await maybeRunV2Effects("heartbeat_workflow")).toMatchObject({ status: "not_production" });
      expect(await runSavHeartbeatTick("owner")).toEqual({ alive: false, reason: "not_production" });
    }
    expect(s.claims).toBe(0);
    for (const fn of [s.beat, s.pass, s.v2, s.monitor, s.renew, s.purge]) expect(fn).not.toHaveBeenCalled();
  });
  it("heartbeat tick: a switched-OFF beat stops the run at this tick and runs nothing", async () => {
    s.beat.mockResolvedValue({ alive: false, reason: "switch_off" });
    expect(await runSavHeartbeatTick("root#3")).toEqual({ alive: false, reason: "switch_off" });
    expect(s.claims).toBe(0);
  });
});

describe("sav-v2-effects fallback (11/11)", () => {
  const v2Fresh = (minutes: number) => signals({ v2EffectsPulse: { id: "cron-v2", startedAt: iso(NOW - minutes * MIN) } });
  it("decision: its own pulse started less than 12 min ago keeps it idle (10-min cadence); older or none runs one pass; sav-reconcile's pulse is not read", () => {
    expect(decideV2Effects(null, v2Fresh(4), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideV2Effects(null, v2Fresh(11), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideV2Effects(null, v2Fresh(12), NOW)).toEqual({ run: true });
    expect(decideV2Effects(null, signals(), NOW)).toEqual({ run: true });
    expect(decideV2Effects(null, signals({ pulse: { id: "cron", startedAt: iso(NOW - MIN) } }), NOW)).toEqual({ run: true });
    expect(decideV2Effects(record({ lastStartedAt: iso(NOW - 2 * MIN) }), signals(), NOW)).toEqual({ run: false, reason: "fresh" });
    expect(decideV2Effects(record({ leaseUntil: iso(NOW + MIN) }), signals(), NOW)).toEqual({ run: false, reason: "leased" });
  });
  it("fresh pulse: no pass; stale pulse: exactly one pass of the cron's function, with the fallback's trigger, budget and pulse id", async () => {
    s.signals = v2Fresh(4);
    expect(await maybeRunV2Effects("heartbeat_workflow")).toEqual({ job: "sav-v2-effects", status: "skipped", reason: "fresh" });
    expect(s.v2).not.toHaveBeenCalled();
    s.signals = v2Fresh(25);
    expect(await maybeRunV2Effects("heartbeat_workflow")).toEqual({ job: "sav-v2-effects", status: "ran", reason: "ok" });
    expect(s.v2).toHaveBeenCalledTimes(1);
    const [options] = s.v2.mock.calls[0];
    expect(options).toMatchObject({ trigger: "heartbeat_workflow", budgetMs: 270_000 });
    expect(s.records.get("sav-v2-effects")).toMatchObject({ lastPulseId: options.pulseId, lastTrigger: "heartbeat_workflow", lastStatus: "ok", leaseUntil: iso(NOW) });
    expect(await maybeRunV2Effects("gmail_webhook")).toEqual({ job: "sav-v2-effects", status: "skipped", reason: "fresh" });
    expect(s.v2).toHaveBeenCalledTimes(1); expect(s.pass).not.toHaveBeenCalled();
  });
  it("a failed pass is recorded as step_failure and releases its lease", async () => {
    s.v2.mockResolvedValue({ payload: { caseEffects: { status: "error", durationMs: 1, errorCode: "X" } }, hasStepFailure: true, pulseId: "v" });
    expect(await maybeRunV2Effects("heartbeat_workflow")).toEqual({ job: "sav-v2-effects", status: "ran", reason: "step_failure" });
    expect(s.records.get("sav-v2-effects")).toMatchObject({ lastStatus: "step_failure", leaseUntil: iso(NOW) });
  });
  it("single-flight: two concurrent triggers (webhook and heartbeat) give one pass", async () => {
    s.signals = v2Fresh(25);
    let release!: () => void;
    s.v2.mockImplementation(() => new Promise(resolve => { release = () => resolve({ payload: {}, hasStepFailure: false, pulseId: "v" }); }));
    const first = maybeRunV2Effects("gmail_webhook"), second = maybeRunV2Effects("heartbeat_workflow");
    expect(await second).toEqual({ job: "sav-v2-effects", status: "skipped", reason: "leased" });
    release();
    expect(await first).toMatchObject({ status: "ran" });
    expect(s.claims).toBe(2); expect(s.v2).toHaveBeenCalledTimes(1);
    expect(s.v2.mock.calls[0][0]).toMatchObject({ trigger: "gmail_webhook", budgetMs: 250_000 });
  });
  it("switch OFF (absent row): nothing runs, from the webhook or the heartbeat", async () => {
    s.switchOn = false; s.signals = v2Fresh(60);
    expect(await maybeRunV2Effects("heartbeat_workflow")).toEqual({ job: "sav-v2-effects", status: "skipped", reason: "switch_off" });
    expect(await maybeRunV2Effects("gmail_webhook")).toEqual({ job: "sav-v2-effects", status: "skipped", reason: "switch_off" });
    const webhook = await runSavSelfSchedulerFromWebhook();
    expect(webhook).toMatchObject({ status: "checked" });
    expect((webhook as { results: { job: string; status: string; reason?: string }[] }).results.find(r => r.job === "sav-v2-effects")).toEqual({ job: "sav-v2-effects", status: "skipped", reason: "switch_off" });
    expect(s.v2).not.toHaveBeenCalled(); expect(s.pass).not.toHaveBeenCalled();
  });
  it("non-production: nothing, not even a claim", async () => {
    vi.stubEnv("VERCEL_ENV", "preview"); s.signals = v2Fresh(60);
    expect(await maybeRunV2Effects("heartbeat_workflow")).toEqual({ job: "sav-v2-effects", status: "not_production" });
    expect(s.claims).toBe(0); expect(s.v2).not.toHaveBeenCalled();
  });
  it("webhook: runs beside the catch-up within the webhook's deadline, none under a minute", async () => {
    s.signals = v2Fresh(25);
    const result = await runSavSelfSchedulerFromWebhook({ requestStartedAt: NOW - 30_000 });
    expect((result as { results: { job: string }[] }).results.map(r => r.job)).toEqual(["gmail-watch", "sav-reconcile", "sav-v2-effects", "sav-monitor", "memory-retention"]);
    expect(s.v2).toHaveBeenCalledTimes(1); expect(s.v2.mock.calls[0][0]).toMatchObject({ trigger: "gmail_webhook", budgetMs: 220_000 });
    s.records.clear();
    expect(await maybeRunV2Effects("gmail_webhook", { requestStartedAt: NOW - 200_000 })).toEqual({ job: "sav-v2-effects", status: "skipped", reason: "insufficient_budget" });
    expect(s.v2).toHaveBeenCalledTimes(1);
  });
});
