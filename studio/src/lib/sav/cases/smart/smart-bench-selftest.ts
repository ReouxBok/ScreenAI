import "server-only";
import { like } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../../crypto";
import { createSavBenchCurrentAgent, createSavBenchCurrentModel } from "../../bench/bench-agent-current";
import { SAV_BENCH_CORPUS, SAV_BENCH_CORPUS_REVISION } from "../../bench/bench-corpus";
import { createSavBenchGeminiJudge, SAV_BENCH_JUDGE_REVISION, type SavBenchJudge } from "../../bench/bench-judge";
import { runSavBench, savBenchMetrics, type SavBenchConversationRow, type SavBenchTurnRow } from "../../bench/bench-run";
import type { SavBenchAgent, SavBenchConversation } from "../../bench/bench-types";
import { resolveCaseV2GeminiKey, SAV_V2_MODEL_ENV, type CaseV2Network } from "../investigation-v2-providers";
import { readCaseV2TransportPolicy } from "../investigation-v2-spend";
import { createSavBenchAgent } from "./smart-bench-agent";
import { claimSmartItem, readSmartLedger, settleSmartItem, smartItemKey, smartLedgerSpent } from "./smart-ledger";
import { smartPrices } from "./smart-model";
import { SAV_SMART_PROMPT_REVISION, smartPromptPinned, smartPromptSha256 } from "./smart-prompt";

/*
 * Agent SAV intelligent, lot F' (20/11): the PRODUCTION self-test of the bench (the Gemini key stays in Vercel, so the real-model bench runs there,
 * with no new route), modelled on the Access self-test. `SAV_V2_SMART_BENCH_SELFTEST=run` (default off): the existing reconcile pass replays a few
 * of the 120 FICTIONAL conversations bundled in the app, turn by turn, through the current agent (V2's decision path, replayed with no effect),
 * the new agent (`runSmartTurn`) or both, and the bench judge. Nothing else: no case, ticket, mail, HubSpot, Gmail or Slack; only the model endpoint.
 *
 * Money: the new agent's OWN ledger (`smart-ledger.ts`, scope = the run id), capped by `_MAX_MICRO_USD` (default and ceiling 10 000 000 µUSD = Ugo's
 * 10 EUR), separate from V2's daily budget. One item = one (agent, conversation), CLAIMED with its worst case (every turn × every call it may
 * make, judge included, at V2's approved reservation per call) BEFORE any paid call: never paid twice, even across overlapping passes. The
 * conversation's calls go through a meter that refuses any call beyond that reservation. Settled at the measured cost.
 * Time: skipped below 90 s; a conversation starts only with 150 s left; each call bounded by the time left.
 * Report: one log line `sav_smart_bench_selftest` (codes and numbers), and `readSmartBenchSelfTestReport(runId)` for root (aggregates by family and
 * criterion, current/new comparison, failures with their conversation id).
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_SMART_BENCH_SELFTEST_ENV = "SAV_V2_SMART_BENCH_SELFTEST";
export const SAV_SMART_BENCH_SELFTEST_ID_ENV = "SAV_V2_SMART_BENCH_SELFTEST_ID";
export const SAV_SMART_BENCH_SELFTEST_AGENT_ENV = "SAV_V2_SMART_BENCH_SELFTEST_AGENT";
export const SAV_SMART_BENCH_SELFTEST_BATCH_ENV = "SAV_V2_SMART_BENCH_SELFTEST_BATCH";
export const SAV_SMART_BENCH_SELFTEST_CAP_ENV = "SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD";
export const SAV_SMART_BENCH_SELFTEST_PREFIX = "sav-v2-smart-bench-selftest.v1";
export const SAV_SMART_BENCH_SELFTEST_MAX_CAP_MICRO_USD = 10_000_000;
export const SAV_SMART_BENCH_SELFTEST_DEFAULT_BATCH = 6, SAV_SMART_BENCH_SELFTEST_MAX_BATCH = 20;
const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/, INTEGER = /^[0-9]{1,12}$/;
const STEP_MIN_MS = 90_000, CONVERSATION_MIN_MS = 150_000, CALL_MAX_MS = 45_000, CALL_MIN_MS = 8_000, CALL_MARGIN_MS = 3_000;
const JUDGE_MAX_OUTPUT_TOKENS = 4_096;
export type SmartBenchAgentName = "current" | "new";
/** Ceilings per turn: V2's runner (`SAV_CASE_INVESTIGATION_MAX_CALLS`, 3) and the new agent (understand, decide, verify, correct, reverify). Tested equal. */
export const SAV_SMART_BENCH_CURRENT_CALLS = 3, SAV_SMART_BENCH_NEW_CALLS = 5;

export type SmartBenchSelfTestConfig =
  | Readonly<{ mode: "off" }>
  | Readonly<{ mode: "refused"; reason: "id_invalid" | "agent_invalid" | "batch_invalid" | "cap_invalid" }>
  | Readonly<{ mode: "run"; runId: string; agents: readonly SmartBenchAgentName[]; batch: number; capMicroUsd: number }>;

export function readSmartBenchSelfTestConfig(env: Env): SmartBenchSelfTestConfig {
  if (env[SAV_SMART_BENCH_SELFTEST_ENV] !== "run") return { mode: "off" };
  const runId = env[SAV_SMART_BENCH_SELFTEST_ID_ENV] ?? "";
  if (!RUN_ID.test(runId)) return { mode: "refused", reason: "id_invalid" };
  const agent = env[SAV_SMART_BENCH_SELFTEST_AGENT_ENV] ?? "both";
  if (agent !== "current" && agent !== "new" && agent !== "both") return { mode: "refused", reason: "agent_invalid" };
  const integer = (name: string, fallback: number, max: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = INTEGER.test(raw) ? Number(raw) : NaN;
    return value >= 1 && value <= max ? value : null;
  };
  const batch = integer(SAV_SMART_BENCH_SELFTEST_BATCH_ENV, SAV_SMART_BENCH_SELFTEST_DEFAULT_BATCH, SAV_SMART_BENCH_SELFTEST_MAX_BATCH);
  if (batch === null) return { mode: "refused", reason: "batch_invalid" };
  const capMicroUsd = integer(SAV_SMART_BENCH_SELFTEST_CAP_ENV, SAV_SMART_BENCH_SELFTEST_MAX_CAP_MICRO_USD, SAV_SMART_BENCH_SELFTEST_MAX_CAP_MICRO_USD);
  if (capMicroUsd === null) return { mode: "refused", reason: "cap_invalid" };
  return { mode: "run", runId, agents: agent === "both" ? ["current", "new"] : [agent], batch, capMicroUsd };
}

/** Model calls an agent may make on one turn (the judge adds one): the current runner's ceiling, the new agent's five. */
export const smartBenchCallsPerTurn = (agent: SmartBenchAgentName) => (agent === "current" ? SAV_SMART_BENCH_CURRENT_CALLS : SAV_SMART_BENCH_NEW_CALLS) + 1;
export const smartBenchItem = (runId: string, agent: SmartBenchAgentName, conversationId: string) => `${runId}:${agent}:${conversationId}`;

export type SmartBenchStored = Readonly<{
  runId: string; agent: SmartBenchAgentName; agentRevision: string; judgeRevision: string; corpusRevision: string; model: string; codeSha: string | null;
  conversationId: string; costMicroUsd: number; calls: number; durationMs: number;
  /** Why the conversation stopped early: the meter (`call_budget`, `deadline`), the bench (`sensitive_admitted`), or null. */
  stopped: string | null;
  conversation: SavBenchConversationRow | null; turns: readonly SavBenchTurnRow[];
}>;
export type SmartBenchSelfTestDeps = Readonly<{
  env: () => Env; now: () => Date; deadlineMs?: number; clock?: () => number;
  network?: CaseV2Network;
  /** Tests only: replaces the bench agents and the judge (they still go through the meter's network). */
  agents?: (name: SmartBenchAgentName, network: CaseV2Network) => SavBenchAgent;
  judge?: (network: CaseV2Network) => SavBenchJudge;
  corpus?: readonly SavBenchConversation[];
  log?: (event: string, fields: Record<string, unknown>) => void;
}>;
export type SmartBenchSelfTestPass =
  | Readonly<{ skipped: "off" | "deadline" | "prompt_unpinned" | "price_unavailable" | "model_invalid" | "key_unavailable" }>
  | Readonly<{ skipped: "refused"; reason: string }>
  | Readonly<{ ran: number; stoppedBy: "batch" | "done" | "deadline" | "money_cap"; spentMicroUsd: number; remaining: number }>;

/** One self-test batch. Never throws for a model failure (the conversation records it). */
export async function runSmartBenchSelfTestPass(deps: SmartBenchSelfTestDeps): Promise<SmartBenchSelfTestPass> {
  const config = readSmartBenchSelfTestConfig(deps.env());
  if (config.mode === "off") return { skipped: "off" };
  const log = deps.log ?? ((event, fields) => console.info(event, JSON.stringify(fields)));
  if (config.mode === "refused") { log("sav_smart_bench_selftest_refused", { reason: config.reason }); return { skipped: "refused", reason: config.reason }; }
  const clock = deps.clock ?? Date.now, left = () => deps.deadlineMs === undefined ? Number.POSITIVE_INFINITY : deps.deadlineMs - clock();
  if (left() < STEP_MIN_MS) return { skipped: "deadline" };
  if (!smartPromptPinned()) return { skipped: "prompt_unpinned" };
  const env = deps.env(), now = deps.now(), prices = smartPrices(env), model = env[SAV_V2_MODEL_ENV] ?? "";
  if (!prices) return { skipped: "price_unavailable" };
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(model)) return { skipped: "model_invalid" };
  const key = resolveCaseV2GeminiKey(env);
  if (!key.ok && !deps.judge) return { skipped: "key_unavailable" };
  let maxOutputTokens = JUDGE_MAX_OUTPUT_TOKENS;
  try { maxOutputTokens = Math.min(JUDGE_MAX_OUTPUT_TOKENS, readCaseV2TransportPolicy(env, now).maxOutputTokens); } catch { return { skipped: "price_unavailable" }; }

  const corpus = deps.corpus ?? SAV_BENCH_CORPUS;
  const claimed = new Set((await requireDb().select({ key: savSyncState.key }).from(savSyncState)
    .where(like(savSyncState.key, `${smartItemKey(SAV_SMART_BENCH_SELFTEST_PREFIX, `${config.runId}:`)}%`))).map(row => row.key));
  const todo = config.agents.flatMap(agent => corpus.map(conversation => ({ agent, conversation })))
    .filter(({ agent, conversation }) => !claimed.has(smartItemKey(SAV_SMART_BENCH_SELFTEST_PREFIX, smartBenchItem(config.runId, agent, conversation.id))));
  let ran = 0, stoppedBy: Extract<SmartBenchSelfTestPass, { ran: number }>["stoppedBy"] = todo.length ? "batch" : "done";
  for (const { agent: agentName, conversation } of todo) {
    if (ran >= config.batch) { stoppedBy = "batch"; break; }
    if (left() < CONVERSATION_MIN_MS) { stoppedBy = "deadline"; break; }
    const item = smartBenchItem(config.runId, agentName, conversation.id), maxCalls = conversation.turns.length * smartBenchCallsPerTurn(agentName);
    const worst = maxCalls * prices.modelReserve;
    const claim = await claimSmartItem({ prefix: SAV_SMART_BENCH_SELFTEST_PREFIX, scope: config.runId, item, worstMicroUsd: worst, capMicroUsd: config.capMicroUsd, maxItems: null, now: deps.now() });
    if (claim.status === "refused") { if (claim.reason === "already_claimed") continue; stoppedBy = "money_cap"; break; }

    // The meter: every call of this conversation (agent and judge), refused beyond the reservation or the time left, costed at V2's prices.
    let cost = 0, calls = 0, meterStop: string | null = null;
    const send = deps.network ?? ((url, init) => fetch(url, init));
    const meter: CaseV2Network = async (url, init) => {
      const timeout = Math.min(CALL_MAX_MS, left() - CALL_MARGIN_MS);
      if (calls >= maxCalls) { meterStop ??= "call_budget"; return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_CALL_BUDGET" }); }
      if (timeout < CALL_MIN_MS) { meterStop ??= "deadline"; return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_DEADLINE" }); }
      calls += 1;
      let response: Response;
      try { response = await send(url, { ...init, signal: AbortSignal.timeout(timeout) }); }
      catch (error) { cost += prices.modelReserve; throw error; }
      if (!response.ok) { cost += response.status >= 500 || response.status === 408 || response.status === 429 ? prices.modelReserve : 0; return response; }
      const json = await response.json().catch(() => null) as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } } | null;
      const usage = json?.usageMetadata;
      cost += usage && Number.isSafeInteger(usage.promptTokenCount)
        ? prices.modelCost({ inputTokens: usage.promptTokenCount!, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) }) : prices.modelReserve;
      return json === null ? new Response("not json", { status: 200 }) : Response.json(json);
    };
    const agent = deps.agents?.(agentName, meter) ?? (agentName === "new"
      ? createSavBenchAgent({ dryRun: false, network: meter, env })
      : createSavBenchCurrentAgent({ model: createSavBenchCurrentModel({ env, network: meter, dryRun: false }), revision: `v2-decision:${model}` }));
    const judge = deps.judge?.(meter) ?? createSavBenchGeminiJudge({ network: meter, model, key: key.ok ? key.key : "", maxOutputTokens });
    const startedAt = clock();
    let stored: SmartBenchStored;
    try {
      const report = await runSavBench({ conversations: [conversation], agent, judge, passes: 1, stopOnSensitiveAdmitted: true, shouldStop: () => meterStop });
      stored = { runId: config.runId, agent: agentName, agentRevision: agent.revision, judgeRevision: SAV_BENCH_JUDGE_REVISION, corpusRevision: SAV_BENCH_CORPUS_REVISION, model,
        codeSha: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 40) ?? null, conversationId: conversation.id, costMicroUsd: cost, calls, durationMs: clock() - startedAt,
        stopped: meterStop ?? report.stopped?.reason ?? null, conversation: report.conversations[0] ?? null, turns: report.turns };
    } catch {
      stored = { runId: config.runId, agent: agentName, agentRevision: agent.revision, judgeRevision: SAV_BENCH_JUDGE_REVISION, corpusRevision: SAV_BENCH_CORPUS_REVISION, model,
        codeSha: null, conversationId: conversation.id, costMicroUsd: worst, calls, durationMs: clock() - startedAt, stopped: "crashed", conversation: null, turns: [] };
      cost = worst;
    }
    await settleSmartItem({ prefix: SAV_SMART_BENCH_SELFTEST_PREFIX, scope: config.runId, item, costMicroUsd: Math.min(cost, worst), status: "done", now: deps.now(), result: stored });
    ran += 1;
    if (meterStop === "deadline") { stoppedBy = "deadline"; break; }
  }
  const spentMicroUsd = smartLedgerSpent(await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, config.runId));
  const remaining = Math.max(0, todo.length - ran);
  const pass = { ran, stoppedBy: ran === todo.length && stoppedBy === "batch" ? "done" as const : stoppedBy, spentMicroUsd, remaining };
  log("sav_smart_bench_selftest", { ...pass, runId: config.runId, agents: config.agents, model, revision: SAV_SMART_PROMPT_REVISION, promptSha256: smartPromptSha256().slice(0, 16) });
  return pass;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Report for root: aggregates by family and criterion, current/new comparison, failures with their conversation id. Codes and numbers only.
// ---------------------------------------------------------------------------------------------------------------------------------
export function aggregateSmartBenchSelfTest(rows: readonly SmartBenchStored[]) {
  const per = (agent: SmartBenchAgentName) => {
    const mine = rows.filter(row => row.agent === agent);
    const turns = mine.flatMap(row => row.turns), conversations = mine.flatMap(row => row.conversation ? [row.conversation] : []);
    const metrics = savBenchMetrics(turns, conversations);
    const failures = turns.filter(row => !row.verdict.passed).map(row => ({ conversationId: row.conversationId, family: row.family, turn: row.turn, expected: row.expected, outcome: row.outcome,
      failed: Object.entries(row.verdict.criteria).filter(([, value]) => value.final === "echec").map(([criterion]) => criterion), checks: row.checks.map(hit => hit.code), failure: row.failure }));
    return { conversationsStored: mine.length, stopped: mine.filter(row => row.stopped).map(row => ({ conversationId: row.conversationId, reason: row.stopped })),
      costMicroUsd: mine.reduce((sum, row) => sum + row.costMicroUsd, 0), calls: mine.reduce((sum, row) => sum + row.calls, 0),
      revisions: [...new Set(mine.map(row => row.agentRevision))], metrics, failures };
  };
  const current = per("current"), next = per("new");
  const both = new Set(rows.filter(row => row.agent === "current").map(row => row.conversationId));
  const paired = rows.filter(row => row.agent === "new" && both.has(row.conversationId)).map(row => row.conversationId);
  const passedBy = (agent: SmartBenchAgentName) => new Set(rows.filter(row => row.agent === agent && row.conversation?.passed).map(row => row.conversationId));
  const currentPassed = passedBy("current"), newPassed = passedBy("new");
  return {
    current, new: next,
    comparison: { paired: paired.length, bothPass: paired.filter(id => currentPassed.has(id) && newPassed.has(id)).length,
      onlyNewPasses: paired.filter(id => newPassed.has(id) && !currentPassed.has(id)), onlyCurrentPasses: paired.filter(id => currentPassed.has(id) && !newPassed.has(id)),
      bothFail: paired.filter(id => !currentPassed.has(id) && !newPassed.has(id)).length },
  };
}

export async function readSmartBenchSelfTestRows(runId: string): Promise<SmartBenchStored[]> {
  const rows = await requireDb().select().from(savSyncState).where(like(savSyncState.key, `${smartItemKey(SAV_SMART_BENCH_SELFTEST_PREFIX, `${runId}:`)}%`));
  return rows.flatMap(row => {
    if (row.status !== "done" || !row.cursor) return [];
    try { const stored = decryptSavPayload<{ result: SmartBenchStored | null }>(row.cursor).result; return stored ? [stored] : []; } catch { return []; }
  });
}
export const readSmartBenchSelfTestReport = async (runId: string) => aggregateSmartBenchSelfTest(await readSmartBenchSelfTestRows(runId));
