import "server-only";
import { like } from "drizzle-orm";
import { requireDb } from "@/db";
import { savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../../crypto";
import { createSavBenchCurrentAgent, createSavBenchCurrentModel } from "../../bench/bench-agent-current";
import { SAV_BENCH_CORPUS, SAV_BENCH_CORPUS_REVISION } from "../../bench/bench-corpus";
import { createSavBenchGeminiJudge, SAV_BENCH_JUDGE_REVISION, type SavBenchJudge } from "../../bench/bench-judge";
import { runSavBench, savBenchCardsOf, savBenchMetrics, type SavBenchConversationRow, type SavBenchTurnRow } from "../../bench/bench-run";
import { SAV_BENCH_CRITERIA, savBenchNormalize, type SavBenchAgent, type SavBenchConversation, type SavBenchMessage } from "../../bench/bench-types";
import { buildSavBenchVariants, SAV_BENCH_VARIANTS_REVISION } from "../../bench/bench-variants";
import { resolveCaseV2GeminiKey, SAV_V2_MODEL_ENV, type CaseV2Network } from "../investigation-v2-providers";
import { readCaseV2TransportPolicy } from "../investigation-v2-spend";
import { SAV_SMART_MAX_EMBED_CALLS, SAV_SMART_MAX_MODEL_CALLS } from "./smart-agent";
import { createSavBenchAgent } from "./smart-bench-agent";
import { createSavBenchSearchAgent, emptySmartBenchSearchRecord, smartBenchNoJudge, type SmartBenchSearchRecord } from "./smart-bench-search";
import { smartDbKnowledge } from "./smart-knowledge";
import { createSmartBenchRealJudge, SAV_SMART_BENCH_REAL_JUDGE_REVISION, SMART_BENCH_REAL_CRITERIA, smartBenchRealPassed, type SmartBenchRealJudge,
  type SmartBenchRealJudgeResult } from "./smart-bench-real-judge";
import type { SmartSource } from "./smart-checks";
import { listSavAdmissibleCards, SAV_RETRIEVAL_EMBEDDING_DIMENSION } from "../../request-retrieval-db";
import type { SmartKnowledgePort } from "./smart-agent";
import { SAV_SMART_BENCH_MULTITURN, SAV_SMART_BENCH_MULTITURN_REVISION } from "./smart-bench-multiturn.fixture";
import { getAcademyTools } from "./tools/academy";
import { claimSmartItem, readSmartLedger, settleSmartItem, smartContainedErrorCode, smartItemKey, smartLedgerSpent } from "./smart-ledger";
import { smartGeminiEmbed, smartInputCap, smartPrices, smartUsageOf, type SmartEmbedPort } from "./smart-model";
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
 *
 * Corpus and passes (Ugo 20/11, cost control): `_SET` = `base` (default: the 132 conversations, unchanged) | `variants` (their paraphrase
 * variants, `bench-variants.ts`) | `all` (both) | `risky` (every sensitive conversation and every trap family, base and variants). `_PASSES` = 1
 * (default) or 2: pass 2 replays the same conversations under a distinct item key (`:p2`), claimed and paid on its own, to measure stability; every
 * stored row and log line carries its pass. Cap: default 10 000 000 µUSD, `_MAX_MICRO_USD` may raise it up to 15 000 000 (Ugo's 15 USD per run).
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_SMART_BENCH_SELFTEST_ENV = "SAV_V2_SMART_BENCH_SELFTEST";
export const SAV_SMART_BENCH_SELFTEST_ID_ENV = "SAV_V2_SMART_BENCH_SELFTEST_ID";
export const SAV_SMART_BENCH_SELFTEST_AGENT_ENV = "SAV_V2_SMART_BENCH_SELFTEST_AGENT";
export const SAV_SMART_BENCH_SELFTEST_BATCH_ENV = "SAV_V2_SMART_BENCH_SELFTEST_BATCH";
export const SAV_SMART_BENCH_SELFTEST_CAP_ENV = "SAV_V2_SMART_BENCH_SELFTEST_MAX_MICRO_USD";
export const SAV_SMART_BENCH_SELFTEST_SET_ENV = "SAV_V2_SMART_BENCH_SELFTEST_SET";
export const SAV_SMART_BENCH_SELFTEST_PASSES_ENV = "SAV_V2_SMART_BENCH_SELFTEST_PASSES";
export const SAV_SMART_BENCH_SELFTEST_CONCURRENCY_ENV = "SAV_V2_SMART_BENCH_SELFTEST_CONCURRENCY";
/** Conversations played at the same time in one pass (21/11): default 1 (one by one, as before), at most 8. */
export const SAV_SMART_BENCH_SELFTEST_DEFAULT_CONCURRENCY = 1, SAV_SMART_BENCH_SELFTEST_MAX_CONCURRENCY = 8;
export const SAV_SMART_BENCH_SELFTEST_PREFIX = "sav-v2-smart-bench-selftest.v1";
/** Ceiling of the run's cap (Ugo 20/11: 15 USD per run); without the env the cap stays at the default 10 000 000 µUSD. */
export const SAV_SMART_BENCH_SELFTEST_MAX_CAP_MICRO_USD = 15_000_000, SAV_SMART_BENCH_SELFTEST_DEFAULT_CAP_MICRO_USD = 10_000_000;
export const SAV_SMART_BENCH_SELFTEST_SETS = ["base", "variants", "all", "risky"] as const;
export type SmartBenchSelfTestSet = typeof SAV_SMART_BENCH_SELFTEST_SETS[number];
export type SmartBenchPass = 1 | 2;
export const SAV_SMART_BENCH_SELFTEST_DEFAULT_BATCH = 6, SAV_SMART_BENCH_SELFTEST_MAX_BATCH = 20;
const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/, INTEGER = /^[0-9]{1,12}$/;
const STEP_MIN_MS = 90_000, CONVERSATION_MIN_MS = 150_000, CALL_MAX_MS = 45_000, CALL_MIN_MS = 8_000, CALL_MARGIN_MS = 3_000;
const JUDGE_MAX_OUTPUT_TOKENS = 4_096;
/** `search` (21/11): the retrieval measurement, the new agent on the REAL Studio search, no judge (`smart-bench-search.ts`). Never part of `both`.
 * `real` (22/11): the same turn as `search`, each turn then judged by the REAL judge on the real cards returned (`smart-bench-real-judge.ts`). Never part of `both`. */
export type SmartBenchAgentName = "current" | "new" | "search" | "real";
/** The agents that run on the real Studio search (query embeddings paid, searches recorded). */
const smartBenchRealSearch = (agent: SmartBenchAgentName) => agent === "search" || agent === "real";
/** Ceilings per turn: V2's runner (`SAV_CASE_INVESTIGATION_MAX_CALLS`, 3) and the new agent (understand, 3 decide passes, verify, correct, reverify). Tested equal. */
export const SAV_SMART_BENCH_CURRENT_CALLS = 3, SAV_SMART_BENCH_NEW_CALLS = SAV_SMART_MAX_MODEL_CALLS;
/** The self-test corpus: the 120 bench conversations, plus the new agent's multi-turn cases (memory and progress rule, 20/11). */
export const SAV_SMART_BENCH_SELFTEST_CORPUS: readonly SavBenchConversation[] = [...SAV_BENCH_CORPUS, ...SAV_SMART_BENCH_MULTITURN];
export const SAV_SMART_BENCH_SELFTEST_CORPUS_REVISION = `${SAV_BENCH_CORPUS_REVISION}+${SAV_SMART_BENCH_MULTITURN_REVISION}`;
/** The paraphrase variants of those 132 conversations (3 each), expectations copied from their origin. */
export const SAV_SMART_BENCH_SELFTEST_VARIANTS: readonly SavBenchConversation[] = buildSavBenchVariants(SAV_SMART_BENCH_SELFTEST_CORPUS);

/** Sensitive: a turn (or a conditional reply) that expects the whole mail to go to the team. Risky set = sensitive or a trap family. */
const smartBenchSensitive = (row: SavBenchConversation) =>
  row.turns.some(turn => [turn.expect.outcome, ...turn.variants.map(variant => variant.expect?.outcome ?? [])].flat().includes("equipe_sensible"));
export const smartBenchRisky = (row: SavBenchConversation) => smartBenchSensitive(row) || row.family.startsWith("piege_");
/** The conversations of a set, in a stable order (base first, then variants). */
export function smartBenchSelfTestSet(set: SmartBenchSelfTestSet, base = SAV_SMART_BENCH_SELFTEST_CORPUS, variants = SAV_SMART_BENCH_SELFTEST_VARIANTS): readonly SavBenchConversation[] {
  if (set === "base") return base;
  if (set === "variants") return variants;
  const all = [...base, ...variants];
  return set === "all" ? all : all.filter(smartBenchRisky);
}
export const smartBenchSelfTestCorpusRevision = (set: SmartBenchSelfTestSet) =>
  set === "base" ? SAV_SMART_BENCH_SELFTEST_CORPUS_REVISION : `${SAV_SMART_BENCH_SELFTEST_CORPUS_REVISION}+${SAV_BENCH_VARIANTS_REVISION}:${set}`;

export type SmartBenchSelfTestConfig =
  | Readonly<{ mode: "off" }>
  | Readonly<{ mode: "refused"; reason: "id_invalid" | "agent_invalid" | "batch_invalid" | "cap_invalid" | "set_invalid" | "passes_invalid" | "concurrency_invalid" }>
  | Readonly<{ mode: "run"; runId: string; agents: readonly SmartBenchAgentName[]; batch: number; capMicroUsd: number; set: SmartBenchSelfTestSet; passes: SmartBenchPass }>;

/** The pass's concurrency: absent → 1; an integer from 1 to 8; anything else → null (the config is then refused, `concurrency_invalid`). */
export function readSmartBenchSelfTestConcurrency(env: Env): number | null {
  const raw = env[SAV_SMART_BENCH_SELFTEST_CONCURRENCY_ENV];
  if (raw === undefined) return SAV_SMART_BENCH_SELFTEST_DEFAULT_CONCURRENCY;
  const value = INTEGER.test(raw) ? Number(raw) : NaN;
  return value >= 1 && value <= SAV_SMART_BENCH_SELFTEST_MAX_CONCURRENCY ? value : null;
}

export function readSmartBenchSelfTestConfig(env: Env): SmartBenchSelfTestConfig {
  if (env[SAV_SMART_BENCH_SELFTEST_ENV] !== "run") return { mode: "off" };
  const runId = env[SAV_SMART_BENCH_SELFTEST_ID_ENV] ?? "";
  if (!RUN_ID.test(runId)) return { mode: "refused", reason: "id_invalid" };
  const agent = env[SAV_SMART_BENCH_SELFTEST_AGENT_ENV] ?? "both";
  if (agent !== "current" && agent !== "new" && agent !== "both" && agent !== "search" && agent !== "real") return { mode: "refused", reason: "agent_invalid" };
  const integer = (name: string, fallback: number, max: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = INTEGER.test(raw) ? Number(raw) : NaN;
    return value >= 1 && value <= max ? value : null;
  };
  const batch = integer(SAV_SMART_BENCH_SELFTEST_BATCH_ENV, SAV_SMART_BENCH_SELFTEST_DEFAULT_BATCH, SAV_SMART_BENCH_SELFTEST_MAX_BATCH);
  if (batch === null) return { mode: "refused", reason: "batch_invalid" };
  const capMicroUsd = integer(SAV_SMART_BENCH_SELFTEST_CAP_ENV, SAV_SMART_BENCH_SELFTEST_DEFAULT_CAP_MICRO_USD, SAV_SMART_BENCH_SELFTEST_MAX_CAP_MICRO_USD);
  if (capMicroUsd === null) return { mode: "refused", reason: "cap_invalid" };
  const set = env[SAV_SMART_BENCH_SELFTEST_SET_ENV] ?? "base";
  if (!(SAV_SMART_BENCH_SELFTEST_SETS as readonly string[]).includes(set)) return { mode: "refused", reason: "set_invalid" };
  const passes = integer(SAV_SMART_BENCH_SELFTEST_PASSES_ENV, 1, 2);
  if (passes === null) return { mode: "refused", reason: "passes_invalid" };
  if (readSmartBenchSelfTestConcurrency(env) === null) return { mode: "refused", reason: "concurrency_invalid" };
  return { mode: "run", runId, agents: agent === "both" ? ["current", "new"] : [agent], batch, capMicroUsd, set: set as SmartBenchSelfTestSet, passes: passes as SmartBenchPass };
}

/** Model calls an agent may make on one turn (the judge adds one, `real` included: its real judge is called on every turn): the current runner's ceiling, the new agent's. */
export const smartBenchCallsPerTurn = (agent: SmartBenchAgentName) => (agent === "current" ? SAV_SMART_BENCH_CURRENT_CALLS : SAV_SMART_BENCH_NEW_CALLS) + 1;
/** Query embeddings one turn may pay (search only): the first search and up to the agent's embed ceiling with `chercher_fiches`. */
export const smartBenchEmbedsPerTurn = (agent: SmartBenchAgentName) => (smartBenchRealSearch(agent) ? SAV_SMART_MAX_EMBED_CALLS : 0);
/** One item per (pass, agent, conversation); pass 1 keeps the historical key, pass 2 has its own (`:p2`), so it is claimed and paid separately. */
export const smartBenchItem = (runId: string, agent: SmartBenchAgentName, conversationId: string, pass: SmartBenchPass = 1) =>
  `${runId}:${agent}:${conversationId}${pass === 1 ? "" : `:p${pass}`}`;

export type SmartBenchStored = Readonly<{
  runId: string; agent: SmartBenchAgentName; agentRevision: string;
  /** 1 or 2 (absent on rows stored before passes existed: pass 1). */
  pass?: SmartBenchPass; set?: SmartBenchSelfTestSet; judgeRevision: string; corpusRevision: string; model: string; codeSha: string | null;
  conversationId: string; costMicroUsd: number; calls: number; durationMs: number;
  /** Why the conversation stopped early: the meter (`call_budget`, `deadline`), the bench (`sensitive_admitted`), or null. */
  stopped: string | null;
  conversation: SavBenchConversationRow | null; turns: readonly SavBenchTurnRow[];
  /** `real` only: the real judge's verdict of every turn played, and the real cards seen (short id and title, never their content). */
  real?: readonly SmartBenchRealTurn[];
}>;
export type SmartBenchRealTurn = Readonly<{
  turn: number; expected: readonly string[]; outcome: string; failure: string | null;
  /** null when the judge failed (« indéterminé », never « ok »). */
  passed: boolean | null; judge: SmartBenchRealJudgeResult;
  cards: readonly Readonly<{ id: string; title: string }>[];
}>;
export type SmartBenchSelfTestDeps = Readonly<{
  env: () => Env; now: () => Date; deadlineMs?: number; clock?: () => number;
  network?: CaseV2Network;
  /** Tests only: replaces the bench agents and the judge (they still go through the meter's network). */
  agents?: (name: SmartBenchAgentName, network: CaseV2Network) => SavBenchAgent;
  /** Tests only (search mode): replaces the real Studio search and the catalogue read. */
  searchKnowledge?: (embed: SmartEmbedPort, now: Date) => SmartKnowledgePort;
  searchCatalogue?: () => Promise<readonly { id: string; title: string; slug: string }[]>;
  judge?: (network: CaseV2Network) => SavBenchJudge;
  /** Tests only (real mode): replaces the real judge (it still goes through the meter's network). */
  realJudge?: (network: CaseV2Network) => SmartBenchRealJudge;
  corpus?: readonly SavBenchConversation[];
  log?: (event: string, fields: Record<string, unknown>) => void;
}>;
export type SmartBenchSelfTestPass =
  | Readonly<{ skipped: "off" | "deadline" | "prompt_unpinned" | "price_unavailable" | "model_invalid" | "key_unavailable" }>
  | Readonly<{ skipped: "refused"; reason: string }>
  | Readonly<{ skipped: "error_contained"; code: string }>
  | Readonly<{ ran: number; stoppedBy: "batch" | "done" | "deadline" | "money_cap"; spentMicroUsd: number; remaining: number }>;

/** `LIKE` pattern of the rows of one run: `_` and `%` (and the escape) of the run id taken literally, so `lot_1` never matches `lotA1`. */
export const smartBenchRunPattern = (runId: string) => `${smartItemKey(SAV_SMART_BENCH_SELFTEST_PREFIX, `${runId}:`).replace(/[\\%_]/g, char => `\\${char}`)}%`;

/**
 * One self-test batch. NEVER throws: any error (SQL at the reservation or the settlement, a lock held past its short bound, a bug) is contained
 * and returned as `{ skipped: "error_contained", code }` (a closed code, never a message), so the reconcile pass never turns red because of it.
 */
export async function runSmartBenchSelfTestPass(deps: SmartBenchSelfTestDeps): Promise<SmartBenchSelfTestPass> {
  const config = readSmartBenchSelfTestConfig(deps.env());
  if (config.mode === "off") return { skipped: "off" };
  const log = deps.log ?? ((event, fields) => console.info(event, JSON.stringify(fields)));
  try { return await runSmartBenchSelfTestPassUnsafe(deps, config, log); }
  catch (error) {
    const code = smartContainedErrorCode(error);
    try { log("sav_smart_bench_selftest_error_contained", { code }); } catch { /* the log never fails the pass */ }
    return { skipped: "error_contained", code };
  }
}

async function runSmartBenchSelfTestPassUnsafe(deps: SmartBenchSelfTestDeps, config: Exclude<SmartBenchSelfTestConfig, { mode: "off" }>,
  log: (event: string, fields: Record<string, unknown>) => void): Promise<SmartBenchSelfTestPass> {
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
  // The input bound the reservation is computed from (V2's `maxInputBytes`, or the lower own cap): every body sent, judge included, fits it.
  const inputCap = smartInputCap(env, now);
  if (inputCap === null) return { skipped: "price_unavailable" };

  const corpus = deps.corpus ?? smartBenchSelfTestSet(config.set), corpusRevision = smartBenchSelfTestCorpusRevision(config.set);
  const passes: readonly SmartBenchPass[] = config.passes === 2 ? [1, 2] : [1];
  const claimed = new Set((await requireDb().select({ key: savSyncState.key }).from(savSyncState)
    .where(like(savSyncState.key, smartBenchRunPattern(config.runId)))).map(row => row.key));
  const todo = passes.flatMap(pass => config.agents.flatMap(agent => corpus.map(conversation => ({ pass, agent, conversation }))))
    .filter(({ pass, agent, conversation }) => !claimed.has(smartItemKey(SAV_SMART_BENCH_SELFTEST_PREFIX, smartBenchItem(config.runId, agent, conversation.id, pass))));
  // Concurrency (21/11): N workers share the to-do list, each takes the next conversation. Concurrency 1 = the historical loop, unchanged.
  // - Batch: a slot is taken (`started`) BEFORE the claim and given back when the claim is refused, so N workers never start more than `_BATCH`.
  // - Money: the claim is atomic (the ledger row locked FOR UPDATE, the item checked in the same transaction) and counts every reservation still
  //   open, so the in-flight conversations' worst cases are counted: N parallel claims never pass the cap; the first refusal stops new starts.
  // - Time: no new conversation below 150 s left; each in-flight call still bounded by the time left (the meter, per conversation).
  // - Stop: the FIRST reason (batch, deadline, money cap, an error) wins; in-flight conversations finish, are settled and logged.
  const concurrency = readSmartBenchSelfTestConcurrency(env) ?? SAV_SMART_BENCH_SELFTEST_DEFAULT_CONCURRENCY;
  // Search only: the catalogue of the cards the search may return now (ids and titles, read only), once per pass that has work to do.
  if (config.agents.some(smartBenchRealSearch) && todo.length) try {
    const cards = await (deps.searchCatalogue ?? (() => listSavAdmissibleCards({ locale: "fr-FR", audience: "support", now })))();
    log("sav_smart_bench_search_catalogue", { runId: config.runId, count: cards.length, cards: cards.map(card => ({ id: card.id.slice(0, 8), title: card.title.slice(0, 120), slug: card.slug.slice(0, 80) })) });
  } catch { try { log("sav_smart_bench_search_catalogue", { runId: config.runId, count: null, error: "catalogue_unreadable" }); } catch { /* never fails the pass */ } }
  let ran = 0, started = 0, next = 0, stopped = false, overrun = false, stoppedBy: Extract<SmartBenchSelfTestPass, { ran: number }>["stoppedBy"] = todo.length ? "batch" : "done";
  const stop = (reason: typeof stoppedBy) => { if (!stopped) { stopped = true; stoppedBy = reason; } };
  const worker = async () => { while (!stopped && next < todo.length) {
    if (started >= config.batch) { stop("batch"); break; }
    if (left() < CONVERSATION_MIN_MS) { stop("deadline"); break; }
    const { pass, agent: agentName, conversation } = todo[next++]!;
    started += 1;
    const item = smartBenchItem(config.runId, agentName, conversation.id, pass), maxCalls = conversation.turns.length * smartBenchCallsPerTurn(agentName);
    const maxEmbeds = conversation.turns.length * smartBenchEmbedsPerTurn(agentName);
    const worst = maxCalls * prices.modelReserve + maxEmbeds * prices.embeddingReserve;
    let claim: Awaited<ReturnType<typeof claimSmartItem>>;
    try { claim = await claimSmartItem({ prefix: SAV_SMART_BENCH_SELFTEST_PREFIX, scope: config.runId, item, worstMicroUsd: worst, capMicroUsd: config.capMicroUsd, maxItems: null, now: deps.now() }); }
    catch (error) { started -= 1; throw error; }
    if (claim.status === "refused") { started -= 1; if (claim.reason === "already_claimed") continue; stop("money_cap"); break; }

    // The meter: every call of this conversation (agent and judge), refused BEFORE sending when its body exceeds the input bound, when the
    // conversation's spend plus one more reservation would pass its own reservation, or beyond the call count or the time left. Costed at
    // V2's prices from a COMPLETE usage (measured, even above the reservation); an incomplete or unreadable usage costs the reservation.
    let cost = 0, calls = 0, embeds = 0, meterStop: string | null = null;
    const send = deps.network ?? ((url, init) => fetch(url, init));
    const meter: CaseV2Network = async (url, init) => {
      const timeout = Math.min(CALL_MAX_MS, left() - CALL_MARGIN_MS);
      // A measured cost above a conversation's reservation (in parallel): no other in-flight conversation sends another call either.
      if (overrun) { meterStop ??= "money_budget"; return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_MONEY_BUDGET" }); }
      // Search only: a query embedding is its own budget (count and reservation), costed at V2's embedding reservation, never a model call.
      if (url.includes(":batchEmbedContents")) {
        if (embeds >= maxEmbeds) { meterStop ??= "call_budget"; return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_CALL_BUDGET" }); }
        if (timeout < CALL_MIN_MS) { meterStop ??= "deadline"; return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_DEADLINE" }); }
        if (cost + prices.embeddingReserve > worst) { meterStop ??= "money_budget"; return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_MONEY_BUDGET" }); }
        embeds += 1; cost += prices.embeddingReserve;
        return send(url, { ...init, signal: AbortSignal.timeout(timeout) });
      }
      if (calls >= maxCalls) { meterStop ??= "call_budget"; return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_CALL_BUDGET" }); }
      if (timeout < CALL_MIN_MS) { meterStop ??= "deadline"; return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_DEADLINE" }); }
      if (cost + prices.modelReserve > worst) { meterStop ??= "money_budget"; return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_MONEY_BUDGET" }); }
      const bodyBytes = typeof init.body === "string" ? Buffer.byteLength(init.body, "utf8") : init.body == null ? 0 : Number.POSITIVE_INFINITY;
      if (bodyBytes > inputCap) return new Response(null, { status: 400, statusText: "SAV_SMART_BENCH_INPUT_TOO_LARGE" });
      calls += 1;
      let response: Response;
      try { response = await send(url, { ...init, signal: AbortSignal.timeout(timeout) }); }
      catch (error) { cost += prices.modelReserve; throw error; }
      if (!response.ok) { cost += response.status >= 500 || response.status === 408 || response.status === 429 ? prices.modelReserve : 0; return response; }
      const json = await response.json().catch(() => null) as { usageMetadata?: unknown } | null;
      cost += prices.modelCost(smartUsageOf(json?.usageMetadata));
      if (cost > worst) { overrun = true; stop("money_cap"); }
      return json === null ? new Response("not json", { status: 200 }) : Response.json(json);
    };
    const record: SmartBenchSearchRecord = emptySmartBenchSearchRecord(conversation);
    // Real mode: the real cards every search of the current turn returned, kept in memory for the real judge only (never logged nor stored).
    let turnSources: SmartSource[] = [];
    const searchKnowledge = deps.searchKnowledge ?? ((embed: SmartEmbedPort, at: Date) => smartDbKnowledge({ now: () => at, embed }));
    const agent = deps.agents?.(agentName, meter) ?? (smartBenchRealSearch(agentName)
      ? createSavBenchSearchAgent({ network: meter, env, conversation, record, academy: getAcademyTools(), name: agentName === "real" ? "real" : "search",
        embed: smartGeminiEmbed({ env: () => env, now: deps.now, network: meter, dimension: SAV_RETRIEVAL_EMBEDDING_DIMENSION, callTimeoutMs: () => Math.min(CALL_MAX_MS, left() - CALL_MARGIN_MS) }),
        knowledge: agentName === "real" ? (embed, at) => { const port = searchKnowledge(embed, at); return async needs => {
          const result = await port(needs); turnSources.push(...result.sources); return result; }; } : searchKnowledge })
      : agentName === "new"
      // Academy (off unless `SAV_V2_SMART_ACADEMY=on`) is a free public read: it does not go through the meter.
      ? createSavBenchAgent({ dryRun: false, network: meter, env, academy: getAcademyTools() })
      : createSavBenchCurrentAgent({ model: createSavBenchCurrentModel({ env, network: meter, dryRun: false }), revision: `v2-decision:${model}` }));
    // The failed turns' detail (`sav_smart_bench_turn_detail`): what the agent received and gave back on each turn, captured here only.
    const captures = new Map<number, SmartBenchTurnCapture>(), realCaptures = new Map<number, SmartBenchRealCapture>();
    const played: SavBenchAgent = { name: agent.name, revision: agent.revision, respond: async input => {
      turnSources = [];
      const turn = await agent.respond(input);
      captures.set(input.turn, { customerMessage: input.messages.at(-1)?.text ?? "", citations: turn.citations, handoffNote: turn.handoffNote ?? null });
      if (agentName === "real") realCaptures.set(input.turn, { messages: input.messages, now: input.now, sources: turnSources });
      return turn;
    } };
    // The bench judge never runs on the real search (its grid reads the fictional cards): `real` has its own judge, called below on every turn.
    const judge = smartBenchRealSearch(agentName) ? smartBenchNoJudge : deps.judge?.(meter) ?? createSavBenchGeminiJudge({ network: meter, model, key: key.ok ? key.key : "", maxOutputTokens, maxInputBytes: inputCap });
    const realJudge = agentName === "real" ? deps.realJudge?.(meter) ?? createSmartBenchRealJudge({ network: meter, model, key: key.ok ? key.key : "", maxOutputTokens, maxInputBytes: inputCap }) : null;
    const startedAt = clock();
    let stored: SmartBenchStored;
    try {
      const report = await runSavBench({ conversations: [conversation], agent: played, judge, passes: 1, stopOnSensitiveAdmitted: true, shouldStop: () => meterStop });
      // Real mode: one real-judge call per turn played (answer, question or handoff), through the same meter, counted in the claim's worst case.
      const real: SmartBenchRealTurn[] = [];
      if (realJudge) for (const row of report.turns) {
        const capture = realCaptures.get(row.turn), sources = capture?.sources ?? [];
        const verdict: SmartBenchRealJudgeResult = meterStop || !capture ? { status: "failed", problem: meterStop ? `stopped_${meterStop}` : "turn_not_captured" }
          : await realJudge.judge({ messages: capture.messages, now: capture.now, expected: row.expected,
            agent: { outcome: row.outcome, reply: row.reply, handoffNote: captures.get(row.turn)?.handoffNote ?? null }, cards: sources });
        const seen = new Set<string>();
        real.push({ turn: row.turn, expected: [...row.expected], outcome: row.outcome, failure: row.failure,
          passed: verdict.status === "ok" ? smartBenchRealPassed(verdict.verdicts) : null, judge: verdict,
          cards: sources.filter(source => !seen.has(source.cardId) && Boolean(seen.add(source.cardId))).slice(0, 10)
            .map(source => ({ id: source.cardId.slice(0, 8), title: clip(source.title, 120) ?? "" })) });
      }
      stored = { runId: config.runId, agent: agentName, agentRevision: agent.revision, pass, set: config.set,
        judgeRevision: agentName === "real" ? SAV_SMART_BENCH_REAL_JUDGE_REVISION : SAV_BENCH_JUDGE_REVISION, corpusRevision, model,
        codeSha: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 40) ?? null, conversationId: conversation.id, costMicroUsd: cost, calls, durationMs: clock() - startedAt,
        stopped: meterStop ?? report.stopped?.reason ?? null, conversation: report.conversations[0] ?? null, turns: report.turns, ...(realJudge ? { real } : {}) };
    } catch {
      stored = { runId: config.runId, agent: agentName, agentRevision: agent.revision, pass, set: config.set,
        judgeRevision: agentName === "real" ? SAV_SMART_BENCH_REAL_JUDGE_REVISION : SAV_BENCH_JUDGE_REVISION, corpusRevision, model,
        codeSha: null, conversationId: conversation.id, costMicroUsd: worst, calls, durationMs: clock() - startedAt, stopped: "crashed", conversation: null, turns: [] };
      cost = Math.max(cost, worst);
      stored = { ...stored, costMicroUsd: cost };
    }
    // The measured cost, never clipped to the reservation: above it, the ledger sees the real spend and refuses the next claim at the cap.
    await settleSmartItem({ prefix: SAV_SMART_BENCH_SELFTEST_PREFIX, scope: config.runId, item, costMicroUsd: cost, status: "done", now: deps.now(), result: stored });
    // One line per conversation, codes and numbers only (fictional corpus ids, no reply text): the judge's verdict readable from the logs.
    try { log("sav_smart_bench_conversation", smartBenchConversationLine(stored)); } catch { /* the log never fails the pass */ }
    // Failed turns only, judged agents only (search has no judge): the reply text and the judge's words, to tell a real fault from a false
    // positive. Safe because the conversation is one of the bundled FICTIONAL ones (guarded again in `smartBenchTurnDetailLine`).
    if (!smartBenchRealSearch(agentName)) for (const row of stored.turns) {
      if (row.verdict.passed) continue;
      try { const line = smartBenchTurnDetailLine(stored, row, conversation, captures.get(row.turn)); if (line) log("sav_smart_bench_turn_detail", line); }
      catch { /* the log never fails the pass */ }
    }
    // Search only: the record of every search (fictional needs, real cards by short id and title), the material of the retrieval analysis.
    if (smartBenchRealSearch(agentName)) try { log("sav_smart_bench_search", { runId: config.runId, pass, ...record }); } catch { /* never fails the pass */ }
    // Real only: EVERY turn (not only failed ones), so the replies can be read: fictional texts, verdicts and reasons, real cards by short id and title.
    if (agentName === "real") for (const realTurn of stored.real ?? []) {
      try { const line = smartBenchRealTurnLine(stored, realTurn, conversation, captures.get(realTurn.turn)); if (line) log("sav_smart_bench_real_turn", line); }
      catch { /* the log never fails the pass */ }
    }
    ran += 1;
    if (meterStop === "deadline") { stop("deadline"); break; }
  } };
  // Every worker runs to its end (none left spending in the background); the first error, if any, is then contained by the caller.
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(concurrency, Math.max(1, todo.length)) }, async () => {
    try { await worker(); } catch (error) { stopped = true; throw error; }
  }));
  const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failed) throw failed.reason;
  const spentMicroUsd = smartLedgerSpent(await readSmartLedger(SAV_SMART_BENCH_SELFTEST_PREFIX, config.runId));
  const remaining = Math.max(0, todo.length - ran);
  const result = { ran, stoppedBy: ran === todo.length && stoppedBy === "batch" ? "done" as const : stoppedBy, spentMicroUsd, remaining };
  log("sav_smart_bench_selftest", { ...result, runId: config.runId, agents: config.agents, set: config.set, passes: config.passes, model, revision: SAV_SMART_PROMPT_REVISION, promptSha256: smartPromptSha256().slice(0, 16) });
  // Run complete: the aggregated report (the same as `readSmartBenchSelfTestReport`), codes and numbers only, on every pass until switched off.
  if (remaining === 0) {
    try { log("sav_smart_bench_report", smartBenchReportLine(config.runId, aggregateSmartBenchSelfTest(await readSmartBenchSelfTestRows(config.runId)))); }
    catch { /* the report never fails the pass */ }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Report for root: aggregates by family and criterion, current/new comparison, failures with their conversation id. Codes and numbers only.
// ---------------------------------------------------------------------------------------------------------------------------------
export const smartBenchStoredPass = (row: SmartBenchStored): SmartBenchPass => row.pass ?? 1;
export function aggregateSmartBenchSelfTest(allRows: readonly SmartBenchStored[]) {
  // The metrics, failures and comparison read pass 1; pass 2 has its own metrics and the stability list (conversations that changed).
  const rows = allRows.filter(row => smartBenchStoredPass(row) === 1);
  const per = (agent: SmartBenchAgentName, source: readonly SmartBenchStored[] = rows) => {
    const mine = source.filter(row => row.agent === agent);
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
  const second = allRows.filter(row => smartBenchStoredPass(row) === 2);
  const stability = (agent: SmartBenchAgentName) => {
    const firstBy = new Map(rows.filter(row => row.agent === agent).map(row => [row.conversationId, row]));
    const signature = (row: SmartBenchStored) => `${row.conversation?.passed ?? false}|${row.turns.map(turn => turn.outcome).join(",")}`;
    const compared = second.filter(row => row.agent === agent && firstBy.has(row.conversationId));
    return { compared: compared.length, unstable: compared.filter(row => signature(row) !== signature(firstBy.get(row.conversationId)!)).map(row => {
      const first = firstBy.get(row.conversationId)!;
      return { conversationId: row.conversationId, family: row.conversation?.family ?? first.conversation?.family ?? null,
        pass1: { passed: first.conversation?.passed ?? false, outcomes: first.turns.map(turn => turn.outcome) }, pass2: { passed: row.conversation?.passed ?? false, outcomes: row.turns.map(turn => turn.outcome) } };
    }) };
  };
  // `real` (22/11): its own side (pass 1), present only when the run has real rows, so the other modes' report is unchanged.
  const real = aggregateSmartBenchReal(rows);
  return {
    current, new: next, ...(real ? { real } : {}),
    pass2: second.length ? { current: per("current", second), new: per("new", second), stability: { current: stability("current"), new: stability("new") } } : null,
    comparison: { paired: paired.length, bothPass: paired.filter(id => currentPassed.has(id) && newPassed.has(id)).length,
      onlyNewPasses: paired.filter(id => newPassed.has(id) && !currentPassed.has(id)), onlyCurrentPasses: paired.filter(id => currentPassed.has(id) && !newPassed.has(id)),
      bothFail: paired.filter(id => !currentPassed.has(id) && !newPassed.has(id)).length },
  };
}

const SMART_BENCH_REPORT_MAX_FAILURES = 150;
const turnFailure = (row: SavBenchTurnRow) => ({ turn: row.turn, expected: row.expected, outcome: row.outcome,
  failed: Object.entries(row.verdict.criteria).filter(([, value]) => value.final === "echec").map(([criterion]) => criterion), checks: row.checks.map(hit => hit.code), failure: row.failure,
  // SAV-122 diagnostic: the agent's closed codes (reasons, refusing check and counter-read codes, calls), never a text.
  codes: [...row.codes, ...row.checks.flatMap(hit => hit.label ? [`bench:${hit.label}`] : [])].filter(code => /^[a-z0-9_:.>-]{1,80}$/.test(code)) });
/** The per-conversation log line: verdict, failed turns with their failed criteria and check codes, cost. Never a reply or a judge's text. */
export function smartBenchConversationLine(stored: SmartBenchStored) {
  return { runId: stored.runId, pass: stored.pass ?? 1, agent: stored.agent, conversationId: stored.conversationId, family: stored.conversation?.family ?? null,
    passed: stored.conversation?.passed ?? false, endedBy: stored.conversation?.endedBy ?? null, turnsPlayed: stored.conversation?.turnsPlayed ?? 0,
    failedTurns: stored.turns.filter(row => !row.verdict.passed).map(turnFailure), stopped: stored.stopped, costMicroUsd: stored.costMicroUsd, calls: stored.calls };
}
/*
 * `sav_smart_bench_turn_detail` (22/11): ONE line per FAILED turn of the self-test, with the texts the per-conversation line never carries (the
 * customer's message, the reply, the question, the team's note, the judge's justifications, the forbidden pattern's matched snippet). Last
 * night's 9 « serious » turns (8 `faits_sources`, 1 `PWD_ASKED_2`) could not be told from false positives without them.
 * PRIVACY: only the bench's bundled FICTIONAL conversations may reach this line. The guard is by identity: the conversation must be one of the
 * self-test corpus or variants objects built at module load (never a row read from the database, a shadow case or a real mail); anything else
 * returns null and nothing is logged. Every text is truncated and the whole line kept under 6 000 bytes.
 */
const SMART_BENCH_FICTIONAL = new Set<SavBenchConversation>([...SAV_SMART_BENCH_SELFTEST_CORPUS, ...SAV_SMART_BENCH_SELFTEST_VARIANTS]);
export const smartBenchFictional = (conversation: SavBenchConversation) => SMART_BENCH_FICTIONAL.has(conversation);
export type SmartBenchTurnCapture = Readonly<{ customerMessage: string; citations: readonly string[]; handoffNote: string | null }>;
export const SMART_BENCH_TURN_DETAIL_MAX_BYTES = 6_000;
const SMART_BENCH_TURN_DETAIL_LIMITS = { customerMessage: 800, reply: 2_500, question: 600, handoffNote: 800, explanation: 1_200, detail: 200 };
const clip = (value: string | null | undefined, max: number): string | null => value == null ? null : value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;

/** The part of the reply a forbidden pattern matched (read on the normalized reply, as the check does), with some context, ≤ 160 chars. */
export function smartBenchForbiddenSnippet(reply: string, source: string, max = 160): string | null {
  const normalized = savBenchNormalize(reply);
  let match: RegExpExecArray | null;
  try { match = new RegExp(source, "iu").exec(normalized); } catch { return null; }
  if (!match) return null;
  // Same length: the offsets hold on the original reply (accents kept); otherwise the normalized text is shown.
  const text = normalized.length === reply.length ? reply : normalized, pad = Math.max(0, Math.floor((max - match[0].length) / 2));
  const start = Math.max(0, match.index - pad);
  return clip(text.slice(start, Math.min(text.length, match.index + match[0].length + pad)), max);
}
/** The questions of an « ask » turn: the reply's sentences with a question mark. */
const smartBenchQuestion = (reply: string | null) => {
  const questions = (reply ?? "").split(/(?<=[.!?\n])\s+/).filter(sentence => sentence.includes("?")).map(sentence => sentence.trim());
  return questions.length ? questions.join(" ") : null;
};

export function smartBenchTurnDetailLine(stored: SmartBenchStored, row: SavBenchTurnRow, conversation: SavBenchConversation, capture: SmartBenchTurnCapture | undefined) {
  if (!smartBenchFictional(conversation) || conversation.id !== row.conversationId) return null;
  const cards = new Map(savBenchCardsOf(conversation).map(card => [card.id, card.title]));
  const failed = SAV_BENCH_CRITERIA.filter(criterion => row.verdict.criteria[criterion].final === "echec");
  const build = (limits: typeof SMART_BENCH_TURN_DETAIL_LIMITS) => {
    const judge = row.judge === null ? { status: "non_appele" as const }
      : row.judge.status === "failed" ? { status: "failed" as const, problem: row.judge.problem.slice(0, 80) }
      : { status: "ok" as const, verdicts: Object.fromEntries(SAV_BENCH_CRITERIA.map(criterion => [criterion, (row.judge as Extract<typeof row.judge, { status: "ok" }>).verdicts[criterion].verdict])),
        // The judge's own justification of every criterion that did not end « ok » (its words, even where it said « ok » and a check fired).
        explanation: clip(SAV_BENCH_CRITERIA.filter(criterion => row.verdict.criteria[criterion].final !== "ok")
          .map(criterion => `${criterion}: ${(row.judge as Extract<typeof row.judge, { status: "ok" }>).verdicts[criterion].justification}`).join(" | ") || null, limits.explanation) };
    return {
      runId: stored.runId, pass: stored.pass ?? 1, agent: stored.agent, conversationId: row.conversationId, family: row.family, turn: row.turn,
      expectedOutcomes: row.expected, outcome: row.outcome, failed, failure: row.failure,
      checks: row.checks.slice(0, 10).map(hit => ({ code: hit.code, criterion: hit.criterion, ...(hit.label ? { label: hit.label } : {}), detail: clip(hit.detail, limits.detail) })),
      codes: [...row.codes, ...row.checks.flatMap(hit => hit.label ? [`bench:${hit.label}`] : [])].filter(code => /^[a-z0-9_:.>-]{1,80}$/.test(code)).slice(0, 20),
      customerMessage: clip(capture?.customerMessage ?? null, limits.customerMessage),
      reply: clip(row.reply, limits.reply),
      question: row.outcome === "demander" ? clip(smartBenchQuestion(row.reply), limits.question) : null,
      handoffNote: clip(capture?.handoffNote ?? null, limits.handoffNote),
      judge,
      forbiddenMatches: row.checks.filter(hit => hit.code === "forbidden_pattern").slice(0, 5)
        .map(hit => ({ pattern: hit.label ?? "forbidden_pattern", source: hit.detail.slice(0, 120), snippet: row.reply ? smartBenchForbiddenSnippet(row.reply, hit.detail) : null })),
      citedCards: (capture?.citations ?? []).slice(0, 10).map(id => ({ id: id.slice(0, 80), title: clip(cards.get(id) ?? null, 120) })),
    };
  };
  // Under the byte cap: the longest texts shrink first (reply, note, customer message, explanation, question, check details).
  const limits = { ...SMART_BENCH_TURN_DETAIL_LIMITS };
  let line = build(limits);
  for (const key of ["reply", "handoffNote", "customerMessage", "explanation", "question", "detail"] as const) {
    const excess = Buffer.byteLength(JSON.stringify(line), "utf8") - SMART_BENCH_TURN_DETAIL_MAX_BYTES;
    if (excess <= 0) break;
    const length = key === "explanation" ? (line.judge.status === "ok" ? line.judge.explanation?.length ?? 0 : 0)
      : key === "detail" ? Math.max(0, ...line.checks.map(hit => hit.detail?.length ?? 0)) : line[key]?.length ?? 0;
    if (!length) continue;
    limits[key] = Math.max(key === "detail" ? 40 : 120, Math.min(limits[key], length) - excess - 16);
    line = build(limits);
  }
  return line;
}

/*
 * `sav_smart_bench_real_turn` (22/11, mode `real`): ONE line per turn played, failed or not, so Ugo can read the replies made on the real cards.
 * The fictional texts (customer's message, reply, question, team's note, same bounds as the turn detail), the real judge's verdicts and reasons,
 * and the real cards by SHORT ID AND TITLE ONLY: the cards' content is never logged (nor stored). Same fictional-only guard, same 6 000-byte cap.
 */
export type SmartBenchRealCapture = Readonly<{ messages: readonly SavBenchMessage[]; now: string; sources: readonly SmartSource[] }>;
const SMART_BENCH_REAL_REASON_MAX = 300;
export function smartBenchRealTurnLine(stored: SmartBenchStored, realTurn: SmartBenchRealTurn, conversation: SavBenchConversation, capture: SmartBenchTurnCapture | undefined) {
  if (!smartBenchFictional(conversation) || conversation.id !== stored.conversationId) return null;
  const row = stored.turns.find(turn => turn.turn === realTurn.turn);
  const build = (limits: typeof SMART_BENCH_TURN_DETAIL_LIMITS & { reason: number }) => ({
    runId: stored.runId, pass: stored.pass ?? 1, agent: stored.agent, conversationId: stored.conversationId, family: conversation.family, turn: realTurn.turn,
    expectedOutcomes: realTurn.expected, outcome: realTurn.outcome, failure: realTurn.failure, passed: realTurn.passed,
    customerMessage: clip(capture?.customerMessage ?? null, limits.customerMessage),
    reply: clip(row?.reply ?? null, limits.reply),
    question: realTurn.outcome === "demander" ? clip(smartBenchQuestion(row?.reply ?? null), limits.question) : null,
    handoffNote: clip(capture?.handoffNote ?? null, limits.handoffNote),
    judge: realTurn.judge.status === "failed" ? { status: "failed" as const, problem: realTurn.judge.problem.slice(0, 80) }
      : { status: "ok" as const, verdicts: Object.fromEntries(SMART_BENCH_REAL_CRITERIA.map(criterion => {
        const value = (realTurn.judge as Extract<SmartBenchRealJudgeResult, { status: "ok" }>).verdicts[criterion];
        return [criterion, { verdict: value.verdict, reason: clip(value.reason, limits.reason) }];
      })) },
    cards: realTurn.cards.slice(0, 10).map(card => ({ id: card.id.slice(0, 8), title: clip(card.title, 120) })),
  });
  const limits = { ...SMART_BENCH_TURN_DETAIL_LIMITS, reason: SMART_BENCH_REAL_REASON_MAX };
  let line = build(limits);
  for (const key of ["reply", "handoffNote", "customerMessage", "reason", "question"] as const) {
    const excess = Buffer.byteLength(JSON.stringify(line), "utf8") - SMART_BENCH_TURN_DETAIL_MAX_BYTES;
    if (excess <= 0) break;
    const length = key === "reason" ? (line.judge.status === "ok" ? Math.max(0, ...Object.values(line.judge.verdicts).map(value => (value as { reason: string | null }).reason?.length ?? 0)) : 0)
      : line[key]?.length ?? 0;
    if (!length) continue;
    limits[key] = Math.max(key === "reason" ? 60 : 120, Math.min(limits[key], length) - (key === "reason" ? Math.ceil(excess / SMART_BENCH_REAL_CRITERIA.length) : excess) - 16);
    line = build(limits);
  }
  return line;
}

/** The `real` side of the report: rates per criterion and per family, the `no_card` count, failed turns (codes only). Null without real rows. */
export function aggregateSmartBenchReal(rows: readonly SmartBenchStored[]) {
  const mine = rows.filter(row => row.agent === "real");
  if (!mine.length) return null;
  const turns = mine.flatMap(row => (row.real ?? []).map(turn => ({ ...turn, conversationId: row.conversationId, family: row.conversation?.family ?? "inconnue" })));
  const rate = (ok: number, echec: number) => ok + echec ? Math.round((ok / (ok + echec)) * 1000) / 1000 : null;
  const tally = (list: typeof turns) => {
    const judged = list.filter(turn => turn.judge.status === "ok") as Array<(typeof turns)[number] & { judge: Extract<SmartBenchRealJudgeResult, { status: "ok" }> }>;
    const byCriterion = Object.fromEntries(SMART_BENCH_REAL_CRITERIA.map(criterion => {
      const count = (verdict: string) => judged.filter(turn => turn.judge.verdicts[criterion].verdict === verdict).length;
      const ok = count("ok"), echec = count("echec");
      return [criterion, { ok, echec, sans_objet: count("sans_objet"), no_card: count("no_card"), rate: rate(ok, echec) }];
    }));
    const passed = list.filter(turn => turn.passed === true).length, failed = list.filter(turn => turn.passed === false).length;
    return { turns: list.length, judged: judged.length, judgeFailures: list.length - judged.length, passed, failed, passRate: rate(passed, failed), byCriterion };
  };
  const families = [...new Set(turns.map(turn => turn.family))].sort();
  return {
    conversationsStored: mine.length, costMicroUsd: mine.reduce((sum, row) => sum + row.costMicroUsd, 0), calls: mine.reduce((sum, row) => sum + row.calls, 0),
    revisions: [...new Set(mine.map(row => row.agentRevision))], stopped: mine.filter(row => row.stopped).map(row => ({ conversationId: row.conversationId, reason: row.stopped })),
    conversationsPassed: mine.filter(row => (row.real ?? []).length > 0 && (row.real ?? []).every(turn => turn.passed === true) && !row.stopped).length,
    noCard: turns.filter(turn => turn.judge.status === "ok" && turn.judge.verdicts.decision.verdict === "no_card").length,
    ...tally(turns),
    byFamily: Object.fromEntries(families.map(family => [family, tally(turns.filter(turn => turn.family === family))])),
    failures: turns.filter(turn => turn.passed !== true).map(turn => ({ conversationId: turn.conversationId, family: turn.family, turn: turn.turn, expected: turn.expected, outcome: turn.outcome,
      failed: turn.judge.status === "ok" ? SMART_BENCH_REAL_CRITERIA.filter(criterion => (turn.judge as Extract<SmartBenchRealJudgeResult, { status: "ok" }>).verdicts[criterion].verdict === "echec") : [],
      judgeProblem: turn.judge.status === "failed" ? turn.judge.problem.slice(0, 80) : null })),
  };
}

/** The run's report as one log line: metrics per agent, the comparison, and at most 150 failed turns per agent (the count says if cut). */
export function smartBenchReportLine(runId: string, report: ReturnType<typeof aggregateSmartBenchSelfTest>) {
  const side = (agent: ReturnType<typeof aggregateSmartBenchSelfTest>["current"]) => ({
    conversationsStored: agent.conversationsStored, costMicroUsd: agent.costMicroUsd, calls: agent.calls, revisions: agent.revisions, stopped: agent.stopped,
    metrics: agent.metrics, failuresCount: agent.failures.length, failures: agent.failures.slice(0, SMART_BENCH_REPORT_MAX_FAILURES) });
  const stabilityLine = (value: NonNullable<typeof report.pass2>["stability"]["current"]) => ({ compared: value.compared, unstableCount: value.unstable.length, unstable: value.unstable.slice(0, SMART_BENCH_REPORT_MAX_FAILURES) });
  return { runId, current: side(report.current), new: side(report.new), comparison: report.comparison,
    pass2: report.pass2 ? { current: side(report.pass2.current), new: side(report.pass2.new),
      stability: { current: stabilityLine(report.pass2.stability.current), new: stabilityLine(report.pass2.stability.new) } } : null,
    ...(report.real ? { real: { ...report.real, failuresCount: report.real.failures.length, failures: report.real.failures.slice(0, SMART_BENCH_REPORT_MAX_FAILURES) } } : {}) };
}

export async function readSmartBenchSelfTestRows(runId: string): Promise<SmartBenchStored[]> {
  const rows = await requireDb().select().from(savSyncState).where(like(savSyncState.key, smartBenchRunPattern(runId)));
  return rows.flatMap(row => {
    if (row.status !== "done" || !row.cursor) return [];
    try { const stored = decryptSavPayload<{ result: SmartBenchStored | null }>(row.cursor).result; return stored ? [stored] : []; } catch { return []; }
  });
}
export const readSmartBenchSelfTestReport = async (runId: string) => aggregateSmartBenchSelfTest(await readSmartBenchSelfTestRows(runId));
