import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { requireDb } from "@/db";

// SAV-9 backlog: a mail the retired V0 engine had started (processing, failed, or pending with an attempt or any V0 trace) is never claimed by
// intake (`unclaimedMessage` in runtime-store.ts) and V0 no longer resumes it. This module makes it READABLE: which cause, how old, who takes it,
// and what a person can check without touching anything. Likewise the human V0 commands that were already queued when the circuit was retired.
// Everything here is a read in a read-only transaction. It resumes, resets, cancels, acknowledges and sends nothing, calls no provider and no
// model, and returns identifiers, counts and fixed codes only (no mail text, no address, no CRM data). The decision on the queued commands is
// Ugo's (PRODUCT_QUESTIONS C2): nothing here executes or cancels them.

/** Grace period before a mail counts as abandoned; the monitor's historical value. */
export const LEGACY_STARTED_GRACE_SECONDS = 600;
const PAGE_MAX = 100;

export const legacyStartedCauses = ["v0_processing", "v0_failed", "v0_pending_after_attempt", "v0_pending_with_traces"] as const;
export type LegacyStartedCause = typeof legacyStartedCauses[number];
export const legacyCommandStates = ["queued_not_dispatched", "running_not_dispatched", "dispatch_started_unconfirmed"] as const;
export type LegacyCommandState = typeof legacyCommandStates[number];
export type LegacyReadOnlyCheck = "open_archived_dossier" | "check_gmail_thread_for_a_reply" | "check_crm_ticket";

const CAUSES: Record<LegacyStartedCause, { label: string }> = {
  v0_processing: { label: "L'ancien moteur avait commencé l'analyse de ce mail et ne la reprendra pas." },
  v0_failed: { label: "L'ancien moteur a échoué sur ce mail et ne le reprendra pas." },
  v0_pending_after_attempt: { label: "L'ancien moteur avait tenté ce mail (tentative ou début d'analyse enregistrés) sans le terminer." },
  v0_pending_with_traces: { label: "Ce mail porte des traces de l'ancien moteur (décision, exécution, action ou relecture) sans analyse terminée." },
};
const CHECKS: LegacyReadOnlyCheck[] = ["open_archived_dossier", "check_gmail_thread_for_a_reply", "check_crm_ticket"];
export const legacyReadOnlyCheckLabels: Record<LegacyReadOnlyCheck, string> = {
  open_archived_dossier: "Consulter le dossier archivé (lecture seule).",
  check_gmail_thread_for_a_reply: "Vérifier dans le fil Gmail si une réponse est déjà partie.",
  check_crm_ticket: "Vérifier dans le CRM si un ticket existe déjà.",
};

/**
 * The handoff is always the team, by hand: neither V1 nor the retired engine will process this mail. The checks are for a person; nothing here
 * runs them and nothing is reset.
 */
export function describeLegacyStartedCause(cause: LegacyStartedCause) {
  return { cause, label: CAUSES[cause].label, handoff: { owner: "team" as const, state: "manual_follow_up" as const, automaticRecovery: false as const }, readOnlyChecks: [...CHECKS] };
}

const COMMANDS: Record<LegacyCommandState, { label: string; cronMayStillExecute: boolean }> = {
  queued_not_dispatched: { label: "Commande humaine de l'ancien circuit en file, rien n'est parti. Le cron peut encore l'exécuter ; décision d'Ugo attendue.", cronMayStillExecute: true },
  running_not_dispatched: { label: "Commande humaine de l'ancien circuit en cours sans trace d'envoi. Le cron peut la reprendre ; décision d'Ugo attendue.", cronMayStillExecute: true },
  dispatch_started_unconfirmed: { label: "Envoi tenté par l'ancien circuit, non confirmé. Il n'est jamais renvoyé ; seule la vérification en lecture seule est possible.", cronMayStillExecute: false },
};
export function describeLegacyCommandState(state: LegacyCommandState) {
  return { state, label: COMMANDS[state].label, cronMayStillExecute: COMMANDS[state].cronMayStillExecute, handoff: { owner: "team" as const, decision: "ugo_pending_C2" as const },
    readOnlyChecks: [...CHECKS], automaticAction: false as const };
}

/** The monitor's own predicate, shared so the count and the inventory cannot drift apart. Latest inbound mail of an unpaused thread past the grace period. */
export function legacyStartedMailSource(now: Date): SQL {
  return sql`from sav.messages m join sav.threads t on t.id=m.thread_id
    join sav.sync_state l on l.key='sav-intake-launch:'||m.mailbox_id::text and l.status='intake_launch_v1'
    where m.direction='inbound' and not t.ai_paused and m.created_at < ${new Date(now.getTime() - LEGACY_STARTED_GRACE_SECONDS * 1000).toISOString()}
    and m.received_at>(l.cursor::jsonb->>'receivedAfter')::timestamptz and m.created_at>(l.cursor::jsonb->>'createdAfter')::timestamptz
    and not exists(select 1 from sav.messages n where n.thread_id=m.thread_id and n.direction='inbound' and (least(n.received_at,n.created_at),n.created_at,n.id)>(least(m.received_at,m.created_at),m.created_at,m.id))
    and (m.analysis_status in ('processing','failed') or m.analysis_status='pending' and (m.analysis_attempts<>0 or m.analysis_started_at is not null or m.processed_at is not null
      or exists(select 1 from sav.decisions d where d.message_id=m.id) or exists(select 1 from sav.agent_runs a where a.message_id=m.id)
      or exists(select 1 from sav.pilot_items p where p.message_id=m.id) or exists(select 1 from sav.actions a where a.message_id=m.id)
      or exists(select 1 from sav.proposal_reviews r where r.message_id=m.id)))`;
}
export const legacyStartedCauseSql = sql`case when m.analysis_status='processing' then 'v0_processing' when m.analysis_status='failed' then 'v0_failed'
  when m.analysis_attempts<>0 or m.analysis_started_at is not null or m.processed_at is not null then 'v0_pending_after_attempt' else 'v0_pending_with_traces' end`;

/** Legacy conflict kinds and markers of `assertNoLegacyConflict` (execution-store.ts): the same rows V1 admission looks at. */
const KINDS = sql`('create_ticket','link_ticket','create_note','log_email','update_ticket_status','send_reply','request_human')`;
const MARKER = sql`(a.payload->>'ticketCreateDispatchedAt' is not null or a.payload->>'ticketReturnDispatchedAt' is not null or a.payload->>'replySendDispatchedAt' is not null
  or a.payload->>'forwardDispatchedAt' is not null or a.payload->>'intakeOccupationDispatchedAt' is not null)`;
const COMMAND_STATE = sql`case when ${MARKER} then 'dispatch_started_unconfirmed' when a.status='running' then 'running_not_dispatched' else 'queued_not_dispatched' end`;
/** Human commands still open: pending or running, or a dispatch trace on a row that is not succeeded (failed or cancelled with a trace stays visible). */
export function legacyHumanCommandSource(): SQL {
  return sql`from sav.actions a where a.actor_type='human' and a.kind in ${KINDS} and a.status<>'succeeded' and (a.status in ('pending','running') or ${MARKER})`;
}
/** Machine rows still open: what blocks V1 admission everywhere (LEGACY_SCOPE_OCCUPIED). Counted, never touched. */
export function legacyMachineRowSource(): SQL {
  return sql`from sav.actions a where a.actor_type<>'human' and a.kind in ${KINDS} and a.status<>'succeeded' and (a.status in ('pending','running') or ${MARKER})`;
}

type Reader = Pick<ReturnType<typeof requireDb>, "execute">;
export async function legacyRows<T extends Record<string, unknown>>(tx: Reader, statement: SQL): Promise<T[]> {
  const result = await tx.execute<T>(statement);
  const rows = Array.isArray(result) ? result : (result as unknown as { rows: T[] }).rows;
  if (!Array.isArray(rows) || rows.length > PAGE_MAX) throw Error("SAV_LEGACY_STARTED_RESULT_INVALID");
  return rows as T[];
}

const zeroCauses = () => Object.fromEntries(legacyStartedCauses.map(c => [c, 0])) as Record<LegacyStartedCause, number>;
const zeroStates = () => Object.fromEntries(legacyCommandStates.map(s => [s, 0])) as Record<LegacyCommandState, number>;
const known = <T extends string>(list: readonly T[], value: unknown): T => { if (!list.includes(value as T)) throw Error("SAV_LEGACY_STARTED_VALUE_INVALID"); return value as T; };

/** Counts by cause and age of the oldest mail; the monitor's `legacy_unclaimed` is their sum. */
export async function countLegacyStartedMails(tx: Reader, now: Date) {
  const rows = await legacyRows<{ cause: string; count: number; oldest: number | null }>(tx, sql`select ${legacyStartedCauseSql} as cause, count(*)::int as count,
    extract(epoch from (${now.toISOString()}::timestamptz-min(m.created_at)))::int as oldest ${legacyStartedMailSource(now)} group by 1`);
  const byCause = zeroCauses();
  let total = 0, oldest = 0;
  for (const row of rows) { byCause[known(legacyStartedCauses, row.cause)] = row.count; total += row.count; oldest = Math.max(oldest, row.oldest ?? 0); }
  return { total, byCause, oldestAgeSeconds: Math.max(0, oldest) };
}
export async function countLegacyHumanCommands(tx: Reader, now: Date) {
  const rows = await legacyRows<{ state: string; count: number; oldest: number | null }>(tx, sql`select ${COMMAND_STATE} as state, count(*)::int as count,
    extract(epoch from (${now.toISOString()}::timestamptz-min(a.created_at)))::int as oldest ${legacyHumanCommandSource()} group by 1`);
  const byState = zeroStates();
  let total = 0, oldest = 0;
  for (const row of rows) { byState[known(legacyCommandStates, row.state)] = row.count; total += row.count; oldest = Math.max(oldest, row.oldest ?? 0); }
  const machine = await legacyRows<{ count: number }>(tx, sql`select count(*)::int as count ${legacyMachineRowSource()}`);
  return { total, byState, oldestAgeSeconds: Math.max(0, oldest), machineRowsOpen: machine[0]?.count ?? 0 };
}

export type LegacyStartedInventory = Awaited<ReturnType<typeof readLegacyStartedInventory>>;
/**
 * The readable inventory. Ordered oldest first, bounded (`limit` 1 to 100, default 50, with `truncated` when more exist). Read-only transaction.
 * An item carries identifiers (message, thread, action), a fixed cause or state, ages and the V0 trace counts, plus the French label and the
 * handoff. It never carries content.
 */
export async function readLegacyStartedInventory(input: { now?: Date; limit?: number; db?: Pick<ReturnType<typeof requireDb>, "transaction"> } = {}) {
  const now = input.now ?? new Date(), limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new RangeError("limit must be an integer from 1 to 100");
  return (input.db ?? requireDb()).transaction(async tx => {
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    await tx.execute(sql`select set_config('statement_timeout','5s',true),set_config('lock_timeout','1s',true)`);
    const mails = await countLegacyStartedMails(tx, now), commands = await countLegacyHumanCommands(tx, now);
    const mailRows = await legacyRows<{ message_id: string; thread_id: string; cause: string; age_seconds: number; attempts: number; decisions: number; runs: number; pilot_items: number; actions: number; reviews: number }>(tx,
      sql`select m.id::text as message_id, m.thread_id::text as thread_id, ${legacyStartedCauseSql} as cause, extract(epoch from (${now.toISOString()}::timestamptz-m.created_at))::int as age_seconds,
        m.analysis_attempts::int as attempts,
        (select count(*) from sav.decisions d where d.message_id=m.id)::int as decisions, (select count(*) from sav.agent_runs a where a.message_id=m.id)::int as runs,
        (select count(*) from sav.pilot_items p where p.message_id=m.id)::int as pilot_items, (select count(*) from sav.actions a where a.message_id=m.id)::int as actions,
        (select count(*) from sav.proposal_reviews r where r.message_id=m.id)::int as reviews
        ${legacyStartedMailSource(now)} order by m.created_at, m.id limit ${limit}`);
    const commandRows = await legacyRows<{ action_id: string; thread_id: string; message_id: string | null; kind: string; status: string; state: string; attempts: number; age_seconds: number }>(tx,
      sql`select a.id::text as action_id, a.thread_id::text as thread_id, a.message_id::text as message_id, a.kind::text as kind, a.status::text as status, ${COMMAND_STATE} as state,
        a.attempt_count::int as attempts, extract(epoch from (${now.toISOString()}::timestamptz-a.created_at))::int as age_seconds
        ${legacyHumanCommandSource()} order by a.created_at, a.id limit ${limit}`);
    return {
      observedAt: now.toISOString(), readOnly: true as const, providerCalls: 0 as const, modelCalls: 0 as const,
      startedMails: { total: mails.total, byCause: mails.byCause, oldestAgeSeconds: mails.oldestAgeSeconds, truncated: mails.total > mailRows.length,
        items: mailRows.map(row => ({ messageId: row.message_id, threadId: row.thread_id, ageSeconds: Math.max(0, row.age_seconds), v0Attempts: row.attempts,
          traces: { decisions: row.decisions, agentRuns: row.runs, pilotItems: row.pilot_items, actions: row.actions, reviews: row.reviews }, ...describeLegacyStartedCause(known(legacyStartedCauses, row.cause)) })) },
      queuedHumanCommands: { total: commands.total, byState: commands.byState, oldestAgeSeconds: commands.oldestAgeSeconds, truncated: commands.total > commandRows.length,
        items: commandRows.map(row => ({ actionId: row.action_id, threadId: row.thread_id, messageId: row.message_id, kind: row.kind, status: row.status, attempts: row.attempts,
          ageSeconds: Math.max(0, row.age_seconds), ...describeLegacyCommandState(known(legacyCommandStates, row.state)) })) },
      machineRowsOpen: commands.machineRowsOpen,
    };
  });
}
