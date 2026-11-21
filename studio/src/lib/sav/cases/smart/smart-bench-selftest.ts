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
import { buildSavBenchVariants, SAV_BENCH_VARIANTS_REVISION } from "../../bench/bench-variants";
import { resolveCaseV2GeminiKey, SAV_V2_MODEL_ENV, type CaseV2Network } from "../investigation-v2-providers";
import { readCaseV2TransportPolicy } from "../investigation-v2-spend";
import { SAV_SMART_MAX_EMBED_CALLS, SAV_SMART_MAX_MODEL_CALLS } from "./smart-agent";
import { createSavBenchAgent } from "./smart-bench-agent";
import { createSavBenchSearchAgent, emptySmartBenchSearchRecord, smartBenchNoJudge, type SmartBenchSearchRecord } from "./smart-bench-search";
import { smartDbKnowledge } from "./smart-knowledge";
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
/** `search` (21/11): the retrieval measurement, the new agent on the REAL Studio search, no judge (`smart-bench-search.ts`). Never part of `both`. */
export type SmartBenchAgentName = "current" | "new" | "search";
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
  if (agent !== "current" && agent !== "new" && agent !== "both" && agent !== "search") return { mode: "refused", reason: "agent_invalid" };
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

/** Model calls an agent may make on one turn (the judge adds one): the current runner's ceiling, the new agent's five. */
export const smartBenchCallsPerTurn = (agent: SmartBenchAgentName) => (agent === "current" ? SAV_SMART_BENCH_CURRENT_CALLS : SAV_SMART_BENCH_NEW_CALLS) + 1;
/** Query embeddings one turn may pay (search only): the first search and up to the agent's embed ceiling with `chercher_fiches`. */
export const smartBenchEmbedsPerTurn = (agent: SmartBenchAgentName) => (agent === "search" ? SAV_SMART_MAX_EMBED_CALLS : 0);
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
  if (config.agents.includes("search") && todo.length) try {
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
    const agent = deps.agents?.(agentName, meter) ?? (agentName === "search"
      ? createSavBenchSearchAgent({ network: meter, env, conversation, record, academy: getAcademyTools(),
        embed: smartGeminiEmbed({ env: () => env, now: deps.now, network: meter, dimension: SAV_RETRIEVAL_EMBEDDING_DIMENSION, callTimeoutMs: () => Math.min(CALL_MAX_MS, left() - CALL_MARGIN_MS) }),
        knowledge: deps.searchKnowledge ?? ((embed, at) => smartDbKnowledge({ now: () => at, embed })) })
      : agentName === "new"
      // Academy (off unless `SAV_V2_SMART_ACADEMY=on`) is a free public read: it does not go through the meter.
      ? createSavBenchAgent({ dryRun: false, network: meter, env, academy: getAcademyTools() })
      : createSavBenchCurrentAgent({ model: createSavBenchCurrentModel({ env, network: meter, dryRun: false }), revision: `v2-decision:${model}` }));
    const judge = agentName === "search" ? smartBenchNoJudge : deps.judge?.(meter) ?? createSavBenchGeminiJudge({ network: meter, model, key: key.ok ? key.key : "", maxOutputTokens, maxInputBytes: inputCap });
    const startedAt = clock();
    let stored: SmartBenchStored;
    try {
      const report = await runSavBench({ conversations: [conversation], agent, judge, passes: 1, stopOnSensitiveAdmitted: true, shouldStop: () => meterStop });
      stored = { runId: config.runId, agent: agentName, agentRevision: agent.revision, pass, set: config.set, judgeRevision: SAV_BENCH_JUDGE_REVISION, corpusRevision, model,
        codeSha: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 40) ?? null, conversationId: conversation.id, costMicroUsd: cost, calls, durationMs: clock() - startedAt,
        stopped: meterStop ?? report.stopped?.reason ?? null, conversation: report.conversations[0] ?? null, turns: report.turns };
    } catch {
      stored = { runId: config.runId, agent: agentName, agentRevision: agent.revision, pass, set: config.set, judgeRevision: SAV_BENCH_JUDGE_REVISION, corpusRevision, model,
        codeSha: null, conversationId: conversation.id, costMicroUsd: worst, calls, durationMs: clock() - startedAt, stopped: "crashed", conversation: null, turns: [] };
      cost = Math.max(cost, worst);
      stored = { ...stored, costMicroUsd: cost };
    }
    // The measured cost, never clipped to the reservation: above it, the ledger sees the real spend and refuses the next claim at the cap.
    await settleSmartItem({ prefix: SAV_SMART_BENCH_SELFTEST_PREFIX, scope: config.runId, item, costMicroUsd: cost, status: "done", now: deps.now(), result: stored });
    // One line per conversation, codes and numbers only (fictional corpus ids, no reply text): the judge's verdict readable from the logs.
    try { log("sav_smart_bench_conversation", smartBenchConversationLine(stored)); } catch { /* the log never fails the pass */ }
    // Search only: the record of every search (fictional needs, real cards by short id and title), the material of the retrieval analysis.
    if (agentName === "search") try { log("sav_smart_bench_search", { runId: config.runId, pass, ...record }); } catch { /* never fails the pass */ }
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
  return {
    current, new: next,
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
/** The run's report as one log line: metrics per agent, the comparison, and at most 150 failed turns per agent (the count says if cut). */
export function smartBenchReportLine(runId: string, report: ReturnType<typeof aggregateSmartBenchSelfTest>) {
  const side = (agent: ReturnType<typeof aggregateSmartBenchSelfTest>["current"]) => ({
    conversationsStored: agent.conversationsStored, costMicroUsd: agent.costMicroUsd, calls: agent.calls, revisions: agent.revisions, stopped: agent.stopped,
    metrics: agent.metrics, failuresCount: agent.failures.length, failures: agent.failures.slice(0, SMART_BENCH_REPORT_MAX_FAILURES) });
  const stabilityLine = (value: NonNullable<typeof report.pass2>["stability"]["current"]) => ({ compared: value.compared, unstableCount: value.unstable.length, unstable: value.unstable.slice(0, SMART_BENCH_REPORT_MAX_FAILURES) });
  return { runId, current: side(report.current), new: side(report.new), comparison: report.comparison,
    pass2: report.pass2 ? { current: side(report.pass2.current), new: side(report.pass2.new),
      stability: { current: stabilityLine(report.pass2.stability.current), new: stabilityLine(report.pass2.stability.new) } } : null };
}

export async function readSmartBenchSelfTestRows(runId: string): Promise<SmartBenchStored[]> {
  const rows = await requireDb().select().from(savSyncState).where(like(savSyncState.key, smartBenchRunPattern(runId)));
  return rows.flatMap(row => {
    if (row.status !== "done" || !row.cursor) return [];
    try { const stored = decryptSavPayload<{ result: SmartBenchStored | null }>(row.cursor).result; return stored ? [stored] : []; } catch { return []; }
  });
}
export const readSmartBenchSelfTestReport = async (runId: string) => aggregateSmartBenchSelfTest(await readSmartBenchSelfTestRows(runId));
