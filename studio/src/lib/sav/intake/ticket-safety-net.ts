import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { savIntakeRuns, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { listSavExternalCompletionMessageIds, readSavExternalCompletion } from "../external-completion";
import { readSavAgentPause } from "./agent-pause";
import { intakeActiveBlockSql, intakeAttemptBudget, intakeRescueConsumedSql, intakeRunAnalysed, SAV_INTAKE_ATTEMPT_POLICY, SAV_INTAKE_BLOCKING_JOURNAL_KINDS, SAV_INTAKE_RESCUE_KINDS } from "./attempt-policy";
import { savIntakeRuntimeConfig, type IntakeRuntimeConfig, type IntakeRuntimePayload } from "./runtime-contract";

/**
 * SAV-88 ticket safety net (Ugo, 12/11): no client mail stays without a HubSpot ticket and without anyone knowing.
 *
 * This module NEVER writes to HubSpot or Gmail and never calls a model. It is a trigger:
 * - a mail whose V1 analysis ran out of attempts gets ONE recorded rescue attempt (journal `rescue_granted`) that the
 *   NORMAL V1 pipeline consumes: same claim, same daily AI budget, same planner (classification, exclusions, same/other
 *   subject, 15-day rule, identification template), same executor, admission, recovery and policy. See attempt-policy.ts.
 * - when the rescue does not conclude either, V1 itself writes `rescue_failed`: the dossier is "à traiter à la main"
 *   (console cause `manual_required`, morning counter) and no further attempt is ever made.
 * - every other mail older than 24 h without ticket is listed with its V1 cause; nothing is decided here.
 *
 * Modes (`SAV_INTAKE_TICKET_SAFETY_NET`): `off`; `observe` (default: list and count, no write); `execute` (grant rescues).
 */
export const SAV_SAFETY_NET_AFTER_MS = 24 * 3_600_000;
export const SAV_SAFETY_NET_BATCH = 5;
export type SafetyNetMode = "off" | "observe" | "execute";
export function safetyNetMode(env: Record<string, string | undefined> = process.env): SafetyNetMode {
  const value = env.SAV_INTAKE_TICKET_SAFETY_NET ?? "observe";
  return value === "execute" || value === "off" ? value : "observe";
}

/** What the V1 state of a mail without ticket means for the team. Never a guess: each comes from a stored V1 fact. */
export type SafetyNetCategory =
  | "rescue_eligible"   // attempts exhausted by the lifetime caps: one rescue through V1 can be granted
  | "rescue_pending"    // rescue granted, waiting for the next V1 analysis pass
  | "rescue_running"    // rescue claimed by V1: analysis or execution in progress
  | "manual"            // "à traiter à la main": rescue failed, or blocked by a marker a new attempt cannot lift
  | "human_decision"    // V1 decided a person must choose or complete (collect_context / human choice), or a human pause holds the dossier (human_hold)
  | "execution_pending" // V1 decided a ticket or an identification email; the V1 executor has not done it yet
  | "in_progress";      // V1 still has attempts (queued, deferred, waiting): nothing to rescue yet
export type SafetyNetItem = { messageId: string; threadId: string; ageHours: number; over24h: boolean; category: SafetyNetCategory; cause: string | null };

type Row = { message_id: string; thread_id: string; received_at: string | Date; run_id: string | null; run_state: string | null; run_attempts: number | null;
  run_config: string | null; run_payload: string | null; blocking: string | null; lifetime: string | null; granted: boolean; claimed: boolean; usedHere: boolean; failed: boolean; ai_paused?: boolean | null };

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[];
}

/** Latest inbound of each open thread of the mailbox with no ticket at all (thread, V1 execution or confirmed creation), oldest first. Read only. */
async function readCandidates(runtime: Pick<IntakeRuntimeConfig, "mailboxId">, limit: number) {
  const db = requireDb();
  const handled = await listSavExternalCompletionMessageIds(db, false, runtime.mailboxId);
  const notHandled = handled.length ? sql`m.id not in (${sql.join(handled.map(id => sql`${id}::uuid`), sql`, `)})` : sql`true`;
  const others = SAV_INTAKE_BLOCKING_JOURNAL_KINDS.filter(k => k !== "attempts_exhausted");
  return rows<Row>(await db.execute(sql`select m.id as message_id, m.thread_id, least(m.received_at, m.created_at) as received_at,
      t.ai_paused as ai_paused, r.id as run_id, r.state as run_state, r.attempts as run_attempts, r.config_hash as run_config, r.payload_ciphertext as run_payload,
      (select bj.kind from sav.intake_journal bj where bj.run_id = r.id and bj.kind in (${sql.join(others.map(k => sql`${k}`), sql`, `)}) order by bj.created_at desc limit 1) as blocking,
      case when ${intakeActiveBlockSql(sql`r.id`, ["attempts_exhausted"])} then 'attempts_exhausted' else null end as lifetime,
      exists(select 1 from sav.intake_journal g where g.run_id = r.id and g.kind = ${SAV_INTAKE_RESCUE_KINDS.granted}) as granted,
      ${intakeRescueConsumedSql(sql`m.id`)} as claimed, ${intakeRescueConsumedSql(sql`m.id`, sql`r.id`)} as "usedHere",
      exists(select 1 from sav.intake_journal c join sav.intake_runs cr on cr.id = c.run_id where cr.message_id = m.id and c.kind = ${SAV_INTAKE_RESCUE_KINDS.failed}) as failed
    from sav.messages m join sav.threads t on t.id = m.thread_id
      join sav.intake_runs r on r.message_id = m.id and r.is_current
    where t.mailbox_id = ${runtime.mailboxId} and m.direction = 'inbound' and ${notHandled}
      and t.status not in ('resolved', 'closed_no_action') and t.hubspot_ticket_id is null
      and m.id = (select l.id from sav.messages l where l.thread_id = m.thread_id and l.direction = 'inbound'
        order by least(l.received_at, l.created_at) desc, l.created_at desc, l.id desc limit 1)
      and not exists(select 1 from sav.intake_executions e where e.thread_id = t.id and (e.ticket_id is not null or e.state = 'confirmed'))
      and not exists(select 1 from sav.intake_effects f join sav.intake_executions e on e.id = f.execution_id
        where e.thread_id = t.id and f.kind = 'ticket_create' and f.state = 'confirmed')
    order by least(m.received_at, m.created_at) asc, m.created_at asc, m.id asc limit ${Math.max(1, Math.min(500, limit))}`));
}

function categorize(row: Row, runtime: Pick<IntakeRuntimeConfig, "configHash">, now: Date): SafetyNetItem | null {
  const receivedAt = new Date(row.received_at), ageMs = now.getTime() - receivedAt.getTime();
  let payload: IntakeRuntimePayload | null = null;
  try { payload = row.run_payload ? decryptSavPayload<IntakeRuntimePayload>(row.run_payload) : null; } catch { payload = null; }
  const plan = payload?.plan, disposition = plan?.decision?.disposition;
  // The V1 rules give these no ticket (automatic notice, acknowledgement, qualified « Autres », commercial/partner/investor): never listed.
  if (disposition?.kind === "no_ticket") return null;
  const base = { messageId: row.message_id, threadId: row.thread_id, ageHours: Math.floor(ageMs / 3_600_000), over24h: ageMs > SAV_SAFETY_NET_AFTER_MS };
  const item = (category: SafetyNetCategory, cause: string | null): SafetyNetItem => ({ ...base, category, cause });
  if (row.failed) return item("manual", "rescue_failed");
  if (row.blocking) return item("manual", row.blocking);
  // Once the rescue analysis is observed, it is V1's decision (categories below), never a rescue still running.
  if (row.usedHere && row.run_state !== "observed") return item("rescue_running", row.run_state);
  // SAV-90: the team holds the thread (threads.ai_paused). V1 legitimately waits on it and a rescue is never granted
  // there (grantIntakeRescue): a human decision, listed when it would otherwise be, never « in progress / pending ».
  if (row.ai_paused) return base.over24h || row.lifetime ? item("human_decision", "human_hold") : null;
  if (row.lifetime) {
    // Exhausted again after the one rescue of this message (for example on a later version): no second rescue.
    if (row.claimed) return item("manual", "rescue_used");
    if (row.granted) return item("rescue_pending", "attempts_exhausted");
    // A version without a free slot, or bound to an older configuration, cannot take the rescue now: a person decides.
    const rescuable = (row.run_attempts ?? 0) < SAV_INTAKE_ATTEMPT_POLICY.perVersion && row.run_config === runtime.configHash;
    return item(rescuable ? "rescue_eligible" : "manual", rescuable ? "attempts_exhausted" : "attempts_exhausted_version");
  }
  if (!base.over24h) return null;
  if (disposition?.kind === "collect_context" || plan?.progress?.kind === "human_choice")
    return item("human_decision", disposition?.kind === "collect_context" ? disposition.reasons[0] ?? null : "human_choice");
  if (disposition) return item("execution_pending", disposition.kind);
  return item("in_progress", payload?.reason ?? row.run_state);
}

export type SafetyNetReport = { mode: SafetyNetMode; skipped?: string; withoutTicketOver24h: number; manual: number; eligible: number; granted: number; items: SafetyNetItem[] };

/** Read only. Ids, ages and codes only: no address, no subject, no amount. */
export async function listTicketSafetyNet(runtime: Pick<IntakeRuntimeConfig, "mailboxId" | "configHash">, now = new Date(), limit = 500) {
  const candidates = await readCandidates(runtime, limit);
  for (const row of candidates) if (!row.lifetime && !row.usedHere && row.run_id && await lifetimeExhausted(row.run_id, row.message_id)) row.lifetime = "attempts_exhausted";
  return candidates.map(row => categorize(row, runtime, now)).filter((x): x is SafetyNetItem => x !== null);
}
/** SAV-88 review B1: the version a deployment re-creates after the lifetime cap is never claimed, so it never gets the
 * attempts_exhausted marker. The exhaustion is derived from the same budget the V1 claim applies; a run that already
 * holds an analysis is a V1 decision, never an exhaustion. */
async function lifetimeExhausted(runId: string, messageId: string, db: Pick<ReturnType<typeof requireDb>, "select"> = requireDb()) {
  const siblings = await db.select({ id: savIntakeRuns.id, attempts: savIntakeRuns.attempts, payloadCiphertext: savIntakeRuns.payloadCiphertext }).from(savIntakeRuns).where(eq(savIntakeRuns.messageId, messageId));
  const current = siblings.find(s => s.id === runId);
  if (!current || intakeRunAnalysed(current.payloadCiphertext) !== false) return false;
  const exhausted = intakeAttemptBudget(runId, siblings).exhausted;
  return exhausted === "failed_per_message" || exhausted === "total_per_message";
}

/** Records one rescue on the current run of `messageId`, under the thread lock V1 claims take. Re-checks every condition. */
export async function grantIntakeRescue(messageId: string, runtime: IntakeRuntimeConfig, trigger: "attempts_exhausted" | "over_24h") {
  return requireDb().transaction(async tx => {
    const [message] = await tx.select().from(savMessages).where(eq(savMessages.id, messageId));
    if (!message) return false;
    const [thread] = await tx.select().from(savThreads).where(eq(savThreads.id, message.threadId)).for("update");
    const [run] = await tx.select().from(savIntakeRuns).where(and(eq(savIntakeRuns.messageId, messageId), eq(savIntakeRuns.isCurrent, true))).for("update");
    if (!thread || !run || thread.aiPaused || thread.hubspotTicketId || run.configHash !== runtime.configHash || run.attempts >= SAV_INTAKE_ATTEMPT_POLICY.perVersion) return false;
    if (await readSavExternalCompletion(message, tx)) return false;
    const [fresh] = rows<{ lifetime: boolean; other: boolean; granted: boolean; used: boolean; ticket: boolean }>(await tx.execute(sql`select
        ${intakeActiveBlockSql(sql`${run.id}::uuid`, ["attempts_exhausted"])} as lifetime,
        ${intakeActiveBlockSql(sql`${run.id}::uuid`, SAV_INTAKE_BLOCKING_JOURNAL_KINDS.filter(k => k !== "attempts_exhausted"))} as other,
        exists(select 1 from sav.intake_journal g where g.run_id = ${run.id}::uuid and g.kind = ${SAV_INTAKE_RESCUE_KINDS.granted}) as granted,
        ${intakeRescueConsumedSql(sql`${messageId}::uuid`)} as used,
        exists(select 1 from sav.intake_executions e where e.thread_id = ${thread.id}::uuid and (e.ticket_id is not null or e.state = 'confirmed')) as ticket`));
    if (!fresh || fresh.other || fresh.granted || fresh.used || fresh.ticket || !fresh.lifetime && !await lifetimeExhausted(run.id, messageId, tx)) return false;
    const siblings = await tx.select({ id: savIntakeRuns.id, attempts: savIntakeRuns.attempts, payloadCiphertext: savIntakeRuns.payloadCiphertext }).from(savIntakeRuns).where(eq(savIntakeRuns.messageId, messageId));
    const budget = intakeAttemptBudget(run.id, siblings);
    if (!budget.exhausted || budget.exhausted === "per_version") return false;
    await tx.execute(sql`insert into sav.intake_journal (run_id, kind, payload_ciphertext) values (${run.id}::uuid, ${SAV_INTAKE_RESCUE_KINDS.granted},
      ${encryptSavPayload({ revision: "sav-intake-rescue.v1", trigger, cause: budget.exhausted, failed: budget.failed, total: budget.total })})`);
    // A due time left by an earlier wait never delays the rescue; the claim takes its own lease.
    await tx.update(savIntakeRuns).set({ leaseUntil: null, updatedAt: new Date() }).where(and(eq(savIntakeRuns.id, run.id), sql`${savIntakeRuns.leaseToken} is null`));
    return true;
  });
}

/** One bounded pass: list, count, and in `execute` grant at most `batch` rescues (oldest first). Listing-only dossiers never take a slot. */
export async function reconcileTicketSafetyNet(options: { env?: Record<string, string | undefined>; now?: Date; deadlineMs?: number; batch?: number } = {}): Promise<SafetyNetReport> {
  const env = options.env ?? process.env, now = options.now ?? new Date(), mode = safetyNetMode(env);
  const empty = (skipped: string): SafetyNetReport => ({ mode, skipped, withoutTicketOver24h: 0, manual: 0, eligible: 0, granted: 0, items: [] });
  if (mode === "off") return empty("off");
  let runtime: IntakeRuntimeConfig | null;
  try { runtime = savIntakeRuntimeConfig(env); } catch { return empty("runtime_configuration_invalid"); }
  if (!runtime) return empty("runtime_off");
  const items = await listTicketSafetyNet(runtime, now);
  const eligible = items.filter(i => i.category === "rescue_eligible");
  const report: SafetyNetReport = { mode, withoutTicketOver24h: items.filter(i => i.over24h).length, manual: items.filter(i => i.category === "manual").length,
    eligible: eligible.length, granted: 0, items };
  if (mode === "execute") {
    // A full pause stops every claim: a rescue granted now would only wait. An actions-only pause still lets V1 analyse.
    const pause = await readSavAgentPause(requireDb());
    if (pause.level === "fully_paused") report.skipped = "agent_paused";
    else for (const candidate of eligible.slice(0, Math.max(0, options.batch ?? SAV_SAFETY_NET_BATCH))) {
      if (options.deadlineMs && Date.now() + 2_000 > options.deadlineMs) { report.skipped = "deadline"; break; }
      if (await grantIntakeRescue(candidate.messageId, runtime, candidate.over24h ? "over_24h" : "attempts_exhausted")) report.granted++;
    }
  }
  console.info("sav_intake_ticket_safety_net", { mode, skipped: report.skipped ?? null, withoutTicketOver24h: report.withoutTicketOver24h, manual: report.manual,
    eligible: report.eligible, granted: report.granted, items: items.filter(i => i.over24h || i.category !== "in_progress").slice(0, 50)
      .map(i => ({ messageId: i.messageId, ageHours: i.ageHours, category: i.category, cause: i.cause })) });
  return report;
}

/** Morning list / monitoring: dossiers without ticket, by category. Ids, ages and codes only. */
export async function readTicketSafetyNetBacklog(env: Record<string, string | undefined> = process.env, now = new Date()) {
  const runtime = savIntakeRuntimeConfig(env);
  if (!runtime) return { available: false as const, reason: "runtime_off" };
  const items = await listTicketSafetyNet(runtime, now);
  const count = (c: SafetyNetCategory) => items.filter(i => i.category === c).length;
  return { available: true as const, mode: safetyNetMode(env), withoutTicketOver24h: items.filter(i => i.over24h).length, manual: count("manual"),
    rescueEligible: count("rescue_eligible"), rescuePending: count("rescue_pending"), rescueRunning: count("rescue_running"), humanDecision: count("human_decision"),
    executionPending: count("execution_pending"), inProgress: count("in_progress"), oldestHours: items.reduce((max, i) => Math.max(max, i.ageHours), 0),
    dossiers: items.filter(i => i.over24h || i.category === "manual").slice(0, 100).map(i => ({ messageId: i.messageId, threadId: i.threadId, ageHours: i.ageHours, category: i.category, cause: i.cause })) };
}
