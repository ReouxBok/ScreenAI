import { savDerivedCostQuote } from "../derived-budget";
export const SAV_INTAKE_OPERATIONAL_PROFILE = "operational_utc_v1" as const;
export const SAV_INTAKE_DAY_MS = 86_400_000;
export type IntakeBudgetPins = { budgetProfile?: typeof SAV_INTAKE_OPERATIONAL_PROFILE; maxNanoUsd: number; maxCalls: number; maxRollingNanoUsd?: number };
export type IntakeBudgetRow = { state: string; chargedNanoUsd: number; createdAt: Date };
/** All ledger rows participate, regardless of configuration, policy or mailbox.
 * Unknown cost carries its entire reservation into BOTH current margins forever
 * until verified settlement. It is counted once in each margin, never refunded. */
export function intakeBudgetUsage(rows: IntakeBudgetRow[], config: IntakeBudgetPins, now = new Date()) {
  if (!Number.isFinite(now.getTime()) || now.getTime() > Date.now()
    || rows.some(row => !Number.isFinite(row.createdAt.getTime()) || row.createdAt > now)) throw Error("SAV_INTAKE_RUNTIME_LEDGER_CLOCK_REJECTED");
  const day = Date.parse(now.toISOString().slice(0,10) + "T00:00:00.000Z"), rolling = now.getTime() - 30 * SAV_INTAKE_DAY_MS;
  const operational = config.budgetProfile === SAV_INTAKE_OPERATIONAL_PROFILE;
  const dailyRows = operational ? rows.filter(row => row.state !== "settled" || row.createdAt.getTime() >= day) : rows;
  const rollingRows = operational ? rows.filter(row => row.state !== "settled" || row.createdAt.getTime() >= rolling) : rows;
  const sum = (items: IntakeBudgetRow[]) => items.reduce((total,row) => total + row.chargedNanoUsd,0);
  const chargedNanoUsd = sum(dailyRows), rollingChargedNanoUsd = sum(rollingRows);
  return { profile: operational ? SAV_INTAKE_OPERATIONAL_PROFILE : "qualification_lifetime", maxNanoUsd:config.maxNanoUsd, maxCalls:config.maxCalls,
    chargedNanoUsd, callCount:dailyRows.length, remainingNanoUsd:Math.max(0,config.maxNanoUsd-chargedNanoUsd), remainingCalls:Math.max(0,config.maxCalls-dailyRows.length),
    maxRollingNanoUsd:operational ? config.maxRollingNanoUsd! : config.maxNanoUsd, rollingChargedNanoUsd,
    remainingRollingNanoUsd:Math.max(0,(operational ? config.maxRollingNanoUsd! : config.maxNanoUsd)-rollingChargedNanoUsd),
    lifetimeChargedNanoUsd:sum(rows), lifetimeCallCount:rows.length, uncertain:rows.some(row=>row.state!=="settled") };
}
/** Initial ingestion frontier is independent from this explicitly approved term.
 * Pricing validity can shorten the maximum30day authority; it cannot extend it. */
export function intakeOperationalTermValid(expiresAt: string, now = new Date()) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(now.getTime()) || now.getTime()>Date.now() || expiry<=now.getTime() || expiry-now.getTime()>30*SAV_INTAKE_DAY_MS) return false;
  try { return expiry<=Date.parse(savDerivedCostQuote("gemini-3.6-flash",8192,now).priceExpiresAt); } catch { return false; }
}
export function intakeAdmissionUsage(rows: Array<{createdAt:Date}>, operational: boolean, now = new Date()) {
  if (!Number.isFinite(now.getTime()) || now.getTime()>Date.now() || rows.some(row=>!Number.isFinite(row.createdAt.getTime())||row.createdAt>now)) throw Error("SAV_INTAKE_EXECUTION_LEDGER_CLOCK_REJECTED");
  const day=Date.parse(now.toISOString().slice(0,10)+"T00:00:00.000Z");
  return operational ? rows.filter(row=>row.createdAt.getTime()>=day).length : rows.length;
}
