/** SAV-77: business measures of intake, separate from technical success. Pure: the caller
 * supplies the dossiers and the audited pause changes; nothing here reads production. */

export type IntakeMeasureOutcome =
  /** Ticket created or linked by the agent, every required effect confirmed, no human command. */
  | "autonomous_confirmed"
  /** Acknowledgement completed by the agent: no ticket effect. */
  | "acknowledgement_completed"
  /** The team handled the dossier itself (outside Studio, manual classification, human command). */
  | "operator_catchup"
  /** The agent asked a person to decide (to_validate). */
  | "human_validation"
  /** A known, expected wait: scheduled retry, budget deferral, administrative pause. */
  | "expected_wait"
  /** Blocked: attempts exhausted, invalid input, technical wait past the threshold. */
  | "technical_failure"
  /** An external effect is dispatched but not confirmed. Never counted as success. */
  | "uncertain_effect"
  | "not_started";
export const INTAKE_MEASURE_OUTCOMES: readonly IntakeMeasureOutcome[] = ["autonomous_confirmed", "acknowledgement_completed", "operator_catchup", "human_validation", "expected_wait", "technical_failure", "uncertain_effect", "not_started"];
export type IntakeMeasureDossier = {
  threadId: string;
  /** Inbound messages of the dossier inside the period. noise: auto-reply, notification, Other, internal copy. */
  messages: { id: string; receivedAt: string; noise?: boolean }[];
  outcome: IntakeMeasureOutcome;
  /** Confirmed external effects only (read-back verified), never planned or dispatched ones. */
  confirmedEffects: number;
  /** When the outcome was reached (confirmation, operator action); null if not reached or unknown. */
  outcomeAt?: string | null;
};
export type IntakePauseChange = { at: string; previousLevel: string; nextLevel: string };
export type IntakePauseInterval = { from: string | null; to: string | null; level: "actions_paused" | "fully_paused" };
export type IntakeMeasureRate = { numerator: number; denominator: number; value: number | null };

const paused = (level: string) => level === "actions_paused" || level === "fully_paused" || level === "invalid";
/** Audited changes, oldest first. A pause already active before the first audited change has an
 * unknown start (from: null); one still active has no end (to: null). No time is invented. */
export function intakePauseIntervals(changes: readonly IntakePauseChange[]): IntakePauseInterval[] {
  const ordered = [...changes].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const intervals: IntakePauseInterval[] = [];
  let open: IntakePauseInterval | null = ordered.length && paused(ordered[0].previousLevel)
    ? { from: null, to: null, level: ordered[0].previousLevel === "actions_paused" ? "actions_paused" : "fully_paused" } : null;
  for (const change of ordered) {
    if (open) { open.to = change.at; intervals.push(open); open = null; }
    if (paused(change.nextLevel)) open = { from: change.at, to: null, level: change.nextLevel === "actions_paused" ? "actions_paused" : "fully_paused" };
  }
  if (open) intervals.push(open);
  return intervals;
}
/** null: the pause state at this instant cannot be established from the supplied changes. */
export function intakePausedAt(intervals: readonly IntakePauseInterval[] | null, at: string): boolean | null {
  if (!intervals) return null;
  const t = Date.parse(at);
  for (const i of intervals) {
    if (i.from === null && (i.to === null || t < Date.parse(i.to))) return null;
    if (i.from !== null && t >= Date.parse(i.from) && (i.to === null || t < Date.parse(i.to))) return true;
  }
  return false;
}
const rate = (numerator: number, denominator: number): IntakeMeasureRate => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
const counts = (rows: readonly IntakeMeasureDossier[]) => Object.fromEntries(INTAKE_MEASURE_OUTCOMES.map(o => [o, rows.filter(r => r.outcome === o).length])) as Record<IntakeMeasureOutcome, number>;

/** A dossier is one thread: repeated messages of the same case are one dossier, never
 * independent cases. A dossier whose every message is noise is excluded from SAV rates.
 * Dossiers that arrived during a pause form their own cohort; their catch-up after the
 * explicit resume is measured apart and never counted as failures of the running agent. */
export function measureSavIntake(input: { period: { from: string; to: string }; dossiers: readonly IntakeMeasureDossier[]; pauses: readonly IntakePauseInterval[] | null }) {
  const from = Date.parse(input.period.from), to = Date.parse(input.period.to);
  const inPeriod = (at: string) => Date.parse(at) >= from && Date.parse(at) < to;
  const limits: string[] = [];
  const seen = new Set<string>();
  const dossiers = input.dossiers.filter(d => { if (seen.has(d.threadId)) { limits.push("duplicate_dossier_ignored"); return false; } seen.add(d.threadId); return true; })
    .map(d => ({ ...d, messages: d.messages.filter(m => inPeriod(m.receivedAt)) })).filter(d => d.messages.length);
  const messages = dossiers.flatMap(d => d.messages), noise = messages.filter(m => m.noise);
  const sav = dossiers.filter(d => d.messages.some(m => !m.noise));
  const first = (d: IntakeMeasureDossier) => d.messages.filter(m => !m.noise).map(m => m.receivedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const cohort = sav.map(d => ({ d, paused: intakePausedAt(input.pauses, first(d)) }));
  const running = cohort.filter(c => c.paused === false).map(c => c.d), pausedCohort = cohort.filter(c => c.paused === true).map(c => c.d);
  const unknown = cohort.filter(c => c.paused === null).map(c => c.d);
  if (!input.pauses) limits.push("pause_boundaries_unknown");
  else if (unknown.length) limits.push("pause_start_unknown");
  // A decided dossier ends in a business outcome; expected waits and not-started ones are not judged yet.
  const decided = (rows: readonly IntakeMeasureDossier[]) => rows.filter(d => !["expected_wait", "not_started"].includes(d.outcome));
  const runningDecided = decided(running);
  const lastResume = input.pauses?.filter(i => i.to !== null).map(i => i.to!).sort().at(-1) ?? null;
  return {
    period: input.period,
    denominators: { messages: messages.length, noiseMessages: noise.length, savMessages: messages.length - noise.length,
      dossiers: sav.length, noiseOnlyDossiers: dossiers.length - sav.length, confirmedEffects: sav.reduce((n, d) => n + d.confirmedEffects, 0) },
    running: { dossiers: running.length, outcomes: counts(running),
      autonomousRate: rate(running.filter(d => d.outcome === "autonomous_confirmed").length, runningDecided.length),
      operatorCatchupRate: rate(running.filter(d => d.outcome === "operator_catchup").length, runningDecided.length),
      technicalFailureRate: rate(running.filter(d => d.outcome === "technical_failure").length, runningDecided.length) },
    pausedCohort: { dossiers: pausedCohort.length, outcomes: counts(pausedCohort), lastResumeAt: lastResume,
      // Caught up = reached a business outcome after the explicit resume, by the agent or the team.
      caughtUpAfterResume: lastResume ? pausedCohort.filter(d => d.outcomeAt && Date.parse(d.outcomeAt) >= Date.parse(lastResume) && !["expected_wait", "not_started", "technical_failure"].includes(d.outcome)).length : null },
    unknownCohort: { dossiers: unknown.length, outcomes: counts(unknown) },
    limits: [...new Set(limits)],
  };
}
