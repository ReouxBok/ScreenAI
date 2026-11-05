import { SAV_CASE_INVESTIGATION_RECORD_KIND } from "./investigation-record";

/*
 * Calls per case over a sliding window (P1, decision Ugo 28/10, option c): measured and flagged, never blocking. No
 * value is chosen here: with no threshold the signal only measures, so the value can be picked from real counts. It
 * reads the case's own durable investigation records, so it is a lower bound: a call whose run crashed before its
 * record is counted by the call ledger only. Pure: no database, no clock of its own.
 */

export type CaseCallSignalConfig = { windowHours: number; threshold: number | null };
export type CaseCallSignal = { windowHours: number; calls: number; threshold: number | null; over: boolean | null };

/** Structural view of a pole A case event: only what this reader needs. */
type JournalEvent = { kind: string; createdAt: string; detail: Record<string, unknown> | null };

const validConfig = (config: CaseCallSignalConfig) => Number.isInteger(config.windowHours) && config.windowHours >= 1 && config.windowHours <= 168
  && (config.threshold === null || (Number.isInteger(config.threshold) && config.threshold >= 1 && config.threshold <= 1000));

/** Calls recorded in the window: per input, the highest call count recorded in it minus the highest recorded before it. */
export function caseCallsInWindow(events: readonly JournalEvent[], now: Date, windowHours: number): number {
  const start = now.getTime() - windowHours * 3_600_000;
  const inside = new Map<string, number>(), before = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "observation_recorded") continue;
    const record = event.detail?.record as { kind?: unknown; inputKey?: unknown; progress?: { modelCalls?: unknown } } | undefined;
    const calls = record?.progress?.modelCalls;
    if (record?.kind !== SAV_CASE_INVESTIGATION_RECORD_KIND || typeof record.inputKey !== "string" || typeof calls !== "number") continue;
    // An unreadable recording date counts inside the window: a measure errs towards more calls, never fewer.
    const at = Date.parse(event.createdAt), side = at < start ? before : inside;
    side.set(record.inputKey, Math.max(side.get(record.inputKey) ?? 0, calls));
  }
  let total = 0;
  for (const [input, calls] of inside) total += Math.max(0, calls - (before.get(input) ?? 0));
  return total;
}

/** The signal for a run that adds `callsThisRun`; null when not configured or configured out of bounds. */
export function caseCallSignal(events: readonly JournalEvent[], now: Date, config: CaseCallSignalConfig | undefined, callsThisRun: number): CaseCallSignal | null {
  if (!config || !validConfig(config)) return null;
  const calls = caseCallsInWindow(events, now, config.windowHours) + callsThisRun;
  return { windowHours: config.windowHours, calls, threshold: config.threshold, over: config.threshold === null ? null : calls > config.threshold };
}
