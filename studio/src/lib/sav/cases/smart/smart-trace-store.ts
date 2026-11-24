import "server-only";
import { and, asc, eq, isNotNull, like, lt, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCaseEffectExecutions, savCases, savIntakeEffects, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../../crypto";
import { smartPrices } from "./smart-model";
import { summarizeSmartCaseTraces, type SmartCaseTrace } from "./smart-trace";

/*
 * Storage of the real smart turns' traces (`smart-trace.ts`): one ENCRYPTED row per decision call in `sav.sync_state` (no migration, same
 * pattern as the shadow), key `sav-v2-smart-trace.v1:<case>:<input>:call<n>`, kept 30 days (older rows are deleted by a write, at most once per hour).
 * The row holds customer-derived text, so it never reaches a log: a failed write logs a closed code and the case id only, and is swallowed.
 * Read only by the staff MCP (`get_dossier` full trace; `list_v2_cases` a summary without customer text).
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_SMART_TRACE_PREFIX = "sav-v2-smart-trace.v1";
export const SAV_SMART_TRACE_RETENTION_MS = 30 * 86_400_000;
/** Marker of the last prune (outside the trace prefix, so never pruned itself) and the minimum interval between two prunes. */
export const SAV_SMART_TRACE_PRUNE_KEY = "sav-v2-smart-trace-prune.v1";
export const SAV_SMART_TRACE_PRUNE_EVERY_MS = 3_600_000;
/** Traces read per case (the latest ones). */
export const SAV_SMART_TRACE_READ_PER_CASE = 12;

export const smartTraceKey = (trace: Pick<SmartCaseTrace, "caseId" | "inputKey" | "call">) => `${SAV_SMART_TRACE_PREFIX}:${trace.caseId}:${trace.inputKey}:call${trace.call}`;

/** The cost of the turn's calls at V2's approved prices; null when a sent call has no usage or the policy is absent. */
export function smartTraceCost(trace: SmartCaseTrace, env: Env): number | null {
  if (trace.kind === "refused_twice") return 0;
  const prices = smartPrices(env);
  if (!prices || trace.calls.filter(row => row.sent).length !== trace.modelCalls) return null;
  let total = 0;
  for (const call of trace.calls.filter(row => row.sent)) {
    if (call.uncertain || call.inputTokens === null || call.outputTokens === null) return null;
    total += prices.modelCost({ inputTokens: call.inputTokens, outputTokens: call.outputTokens });
  }
  return total;
}

/** The production sink: encrypt and upsert the trace, prune expired rows. Never throws; a failure logs `sav_smart_trace_write_failed` (case id only). */
export function smartCaseTraceStore(deps: Readonly<{ env: () => Env; now?: () => Date; log?: (event: string, fields: Record<string, unknown>) => void }>) {
  const now = deps.now ?? (() => new Date()), log = deps.log ?? ((event, fields) => console.warn(event, fields));
  return async (trace: SmartCaseTrace): Promise<void> => {
    try {
      let costMicroUsd: number | null = null;
      try { costMicroUsd = smartTraceCost(trace, deps.env()); } catch { costMicroUsd = null; }
      const stored: SmartCaseTrace = { ...trace, costMicroUsd };
      const at = now(), cursor = encryptSavPayload(stored), db = requireDb();
      await db.insert(savSyncState).values({ key: smartTraceKey(trace), status: "done", cursor, startedAt: at, completedAt: at, updatedAt: at })
        .onConflictDoUpdate({ target: savSyncState.key, set: { cursor, status: "done", completedAt: at, updatedAt: at } });
      // The prune runs at most once per hour: one atomic marker upsert wins the slot (first write, or marker older than an hour), only then the delete.
      const slot = await db.insert(savSyncState).values({ key: SAV_SMART_TRACE_PRUNE_KEY, status: "done", startedAt: at, completedAt: at, updatedAt: at })
        .onConflictDoUpdate({ target: savSyncState.key, set: { completedAt: at, updatedAt: at }, setWhere: lt(savSyncState.completedAt, new Date(at.getTime() - SAV_SMART_TRACE_PRUNE_EVERY_MS)) })
        .returning({ key: savSyncState.key });
      if (slot.length) await db.delete(savSyncState).where(and(like(savSyncState.key, `${SAV_SMART_TRACE_PREFIX}:%`), lt(savSyncState.startedAt, new Date(at.getTime() - SAV_SMART_TRACE_RETENTION_MS))));
    } catch (error) {
      log("sav_smart_trace_write_failed", { caseId: trace.caseId, call: trace.call, code: error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message) ? error.message : "write_failed" });
    }
  };
}

const readable = (cursor: string | null): SmartCaseTrace | null => {
  try { const value = decryptSavPayload<SmartCaseTrace>(cursor ?? ""); return value && value.v === 1 ? value : null; } catch { return null; }
};

/** Reason of the exact model call that produced the accepted handoff proposal. */
export async function readSmartHandoffTraceReason(call: Pick<SmartCaseTrace, "caseId" | "inputKey" | "call" | "caseVersion">) {
  try {
    const [row] = await requireDb().select({ cursor: savSyncState.cursor }).from(savSyncState)
      .where(eq(savSyncState.key, smartTraceKey(call)));
    const trace = readable(row?.cursor ?? null);
    if (trace?.caseVersion === call.caseVersion && trace.kind === "turn" && trace.decision.kind === "handoff") return trace.decision.noteReason;
  } catch { /* A missing or unreadable trace cannot qualify a signal. */ }
  return null;
}

/** The stored traces of some cases, oldest first, at most `SAV_SMART_TRACE_READ_PER_CASE` (the latest) per case. Read only. */
export async function readSmartCaseTraces(caseIds: readonly string[]): Promise<Map<string, SmartCaseTrace[]>> {
  const out = new Map<string, SmartCaseTrace[]>();
  const ids = [...new Set(caseIds)].filter(id => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100);
  if (!ids.length) return out;
  const patterns = `{${ids.map(id => `${SAV_SMART_TRACE_PREFIX}:${id}:%`).join(",")}}`;
  const rows = await requireDb().select({ cursor: savSyncState.cursor }).from(savSyncState).where(sql`${savSyncState.key} like any(${patterns}::text[])`)
    .orderBy(sql`${savSyncState.startedAt} desc`).limit(ids.length * SAV_SMART_TRACE_READ_PER_CASE * 4);
  for (const row of rows) {
    const trace = readable(row.cursor);
    if (!trace || !ids.includes(trace.caseId)) continue;
    const list = out.get(trace.caseId) ?? [];
    if (list.length < SAV_SMART_TRACE_READ_PER_CASE) { list.push(trace); out.set(trace.caseId, list); }
  }
  for (const list of out.values()) list.sort((a, b) => a.caseVersion - b.caseVersion || a.call - b.call || a.at.localeCompare(b.at));
  return out;
}

/** The confirmed reply mails of a case, with the text stored for the send (bounded). Read only. */
async function readConfirmedReplies(caseId: string) {
  const rows = await requireDb().select({ executionId: savCaseEffectExecutions.id, payload: savCaseEffectExecutions.payloadCiphertext, confirmedAt: savIntakeEffects.confirmedAt })
    .from(savCaseEffectExecutions).innerJoin(savIntakeEffects, eq(savIntakeEffects.executionId, savCaseEffectExecutions.id))
    .where(and(eq(savCaseEffectExecutions.caseId, caseId), eq(savIntakeEffects.kind, "reply_send"), eq(savIntakeEffects.state, "confirmed"), isNotNull(savIntakeEffects.confirmedAt)))
    .orderBy(asc(savIntakeEffects.confirmedAt)).limit(10);
  return rows.map(row => {
    let text: string | null = null;
    try { const value = decryptSavPayload<{ proposal?: { text?: unknown } }>(row.payload)?.proposal?.text; text = typeof value === "string" ? value.slice(0, 6000) : null; } catch { text = null; }
    return { executionId: row.executionId, confirmedAt: row.confirmedAt?.toISOString() ?? null, text };
  });
}

/**
 * The V2 cases of an intake thread with their smart traces and the confirmed reply texts, for `get_dossier`. Read only; never throws (an
 * unreadable store gives `unavailable`), so the dossier itself is always returned.
 */
export async function readSmartTracesForThread(threadId: string) {
  try {
    const cases = await requireDb().select({ id: savCases.id }).from(savCases).where(sql`${threadId}::uuid = any(${savCases.threadIds})`).orderBy(asc(savCases.createdAt)).limit(5);
    const traces = await readSmartCaseTraces(cases.map(row => row.id));
    const out = [];
    for (const row of cases) {
      const caseTraces = traces.get(row.id) ?? [];
      out.push({ caseId: row.id, summary: summarizeSmartCaseTraces(caseTraces), turns: caseTraces, sentReplies: await readConfirmedReplies(row.id) });
    }
    return { available: true as const, cases: out };
  } catch {
    return { available: false as const, cases: [] };
  }
}

/** Per case, the compact summary (no customer text), for `list_v2_cases`. Never throws: an unreadable store gives an empty map. */
export async function readSmartTraceSummaries(caseIds: readonly string[]) {
  try {
    const traces = await readSmartCaseTraces(caseIds);
    return new Map([...traces].map(([caseId, rows]) => [caseId, summarizeSmartCaseTraces(rows)]));
  } catch { return new Map<string, ReturnType<typeof summarizeSmartCaseTraces>>(); }
}
