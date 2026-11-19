import "server-only";
import { and, eq, like, lt } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../../crypto";
import { readCaseV2SpendPolicy } from "../investigation-v2-spend";
import { SAV_V2_MODEL_ENV } from "../investigation-v2-providers";
import { SAV_ACCESS_SKILL_CORPUS } from "../access-skill/access-skill-corpus.fixture";
import { accessSkillEvalInput, type AccessSkillEvalCase } from "../access-skill/access-skill-eval";
import { accessSkillCallOf, prepareAccessSkillCall, type AccessSkillDeps } from "../access-skill/access-skill-judge";
import { accessSkillTextsOf, type AccessSkillCall } from "../access-skill/access-skill-rule";
import type { AccessSkillWireResult } from "../access-skill/access-skill-wire";
import { SAV_ENTRY_SKILL_BLOCKS } from "../blocks/registry";
import type { CorpusCase, RequestRoute } from "../../skills/corpus-contract";
import { entrySkillBlockProblems, type EntrySkillBlock } from "../../skills/entry-block";
import { decideEntry, entryAccessReadingsWith, runEntryReadings, type EntryCatalog } from "../../skills/entry-decision";
import { entryPackageSha256 } from "../../skills/entry-package";
import type { EntrySkillInput } from "../../skills/entry-wire";
import { qualificationVerdict, type QualificationCaseResult, type QualificationVerdict } from "../../skills/qualification-verdict";
import { prepareEntryCall } from "./entry-skill-reading";

/*
 * Chantier « 3 blocs »: the GENERIC production self-test of the entry, on the corpus of ANY registered block (or Access's corpus replayed through the
 * router), with the same guarantees as SAV-97's (`access-skill-selftest.ts`, which keeps working unchanged under `SAV_V2_ACCESS_SKILL_SELFTEST`):
 *   SAV_V2_ENTRY_SKILL_SELFTEST=run (default off), SAV_V2_ENTRY_SKILL_SELFTEST_TARGET=<blockId> | access, SAV_V2_ENTRY_SKILL_SELFTEST_ID=<run id>,
 *   optional _MAX_MICRO_USD (default AND ceiling 10 000 000 µUSD = 10 USD), _PASSES (1..3, default 3), _BATCH (1..50, default 10).
 * The existing reconcile pass sends a small batch of the FICTIONAL corpus bundled in the app through the real two-stage entry (router, the elected
 * blocks' skills, Access's judge and counter-read, the shared counter-read) on V2's Gemini transport, decides each with the production rule and stores
 * each result. Nothing else: no case, no ticket, no mail, no HubSpot or Gmail call, no admission; only the model endpoint is called.
 * Catalog: Access and EVERY valid registered block (the package to qualify), whatever their entry switch.
 * Money: a DEDICATED ledger capped at 10 USD at most, separate from V2's daily budget: each case reserves its worst case (every call it could make, at V2's
 * approved `reserveMicroUsdPerCall`) before anything is sent, then counts its reported usage at V2's prices. A case that would pass the cap is not started.
 * Stops: the first sensitive mail admitted, or the cap. At the end ONE log line `sav_entry_skill_selftest` with the aggregate (ids and codes only), whose
 * verdict is N3's `qualificationVerdict` (0 sensitive admitted, neighbours ≥ 95 %, recall ≥ 90 %, traps ≥ 90 %, complete).
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_ENTRY_SKILL_SELFTEST_ENV = "SAV_V2_ENTRY_SKILL_SELFTEST";
export const SAV_ENTRY_SKILL_SELFTEST_TARGET_ENV = "SAV_V2_ENTRY_SKILL_SELFTEST_TARGET";
export const SAV_ENTRY_SKILL_SELFTEST_ID_ENV = "SAV_V2_ENTRY_SKILL_SELFTEST_ID";
export const SAV_ENTRY_SKILL_SELFTEST_CAP_ENV = "SAV_V2_ENTRY_SKILL_SELFTEST_MAX_MICRO_USD";
export const SAV_ENTRY_SKILL_SELFTEST_PASSES_ENV = "SAV_V2_ENTRY_SKILL_SELFTEST_PASSES";
export const SAV_ENTRY_SKILL_SELFTEST_BATCH_ENV = "SAV_V2_ENTRY_SKILL_SELFTEST_BATCH";
export const SAV_ENTRY_SKILL_SELFTEST_PREFIX = "sav-v2-entry-skill-selftest.v1";
export const SAV_ENTRY_SKILL_SELFTEST_MAX_CAP_MICRO_USD = 10_000_000;
const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/, INTEGER = /^[0-9]{1,12}$/, LEASE_MS = 5 * 60_000;

export type EntrySkillSelfTestConfig =
  | Readonly<{ mode: "off" }>
  | Readonly<{ mode: "refused"; reason: "id_invalid" | "target_unknown" | "target_invalid" | "cap_invalid" | "passes_invalid" | "batch_invalid" }>
  | Readonly<{ mode: "run"; runId: string; target: string; capMicroUsd: number; passes: number; batch: number }>;

export function readEntrySkillSelfTestConfig(env: Env, registry: readonly EntrySkillBlock[] = SAV_ENTRY_SKILL_BLOCKS): EntrySkillSelfTestConfig {
  if (env[SAV_ENTRY_SKILL_SELFTEST_ENV] !== "run") return { mode: "off" };
  const runId = env[SAV_ENTRY_SKILL_SELFTEST_ID_ENV] ?? "";
  if (!RUN_ID.test(runId)) return { mode: "refused", reason: "id_invalid" };
  const target = env[SAV_ENTRY_SKILL_SELFTEST_TARGET_ENV] ?? "";
  const block = registry.find(row => row.blockId === target);
  if (target !== "access" && !block) return { mode: "refused", reason: "target_unknown" };
  if (block && entrySkillBlockProblems(block).length) return { mode: "refused", reason: "target_invalid" };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = INTEGER.test(raw) ? Number(raw) : NaN;
    return value >= min && value <= max ? value : null;
  };
  const capMicroUsd = integer(SAV_ENTRY_SKILL_SELFTEST_CAP_ENV, SAV_ENTRY_SKILL_SELFTEST_MAX_CAP_MICRO_USD, 1, SAV_ENTRY_SKILL_SELFTEST_MAX_CAP_MICRO_USD);
  if (capMicroUsd === null) return { mode: "refused", reason: "cap_invalid" };
  const passes = integer(SAV_ENTRY_SKILL_SELFTEST_PASSES_ENV, 3, 1, 3);
  if (passes === null) return { mode: "refused", reason: "passes_invalid" };
  const batch = integer(SAV_ENTRY_SKILL_SELFTEST_BATCH_ENV, 10, 1, 50);
  if (batch === null) return { mode: "refused", reason: "batch_invalid" };
  return { mode: "run", runId, target, capMicroUsd, passes, batch };
}

/** One self-test case: the N3 labels and the exact input the entry would read. */
type SelfTestCase = Readonly<{ qualification: Pick<CorpusCase, "id" | "group" | "requests">; input: EntrySkillInput }>;

/** A block's N3 corpus: one request per label; several requests carry their verbatim words when the registration provides them (else none: the team). */
function blockCases(block: EntrySkillBlock): SelfTestCase[] {
  return block.corpus.map(row => ({ qualification: row, input: { purpose: "first_mail", subject: row.subject ?? "", text: row.text, originalRequest: null,
    requests: row.requests.map(request => ({ requestId: request.requestId, kind: "support",
      words: row.requests.length > 1 ? block.corpusRequestWords?.[row.id]?.[request.requestId] ?? null : null })) } }));
}
/** Access's SAV-97 corpus in N3 terms: sensitive → sensitive, Access → positive (capcar twins → trap, still Access), other → neighbour (the team). */
function accessCases(cases: readonly AccessSkillEvalCase[]): SelfTestCase[] {
  return cases.map(row => {
    const { input } = accessSkillEvalInput(row);
    const label = (verdict: "access" | "other" | "sensitive"): CorpusCase["requests"][number]["expected"] =>
      verdict === "access" ? { kind: "block", blockId: "access" } : verdict === "sensitive" ? { kind: "sensitive" } : { kind: "team" };
    const main = row.group === "access" ? "access" : row.group === "sensitive" ? "sensitive" : "other";
    const group: CorpusCase["group"] = row.group === "sensitive" ? "sensitive" : row.group === "other" ? "neighbour" : row.capcarTwin ? "trap" : "positive";
    return { qualification: { id: row.id, group, requests: [{ requestId: "r1", expected: label(main) }, ...(row.secondRequest ? [{ requestId: "r2", expected: label(row.secondRequest.verdict) }] : [])] }, input };
  });
}

type CaseResult = Readonly<{ routes: Readonly<Record<string, string>>; outcome: "admit" | "team"; reasons: readonly string[]; calls: readonly string[]; failures: readonly string[]; costMicroUsd: number }>;
type CaseRow = Readonly<{ version: 1; reservedMicroUsd: number; result: CaseResult | null }>;
type RunRow = Readonly<{ version: 1; target: string; packageSha256: string; catalog: readonly string[]; model: string; capMicroUsd: number; passes: number; startedAt: string; aggregate?: EntrySkillSelfTestAggregate }>;
export type EntrySkillSelfTestAggregate = Readonly<{
  runId: string; target: string; packageSha256: string; catalog: readonly string[]; model: string; status: "done" | "stopped"; stopReason: "sensitive_admitted" | "cap_reached" | null;
  stopCaseId: string | null; passesPlanned: number; casesPerPass: number; casesDone: number; unfinished: number; costMicroUsd: number; capMicroUsd: number;
  perPass: readonly Readonly<{ pass: number; verdict: QualificationVerdict }>[];
  verdict: "PASS" | "FAIL";
}>;
export type EntrySkillSelfTestPass =
  | Readonly<{ skipped: "off" | "busy" | "finished" | "price_unavailable" } & Record<string, unknown>>
  | Readonly<{ skipped: "refused"; reason: string }>
  | Readonly<{ ran: number; status: "running" | "done" | "stopped"; spentMicroUsd: number }>;
export type EntrySkillSelfTestDeps = AccessSkillDeps & Readonly<{ deadlineMs?: number; registry?: readonly EntrySkillBlock[]; accessCorpus?: readonly AccessSkillEvalCase[];
  log?: (event: string, fields: unknown) => void }>;

const runKey = (runId: string) => `${SAV_ENTRY_SKILL_SELFTEST_PREFIX}:${runId}:run`;
const leaseKey = (runId: string) => `${SAV_ENTRY_SKILL_SELFTEST_PREFIX}:${runId}:lease`;
const casePrefix = (runId: string) => `${SAV_ENTRY_SKILL_SELFTEST_PREFIX}:${runId}:case:`;
const caseKey = (runId: string, pass: number, caseId: string) => `${casePrefix(runId)}p${pass}:${caseId}`;
const PASS_CASE = /:case:p([0-9]):(.+)$/;
const isSensitive = (row: SelfTestCase) => row.qualification.group === "sensitive" || row.qualification.requests.some(request => request.expected.kind === "sensitive");
const routeOf = (code: string | undefined): RequestRoute => code && code !== "team" ? { kind: "block", blockId: code } : { kind: "team" };

function aggregateOf(input: Readonly<{ runId: string; run: RunRow; cases: readonly SelfTestCase[]; rows: ReadonlyMap<string, CaseRow>; status: "done" | "stopped";
  stopReason: EntrySkillSelfTestAggregate["stopReason"]; stopCaseId: string | null }>): EntrySkillSelfTestAggregate {
  let unfinished = 0, costMicroUsd = 0, casesDone = 0;
  const results = new Map<number, QualificationCaseResult[]>();
  for (const [key, row] of input.rows) {
    const match = PASS_CASE.exec(key);
    if (!match) continue;
    if (!row.result) { unfinished += 1; costMicroUsd += row.reservedMicroUsd; continue; }
    costMicroUsd += row.result.costMicroUsd; casesDone += 1;
    const pass = Number(match[1]), list = results.get(pass) ?? [];
    list.push({ caseId: match[2]!, status: "complete", requests: Object.entries(row.result.routes).map(([requestId, code]) => ({ requestId, route: routeOf(code) })) });
    results.set(pass, list);
  }
  const blockId = input.run.target, cases = input.cases.map(row => row.qualification);
  const perPass = Array.from({ length: input.run.passes }, (_, index) => ({ pass: index + 1,
    verdict: qualificationVerdict({ blockId, cases, results: results.get(index + 1) ?? [], budgetExhausted: input.stopReason === "cap_reached" }) }));
  const pass = input.status === "done" && unfinished === 0 && perPass.every(row => row.verdict.status === "pass");
  return { runId: input.runId, target: blockId, packageSha256: input.run.packageSha256, catalog: input.run.catalog, model: input.run.model, status: input.status,
    stopReason: input.stopReason, stopCaseId: input.stopCaseId, passesPlanned: input.run.passes, casesPerPass: input.cases.length, casesDone, unfinished, costMicroUsd,
    capMicroUsd: input.run.capMicroUsd, perPass, verdict: pass ? "PASS" : "FAIL" };
}

async function readRows(runId: string) {
  const rows = await requireDb().select().from(savSyncState).where(like(savSyncState.key, `${casePrefix(runId)}%`));
  return new Map(rows.map(row => [row.key, decryptSavPayload<CaseRow>(row.cursor ?? "")]));
}

async function finish(deps: EntrySkillSelfTestDeps, runId: string, run: RunRow, cases: readonly SelfTestCase[], status: "done" | "stopped",
  stop: { reason: "sensitive_admitted" | "cap_reached"; caseId: string | null } | null) {
  const aggregate = aggregateOf({ runId, run, cases, rows: await readRows(runId), status, stopReason: stop?.reason ?? null, stopCaseId: stop?.caseId ?? null });
  const [written] = await requireDb().update(savSyncState).set({ status, cursor: encryptSavPayload({ ...run, aggregate } satisfies RunRow), completedAt: deps.now(), updatedAt: deps.now() })
    .where(and(eq(savSyncState.key, runKey(runId)), eq(savSyncState.status, "running"))).returning({ key: savSyncState.key });
  if (written) (deps.log ?? ((event, fields) => console.info(event, JSON.stringify(fields))))("sav_entry_skill_selftest", aggregate);
  return aggregate;
}

/** One batch of the generic self-test, from the existing reconcile pass. Never throws for a model failure (the case records it); touches only its rows. */
export async function runEntrySkillSelfTestPass(deps: EntrySkillSelfTestDeps): Promise<EntrySkillSelfTestPass> {
  const registry = deps.registry ?? SAV_ENTRY_SKILL_BLOCKS, config = readEntrySkillSelfTestConfig(deps.env(), registry);
  if (config.mode === "off") return { skipped: "off" };
  if (config.mode === "refused") {
    (deps.log ?? ((event, fields) => console.info(event, fields)))("sav_entry_skill_selftest_refused", { reason: config.reason });
    return { skipped: "refused", reason: config.reason };
  }
  const policy = readCaseV2SpendPolicy(deps.env());
  if (!policy.ok) return { skipped: "price_unavailable" };
  const prices = policy.policy.model, perCall = prices.reserveMicroUsdPerCall;
  const costOf = (result: AccessSkillWireResult) => result.usage
    ? Math.ceil((result.usage.inputTokens * prices.microUsdPerMillionInputTokens + result.usage.outputTokens * prices.microUsdPerMillionOutputTokens) / 1_000_000)
    : perCall;
  const blocks = registry.filter(block => !entrySkillBlockProblems(block).length), catalog: EntryCatalog = { access: true, blocks };
  const target = blocks.find(block => block.blockId === config.target);
  const cases = target ? blockCases(target) : accessCases(deps.accessCorpus ?? SAV_ACCESS_SKILL_CORPUS);
  // Worst case of one mail: the router, Access's judge and counter-read, every block's skill, the shared counter-read.
  const worstCase = (4 + blocks.length) * perCall;
  const db = requireDb(), now = deps.now(), model = deps.env()[SAV_V2_MODEL_ENV] ?? "";
  const initial: RunRow = { version: 1, target: config.target, packageSha256: entryPackageSha256(catalog, model), catalog: ["access", ...blocks.map(block => block.blockId)], model,
    capMicroUsd: config.capMicroUsd, passes: config.passes, startedAt: now.toISOString() };
  await db.insert(savSyncState).values({ key: runKey(config.runId), status: "running", cursor: encryptSavPayload(initial), startedAt: now }).onConflictDoNothing();
  const [runRow] = await db.select().from(savSyncState).where(eq(savSyncState.key, runKey(config.runId)));
  if (!runRow || runRow.status !== "running") return { skipped: "finished", status: runRow?.status ?? "absent" };
  // The run keeps the target, package, cap and pass count it started with: an id is one run.
  const run = decryptSavPayload<RunRow>(runRow.cursor ?? "");
  if (run.packageSha256 !== initial.packageSha256 || run.target !== config.target) return { skipped: "finished", status: "package_changed" };
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
      const match = PASS_CASE.exec(key), source = match && cases.find(item => item.qualification.id === match[2]);
      if (source && isSensitive(source) && row.result?.outcome === "admit") { await finish(deps, config.runId, run, cases, "stopped", { reason: "sensitive_admitted", caseId: source.qualification.id }); return { ran, status: "stopped", spentMicroUsd: spent }; }
    }
    const todo = Array.from({ length: run.passes }, (_, index) => index + 1).flatMap(pass => cases.map(item => ({ pass, item })))
      .filter(({ pass, item }) => !rows.has(caseKey(config.runId, pass, item.qualification.id)));
    for (const { pass, item } of todo.slice(0, config.batch)) {
      if (deps.deadlineMs !== undefined && Date.now() + 60_000 > deps.deadlineMs) return { ran, status: "running", spentMicroUsd: spent };
      if (spent + worstCase > run.capMicroUsd) { await finish(deps, config.runId, run, cases, "stopped", { reason: "cap_reached", caseId: item.qualification.id }); return { ran, status: "stopped", spentMicroUsd: spent }; }
      const key = caseKey(config.runId, pass, item.qualification.id);
      const claimed = await db.insert(savSyncState).values({ key, status: "pending", cursor: encryptSavPayload({ version: 1, reservedMicroUsd: worstCase, result: null } satisfies CaseRow), startedAt: deps.now() })
        .onConflictDoNothing().returning({ key: savSyncState.key });
      if (!claimed.length) continue;
      spent += worstCase;
      let cost = 0;
      const calls: string[] = [], failures: string[] = [];
      const paid = async (label: string, prepared: ReturnType<typeof prepareEntryCall>): Promise<AccessSkillCall> => {
        calls.push(label);
        if (!prepared.ok) { failures.push(`${label}:${prepared.call.status === "failed" ? prepared.call.problem : "skipped"}`); return prepared.call; }
        const result = await prepared.send();
        cost += costOf(result);
        if (result.status === "failed") failures.push(`${label}:${result.problem}`);
        return accessSkillCallOf(result);
      };
      const texts = accessSkillTextsOf(item.input), requestIds = item.input.requests.map(row => row.requestId);
      const readings = await runEntryReadings({ texts, requestIds, catalog },
        call => paid(call.kind === "judge" ? `judge:${call.blockId}` : call.kind, prepareEntryCall(deps, catalog, item.input, call)),
        entryAccessReadingsWith(texts, requestIds, kind => paid(`access_${kind}`, prepareAccessSkillCall(deps, kind, item.input))));
      const verdict = decideEntry({ texts, requestIds, catalog, readings });
      const routes = Object.fromEntries(requestIds.map(id => {
        const route = verdict.outcome === "admit" ? verdict.requests[id] : undefined;
        return [id, route && "blockId" in route ? route.blockId : "team"];
      }));
      const result: CaseResult = { routes, outcome: verdict.outcome, reasons: verdict.outcome === "team" ? verdict.reasons : [], calls, failures, costMicroUsd: cost };
      await db.update(savSyncState).set({ status: "done", cursor: encryptSavPayload({ version: 1, reservedMicroUsd: worstCase, result } satisfies CaseRow), completedAt: deps.now(), updatedAt: deps.now() })
        .where(eq(savSyncState.key, key));
      spent += cost - worstCase; ran += 1;
      if (isSensitive(item) && verdict.outcome === "admit") { await finish(deps, config.runId, run, cases, "stopped", { reason: "sensitive_admitted", caseId: item.qualification.id }); return { ran, status: "stopped", spentMicroUsd: spent }; }
    }
    if (todo.length <= config.batch) { await finish(deps, config.runId, run, cases, "done", null); return { ran, status: "done", spentMicroUsd: spent }; }
    return { ran, status: "running", spentMicroUsd: spent };
  } finally {
    await db.delete(savSyncState).where(eq(savSyncState.key, leaseKey(config.runId)));
  }
}

/** The stored aggregate of a finished run (read-only); null while it runs or when absent. */
export async function readEntrySkillSelfTestAggregate(runId: string): Promise<EntrySkillSelfTestAggregate | null> {
  if (!RUN_ID.test(runId)) return null;
  const [row] = await requireDb().select().from(savSyncState).where(eq(savSyncState.key, runKey(runId)));
  return row && row.status !== "running" ? decryptSavPayload<RunRow>(row.cursor ?? "").aggregate ?? null : null;
}
