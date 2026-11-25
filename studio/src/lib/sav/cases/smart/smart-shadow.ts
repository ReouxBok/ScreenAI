import "server-only";
import { and, asc, desc, eq, gte, isNotNull, like, lt, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeExecutions, savMessages, savSyncState } from "@/db/schema";
import { decryptSavPayload } from "../../crypto";
import { SAV_RETRIEVAL_EMBEDDING_DIMENSION } from "../../request-retrieval-db";
import { SAV_V2_MODEL_ENV, type CaseV2Network } from "../investigation-v2-providers";
import type { ExecutionPayload } from "../../intake/execution-types";
import { encryptSavPayload } from "../../crypto";
import { runSmartTurn, SAV_SMART_MAX_EMBED_CALLS, SAV_SMART_MAX_MODEL_CALLS, type SmartKnowledgePort, type SmartThreadMessage, type SmartTurnResult } from "./smart-agent";
import { smartMaxExchanges } from "./smart-memory";
import { getAcademyTools } from "./tools/academy";
import { SAV_SMART_CONTRACT_REVISION } from "./smart-contract";
import { smartDbKnowledge } from "./smart-knowledge";
import { claimSmartItem, readSmartLedger, settleSmartItem, smartContainedErrorCode, smartItemKey, smartLedgerSpent, type SmartItemRow } from "./smart-ledger";
import { smartGeminiEmbed, smartGeminiModel, smartInputCap, smartPrices, type SmartEmbedPort, type SmartModelPort } from "./smart-model";
import { SAV_SMART_PROMPT_REVISION, smartPromptPinned, smartPromptSha256 } from "./smart-prompt";
import { readSmartShadowConfig, SAV_SMART_SHADOW_LOOKBACK_MS, smartCommercialSet } from "./smart-switch";

/*
 * Agent SAV intelligent, lot E (20/11): the SHADOW pass of the new agent, from the existing reconcile pass, behind `SAV_V2_SMART_AGENT=shadow`.
 * Off (absent or any other value): this file is not even loaded (`reconcile-pass.ts`), and the pass returns before any read.
 *
 * Which mails: each INBOUND mail V1 finished with (its intake execution `confirmed`, a ticket recorded), received after the lookback bound, read
 * BY ITS V1 MESSAGE ID and checked to be on the execution's own thread. What the agent may know is frozen at the mail's reception: the thread
 * messages strictly BEFORE it, never the team's later reply (Astra's correction). It does not go through V2's launcher (which needs an admitted
 * case and the agent as owner): no case, no admission, no ticket, no mail, no HubSpot, no Slack, nothing queued. Only the model endpoint is called.
 *
 * V1 gate (SAV-116): the target is that the agent only receives what V1 classed `support`. Each candidate's V1 decision (its execution plan: the
 * classification and the kind of every request, read only) gives a gate: `support` (at least one support request, no finance, no cancellation) goes
 * to the model; anything else is `team`, with a closed reason, and costs no call and no quota: a light row (`…:gate:mail:<id>`, codes only) is kept
 * so it is counted once and never selected again. A decision that cannot be read is `team/unknown`.
 *
 * Money: the shadow's OWN ledger (`smart-ledger.ts`), capped per UTC day in µUSD (10 EUR by default and at most) and in mails (20 by default),
 * V2's approved prices read only. Each mail is claimed with its WORST case (7 model calls + 3 embeddings) before any paid call: two passes on the
 * same mail pay once; a crash keeps the reservation. Time: never started with less than 90 s left in the pass, no mail started with less than
 * 60 s, each call bounded by the time left; out of time, the mail stops as `interrupted` (its spend settled, never retried).
 * Storage: one encrypted row per mail in `sav.sync_state` (no migration), deleted after 30 days by this pass. Logs: closed codes and numbers only.
 */

type Env = Readonly<Record<string, string | undefined>>;
export const SAV_SMART_SHADOW_PREFIX = "sav-v2-smart-shadow.v1";
export const SAV_SMART_SHADOW_RETENTION_MS = 30 * 86_400_000;
/** Worst case of one mail (v2): understand, 3 decide passes, verify, correct, reverify, plus 3 query embeddings (first search + `chercher_fiches`). */
export const SAV_SMART_SHADOW_MODEL_CALLS = SAV_SMART_MAX_MODEL_CALLS, SAV_SMART_SHADOW_EMBED_CALLS = SAV_SMART_MAX_EMBED_CALLS;
const STEP_MIN_MS = 90_000, MAIL_MIN_MS = 60_000, CALL_MAX_MS = 25_000, CALL_MIN_MS = 8_000, CALL_MARGIN_MS = 3_000;

/** The V1 gate of a mail. Old rows (before SAV-116) have none and are read as `unknown`. */
export type SmartV1Gate = "support" | "team";
export const SMART_V1_TEAM_REASONS = ["finance", "cancellation", "partnership", "commercial", "investor", "other", "acknowledgement", "unknown"] as const;
export type SmartV1TeamReason = typeof SMART_V1_TEAM_REASONS[number];
export type SmartV1GateReading = Readonly<{ gate: "support" } | { gate: "team"; reason: SmartV1TeamReason }>;

/**
 * Pure: the gate of one V1 decision (`classification` and the kinds of its requests, as the case relay reads them). Finance and cancellation
 * win over everything (cancellation first, as `caseSensitivityOf`); then at least one support request goes to the agent; a mail whose analysis
 * listed no request (or only acknowledgements) is read by its classification; otherwise the first non-support kind, in the ticket's order.
 */
export function smartV1Gate(decision: unknown): SmartV1GateReading {
  const value = decision as { classification?: unknown; requests?: unknown } | null | undefined;
  if (!value || typeof value !== "object" || !Array.isArray(value.requests)) return { gate: "team", reason: "unknown" };
  const known = (kind: unknown): SmartV1TeamReason | "support" => kind === "support" ? "support" : (SMART_V1_TEAM_REASONS as readonly unknown[]).includes(kind) ? kind as SmartV1TeamReason : "unknown";
  const requestKinds = value.requests.map(request => known((request as { kind?: unknown } | null)?.kind)), own = requestKinds.filter(kind => kind !== "acknowledgement");
  const classification = known(value.classification);
  const kinds = new Set<string>([classification, ...requestKinds]);
  if (kinds.has("cancellation")) return { gate: "team", reason: "cancellation" };
  if (kinds.has("finance")) return { gate: "team", reason: "finance" };
  const considered = own.length ? own : [classification];
  if (considered.includes("support")) return { gate: "support" };
  const reason = SMART_V1_TEAM_REASONS.find(candidate => candidate !== "finance" && candidate !== "cancellation" && (considered.includes(candidate) || (!own.length && requestKinds.includes(candidate))));
  return { gate: "team", reason: reason ?? "unknown" };
}
/** The V1 decision stored with an execution (read only); null when it cannot be read. */
export function readSmartV1Decision(payloadCiphertext: string): unknown {
  try { return decryptSavPayload<ExecutionPayload>(payloadCiphertext)?.plan?.decision ?? null; } catch { return null; }
}
export const smartShadowGateKey = (messageId: string) => `${SAV_SMART_SHADOW_PREFIX}:gate:${smartShadowItem(messageId)}`;
type SmartShadowGateRow = Readonly<{ messageId: string; gate: "team"; reason: SmartV1TeamReason; at: string }>;

export type SmartShadowStored = Readonly<{
  /** SAV-116: absent on rows stored before the gate (read as `unknown`). */
  v1Gate?: "support";
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
  /** Tests: the Academy tools (default `getAcademyTools()`, empty unless `SAV_V2_SMART_ACADEMY=on`). */
  academy?: Parameters<typeof runSmartTurn>[1]["academy"];
}>;
export type SmartShadowPass =
  | Readonly<{ skipped: "off" | "deadline" | "prompt_unpinned" | "price_unavailable" | "transport_invalid" | "model_invalid" }>
  | Readonly<{ skipped: "refused"; reason: string }>
  | Readonly<{ skipped: "error_contained"; code: string }>
  | Readonly<{ ran: number; stoppedBy: "batch" | "no_mail" | "deadline" | "money_cap" | "item_cap"; outcomes: Record<string, number>; skippedMails: Record<string, number>; discardedByV1: Record<string, number>; spentTodayMicroUsd: number }>;

export const smartShadowItem = (messageId: string) => `mail:${messageId}`;

/** The candidates: V1-finished inbound mails, newest bound applied, not yet claimed by the shadow. Read only. */
export async function selectSmartShadowCandidates(input: Readonly<{ since: Date; limit: number }>) {
  const claimedPrefix = `${smartItemKey(SAV_SMART_SHADOW_PREFIX, "mail:")}`;
  const gatePrefix = `${SAV_SMART_SHADOW_PREFIX}:gate:${smartShadowItem("")}`;
  return requireDb().select({ messageId: savMessages.id, executionThreadId: savIntakeExecutions.threadId, receivedAt: savMessages.receivedAt, executionPayload: savIntakeExecutions.payloadCiphertext })
    .from(savIntakeExecutions).innerJoin(savMessages, eq(savMessages.id, savIntakeExecutions.messageId))
    .where(and(eq(savIntakeExecutions.state, "confirmed"), isNotNull(savIntakeExecutions.ticketId), eq(savMessages.direction, "inbound"), isNotNull(savMessages.gmailMessageId),
      gte(savMessages.receivedAt, input.since),
      sql`not exists (select 1 from sav.sync_state s where s.key = ${claimedPrefix} || ${savMessages.id}::text or s.key = ${gatePrefix} || ${savMessages.id}::text)`))
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
  const outcomes: Record<string, number> = {}, skippedMails: Record<string, number> = {}, discardedByV1: Record<string, number> = {};
  let ran = 0, stoppedBy: Extract<SmartShadowPass, { ran: number }>["stoppedBy"] = candidates.length ? "batch" : "no_mail";
  for (const candidate of candidates) {
    if (ran >= config.batch) { stoppedBy = "batch"; break; }
    if (left() < MAIL_MIN_MS) { stoppedBy = "deadline"; break; }
    // SAV-116: only what V1 classed `support` reaches the model; the rest is counted with its reason, at no call and no quota.
    const gate = smartV1Gate(readSmartV1Decision(candidate.executionPayload));
    if (gate.gate === "team") {
      const row: SmartShadowGateRow = { messageId: candidate.messageId, gate: "team", reason: gate.reason, at: deps.now().toISOString() };
      await db.insert(savSyncState).values({ key: smartShadowGateKey(candidate.messageId), status: "team", cursor: encryptSavPayload(row), startedAt: deps.now(), completedAt: deps.now() }).onConflictDoNothing();
      discardedByV1[gate.reason] = (discardedByV1[gate.reason] ?? 0) + 1;
      continue;
    }
    const mail = await readSmartShadowMail(candidate);
    if (!mail.ok) { skippedMails[mail.reason] = (skippedMails[mail.reason] ?? 0) + 1; continue; }
    const item = smartShadowItem(candidate.messageId);
    const claim = await claimSmartItem({ prefix: SAV_SMART_SHADOW_PREFIX, scope: day, item, worstMicroUsd: worst, capMicroUsd: config.capMicroUsdPerDay, maxItems: config.maxMailsPerDay, now: deps.now() });
    if (claim.status === "refused") {
      if (claim.reason === "already_claimed") { skippedMails.already_claimed = (skippedMails.already_claimed ?? 0) + 1; continue; }
      stoppedBy = claim.reason; break;
    }
    // From here every call is paid inside the reservation: at most 7 model calls and 3 embeddings, each bounded by the time left.
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
        { model: modelPort, knowledge: (deps.knowledge ?? (embed => smartDbKnowledge({ now: deps.now, embed })))(embedPort), maxInputBytes: cap, today: day,
          // Shadow: nothing is sent, so the agent's own questions and trials are never recorded; the memory is seeded from the thread.
          academy: deps.academy ?? getAcademyTools(), recordOwn: false, maxExchanges: smartMaxExchanges(env), ...smartCommercialSet(env) });
    } catch {
      // Unexpected: the reservation is kept as spent (nothing is known of what was sent), the mail never retried.
      await settleSmartItem({ prefix: SAV_SMART_SHADOW_PREFIX, scope: day, item, costMicroUsd: Math.max(cost, worst), status: "failed", now: deps.now(), result: null });
      outcomes.crashed = (outcomes.crashed ?? 0) + 1; ran += 1; continue;
    }
    const stored: SmartShadowStored = { v1Gate: "support", messageId: candidate.messageId, receivedAt: mail.receivedAt.toISOString(), startedAt: new Date(startedAt).toISOString(),
      durationMs: clock() - startedAt, costMicroUsd: cost, revision: SAV_SMART_PROMPT_REVISION, promptSha256: smartPromptSha256(smartCommercialSet(env)), contractRevision: SAV_SMART_CONTRACT_REVISION,
      model, codeSha: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 40) ?? null, turn };
    await settleSmartItem({ prefix: SAV_SMART_SHADOW_PREFIX, scope: day, item, costMicroUsd: cost, status: "done", now: deps.now(), result: stored });
    outcomes[turn.outcome] = (outcomes[turn.outcome] ?? 0) + 1; ran += 1;
    if (turn.outcome === "interrupted") { stoppedBy = "deadline"; break; }
  }
  const spentTodayMicroUsd = smartLedgerSpent(await readSmartLedger(SAV_SMART_SHADOW_PREFIX, day));
  const pass = { ran, stoppedBy, outcomes, skippedMails, discardedByV1, spentTodayMicroUsd };
  log("sav_smart_shadow_pass", { ...pass, day, revision: SAV_SMART_PROMPT_REVISION, promptSha256: smartPromptSha256(smartCommercialSet(env)).slice(0, 16), model });
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

/**
 * Pure: the report of stored shadow rows, in two blocks (SAV-116). `support`: the mails V1 classed support, which the agent processed (decisions,
 * hand-offs with their reasons, failures, cost, time p50/p95). `discardedByV1`: the mails V1 sent to the team, by reason, never given to the model.
 * Rows stored before the gate have no `v1Gate`: they are read as `unknown`, counted apart (`unknownGate`) and never mixed into the support figures.
 * Every number comes with its denominator (`mails`).
 */
export function aggregateSmartShadow(rows: readonly SmartShadowStored[], gates: readonly Pick<SmartShadowGateRow, "reason">[] = []) {
  const support = rows.filter(row => row.v1Gate === "support");
  const byReason: Record<string, number> = {};
  for (const gate of gates) bump(byReason, gate.reason);
  return { support: aggregateSupportRows(support), discardedByV1: { mails: gates.length, byReason }, unknownGate: { mails: rows.length - support.length } };
}

function aggregateSupportRows(rows: readonly SmartShadowStored[]) {
  const outcomes: Record<string, number> = {}, refusals: Record<string, number> = {}, verifyRefusals: Record<string, number> = {}, stopReasons: Record<string, number> = {};
  const missingByTheme: Record<string, number> = {}, sensitiveStopped = { net: 0, understand: 0 }, bytes: Record<string, number[]> = {};
  let corrected = 0, refusedAfterCorrection = 0, serverCaughtWhatVerifyPassed = 0, toolCalls = 0, mailsWithTools = 0, progressHandoffs = 0, withTeamNote = 0;
  const toolStatus: Record<string, number> = {}, decidePasses: Record<string, number> = {};
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
    // v2 (rows stored before the loop have no steps): tool calls by status, decide passes, handoffs forced by the progress rule, notes.
    const steps = turn.steps ?? [], tools = steps.filter(step => step.kind === "tool");
    toolCalls += tools.length; if (tools.length) mailsWithTools += 1;
    for (const step of tools) bump(toolStatus, `${step.tool}:${step.status}`);
    const passes = steps.filter(step => step.kind === "decide").length;
    if (passes) bump(decidePasses, String(passes));
    if (turn.reasons.some(reason => reason.startsWith("progress:"))) progressHandoffs += 1;
    if (turn.teamNote) withTeamNote += 1;
  }
  return {
    mails: rows.length, outcomes, sensitiveStopped, stopReasons, serverRefusals: refusals, verifyRefusals, corrected, refusedAfterCorrection, serverCaughtWhatVerifyPassed,
    costMicroUsd: { total: rows.reduce((sum, row) => sum + row.costMicroUsd, 0), ...spread(rows.map(row => row.costMicroUsd)) },
    durationMs: spread(rows.map(row => row.durationMs)),
    bytesByStage: Object.fromEntries(Object.entries(bytes).map(([kind, values]) => [kind, spread(values)])),
    missingByTheme,
    tools: { calls: toolCalls, mailsWithTools, byToolAndStatus: toolStatus, decidePasses }, progressHandoffs, withTeamNote,
    revisions: [...new Set(rows.map(row => `${row.revision}:${row.promptSha256.slice(0, 16)}:${row.model}:${row.codeSha ?? "?"}`))],
  };
}

/** The stored rows of the shadow (decrypted, read only), oldest first, bounded. */
export async function readSmartShadowRows(limit = 500): Promise<SmartShadowStored[]> {
  const rows = await requireDb().select().from(savSyncState).where(and(like(savSyncState.key, `${smartItemKey(SAV_SMART_SHADOW_PREFIX, "mail:")}%`), eq(savSyncState.status, "done")))
    .orderBy(asc(savSyncState.startedAt)).limit(Math.min(Math.max(limit, 1), 2_000));
  return rows.flatMap(row => { try { const stored = decryptSavPayload<SmartItemRow<SmartShadowStored>>(row.cursor ?? ""); return stored.result ? [stored.result] : []; } catch { return []; } });
}

/** The light rows of the mails V1 sent to the team (read only, codes and numbers), oldest first, bounded. */
export async function readSmartShadowGates(limit = 2_000): Promise<SmartShadowGateRow[]> {
  const rows = await requireDb().select().from(savSyncState).where(and(like(savSyncState.key, `${SAV_SMART_SHADOW_PREFIX}:gate:%`), eq(savSyncState.status, "team")))
    .orderBy(asc(savSyncState.startedAt)).limit(Math.min(Math.max(limit, 1), 5_000));
  return rows.flatMap(row => { try { return [decryptSavPayload<SmartShadowGateRow>(row.cursor ?? "")]; } catch { return []; } });
}
