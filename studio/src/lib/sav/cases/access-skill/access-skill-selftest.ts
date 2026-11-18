import "server-only";
import { and, eq, like, lt } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../../crypto";
import { readCaseV2SpendPolicy } from "../investigation-v2-spend";
import { SAV_V2_MODEL_ENV } from "../investigation-v2-providers";
import { SAV_ACCESS_SKILL_CORPUS } from "./access-skill-corpus.fixture";
import { accessSkillBarrierOf, accessSkillEvalInput, accessSkillEvalMetrics, type AccessSkillEvalCase, type AccessSkillEvalRow } from "./access-skill-eval";
import { accessSkillPromptSha256, SAV_ACCESS_SKILL_REVISION } from "./access-skill-guidelines";
import { accessSkillCallOf, prepareAccessSkillCall, type AccessSkillDeps } from "./access-skill-judge";
import { decideAccessSkill, runAccessSkillReadings, type AccessSkillCall, type AccessSkillTeamReason } from "./access-skill-rule";
import type { AccessSkillCallKind, AccessSkillWireResult } from "./access-skill-wire";

/*
 * SAV-97 production self-test of the Access skill (Ugo 18/11: the Gemini key stays in Vercel, so the real-model evaluation runs there, with no new route).
 * `SAV_V2_ACCESS_SKILL_SELFTEST=run` (default off), independent of `SAV_V2_ACCESS_SKILL`: the existing reconcile pass sends a small batch of the FICTIONAL
 * corpus bundled in the app through the real judge and counter-read (V2's Gemini transport and key resolution), decides each with the production rule,
 * and stores each result. Nothing else: no case, no ticket, no mail, no HubSpot or Gmail call, no admission; only the model endpoint is called.
 *
 * Money: a DEDICATED ledger capped by `SAV_V2_ACCESS_SKILL_SELFTEST_MAX_MICRO_USD` (default 10 000 000 µUSD, Ugo's approved 10 EUR, never above), separate
 * from V2's daily budget: each call reserves the approved worst case (`model.reserveMicroUsdPerCall` of V2's spend policy) before it is sent, then
 * counts its reported usage at V2's approved prices (the worst case when the usage is unknown). A case that would pass the cap is not started.
 * Storage: `sav.sync_state`, no migration: one row per (run, pass, case), claimed before any spend (never paid twice, resumes across passes), one run row.
 * Stops: the first sensitive mail admitted, or the cap. At the end ONE log line `sav_access_skill_selftest` with the aggregate (ids and codes only).
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_ACCESS_SKILL_SELFTEST_ENV = "SAV_V2_ACCESS_SKILL_SELFTEST";
export const SAV_ACCESS_SKILL_SELFTEST_ID_ENV = "SAV_V2_ACCESS_SKILL_SELFTEST_ID";
export const SAV_ACCESS_SKILL_SELFTEST_CAP_ENV = "SAV_V2_ACCESS_SKILL_SELFTEST_MAX_MICRO_USD";
export const SAV_ACCESS_SKILL_SELFTEST_PASSES_ENV = "SAV_V2_ACCESS_SKILL_SELFTEST_PASSES";
export const SAV_ACCESS_SKILL_SELFTEST_BATCH_ENV = "SAV_V2_ACCESS_SKILL_SELFTEST_BATCH";
export const SAV_ACCESS_SKILL_SELFTEST_PREFIX = "sav-v2-access-skill-selftest.v1";
/** Ugo's approval (18/11): 10 EUR at most; read as 10 000 000 µUSD, the default and the ceiling. */
export const SAV_ACCESS_SKILL_SELFTEST_MAX_CAP_MICRO_USD = 10_000_000;
const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/, INTEGER = /^[0-9]{1,12}$/;
const LEASE_MS = 5 * 60_000;

export type AccessSkillSelfTestConfig =
  | Readonly<{ mode: "off" }>
  | Readonly<{ mode: "refused"; reason: "id_invalid" | "cap_invalid" | "passes_invalid" | "batch_invalid" }>
  | Readonly<{ mode: "run"; runId: string; capMicroUsd: number; passes: number; batch: number }>;
export function readAccessSkillSelfTestConfig(env: Env): AccessSkillSelfTestConfig {
  if (env[SAV_ACCESS_SKILL_SELFTEST_ENV] !== "run") return { mode: "off" };
  const runId = env[SAV_ACCESS_SKILL_SELFTEST_ID_ENV] ?? "";
  if (!RUN_ID.test(runId)) return { mode: "refused", reason: "id_invalid" };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = INTEGER.test(raw) ? Number(raw) : NaN;
    return value >= min && value <= max ? value : null;
  };
  const capMicroUsd = integer(SAV_ACCESS_SKILL_SELFTEST_CAP_ENV, SAV_ACCESS_SKILL_SELFTEST_MAX_CAP_MICRO_USD, 1, SAV_ACCESS_SKILL_SELFTEST_MAX_CAP_MICRO_USD);
  if (capMicroUsd === null) return { mode: "refused", reason: "cap_invalid" };
  const passes = integer(SAV_ACCESS_SKILL_SELFTEST_PASSES_ENV, 3, 1, 3);
  if (passes === null) return { mode: "refused", reason: "passes_invalid" };
  const batch = integer(SAV_ACCESS_SKILL_SELFTEST_BATCH_ENV, 20, 1, 50);
  if (batch === null) return { mode: "refused", reason: "batch_invalid" };
  return { mode: "run", runId, capMicroUsd, passes, batch };
}

type CaseResult = Readonly<{ outcome: "admit" | "team"; barrier: AccessSkillEvalRow["barrier"]; reasons: readonly AccessSkillTeamReason[]; calls: readonly AccessSkillCallKind[];
  failures: readonly string[]; costMicroUsd: number }>;
type CaseRow = Readonly<{ version: 1; reservedMicroUsd: number; result: CaseResult | null }>;
type RunRow = Readonly<{ version: 1; revision: string; promptSha256: string; model: string; capMicroUsd: number; passes: number; startedAt: string; aggregate?: AccessSkillSelfTestAggregate }>;
export type AccessSkillSelfTestAggregate = ReturnType<typeof aggregateOf>;
export type AccessSkillSelfTestPass =
  | Readonly<{ skipped: "off" | "busy" | "finished" | "deadline" | "price_unavailable" } & Record<string, unknown>>
  | Readonly<{ skipped: "refused"; reason: string }>
  | Readonly<{ ran: number; status: "running" | "done" | "stopped"; spentMicroUsd: number }>;
export type AccessSkillSelfTestDeps = AccessSkillDeps & Readonly<{ deadlineMs?: number; cases?: readonly (AccessSkillEvalCase & { traits?: readonly string[] })[]; log?: (event: string, fields: unknown) => void }>;

const runKey = (runId: string) => `${SAV_ACCESS_SKILL_SELFTEST_PREFIX}:${runId}:run`;
const leaseKey = (runId: string) => `${SAV_ACCESS_SKILL_SELFTEST_PREFIX}:${runId}:lease`;
const casePrefix = (runId: string) => `${SAV_ACCESS_SKILL_SELFTEST_PREFIX}:${runId}:case:`;
const caseKey = (runId: string, pass: number, caseId: string) => `${casePrefix(runId)}p${pass}:${caseId}`;
const PASS_CASE = /:case:p([0-9]):(.+)$/;

const verdictLabel = (ok: boolean) => ok ? "PASS" : "FAIL";
function aggregateOf(input: Readonly<{ runId: string; run: RunRow; cases: readonly AccessSkillEvalCase[]; rows: ReadonlyMap<string, CaseRow>; status: "done" | "stopped";
  stopReason: "sensitive_admitted" | "cap_reached" | null; stopCaseId: string | null }>) {
  const byId = new Map(input.cases.map(row => [row.id, row])), evalRows: AccessSkillEvalRow[] = [];
  let unfinished = 0, costMicroUsd = 0;
  for (const [key, row] of input.rows) {
    const match = PASS_CASE.exec(key), source = match ? byId.get(match[2]!) : undefined;
    if (!match || !source) continue;
    if (!row.result) { unfinished += 1; costMicroUsd += row.reservedMicroUsd; continue; }
    costMicroUsd += row.result.costMicroUsd;
    evalRows.push({ pass: Number(match[1]), caseId: source.id, group: source.group, subgroup: source.subgroup, capcarTwin: source.capcarTwin, expected: source.expected,
      outcome: row.result.outcome, barrier: row.result.barrier, reasons: row.result.reasons, calls: row.result.calls, failures: row.result.failures });
  }
  const passes = Array.from({ length: input.run.passes }, (_, index) => accessSkillEvalMetrics(index + 1, evalRows.filter(row => row.pass === index + 1)));
  const complete = input.status === "done" && unfinished === 0 && passes.every(pass => pass.cases === input.cases.length);
  const zeroSensitiveAdmitted = passes.every(pass => pass.sensitiveAdmitted === 0);
  const accessRecall = complete && passes.every(pass => pass.accessRecall >= 0.9), capcarRecall = complete && passes.every(pass => pass.capcarRecall >= 0.9);
  const otherRouted = complete && passes.every(pass => pass.otherRouted >= 0.95);
  const failing = [...new Set(evalRows.filter(row => row.outcome !== row.expected).map(row => `p${row.pass}:${row.caseId}`))].sort();
  return {
    runId: input.runId, revision: input.run.revision, promptSha256: input.run.promptSha256, model: input.run.model, status: input.status, stopReason: input.stopReason, stopCaseId: input.stopCaseId,
    passesPlanned: input.run.passes, casesPerPass: input.cases.length, casesDone: evalRows.length, unfinished,
    perPass: passes.map(pass => ({ pass: pass.pass, cases: pass.cases,
      groups: { sensitive: evalRows.filter(row => row.pass === pass.pass && row.group === "sensitive").length, access: evalRows.filter(row => row.pass === pass.pass && row.group === "access").length,
        other: evalRows.filter(row => row.pass === pass.pass && row.group === "other").length },
      sensitiveAdmitted: pass.sensitiveAdmitted, otherAdmitted: pass.otherAdmitted, otherExpectedTeam: pass.otherExpectedTeam, otherMisrouted: pass.otherMisrouted, otherRouted: pass.otherRouted, accessRecall: pass.accessRecall, accessAdmitted: pass.accessAdmitted, accessExpected: pass.accessExpected,
      capcarRecall: pass.capcarRecall, capcarAdmitted: pass.capcarAdmitted, capcarExpected: pass.capcarExpected, sensitiveCaughtBy: pass.sensitiveCaughtBy, calls: pass.calls, failedCalls: pass.failedCalls })),
    sensitiveAdmitted: passes.reduce((n, pass) => n + pass.sensitiveAdmitted, 0),
    costMicroUsd, capMicroUsd: input.run.capMicroUsd,
    failingCaseCount: failing.length, failingCaseIds: failing.slice(0, 100),
    thresholds: { zeroSensitiveAdmitted: verdictLabel(zeroSensitiveAdmitted), accessRecallAtLeast90: verdictLabel(accessRecall), capcarRecallAtLeast90: verdictLabel(capcarRecall), otherRoutedAtLeast95: verdictLabel(otherRouted), complete: verdictLabel(complete) },
    verdict: verdictLabel(complete && zeroSensitiveAdmitted && accessRecall && capcarRecall && otherRouted),
  };
}

async function readRows(runId: string) {
  const rows = await requireDb().select().from(savSyncState).where(like(savSyncState.key, `${casePrefix(runId)}%`));
  return new Map(rows.map(row => [row.key, decryptSavPayload<CaseRow>(row.cursor ?? "")]));
}

/** Writes the end of the run once (running → done|stopped) and logs the aggregate once: a concurrent or later pass finds it finished. */
async function finish(deps: AccessSkillSelfTestDeps, runId: string, run: RunRow, cases: readonly AccessSkillEvalCase[], status: "done" | "stopped",
  stop: { reason: "sensitive_admitted" | "cap_reached"; caseId: string | null } | null) {
  const aggregate = aggregateOf({ runId, run, cases, rows: await readRows(runId), status, stopReason: stop?.reason ?? null, stopCaseId: stop?.caseId ?? null });
  const [written] = await requireDb().update(savSyncState).set({ status, cursor: encryptSavPayload({ ...run, aggregate } satisfies RunRow), completedAt: deps.now(), updatedAt: deps.now() })
    .where(and(eq(savSyncState.key, runKey(runId)), eq(savSyncState.status, "running"))).returning({ key: savSyncState.key });
  if (written) (deps.log ?? ((event, fields) => console.info(event, JSON.stringify(fields))))("sav_access_skill_selftest", aggregate);
  return aggregate;
}

/** One batch of the self-test, from the existing reconcile pass. Never throws for a model failure (the case records it); never touches anything but its rows. */
export async function runAccessSkillSelfTestPass(deps: AccessSkillSelfTestDeps): Promise<AccessSkillSelfTestPass> {
  const config = readAccessSkillSelfTestConfig(deps.env());
  if (config.mode === "off") return { skipped: "off" };
  if (config.mode === "refused") {
    (deps.log ?? ((event, fields) => console.info(event, fields)))("sav_access_skill_selftest_refused", { reason: config.reason });
    return { skipped: "refused", reason: config.reason };
  }
  const policy = readCaseV2SpendPolicy(deps.env());
  if (!policy.ok) return { skipped: "price_unavailable" };
  const prices = policy.policy.model, perCall = prices.reserveMicroUsdPerCall;
  const costOf = (result: AccessSkillWireResult) => result.usage
    ? Math.ceil((result.usage.inputTokens * prices.microUsdPerMillionInputTokens + result.usage.outputTokens * prices.microUsdPerMillionOutputTokens) / 1_000_000)
    : perCall;
  const cases = deps.cases ?? SAV_ACCESS_SKILL_CORPUS, db = requireDb(), now = deps.now();
  const initial: RunRow = { version: 1, revision: SAV_ACCESS_SKILL_REVISION, promptSha256: accessSkillPromptSha256(), model: deps.env()[SAV_V2_MODEL_ENV] ?? "",
    capMicroUsd: config.capMicroUsd, passes: config.passes, startedAt: now.toISOString() };
  await db.insert(savSyncState).values({ key: runKey(config.runId), status: "running", cursor: encryptSavPayload(initial), startedAt: now }).onConflictDoNothing();
  const [runRow] = await db.select().from(savSyncState).where(eq(savSyncState.key, runKey(config.runId)));
  if (!runRow || runRow.status !== "running") return { skipped: "finished", status: runRow?.status ?? "absent" };
  // The run keeps the cap, pass count and revision it started with: an id is one run.
  const run = decryptSavPayload<RunRow>(runRow.cursor ?? "");
  // One batch at a time per run (the cron and the self-scheduler may overlap): a lease row, taken over only once expired.
  const leased = await db.insert(savSyncState).values({ key: leaseKey(config.runId), status: "held", startedAt: now }).onConflictDoNothing().returning({ key: savSyncState.key });
  if (!leased.length) {
    const taken = await db.update(savSyncState).set({ startedAt: now, updatedAt: now })
      .where(and(eq(savSyncState.key, leaseKey(config.runId)), lt(savSyncState.startedAt, new Date(now.getTime() - LEASE_MS)))).returning({ key: savSyncState.key });
    if (!taken.length) return { skipped: "busy" };
  }
  try {
    const rows = await readRows(config.runId);
    let spent = [...rows.values()].reduce((n, row) => n + (row.result ? row.result.costMicroUsd : row.reservedMicroUsd), 0), ran = 0;
    for (const [key, row] of rows) {
      const match = PASS_CASE.exec(key), source = match && cases.find(item => item.id === match[2]);
      if (source && source.group === "sensitive" && row.result?.outcome === "admit") { await finish(deps, config.runId, run, cases, "stopped", { reason: "sensitive_admitted", caseId: source.id }); return { ran, status: "stopped", spentMicroUsd: spent }; }
    }
    const todo = Array.from({ length: run.passes }, (_, index) => index + 1).flatMap(pass => cases.map(item => ({ pass, item }))).filter(({ pass, item }) => !rows.has(caseKey(config.runId, pass, item.id)));
    for (const { pass, item } of todo.slice(0, config.batch)) {
      if (deps.deadlineMs !== undefined && Date.now() + 60_000 > deps.deadlineMs) return { ran, status: "running", spentMicroUsd: spent };
      const { input, texts, requestIds } = accessSkillEvalInput(item);
      // The worst case of this mail (judge and counter-read), reserved in the ledger before anything is sent.
      if (spent + 2 * perCall > run.capMicroUsd) { await finish(deps, config.runId, run, cases, "stopped", { reason: "cap_reached", caseId: item.id }); return { ran, status: "stopped", spentMicroUsd: spent }; }
      const key = caseKey(config.runId, pass, item.id);
      const claimed = await db.insert(savSyncState).values({ key, status: "pending", cursor: encryptSavPayload({ version: 1, reservedMicroUsd: 2 * perCall, result: null } satisfies CaseRow), startedAt: deps.now() })
        .onConflictDoNothing().returning({ key: savSyncState.key });
      if (!claimed.length) continue;
      spent += 2 * perCall;
      let cost = 0;
      const calls: AccessSkillCallKind[] = [], failures: string[] = [];
      const { judge, counter } = await runAccessSkillReadings({ texts, requestIds }, async (kind): Promise<AccessSkillCall> => {
        calls.push(kind);
        const prepared = prepareAccessSkillCall(deps, kind, input);
        if (!prepared.ok) { failures.push(`${kind}:${prepared.call.status === "failed" ? prepared.call.problem : "skipped"}`); return prepared.call; }
        const result = await prepared.send();
        cost += costOf(result);
        if (result.status === "failed") failures.push(`${kind}:${result.problem}`);
        return accessSkillCallOf(result);
      });
      const verdict = decideAccessSkill({ texts, requestIds, judge, counter });
      const reasons = verdict.outcome === "team" ? verdict.reasons : [];
      const result: CaseResult = { outcome: verdict.outcome, barrier: verdict.outcome === "team" ? accessSkillBarrierOf(reasons) : null, reasons, calls, failures, costMicroUsd: cost };
      await db.update(savSyncState).set({ status: "done", cursor: encryptSavPayload({ version: 1, reservedMicroUsd: 2 * perCall, result } satisfies CaseRow), completedAt: deps.now(), updatedAt: deps.now() })
        .where(eq(savSyncState.key, key));
      spent += cost - 2 * perCall; ran += 1;
      if (item.group === "sensitive" && verdict.outcome === "admit") { await finish(deps, config.runId, run, cases, "stopped", { reason: "sensitive_admitted", caseId: item.id }); return { ran, status: "stopped", spentMicroUsd: spent }; }
    }
    if (todo.length <= config.batch) { await finish(deps, config.runId, run, cases, "done", null); return { ran, status: "done", spentMicroUsd: spent }; }
    return { ran, status: "running", spentMicroUsd: spent };
  } finally {
    await db.delete(savSyncState).where(eq(savSyncState.key, leaseKey(config.runId)));
  }
}

/** The stored aggregate of a finished run (read-only), for a diagnostics reader; null while it runs or when absent. */
export async function readAccessSkillSelfTestAggregate(runId: string): Promise<AccessSkillSelfTestAggregate | null> {
  if (!RUN_ID.test(runId)) return null;
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, runKey(runId)));
  return row && row.status !== "running" ? decryptSavPayload<RunRow>(row.cursor ?? "").aggregate ?? null : null;
}
