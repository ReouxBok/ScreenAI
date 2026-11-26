import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, like, lt, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savCases, savIntakeExecutions, savMessages, savSyncState } from "@/db/schema";
import { encryptSavPayload } from "../../crypto";
import { runWithSavRetrievalCardSizeFix } from "../../request-retrieval";
import { SAV_RETRIEVAL_EMBEDDING_DIMENSION } from "../../request-retrieval-db";
import { SAV_V2_MODEL_ENV, type CaseV2Network } from "../investigation-v2-providers";
import { runSmartTurn, type SmartKnowledgePort, type SmartTurnResult } from "./smart-agent";
import { smartMaxExchanges } from "./smart-memory";
import { SAV_SMART_COMMERCIAL_SPLIT_ENV, smartCommercialSet } from "./smart-switch";
import { getAcademyTools } from "./tools/academy";
import { SAV_SMART_CONTRACT_REVISION } from "./smart-contract";
import { smartDbKnowledge } from "./smart-knowledge";
import type { SmartNoRepeat, SmartSentReply } from "./smart-no-repeat";
import { readSmartSentReplies } from "./smart-trace-store";
import { claimSmartItem, readSmartLedger, settleSmartItem, smartContainedErrorCode, smartItemKey, smartLedgerSpent } from "./smart-ledger";
import { smartGeminiEmbed, smartGeminiModel, smartInputCap, smartPrices, type SmartEmbedPort, type SmartModelPort } from "./smart-model";
import { SAV_SMART_PROMPT_REVISION, smartPromptPinned, smartPromptSha256 } from "./smart-prompt";
import { readSmartShadowMail, readSmartV1Decision, SAV_SMART_SHADOW_EMBED_CALLS, SAV_SMART_SHADOW_MODEL_CALLS, SAV_SMART_SHADOW_RETENTION_MS, smartShadowItem, smartV1Gate,
  type SmartShadowStored, type SmartV1TeamReason } from "./smart-shadow";

/*
 * Agent SAV intelligent (25/11): a BOUNDED REPLAY of the shadow, to run the deployed prompt (v20) again on the real support mails of a past window
 * and compare with what the shadow decided then (v19). It is an addition NEXT TO the shadow: the shadow (`smart-shadow.ts`), its keys, its daily
 * ledger and its selection are untouched; the agent itself (`runSmartTurn`) is called exactly as the shadow calls it.
 *
 * Switch: `SAV_V2_SMART_SHADOW_REPLAY` = a run id (`^[a-z0-9-]{6,40}$`). Absent or invalid: the reconcile pass does not even load this file
 * (same regex there), and this pass returns before any read. `_FROM` / `_UNTIL` (ISO, required, at most 7 days) bound the mail's RECEPTION date.
 * Which mails: exactly those the shadow takes (inbound, V1-finished with a ticket, same V1 gate: only `support` reaches the model, `team` costs
 * nothing), the same context frozen at reception (`readSmartShadowMail`). The shadow's rows are never read nor written by this pass.
 * Storage: one encrypted row per mail under `sav-v2-smart-shadow-replay.v1:<runId>:…`, kept 30 days. Each mail is claimed ONCE per run (an
 * `interrupted` or failed mail is final, never replayed).
 * Money: its OWN ledger (scope = the run id), capped for the whole run in µUSD (10 000 000 by default and at most) and in mails (60 by default, 100
 * at most); each mail claimed with its worst case before any paid call. Never V2's daily budget, never the shadow's ledger.
 * Time: the shadow's rules (no start under 90 s, no mail under 60 s, each call bounded). The reconcile pass runs it AFTER the shadow.
 *
 * Bench switches (26/11), for the replay ONLY, while live traffic keeps them off: `_FLAGS` = a comma list, closed, among `card_size_fix`
 * (SAV_RETRIEVAL_CARD_SIZE_FIX scoped to the turn by AsyncLocalStorage), `commercial_split` (SAV_V2_SMART_COMMERCIAL_SPLIT=on in a local copy of
 * the env given to the turn) and `no_repeat` (the replies confirmed sent on the thread's cases BEFORE the mail's reception, read only, handed to
 * the turn as production does). Any other value (`forward`, `images`, `live_search`, unknown) refuses the run. `process.env` is never written.
 * `_THREADS` (optional) = a comma list of thread ids restricting the candidates. Absent or empty: the replay is exactly the previous one.
 * The flags are stored on each replayed row and shown in the report's revisions.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_SMART_REPLAY_ENV = "SAV_V2_SMART_SHADOW_REPLAY";
export const SAV_SMART_REPLAY_FROM_ENV = "SAV_V2_SMART_SHADOW_REPLAY_FROM", SAV_SMART_REPLAY_UNTIL_ENV = "SAV_V2_SMART_SHADOW_REPLAY_UNTIL";
export const SAV_SMART_REPLAY_CAP_ENV = "SAV_V2_SMART_SHADOW_REPLAY_MAX_MICRO_USD", SAV_SMART_REPLAY_MAILS_ENV = "SAV_V2_SMART_SHADOW_REPLAY_MAX_MAILS";
export const SAV_SMART_REPLAY_BATCH_ENV = "SAV_V2_SMART_SHADOW_REPLAY_BATCH";
export const SAV_SMART_REPLAY_FLAGS_ENV = "SAV_V2_SMART_SHADOW_REPLAY_FLAGS", SAV_SMART_REPLAY_THREADS_ENV = "SAV_V2_SMART_SHADOW_REPLAY_THREADS";
/** The only switches the replay may turn on for itself, in this (stored) order. Never a forward, images nor the live search. */
export const SAV_SMART_REPLAY_FLAGS = ["card_size_fix", "commercial_split", "no_repeat"] as const;
export type SmartReplayFlag = (typeof SAV_SMART_REPLAY_FLAGS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The run id format. `reconcile-pass.ts` tests the same pattern before loading this file (checked by the tests). */
export const SAV_SMART_REPLAY_ID = /^[a-z0-9-]{6,40}$/;
export const SAV_SMART_REPLAY_BASE = "sav-v2-smart-shadow-replay.v1";
export const SAV_SMART_REPLAY_MAX_CAP_MICRO_USD = 10_000_000;
export const SAV_SMART_REPLAY_DEFAULT_MAILS = 60, SAV_SMART_REPLAY_MAX_MAILS = 100;
export const SAV_SMART_REPLAY_DEFAULT_BATCH = 10, SAV_SMART_REPLAY_MAX_BATCH = 20;
export const SAV_SMART_REPLAY_MAX_WINDOW_MS = 7 * 86_400_000;
/** A run whose window starts before this is over: its rows reach the 30-day retention, so it is never started again from an empty ledger. */
const REPLAY_EXPIRY_MS = SAV_SMART_SHADOW_RETENTION_MS - 86_400_000;
const STEP_MIN_MS = 90_000, MAIL_MIN_MS = 60_000, CALL_MAX_MS = 25_000, CALL_MIN_MS = 8_000, CALL_MARGIN_MS = 3_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/, INTEGER = /^[0-9]{1,12}$/;

export const smartReplayPrefix = (runId: string) => `${SAV_SMART_REPLAY_BASE}:${runId}`;
export const smartReplayGateKey = (runId: string, messageId: string) => `${smartReplayPrefix(runId)}:gate:${smartShadowItem(messageId)}`;
/** `flags` (and `sentRepliesBefore` with `no_repeat`) only on a run with flags; absent: the previous row. `sentRepliesBefore` null: the read failed. */
export type SmartReplayStored = SmartShadowStored & Readonly<{ runId: string; flags?: readonly SmartReplayFlag[]; sentRepliesBefore?: number | null }>;
export type SmartReplayGateRow = Readonly<{ messageId: string; gate: "team"; reason: SmartV1TeamReason; at: string }>;

export type SmartReplayConfig =
  | Readonly<{ mode: "off" }>
  | Readonly<{ mode: "refused"; reason: "window_invalid" | "cap_invalid" | "mails_invalid" | "batch_invalid" | "flags_invalid" | "threads_invalid" }>
  | Readonly<{ mode: "replay"; runId: string; from: Date; until: Date; capMicroUsd: number; maxMails: number; batch: number; flags: readonly SmartReplayFlag[]; threads: readonly string[] | null }>;

function integer(env: Env, name: string, fallback: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = INTEGER.test(raw) ? Number(raw) : NaN;
  return value >= 1 && value <= max ? value : null;
}
const instant = (raw: string | undefined) => {
  const value = raw && ISO.test(raw) ? new Date(raw) : null;
  return value && Number.isFinite(value.getTime()) ? value : null;
};

/** Pure: the replay's switch and bounds. Off unless the run id is valid; a malformed bound refuses the run (nothing read), never guessed. */
export function readSmartReplayConfig(env: Env): SmartReplayConfig {
  const runId = env[SAV_SMART_REPLAY_ENV];
  if (runId === undefined || !SAV_SMART_REPLAY_ID.test(runId)) return { mode: "off" };
  const from = instant(env[SAV_SMART_REPLAY_FROM_ENV]), until = instant(env[SAV_SMART_REPLAY_UNTIL_ENV]);
  if (!from || !until || !(until.getTime() > from.getTime()) || until.getTime() - from.getTime() > SAV_SMART_REPLAY_MAX_WINDOW_MS) return { mode: "refused", reason: "window_invalid" };
  const capMicroUsd = integer(env, SAV_SMART_REPLAY_CAP_ENV, SAV_SMART_REPLAY_MAX_CAP_MICRO_USD, SAV_SMART_REPLAY_MAX_CAP_MICRO_USD);
  if (capMicroUsd === null) return { mode: "refused", reason: "cap_invalid" };
  const maxMails = integer(env, SAV_SMART_REPLAY_MAILS_ENV, SAV_SMART_REPLAY_DEFAULT_MAILS, SAV_SMART_REPLAY_MAX_MAILS);
  if (maxMails === null) return { mode: "refused", reason: "mails_invalid" };
  const batch = integer(env, SAV_SMART_REPLAY_BATCH_ENV, SAV_SMART_REPLAY_DEFAULT_BATCH, SAV_SMART_REPLAY_MAX_BATCH);
  if (batch === null) return { mode: "refused", reason: "batch_invalid" };
  const flags = list(env[SAV_SMART_REPLAY_FLAGS_ENV]);
  if (flags === null || !flags.every(flag => (SAV_SMART_REPLAY_FLAGS as readonly string[]).includes(flag))) return { mode: "refused", reason: "flags_invalid" };
  const threads = list(env[SAV_SMART_REPLAY_THREADS_ENV]);
  if (threads === null || !threads.every(id => UUID.test(id)) || threads.length > SAV_SMART_REPLAY_MAX_MAILS) return { mode: "refused", reason: "threads_invalid" };
  return { mode: "replay", runId, from, until, capMicroUsd, maxMails, batch, flags: SAV_SMART_REPLAY_FLAGS.filter(flag => flags.includes(flag)), threads: threads.length ? threads : null };
}
/** A comma list: absent or blank = []; an empty item (`a,,b`, `a,`) = null (refused). Items trimmed. */
function list(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return [];
  const items = raw.split(",").map(item => item.trim());
  return items.some(item => !item) ? null : items;
}

export type SmartReplayDeps = Readonly<{
  env: () => Env; now: () => Date; deadlineMs?: number; network?: CaseV2Network;
  knowledge?: (embed: SmartEmbedPort) => SmartKnowledgePort;
  log?: (event: string, fields: unknown) => void;
  clock?: () => number;
  academy?: Parameters<typeof runSmartTurn>[1]["academy"];
}>;
export type SmartReplayPass =
  | Readonly<{ skipped: "off" | "deadline" | "window_expired" | "prompt_unpinned" | "price_unavailable" | "transport_invalid" | "model_invalid" }>
  | Readonly<{ skipped: "refused"; reason: string }>
  | Readonly<{ skipped: "error_contained"; code: string }>
  | Readonly<{ ran: number; stoppedBy: "batch" | "no_mail" | "deadline" | "money_cap" | "item_cap"; outcomes: Record<string, number>; skippedMails: Record<string, number>;
      discardedByV1: Record<string, number>; runMails: number; spentRunMicroUsd: number }>;

/**
 * The replay's candidates: the shadow's selection (`selectSmartShadowCandidates`, same conditions) over [from, until) of reception, minus the mails
 * this RUN already claimed or gated. Read only.
 */
export async function selectSmartReplayCandidates(input: Readonly<{ runId: string; from: Date; until: Date; limit: number; threads?: readonly string[] | null }>) {
  const claimedPrefix = smartItemKey(smartReplayPrefix(input.runId), "mail:"), gatePrefix = `${smartReplayPrefix(input.runId)}:gate:${smartShadowItem("")}`;
  return requireDb().select({ messageId: savMessages.id, executionThreadId: savIntakeExecutions.threadId, receivedAt: savMessages.receivedAt, executionPayload: savIntakeExecutions.payloadCiphertext })
    .from(savIntakeExecutions).innerJoin(savMessages, eq(savMessages.id, savIntakeExecutions.messageId))
    .where(and(eq(savIntakeExecutions.state, "confirmed"), isNotNull(savIntakeExecutions.ticketId), eq(savMessages.direction, "inbound"), isNotNull(savMessages.gmailMessageId),
      gte(savMessages.receivedAt, input.from), lt(savMessages.receivedAt, input.until), ...(input.threads?.length ? [inArray(savMessages.threadId, [...input.threads])] : []),
      sql`not exists (select 1 from sav.sync_state s where s.key = ${claimedPrefix} || ${savMessages.id}::text or s.key = ${gatePrefix} || ${savMessages.id}::text)`))
    .orderBy(asc(savMessages.receivedAt), asc(savMessages.id)).limit(input.limit);
}

/**
 * `no_repeat` (replay only): the replies confirmed sent on the thread's cases (at most 5 cases, each its 10 most recent, `readSmartSentReplies`)
 * strictly BEFORE the mail's reception, oldest first. Read only (`sav.cases`, the case effect rows). Throws on a failed read.
 */
export async function readSmartReplaySentReplies(threadId: string, receivedAt: Date): Promise<SmartSentReply[]> {
  const cases = await requireDb().select({ id: savCases.id }).from(savCases).where(sql`${threadId}::uuid = any(${savCases.threadIds})`).orderBy(desc(savCases.createdAt)).limit(5);
  const sent: SmartSentReply[] = [];
  for (const row of cases) for (const reply of await readSmartSentReplies(row.id)) if (reply.at !== null && Date.parse(reply.at) < receivedAt.getTime()) sent.push(reply);
  return sent.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

/** One replay batch. NEVER throws: any error is contained as `{ skipped: "error_contained", code }` (a closed code, never a message). */
export async function runSmartReplayPass(deps: SmartReplayDeps): Promise<SmartReplayPass> {
  const config = readSmartReplayConfig(deps.env());
  if (config.mode === "off") return { skipped: "off" };
  const log = deps.log ?? ((event, fields) => console.info(event, JSON.stringify(fields)));
  try { return await runSmartReplayPassUnsafe(deps, config, log); }
  catch (error) {
    const code = smartContainedErrorCode(error);
    try { log("sav_smart_shadow_replay_error_contained", { code }); } catch { /* the log never fails the pass */ }
    return { skipped: "error_contained", code };
  }
}

async function runSmartReplayPassUnsafe(deps: SmartReplayDeps, config: Exclude<SmartReplayConfig, { mode: "off" }>, log: (event: string, fields: unknown) => void): Promise<SmartReplayPass> {
  if (config.mode === "refused") { log("sav_smart_shadow_replay_refused", { reason: config.reason }); return { skipped: "refused", reason: config.reason }; }
  const clock = deps.clock ?? Date.now, left = () => deps.deadlineMs === undefined ? Number.POSITIVE_INFINITY : deps.deadlineMs - clock();
  if (left() < STEP_MIN_MS) return { skipped: "deadline" };
  const env = deps.env(), now = deps.now(), db = requireDb(), flags = config.flags;
  // `commercial_split`: a LOCAL copy of the env, given to the turn's prompt set and its fingerprint only. `process.env` is never written (Fluid).
  const turnEnv: Env = flags.includes("commercial_split") ? { ...env, [SAV_SMART_COMMERCIAL_SPLIT_ENV]: "on" } : env;
  // Retention: the replay's own rows (every run) after 30 days; the shadow's prefix (`sav-v2-smart-shadow.v1:`) never matches this one.
  await db.delete(savSyncState).where(and(like(savSyncState.key, `${SAV_SMART_REPLAY_BASE}:%`), lt(savSyncState.startedAt, new Date(now.getTime() - SAV_SMART_SHADOW_RETENTION_MS))));
  if (config.from.getTime() < now.getTime() - REPLAY_EXPIRY_MS) return { skipped: "window_expired" };
  if (!smartPromptPinned()) return { skipped: "prompt_unpinned" };
  const prices = smartPrices(env), cap = smartInputCap(env, now), model = env[SAV_V2_MODEL_ENV] ?? "";
  if (!prices) return { skipped: "price_unavailable" };
  if (cap === null) return { skipped: "transport_invalid" };
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(model)) return { skipped: "model_invalid" };
  const prefix = smartReplayPrefix(config.runId), scope = config.runId, day = now.toISOString().slice(0, 10);
  const worst = SAV_SMART_SHADOW_MODEL_CALLS * prices.modelReserve + SAV_SMART_SHADOW_EMBED_CALLS * prices.embeddingReserve;

  const outcomes: Record<string, number> = {}, skippedMails: Record<string, number> = {}, discardedByV1: Record<string, number> = {};
  const finish = async (ran: number, stoppedBy: Extract<SmartReplayPass, { ran: number }>["stoppedBy"]) => {
    const ledger = await readSmartLedger(prefix, scope);
    const pass = { ran, stoppedBy, outcomes, skippedMails, discardedByV1, runMails: ledger.items, spentRunMicroUsd: smartLedgerSpent(ledger) };
    log("sav_smart_shadow_replay_pass", { ...pass, runId: config.runId, revision: SAV_SMART_PROMPT_REVISION, promptSha256: smartPromptSha256(smartCommercialSet(turnEnv)).slice(0, 16), model, ...(flags.length ? { flags } : {}) });
    return pass;
  };
  // A finished run (mails or money) reads no mail at all.
  const before = await readSmartLedger(prefix, scope), spent = smartLedgerSpent(before);
  if (before.items >= config.maxMails) return finish(0, "item_cap");
  if (spent >= config.capMicroUsd || spent + worst > config.capMicroUsd) return finish(0, "money_cap");

  const candidates = await selectSmartReplayCandidates({ runId: config.runId, from: config.from, until: config.until, limit: config.batch * 4, ...(config.threads ? { threads: config.threads } : {}) });
  let ran = 0, stoppedBy: Extract<SmartReplayPass, { ran: number }>["stoppedBy"] = candidates.length ? "batch" : "no_mail";
  for (const candidate of candidates) {
    if (ran >= config.batch) { stoppedBy = "batch"; break; }
    if (left() < MAIL_MIN_MS) { stoppedBy = "deadline"; break; }
    const gate = smartV1Gate(readSmartV1Decision(candidate.executionPayload));
    if (gate.gate === "team") {
      const row: SmartReplayGateRow = { messageId: candidate.messageId, gate: "team", reason: gate.reason, at: deps.now().toISOString() };
      await db.insert(savSyncState).values({ key: smartReplayGateKey(config.runId, candidate.messageId), status: "team", cursor: encryptSavPayload(row), startedAt: deps.now(), completedAt: deps.now() }).onConflictDoNothing();
      discardedByV1[gate.reason] = (discardedByV1[gate.reason] ?? 0) + 1;
      continue;
    }
    const mail = await readSmartShadowMail(candidate);
    if (!mail.ok) { skippedMails[mail.reason] = (skippedMails[mail.reason] ?? 0) + 1; continue; }
    const item = smartShadowItem(candidate.messageId);
    const claim = await claimSmartItem({ prefix, scope, item, worstMicroUsd: worst, capMicroUsd: config.capMicroUsd, maxItems: config.maxMails, now: deps.now() });
    if (claim.status === "refused") {
      if (claim.reason === "already_claimed") { skippedMails.already_claimed = (skippedMails.already_claimed ?? 0) + 1; continue; }
      stoppedBy = claim.reason; break;
    }
    // The shadow's ports, as is: at most 7 model calls and 3 embeddings inside the reservation, each bounded by the time left.
    let cost = 0, modelCalls = 0, embedCalls = 0;
    const timeout = () => Math.min(CALL_MAX_MS, left() - CALL_MARGIN_MS);
    const gemini = smartGeminiModel({ env: deps.env, now: deps.now, network: deps.network, callTimeoutMs: timeout });
    const modelPort: SmartModelPort = async request => {
      if (timeout() < CALL_MIN_MS) return { status: "failed", problem: "deadline", uncertain: false, usage: null, inputBytes: 0, sent: false };
      if (modelCalls >= SAV_SMART_SHADOW_MODEL_CALLS) return { status: "failed", problem: "call_budget", uncertain: false, usage: null, inputBytes: 0, sent: false };
      if (cost + prices.modelReserve > worst) return { status: "failed", problem: "money_budget", uncertain: false, usage: null, inputBytes: 0, sent: false };
      modelCalls += 1;
      const result = await gemini(request);
      if (result.status === "ok") cost += prices.modelCost(result.usage);
      else if (result.sent) cost += result.uncertain || !result.usage ? prices.modelReserve : prices.modelCost(result.usage);
      return result;
    };
    const geminiEmbed = smartGeminiEmbed({ env: deps.env, now: deps.now, network: deps.network, dimension: SAV_RETRIEVAL_EMBEDDING_DIMENSION, callTimeoutMs: timeout });
    const embedPort: SmartEmbedPort = async texts => {
      if (timeout() < CALL_MIN_MS) return { status: "failed", problem: "deadline", sent: false };
      if (embedCalls >= SAV_SMART_SHADOW_EMBED_CALLS) return { status: "failed", problem: "call_budget", sent: false };
      if (cost + prices.embeddingReserve > worst) return { status: "failed", problem: "money_budget", sent: false };
      embedCalls += 1;
      const result = await geminiEmbed(texts);
      if (result.status === "ok" || result.sent) cost += prices.embeddingReserve;
      return result;
    };
    // `no_repeat`: the replies sent before this mail was received (never after it), as production hands them; a failed read gives none (noted).
    let noRepeat: SmartNoRepeat | null = null, sentRepliesBefore: number | null = null;
    if (flags.includes("no_repeat")) {
      try { noRepeat = { sent: await readSmartReplaySentReplies(candidate.executionThreadId, mail.receivedAt) }; sentRepliesBefore = noRepeat.sent.length; }
      catch (error) { log("sav_smart_shadow_replay_sent_replies_unavailable", { code: smartContainedErrorCode(error) }); noRepeat = { sent: [] }; }
    }
    const startedAt = clock();
    let turn: SmartTurnResult;
    try {
      const play = () => runSmartTurn({ subject: mail.subject, body: mail.body, thread: mail.thread },
        { model: modelPort, knowledge: (deps.knowledge ?? (embed => smartDbKnowledge({ now: deps.now, embed })))(embedPort), maxInputBytes: cap, today: day,
          academy: deps.academy ?? getAcademyTools(), recordOwn: false, maxExchanges: smartMaxExchanges(env), ...smartCommercialSet(turnEnv), ...(noRepeat ? { noRepeat } : {}) });
      // `card_size_fix`: forced on for this turn's async work only (AsyncLocalStorage), never for a concurrent request.
      turn = flags.includes("card_size_fix") ? await runWithSavRetrievalCardSizeFix(true, play) : await play();
    } catch {
      await settleSmartItem({ prefix, scope, item, costMicroUsd: Math.max(cost, worst), status: "failed", now: deps.now(), result: null });
      outcomes.crashed = (outcomes.crashed ?? 0) + 1; ran += 1; continue;
    }
    const stored: SmartReplayStored = { runId: config.runId, v1Gate: "support", messageId: candidate.messageId, receivedAt: mail.receivedAt.toISOString(),
      startedAt: new Date(startedAt).toISOString(), durationMs: clock() - startedAt, costMicroUsd: cost, revision: SAV_SMART_PROMPT_REVISION, promptSha256: smartPromptSha256(smartCommercialSet(turnEnv)),
      contractRevision: SAV_SMART_CONTRACT_REVISION, model, codeSha: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 40) ?? null, turn,
      ...(flags.length ? { flags, ...(noRepeat ? { sentRepliesBefore } : {}) } : {}) };
    await settleSmartItem({ prefix, scope, item, costMicroUsd: cost, status: "done", now: deps.now(), result: stored });
    outcomes[turn.outcome] = (outcomes[turn.outcome] ?? 0) + 1; ran += 1;
    if (turn.outcome === "interrupted") { stoppedBy = "deadline"; break; }
  }
  return finish(ran, stoppedBy);
}
