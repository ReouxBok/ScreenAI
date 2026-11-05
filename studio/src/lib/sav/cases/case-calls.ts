import "server-only";
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseCalls, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { savCaseRecordingEnabled, type CaseTx } from "./case-store";

/** Contract v9 §6. A key passed to `dispatched` is never `reserved` again: after a crash past
 * `markSavCaseCallDispatched` the call is `uncertain` until its own token settles it, so the same
 * callKey is paid at most once. B's keys: subjectKey = sav-case:<caseId>:<inputKey>,
 * callKey = <subjectKey>:call<n>. The global dollar budget stays ROOT's check, between `reserved`
 * and `dispatched`; a refusal there is a `release`. */
export const SAV_CASE_CALL_STATES = ["reserved", "dispatched", "settled", "released"] as const;
export type SavCaseCallResult = { status: "ok"; output: unknown } | { status: "failed"; uncertain: boolean };
export type SavCaseCallReservation =
  | { status: "reserved"; token: string; leaseUntil: string }
  | { status: "known"; result: { status: "ok"; output: unknown } | { status: "failed"; uncertain: false } }
  | { status: "uncertain" }
  | { status: "busy"; retryAt: string }
  | { status: "subject_exhausted" };

const fault = (code: string): never => { throw Error(`SAV_CASE_CALL_${code}`); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, CODE = /^[a-z0-9_.-]{1,80}$/;
// B's inputKey, exactly as investigation-record.ts validates it: `in:` or `back:` then a reference.
const CALL_KEY = /^(sav-case:([0-9a-f-]{36}):((?:in|back):[A-Za-z0-9._@<>=+-]{1,200})):call([1-9][0-9]{0,2})$/i;

function parseKeys(input: { callKey: string; subjectKey?: string; caseId?: string }) {
  const call = CALL_KEY.exec(input.callKey);
  if (!call || !UUID.test(call[2]!)) return fault("KEY_INVALID");
  if ((input.subjectKey !== undefined && input.subjectKey !== call[1]) || (input.caseId !== undefined && input.caseId.toLowerCase() !== call[2]!.toLowerCase())) fault("KEY_INVALID");
  return { subjectKey: call[1]!, caseId: call[2]! };
}

async function writable<T>(run: (tx: CaseTx) => Promise<T>, subjectKey: string) {
  if (!savCaseRecordingEnabled()) fault("RECORDING_OFF");
  const db = requireDb();
  const [marker] = await db.select({ key: savSyncState.key }).from(savSyncState).where(eq(savSyncState.key, "sav-case-schema-v5"));
  if (!marker) fault("SCHEMA_MISSING");
  // One lock per subject: the per-subject cap counts keys, and every key belongs to one subject.
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sav-case-call:${subjectKey}`}))`);
    return run(tx);
  });
}

const iso = (value: Date) => value.toISOString();
type Row = typeof savCaseCalls.$inferSelect;
function known(row: Row): SavCaseCallReservation {
  if (row.resultStatus === "ok") return { status: "known", result: { status: "ok", output: decryptSavPayload(row.outputCiphertext!) } };
  return row.resultUncertain ? { status: "uncertain" } : { status: "known", result: { status: "failed", uncertain: false } };
}

export async function reserveSavCaseCall(input: {
  callKey: string; subjectKey: string; caseId: string; caseVersion: number; purpose: string; holder: string; leaseSeconds: number; maxPerSubject?: number; now?: Date;
}): Promise<SavCaseCallReservation> {
  const { subjectKey, caseId } = parseKeys(input);
  if (!Number.isInteger(input.caseVersion) || input.caseVersion < 1) fault("CASE_VERSION_INVALID");
  if (!CODE.test(input.purpose)) fault("PURPOSE_INVALID");
  if (!input.holder || input.holder.length > 200) fault("HOLDER_INVALID");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 900) fault("LEASE_INVALID");
  const max = input.maxPerSubject ?? 3;
  if (!Number.isInteger(max) || max < 1 || max > 20) fault("MAX_INVALID");
  const now = input.now ?? new Date(), leaseUntil = new Date(now.getTime() + input.leaseSeconds * 1000);
  return writable(async tx => {
    const [row] = await tx.select().from(savCaseCalls).where(eq(savCaseCalls.callKey, input.callKey)).for("update");
    if (row && (row.subjectKey !== subjectKey || row.caseId !== caseId || row.purpose !== input.purpose)) fault("KEY_CONFLICT");
    if (row?.state === "settled") return known(row);
    if (row?.state === "dispatched") return { status: "uncertain" };
    if (row?.state === "reserved" && row.leaseUntil! > now) return { status: "busy", retryAt: iso(row.leaseUntil!) };
    // Absent or released: the key does not count yet. Reserved with its lease gone: it counts already.
    if (!row || row.state === "released") {
      const [{ n }] = await tx.select({ n: count() }).from(savCaseCalls).where(and(eq(savCaseCalls.subjectKey, subjectKey), ne(savCaseCalls.state, "released")));
      if (n >= max) return { status: "subject_exhausted" };
    }
    const token = randomUUID(), fresh = { state: "reserved", token, holder: input.holder, caseVersion: input.caseVersion, leaseUntil, updatedAt: now };
    if (row) await tx.update(savCaseCalls).set(fresh).where(eq(savCaseCalls.callKey, input.callKey));
    else await tx.insert(savCaseCalls).values({ callKey: input.callKey, subjectKey, caseId, purpose: input.purpose, createdAt: now, ...fresh });
    return { status: "reserved", token, leaseUntil: iso(leaseUntil) };
  }, subjectKey);
}

async function owned(tx: CaseTx, callKey: string, token: string) {
  const [row] = await tx.select().from(savCaseCalls).where(eq(savCaseCalls.callKey, callKey)).for("update");
  if (!row) return fault("NOT_FOUND");
  if (row.token !== token) fault("TOKEN_MISMATCH");
  return row;
}

/** Written to disk just before the provider call; from here the key is never reserved again. */
export async function markSavCaseCallDispatched(input: { callKey: string; token: string; now?: Date }) {
  const { subjectKey } = parseKeys(input);
  return writable(async tx => {
    const row = await owned(tx, input.callKey, input.token);
    if (row.state === "dispatched") return { dispatched: true as const };
    if (row.state !== "reserved") fault(row.state === "settled" ? "SETTLED" : "RELEASED");
    await tx.update(savCaseCalls).set({ state: "dispatched", dispatchedAt: input.now ?? new Date(), leaseUntil: null, updatedAt: input.now ?? new Date() }).where(eq(savCaseCalls.callKey, input.callKey));
    return { dispatched: true as const };
  }, subjectKey);
}

/** The provider's answer, by the token that dispatched it; the same outcome again is a no-op. */
export async function settleSavCaseCall(input: { callKey: string; token: string; result: SavCaseCallResult; now?: Date }) {
  const { subjectKey } = parseKeys(input);
  const ok = input.result.status === "ok";
  if (!ok && typeof (input.result as { uncertain?: unknown }).uncertain !== "boolean") fault("RESULT_INVALID");
  return writable(async tx => {
    const row = await owned(tx, input.callKey, input.token);
    if (row.state === "settled") {
      const same = ok ? row.resultStatus === "ok" && JSON.stringify(decryptSavPayload(row.outputCiphertext!)) === JSON.stringify((input.result as { output: unknown }).output)
        : row.resultStatus === "failed" && row.resultUncertain === (input.result as { uncertain: boolean }).uncertain;
      return same ? { settled: true as const } : fault("SETTLED");
    }
    if (row.state !== "dispatched") fault("NOT_DISPATCHED");
    await tx.update(savCaseCalls).set({
      state: "settled", settledAt: input.now ?? new Date(), updatedAt: input.now ?? new Date(), resultStatus: input.result.status,
      resultUncertain: ok ? false : (input.result as { uncertain: boolean }).uncertain, outputCiphertext: ok ? encryptSavPayload((input.result as { output: unknown }).output) : null,
    }).where(eq(savCaseCalls.callKey, input.callKey));
    return { settled: true as const };
  }, subjectKey);
}

/** Nothing was sent (global budget refused, shutdown): the key is reservable again. */
export async function releaseSavCaseCall(input: { callKey: string; token: string; now?: Date }) {
  const { subjectKey } = parseKeys(input);
  return writable(async tx => {
    const row = await owned(tx, input.callKey, input.token);
    if (row.state === "released") return { released: true as const };
    if (row.state !== "reserved") fault("DISPATCHED");
    await tx.update(savCaseCalls).set({ state: "released", leaseUntil: null, updatedAt: input.now ?? new Date() }).where(eq(savCaseCalls.callKey, input.callKey));
    return { released: true as const };
  }, subjectKey);
}

/** Option c of P1: a signal for the case, never a block. Released keys are not counted. */
export async function callsForCaseInWindow(input: { caseId: string; since: Date }) {
  if (!UUID.test(input.caseId)) fault("KEY_INVALID");
  const rows = await requireDb().select({ state: savCaseCalls.state, n: count() }).from(savCaseCalls)
    .where(and(eq(savCaseCalls.caseId, input.caseId), gte(savCaseCalls.createdAt, input.since), ne(savCaseCalls.state, "released"))).groupBy(savCaseCalls.state);
  const by = Object.fromEntries(rows.map(r => [r.state, r.n])) as Record<string, number>;
  const reserved = by.reserved ?? 0, dispatched = by.dispatched ?? 0, settled = by.settled ?? 0;
  return { reserved, dispatched, settled, total: reserved + dispatched + settled };
}
