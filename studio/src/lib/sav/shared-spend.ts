import "server-only";
import { inArray, like, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savIntakeModelCalls, savSyncState } from "@/db/schema";

type Tx = Parameters<Parameters<ReturnType<typeof requireDb>["transaction"]>[0]>[0];
/** SAV-92 (Ugo, 14/11): rolling 30-day cap raised from 90 to 200 USD; the daily cap stays 20 USD. */
export const SAV_SHARED_SPEND_CAPS = { dailyNanoUsd: 20_000_000_000, rollingNanoUsd: 200_000_000_000 } as const;
// Reuse intake's lock: V1 remains compatible, V2 and the other durable monetary
// reservers join it. Check and canonical insertion MUST share this transaction.
export async function lockSavSharedSpend(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-runtime-model-budget-v1'))`);
}
const invalid = (): never => { throw Error("SAV_SHARED_SPEND_HISTORY_INVALID"); };
function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function add(a: number, b: number) { return amount(a + b); }
export type SharedSpendEntry = { at: Date; nanoUsd: number; uncertain: boolean };
export function sharedSpendUsage(entries: SharedSpendEntry[], now: Date) {
  if (!Number.isFinite(now.getTime())) return invalid();
  const day = Date.parse(now.toISOString().slice(0,10)), rolling = now.getTime() - 30 * 86_400_000;
  let dailyNanoUsd = 0, rollingNanoUsd = 0;
  for (const entry of entries) {
    if (!Number.isFinite(entry.at.getTime()) || entry.at > now) return invalid();
    const cost = amount(entry.nanoUsd);
    if (entry.at.getTime() >= day) dailyNanoUsd = add(dailyNanoUsd, cost);
    if (entry.uncertain || entry.at.getTime() >= rolling) rollingNanoUsd = add(rollingNanoUsd, cost);
  }
  return { dailyNanoUsd, rollingNanoUsd };
}
/** No copied ledger and no double counting: each source is read once. Coverage:
 * intake, derived/evaluation monetary audits, V2 model + embedding. Legacy model
 * and shared SAV indexing without monetary receipts are NOT claimed covered. */
export async function readSavSharedSpend(tx: Pick<Tx,"select">, now = new Date()) {
  const entries: SharedSpendEntry[] = [];
  for (const row of await tx.select().from(savIntakeModelCalls)) {
    if (!["dispatched","settled","uncertain"].includes(row.state) || amount(row.chargedNanoUsd) > amount(row.reservedNanoUsd)) return invalid();
    entries.push({ at: row.createdAt, nanoUsd: row.chargedNanoUsd, uncertain: row.state !== "settled" });
  }
  for (const row of await tx.select().from(auditLogs).where(inArray(auditLogs.action,["sav_derived_call_reserved","sav_intake_evaluation_call_v1"]))) {
    const m = row.technicalMetadata;
    // Pre-monetary derived audits cannot be reconstructed. Preserve V1's
    // historical30-day compatibility; do not call this unpriced history covered.
    if (row.action === "sav_derived_call_reserved" && m.reservedNanoUsd === undefined && row.createdAt.getTime() <= now.getTime()-30*86_400_000) continue;
    const held = amount(m.reservedNanoUsd), charged = m.chargedNanoUsd === undefined ? held : amount(m.chargedNanoUsd);
    if (charged > held) return invalid();
    const uncertain = row.action === "sav_derived_call_reserved" ? !m.settledAt || m.chargedNanoUsd === undefined : m.state !== "settled";
    entries.push({ at: row.createdAt, nanoUsd: uncertain ? Math.max(held,charged) : charged, uncertain });
  }
  for (const row of await tx.select().from(savSyncState).where(like(savSyncState.key,"sav-v2-spend.v1:%"))) {
    const key = /^sav-v2-spend\.v1:(model|embedding):(\d{4}-\d{2}-\d{2})$/.exec(row.key);
    if (!key || !row.cursor) return invalid();
    let state: { purpose?: unknown; day?: unknown; settledMicroUsd?: unknown; open?: Record<string,{amount:number}>; done?: Record<string,number>; verifiedUsage?: string[] };
    try { state = JSON.parse(row.cursor); } catch { return invalid(); }
    if (!state || state.purpose !== key[1] || state.day !== key[2] || !state.open || !state.done || Array.isArray(state.open) || Array.isArray(state.done)) return invalid();
    if (state.verifiedUsage !== undefined && (!Array.isArray(state.verifiedUsage) || state.verifiedUsage.some(k=>typeof k!=="string" || state.done![k]===undefined))) return invalid();
    const at = new Date(`${key[2]}T00:00:00.000Z`);
    // V2 stores commitment DAY, not instant: count the whole boundary day in
    // the rolling window rather than undercounting a possible late-day call.
    const rollingDay = now.toISOString().slice(0,10) === key[2] ? at : new Date(at.getTime()+86_400_000-1);
    const committedAt = rollingDay > now ? at : rollingDay;
    let settled = 0;
    for (const [id,cost] of Object.entries(state.done)) {
      settled=add(settled,amount(cost));
      entries.push({at:committedAt,nanoUsd:amount(cost*1000),uncertain:!state.verifiedUsage?.includes(id)});
    }
    if (settled !== amount(state.settledMicroUsd)) return invalid();
    for (const [id,held] of Object.entries(state.open)) {
      if (Object.hasOwn(state.done,id) || !held) return invalid();
      entries.push({at:committedAt,nanoUsd:amount(amount(held.amount)*1000),uncertain:true});
    }
  }
  return sharedSpendUsage(entries,now);
}
export class SavSharedSpendExhaustedError extends Error {
  constructor(readonly limit:"daily_nano_usd"|"rolling_nano_usd") {super("SAV_SHARED_SPEND_BUDGET_EXHAUSTED");}
}
export async function assertSavSharedSpend(tx: Tx, reserveNanoUsd: number, now = new Date()) {
  amount(reserveNanoUsd);
  const used = await readSavSharedSpend(tx,now);
  if (add(used.dailyNanoUsd,reserveNanoUsd)>SAV_SHARED_SPEND_CAPS.dailyNanoUsd) throw new SavSharedSpendExhaustedError("daily_nano_usd");
  if (add(used.rollingNanoUsd,reserveNanoUsd)>SAV_SHARED_SPEND_CAPS.rollingNanoUsd) throw new SavSharedSpendExhaustedError("rolling_nano_usd");
  return used;
}
export async function savSharedSpendAvailable(reserveNanoUsd:number,now=new Date()) {
  try { return await requireDb().transaction(async tx=>{await lockSavSharedSpend(tx);await assertSavSharedSpend(tx,reserveNanoUsd,now);return true;}); } catch { return false; }
}
