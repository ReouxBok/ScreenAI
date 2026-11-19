import "server-only";
import { and, asc, desc, eq, gte, isNotNull, like, lt, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeExecutions, savMessages, savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../../crypto";
import { SAV_RETRIEVAL_EMBEDDING_DIMENSION } from "../../request-retrieval-db";
import { SAV_V2_MODEL_ENV, type CaseV2Network } from "../investigation-v2-providers";
import { runSmartTurn, type SmartKnowledgePort, type SmartThreadMessage, type SmartTurnResult } from "./smart-agent";
import { SAV_SMART_CONTRACT_REVISION } from "./smart-contract";
import { smartDbKnowledge } from "./smart-knowledge";
import { claimSmartItem, readSmartLedger, settleSmartItem, smartContainedErrorCode, smartItemKey, smartLedgerSpent, type SmartItemRow } from "./smart-ledger";
import { smartGeminiEmbed, smartGeminiModel, smartInputCap, smartPrices, type SmartEmbedPort, type SmartModelPort } from "./smart-model";
import { SAV_SMART_PROMPT_REVISION, smartPromptPinned, smartPromptSha256 } from "./smart-prompt";
import { readSmartShadowConfig, SAV_SMART_SHADOW_LOOKBACK_MS } from "./smart-switch";

/*
 * Agent SAV intelligent, lot E (20/11): the SHADOW pass of the new agent, from the existing reconcile pass, behind `SAV_V2_SMART_AGENT=shadow`.
 * Off (absent or any other value): this file is not even loaded (`reconcile-pass.ts`), and the pass returns before any read.
 *
 * Which mails: each INBOUND mail V1 finished with (its intake execution `confirmed`, a ticket recorded), received after the lookback bound, read
 * BY ITS V1 MESSAGE ID and checked to be on the execution's own thread. What the agent may know is frozen at the mail's reception: the thread
 * messages strictly BEFORE it, never the team's later reply (Astra's correction). It does not go through V2's launcher (which needs an admitted
 * case and the agent as owner): no case, no admission, no ticket, no mail, no HubSpot, no Slack, nothing queued. Only the model endpoint is called.
 *
 * Money: the shadow's OWN ledger (`smart-ledger.ts`), capped per UTC day in µUSD (10 EUR by default and at most) and in mails (20 by default),
 * V2's approved prices read only. Each mail is claimed with its WORST case (5 model calls + 1 embedding) before any paid call: two passes on the
 * same mail pay once; a crash keeps the reservation. Time: never started with less than 90 s left in the pass, no mail started with less than
 * 60 s, each call bounded by the time left; out of time, the mail stops as `interrupted` (its spend settled, never retried).
 * Storage: one encrypted row per mail in `sav.sync_state` (no migration), deleted after 30 days by this pass. Logs: closed codes and numbers only.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_SMART_SHADOW_PREFIX = "sav-v2-smart-shadow.v1";
export const SAV_SMART_SHADOW_RETENTION_MS = 30 * 86_400_000;
/** Worst case of one mail: understand, decide, verify, correct, reverify, plus one query embedding. */
export const SAV_SMART_SHADOW_MODEL_CALLS = 5, SAV_SMART_SHADOW_EMBED_CALLS = 1;
const STEP_MIN_MS = 90_000, MAIL_MIN_MS = 60_000, CALL_MAX_MS = 25_000, CALL_MIN_MS = 8_000, CALL_MARGIN_MS = 3_000;

export type SmartShadowStored = Readonly<{
  messageId: string; receivedAt: string; startedAt: string; durationMs: number; costMicroUsd: number;
  revision: string; promptSha256: string; contractRevision: string; model: string; codeSha: string | null;
  turn: SmartTurnResult;
}>;
export type SmartShadowDeps = Readonly<{
  env: () => Env; now: () => Date; deadlineMs?: number; network?: CaseV2Network;
  /** Tests: the knowledge port (the default is the existing search through the shadow's ledger). */
  knowledge?: (embed: SmartEmbedPort) => SmartKnowledgePort;
  log?: (event: string, fields: unknown) => void;
  /** Tests: the wall clock the deadline is read against (default `Date.now`). */
  clock?: () => number;
}>;
export type SmartShadowPass =
  | Readonly<{ skipped: "off" | "deadline" | "prompt_unpinned" | "price_unavailable" | "transport_invalid" | "model_invalid" }>
  | Readonly<{ skipped: "refused"; reason: string }>
  | Readonly<{ skipped: "error_contained"; code: string }>
  | Readonly<{ ran: number; stoppedBy: "batch" | "no_mail" | "deadline" | "money_cap" | "item_cap"; outcomes: Record<string, number>; skippedMails: Record<string, number>; spentTodayMicroUsd: number }>;

export const smartShadowItem = (messageId: string) => `mail:${messageId}`;

/** The candidates: V1-finished inbound mails, newest bound applied, not yet claimed by the shadow. Read only. */
export async function selectSmartShadowCandidates(input: Readonly<{ since: Date; limit: number }>) {
  const claimedPrefix = `${smartItemKey(SAV_SMART_SHADOW_PREFIX, "mail:")}`;
  return requireDb().select({ messageId: savMessages.id, executionThreadId: savIntakeExecutions.threadId, receivedAt: savMessages.receivedAt })
    .from(savIntakeExecutions).innerJoin(savMessages, eq(savMessages.id, savIntakeExecutions.messageId))
    .where(and(eq(savIntakeExecutions.state, "confirmed"), isNotNull(savIntakeExecutions.ticketId), eq(savMessages.direction, "inbound"), isNotNull(savMessages.gmailMessageId),
      gte(savMessages.receivedAt, input.since), sql`not exists (select 1 from sav.sync_state s where s.key = ${claimedPrefix} || ${savMessages.id}::text)`))
    .orderBy(asc(savMessages.receivedAt), asc(savMessages.id)).limit(input.limit);
}

/**
 * One mail as the agent could know it at its reception: the mail itself by its V1 id, on the execution's thread, and the thread's messages
 * strictly before it (never after: the team's reply stays out). Null when it is not that mail (another thread, outbound, unreadable).
 */
export async function readSmartShadowMail(input: Readonly<{ messageId: string; executionThreadId: string }>):
  Promise<{ ok: true; subject: string; body: string; thread: SmartThreadMessage[]; receivedAt: Date } | { ok: false; reason: "absent" | "not_inbound" | "thread_mismatch" | "unreadable" }> {
  const db = requireDb();
  const [mail] = await db.select().from(savMessages).where(eq(savMessages.id, input.messageId));
  if (!mail) return { ok: false, reason: "absent" };
  if (mail.direction !== "inbound") return { ok: false, reason: "not_inbound" };
  if (mail.threadId !== input.executionThreadId) return { ok: false, reason: "thread_mismatch" };
  const text = (ciphertext: string) => { try { const stored = decryptSavPayload<{ text?: unknown }>(ciphertext); return typeof stored?.text === "string" ? stored.text : null; } catch { return null; } };
  const body = text(mail.bodyCiphertext);
  if (body === null) return { ok: false, reason: "unreadable" };
  const before = await db.select().from(savMessages).where(and(eq(savMessages.threadId, mail.threadId), lt(savMessages.receivedAt, mail.receivedAt)))
    .orderBy(desc(savMessages.receivedAt), desc(savMessages.id)).limit(3);
  const thread = before.reverse().flatMap(row => { const value = text(row.bodyCiphertext); return value === null ? [] : [{ from: row.direction === "inbound" ? "customer" as const : "support" as const, at: row.receivedAt.toISOString(), text: value }]; });
  return { ok: true, subject: mail.subject, body, thread, receivedAt: mail.receivedAt };
}

/**
 * One shadow batch. NEVER throws: any error (a SQL failure at the reservation or the settlement, a lock held past its short bound, a bug) is
 * contained and returned as `{ skipped: "error_contained", code }`, so the reconcile pass never turns red because of the shadow. The code is
 * closed (a Postgres SQLSTATE or a fixed word), never a message. A claimed mail whose settlement failed keeps its reservation (never repaid).
 */
export async function runSmartShadowPass(deps: SmartShadowDeps): Promise<SmartShadowPass> {
  const config = readSmartShadowConfig(deps.env());
  if (config.mode === "off") return { skipped: "off" };
  const log = deps.log ?? ((event, fields) => console.info(event, JSON.stringify(fields)));
  try { return await runSmartShadowPassUnsafe(deps, config, log); }
  catch (error) {
    const code = smartContainedErrorCode(error);
    try { log("sav_smart_shadow_error_contained", { code }); } catch { /* the log never fails the pass */ }
    return { skipped: "error_contained", code };
  }
}

async function runSmartShadowPassUnsafe(deps: SmartShadowDeps, config: Exclude<ReturnType<typeof readSmartShadowConfig>, { mode: "off" }>, log: (event: string, fields: unknown) => void): Promise<SmartShadowPass> {
  if (config.mode === "refused") { log("sav_smart_shadow_refused", { reason: config.reason }); return { skipped: "refused", reason: config.reason }; }
  const clock = deps.clock ?? Date.now, left = () => deps.deadlineMs === undefined ? Number.POSITIVE_INFINITY : deps.deadlineMs - clock();
  if (left() < STEP_MIN_MS) return { skipped: "deadline" };
  if (!smartPromptPinned()) return { skipped: "prompt_unpinned" };
  const env = deps.env(), now = deps.now(), prices = smartPrices(env), cap = smartInputCap(env, now), model = env[SAV_V2_MODEL_ENV] ?? "";
  if (!prices) return { skipped: "price_unavailable" };
  if (cap === null) return { skipped: "transport_invalid" };
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(model)) return { skipped: "model_invalid" };
  const db = requireDb(), day = now.toISOString().slice(0, 10), worst = SAV_SMART_SHADOW_MODEL_CALLS * prices.modelReserve + SAV_SMART_SHADOW_EMBED_CALLS * prices.embeddingReserve;

  // Retention: the shadow's own rows only, after 30 days (the existing retention does not target them).
  const cutoff = new Date(now.getTime() - SAV_SMART_SHADOW_RETENTION_MS);
  await db.delete(savSyncState).where(and(like(savSyncState.key, `${SAV_SMART_SHADOW_PREFIX}:%`), lt(savSyncState.startedAt, cutoff)));

  const lookback = new Date(now.getTime() - SAV_SMART_SHADOW_LOOKBACK_MS), since = config.since && config.since > lookback ? config.since : lookback;
  const candidates = await selectSmartShadowCandidates({ since, limit: config.batch * 4 });
  const outcomes: Record<string, number> = {}, skippedMails: Record<string, number> = {};
  let ran = 0, stoppedBy: Extract<SmartShadowPass, { ran: number }>["stoppedBy"] = candidates.length ? "batch" : "no_mail";
  for (const candidate of candidates) {
    if (ran >= config.batch) { stoppedBy = "batch"; break; }
    if (left() < MAIL_MIN_MS) { stoppedBy = "deadline"; break; }
    const mail = await readSmartShadowMail(candidate);
    if (!mail.ok) { skippedMails[mail.reason] = (skippedMails[mail.reason] ?? 0) + 1; continue; }
    const item = smartShadowItem(candidate.messageId);
    const claim = await claimSmartItem({ prefix: SAV_SMART_SHADOW_PREFIX, scope: day, item, worstMicroUsd: worst, capMicroUsd: config.capMicroUsdPerDay, maxItems: config.maxMailsPerDay, now: deps.now() });
    if (claim.status === "refused") {
      if (claim.reason === "already_claimed") { skippedMails.already_claimed = (skippedMails.already_claimed ?? 0) + 1; continue; }
      stoppedBy = claim.reason; break;
    }
    // From here every call is paid inside the reservation: at most 5 model calls and 1 embedding, each bounded by the time left.
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
    const startedAt = clock();
    let turn: SmartTurnResult;
    try {
      turn = await runSmartTurn({ subject: mail.subject, body: mail.body, thread: mail.thread },
        { model: modelPort, knowledge: (deps.knowledge ?? (embed => smartDbKnowledge({ now: deps.now, embed })))(embedPort), maxInputBytes: cap, today: day });
    } catch {
      // Unexpected: the reservation is kept as spent (nothing is known of what was sent), the mail never retried.
      await settleSmartItem({ prefix: SAV_SMART_SHADOW_PREFIX, scope: day, item, costMicroUsd: Math.max(cost, worst), status: "failed", now: deps.now(), result: null });
      outcomes.crashed = (outcomes.crashed ?? 0) + 1; ran += 1; continue;
    }
    const stored: SmartShadowStored = { messageId: candidate.messageId, receivedAt: mail.receivedAt.toISOString(), startedAt: new Date(startedAt).toISOString(),
      durationMs: clock() - startedAt, costMicroUsd: cost, revision: SAV_SMART_PROMPT_REVISION, promptSha256: smartPromptSha256(), contractRevision: SAV_SMART_CONTRACT_REVISION,
      model, codeSha: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 40) ?? null, turn };
    await settleSmartItem({ prefix: SAV_SMART_SHADOW_PREFIX, scope: day, item, costMicroUsd: cost, status: "done", now: deps.now(), result: stored });
    outcomes[turn.outcome] = (outcomes[turn.outcome] ?? 0) + 1; ran += 1;
    if (turn.outcome === "interrupted") { stoppedBy = "deadline"; break; }
  }
  const spentTodayMicroUsd = smartLedgerSpent(await readSmartLedger(SAV_SMART_SHADOW_PREFIX, day));
  const pass = { ran, stoppedBy, outcomes, skippedMails, spentTodayMicroUsd };
  log("sav_smart_shadow_pass", { ...pass, day, revision: SAV_SMART_PROMPT_REVISION, promptSha256: smartPromptSha256().slice(0, 16), model });
  return pass;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Report: aggregates only (codes and numbers), for root and the daily report. Not wired to a page.
// ---------------------------------------------------------------------------------------------------------------------------------
const percentile = (values: readonly number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
};
const spread = (values: readonly number[]) => ({ count: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null });
const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };

/** Pure: the report of stored shadow rows. Every number comes with its denominator (`mails`). */
export function aggregateSmartShadow(rows: readonly SmartShadowStored[]) {
  const outcomes: Record<string, number> = {}, refusals: Record<string, number> = {}, verifyRefusals: Record<string, number> = {}, stopReasons: Record<string, number> = {};
  const missingByTheme: Record<string, number> = {}, sensitiveStopped = { net: 0, understand: 0 }, bytes: Record<string, number[]> = {};
  let corrected = 0, refusedAfterCorrection = 0, serverCaughtWhatVerifyPassed = 0;
  for (const row of rows) {
    const turn = row.turn;
    bump(outcomes, turn.outcome);
    if (turn.sensitiveStop) sensitiveStopped[turn.sensitiveStop] += 1;
    for (const reason of turn.reasons) bump(stopReasons, reason);
    for (const code of [...(turn.checks.first ?? []), ...(turn.checks.second ?? [])]) bump(refusals, code);
    for (const verdict of [turn.verdicts.first, turn.verdicts.second]) for (const problem of verdict?.problems ?? []) bump(verifyRefusals, problem.code);
    if ((turn.checks.first?.length ?? 0) > 0 && turn.verdicts.first?.verdict === "conforme") serverCaughtWhatVerifyPassed += 1;
    if (turn.corrected) corrected += 1;
    if (turn.reasons.includes("refused_after_correction")) refusedAfterCorrection += 1;
    for (const missing of turn.missing) bump(missingByTheme, missing.theme?.trim().toLowerCase() || "sans_theme");
    for (const call of turn.calls) (bytes[call.kind] ??= []).push(call.inputBytes);
  }
  return {
    mails: rows.length, outcomes, sensitiveStopped, stopReasons, serverRefusals: refusals, verifyRefusals, corrected, refusedAfterCorrection, serverCaughtWhatVerifyPassed,
    costMicroUsd: { total: rows.reduce((sum, row) => sum + row.costMicroUsd, 0), ...spread(rows.map(row => row.costMicroUsd)) },
    durationMs: spread(rows.map(row => row.durationMs)),
    bytesByStage: Object.fromEntries(Object.entries(bytes).map(([kind, values]) => [kind, spread(values)])),
    missingByTheme,
    revisions: [...new Set(rows.map(row => `${row.revision}:${row.promptSha256.slice(0, 16)}:${row.model}:${row.codeSha ?? "?"}`))],
  };
}

/** The stored rows of the shadow (decrypted, read only), oldest first, bounded. */
export async function readSmartShadowRows(limit = 500): Promise<SmartShadowStored[]> {
  const rows = await requireDb().select().from(savSyncState).where(and(like(savSyncState.key, `${smartItemKey(SAV_SMART_SHADOW_PREFIX, "mail:")}%`), eq(savSyncState.status, "done")))
    .orderBy(asc(savSyncState.startedAt)).limit(Math.min(Math.max(limit, 1), 2_000));
  return rows.flatMap(row => { try { const stored = decryptSavPayload<SmartItemRow<SmartShadowStored>>(row.cursor ?? ""); return stored.result ? [stored.result] : []; } catch { return []; } });
}
