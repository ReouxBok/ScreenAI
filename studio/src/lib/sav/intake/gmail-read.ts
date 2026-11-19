import "server-only";
import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savActions, savMailboxes, savMessages, savThreads, savIntakeConsole } from "@/db/schema";
import { requestSavGmail } from "../gmail";
import { getSavExternalCompletion, hasUnsettledSavHumanAction, hasUnsettledSavIntakeWork, listSavExternalCompletionMessageIds } from "../external-completion";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "./execution-policy";
import { assertSavAgentActionsAllowed, readSavAgentPause, savAgentPauseCode } from "./agent-pause";
import { readIntakeExecutionProgress } from "./executor";
import { intakeConsoleInstalled } from "./console-capability";
import { readSavIntakeCurrent } from "./runtime-store";
import type { GmailRequest } from "./execution-adapters";
import { savEffectiveReceivedAt } from "@/lib/sav/message-order";

export const SAV_INTAKE_GMAIL_READ = "sav_intake_gmail_read_confirmed";
const FAILED = "sav_intake_gmail_read_failed";
type Source = { mailboxEmail: string; gmailMessageId: string; gmailThreadId: string };
type Metadata = { id?: string; threadId?: string; labelIds?: string[] };

/** Idempotent single-message operation. A timeout is recovered by GET, never by
 * replaying CRM work or sending email. INBOX and all other labels stay intact. */
export async function markHandledGmailMessageRead(source: Source, gmail: GmailRequest, beforeModify: () => Promise<void>) {
  if (source.mailboxEmail !== "contact@limova.ai" || !/^[a-f0-9]+$/i.test(source.gmailMessageId) || !/^[a-f0-9]+$/i.test(source.gmailThreadId)) throw Error("SAV_INTAKE_GMAIL_READ_SOURCE_INVALID");
  const profile = await gmail<{ emailAddress?: string }>(source.mailboxEmail, "profile");
  if (profile.emailAddress?.toLowerCase() !== source.mailboxEmail) throw Error("SAV_INTAKE_GMAIL_READ_MAILBOX_MISMATCH");
  const path = `messages/${source.gmailMessageId}`;
  const read = () => gmail<Metadata>(source.mailboxEmail, `${path}?format=metadata&fields=id,threadId,labelIds`);
  const validate = (message: Metadata) => {
    if (message.id !== source.gmailMessageId || message.threadId !== source.gmailThreadId || !Array.isArray(message.labelIds)
      || message.labelIds.some(x => typeof x !== "string") || message.labelIds.includes("DRAFT") || message.labelIds.includes("SENT")) throw Error("SAV_INTAKE_GMAIL_READ_SOURCE_MISMATCH");
  };
  const before = await read(); validate(before);
  if (!before.labelIds!.includes("UNREAD")) return { alreadyRead: true };
  await beforeModify();
  await gmail(source.mailboxEmail, `${path}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) });
  const after = await read(); validate(after);
  if (after.labelIds!.includes("UNREAD")) throw Error("SAV_INTAKE_GMAIL_READ_UNCONFIRMED");
  return { alreadyRead: false };
}

/** Separately retriable Gmail receipt. No CRM/model adapter is invoked here. */
export async function syncHandledIntakeGmailRead(messageId: string, deps: { env?: () => Record<string, string | undefined>; gmail?: GmailRequest } = {}) {
  const env = deps.env ?? (() => process.env);
  if (env().SAV_INTAKE_GMAIL_MARK_READ !== "on") return { skipped: "off" };
  const authority = async () => {
    const current = env(), config = intakeExecutionConfig(current);
    if (!config || current.SAV_INTAKE_GMAIL_MARK_READ !== "on") throw Error("SAV_INTAKE_GMAIL_READ_DISABLED");
    await readIntakeExecutionAuthority(config);
    // A Gmail write like any other effect: also rechecked just before the modify.
    await assertSavAgentActionsAllowed(requireDb());
  };
  // Paused: no Gmail call and no failure marker; the receipt is retried after resume.
  const paused = savAgentPauseCode(await readSavAgentPause(requireDb()));
  if (paused) return { skipped: paused };
  await authority();
  const db = requireDb();
  if (!await intakeConsoleInstalled(db)) return { skipped: "schema_absent" };
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.id, messageId), eq(savMessages.direction, "inbound")));
  if (!message) return { skipped: "message_missing" };
  // The other inbound messages of the same thread and mailbox are covered by the
  // handled message's proof (evidence() requires it to be the latest inbound).
  const earlier = await db.select({ id: savMessages.id, gmailMessageId: savMessages.gmailMessageId }).from(savMessages)
    .where(and(eq(savMessages.threadId, message.threadId), eq(savMessages.mailboxId, message.mailboxId), eq(savMessages.direction, "inbound"),
      ne(savMessages.id, message.id), sql`${savMessages.gmailMessageId} is not null`))
    .orderBy(asc(savEffectiveReceivedAt), asc(savMessages.id));
  const confirmedIds = new Set((await db.select({ id: auditLogs.entityId }).from(auditLogs).where(and(eq(auditLogs.action, SAV_INTAKE_GMAIL_READ),
    eq(auditLogs.entityType, "sav_message"), eq(auditLogs.actorEmail, "studio-intake"), inArray(auditLogs.entityId, [message.id, ...earlier.map(row => row.id)])))).map(row => row.id));
  const handledConfirmed = confirmedIds.has(message.id);
  const pendingEarlier = earlier.filter(row => !confirmedIds.has(row.id)).slice(0, EARLIER_MESSAGES_PER_CALL);
  if (handledConfirmed && !pendingEarlier.length) return { skipped: "already_confirmed" };
  const evidence = async (): Promise<Record<string, string> | null> => {
    const handled = await getSavExternalCompletion(message);
    if (handled) return { administrativeId: handled.id };
    if (await hasUnsettledSavIntakeWork(message.threadId, db)) return null;
    const actions = await db.select().from(savActions).where(eq(savActions.threadId, message.threadId));
    if (hasUnsettledSavHumanAction(actions)) return null;
    const current = await readSavIntakeCurrent(message.threadId);
    if (!current || current.messageId !== message.id) return null;
    const progress = await readIntakeExecutionProgress(message.id);
    // A confirmed identification email has no ticket yet. Its delivery receipt
    // proves a request for information, not that the support ticket is ready.
    if (progress?.confirmed) return progress.ticketId && progress.runId === current.id && progress.completionSourceHash
      && progress.completionSourceHash === current.currentSourceHash ? { executionId: progress.executionId } : null;
    if (!current.sourceMatches) return null;
    const [projection] = await db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, message.threadId));
    if (projection?.messageId === message.id && projection.epoch === projection.projectedEpoch
      && projection.status === "qualified_other" && projection.view === "other") {
      if (current.id === projection.runId) return { classificationRunId: current.id };
    }
    // A current acknowledgement needs no action: its own run, no execution, fresh projection.
    const plan = current.payload.plan?.decision.disposition;
    if (!progress && projection?.messageId === message.id && projection.epoch === projection.projectedEpoch && projection.runId === current.id
      && projection.status === "acknowledgement_only" && projection.view === "completed"
      && plan?.kind === "no_ticket" && plan.reason === "acknowledgement_only") return { acknowledgementRunId: current.id };
    return null;
  };
  const proof = await evidence();
  if (!proof) return { skipped: "not_handled" };
  const [mailbox] = await db.select().from(savMailboxes).where(eq(savMailboxes.id, message.mailboxId));
  if (!mailbox?.active || mailbox.email !== "contact@limova.ai" || !message.gmailMessageId) return { skipped: "source_invalid" };
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, message.threadId));
  if (!thread) return { skipped: "thread_missing" };
  const guard = async () => { await authority(); if (!await evidence()) throw Error("SAV_INTAKE_GMAIL_READ_PROOF_CHANGED"); };
  const markRead = (gmailMessageId: string) => markHandledGmailMessageRead({ mailboxEmail: mailbox.email, gmailMessageId, gmailThreadId: thread.gmailThreadId }, deps.gmail ?? requestSavGmail, guard);
  let earlierMessages = 0, goneMessages = 0, failedMessages = 0, handledFailed = false, errorCode: string | null = null;
  // One message at a time: a message deleted from Gmail (404/410) has nothing left to mark and is
  // skipped with a "gone" receipt; a failure specific to one message never stops the next ones.
  // A thread-wide failure (authority, pause, proof changed, quota, network) stops the loop.
  const attempt = async (gmailMessageId: string, entityId: string, extra: Record<string, string>) => {
    try {
      const result = await markRead(gmailMessageId);
      await db.insert(auditLogs).values({ actorEmail: "studio-intake", action: SAV_INTAKE_GMAIL_READ, entityType: "sav_message", entityId,
        technicalMetadata: { version: 1, threadId: thread.id, ...proof, alreadyRead: result.alreadyRead, ...extra } });
      return "read" as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/^GMAIL_HTTP_(404|410)$/.test(message)) {
        await db.insert(auditLogs).values({ actorEmail: "studio-intake", action: SAV_INTAKE_GMAIL_READ, entityType: "sav_message", entityId,
          technicalMetadata: { version: 1, threadId: thread.id, ...proof, gone: true, providerStatus: Number(message.slice(-3)), ...extra } });
        goneMessages++; return "gone" as const;
      }
      failedMessages++; errorCode ??= /^SAV_[A-Z_]+$/.test(message) ? message : "SAV_INTAKE_GMAIL_READ_RETRY_REQUIRED";
      return /^SAV_INTAKE_GMAIL_READ_(SOURCE_MISMATCH|SOURCE_INVALID|UNCONFIRMED)$/.test(message) || message === "GMAIL_HTTP_400" ? "skip" as const : "stop" as const;
    }
  };
  // The handled message first: an earlier message that cannot be read never delays it.
  let outcome: "read" | "gone" | "skip" | "stop" = "read";
  if (!handledConfirmed) { outcome = await attempt(message.gmailMessageId, message.id, {}); handledFailed = outcome === "skip" || outcome === "stop"; }
  if (outcome !== "stop") for (const row of pendingEarlier) {
    // Same checks as the handled message: exact mailbox, Gmail thread, never SENT/DRAFT, proof re-read before each write.
    outcome = await attempt(row.gmailMessageId!, row.id, { coveredByMessageId: message.id });
    if (outcome === "read") earlierMessages++;
    if (outcome === "stop") break;
  }
  const counts = { ...earlierMessages ? { earlierMessages } : {}, ...goneMessages ? { goneMessages } : {} };
  if (!failedMessages) return { confirmed: true, ...counts };
  // One failure per attempt on the handled message, whatever the number of messages:
  // it is the row the recovery selects, backs off and caps.
  await db.insert(auditLogs).values({ actorEmail: "studio-intake", action: FAILED, entityType: "sav_message", entityId: message.id,
    technicalMetadata: handledFailed && failedMessages === 1 ? { errorCode } : { errorCode, ...handledFailed ? {} : { scope: "earlier" }, failedMessages } });
  return { confirmed: false, errorCode: errorCode!, ...counts };
}

/** Failures counted since the row's last read receipt. Below the cap, the next
 * attempt waits 5 min × 2^(failures-1); at the cap, once a day and after every
 * other candidate. A row that is never ready can no longer starve the others. */
export const SAV_INTAKE_GMAIL_READ_FAILURE_CAP = 8;
const EARLIER_MESSAGES_PER_CALL = 10;
/** Time window of the recovery and the counter: messages, receipts and failures of the last 90 days.
 * A receipt is always younger than its message, so the window never hides one that matters. */
const WINDOW = sql.raw("interval '90 days'");

/** Candidates of the recovery: the latest inbound message of a contact@ thread
 * whose console state may be finished (the exact proof stays evidence()), and
 * that lacks its own receipt or a receipt for an earlier inbound message. */
function scoredReadCandidates(administrativeIds: string[]) {
  const administrative = administrativeIds.length ? sql`m.id in (${sql.join(administrativeIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
  return sql`with receipt as (
      select a.entity_id, max(a.created_at) as at from public.audit_logs a
      where a.entity_type='sav_message' and a.actor_email='studio-intake' and a.action=${SAV_INTAKE_GMAIL_READ} and a.created_at>now()-${WINDOW} group by a.entity_id
    ), candidate as (
      select m.id, least(m.received_at,m.created_at) as received_at, r.at as confirmed_at
      from sav.messages m left join receipt r on r.entity_id=m.id::text
      where m.direction='inbound' and m.gmail_message_id is not null and least(m.received_at,m.created_at)>now()-${WINDOW}
        and exists(select 1 from sav.mailboxes b where b.id=m.mailbox_id and b.email='contact@limova.ai' and b.active)
        and m.id=(select l.id from sav.messages l where l.thread_id=m.thread_id and l.direction='inbound' order by least(l.received_at,l.created_at) desc,l.created_at desc,l.id desc limit 1)
        and (${administrative} or exists(select 1 from sav.intake_console c where c.message_id=m.id and c.epoch=c.projected_epoch and (c.status='qualified_other' and c.view='other' or c.status='acknowledgement_only' and c.view='completed' or c.status in ('followup_pending','followup_partial','followup_started','not_applicable_sensitive','summary_finished'))))
        and (r.at is null or exists(select 1 from sav.messages e where e.thread_id=m.thread_id and e.mailbox_id=m.mailbox_id and e.direction='inbound' and e.id<>m.id
          and e.gmail_message_id is not null and least(e.received_at,e.created_at)>now()-${WINDOW} and not exists(select 1 from receipt x where x.entity_id=e.id::text)))
    ), failure as (
      select a.entity_id, count(*)::int as n, max(a.created_at) as last_at from public.audit_logs a join candidate c on c.id::text=a.entity_id
      where a.entity_type='sav_message' and a.action=${FAILED} and a.created_at>now()-${WINDOW} and (c.confirmed_at is null or a.created_at>c.confirmed_at) group by a.entity_id
    ), scored as (
      select c.id, c.received_at, c.confirmed_at is not null as backfill, coalesce(f.n,0)::int as failures, f.last_at
      from candidate c left join failure f on f.entity_id=c.id::text
    )`;
}
type Executor = { execute: (query: SQL) => Promise<unknown> };
async function rowsOf<T>(db: Executor, query: SQL) {
  const result = await db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
async function readBacklog(db: Executor, administrativeIds: string[]) {
  const [row] = await rowsOf<{ pending: number | string; parked: number | string }>(db, sql`${scoredReadCandidates(administrativeIds)}
    select count(*)::int as pending, count(*) filter (where failures>=${SAV_INTAKE_GMAIL_READ_FAILURE_CAP})::int as parked from scored`);
  return { pending: Number(row?.pending ?? 0), parked: Number(row?.parked ?? 0) };
}

/** Console counter: counts only, no address, subject or identifier. */
export async function readIntakeGmailReadBacklog(): Promise<{ state: "off" } | { state: "unavailable" } | { state: "available"; pending: number; parked: number }> {
  if (process.env.SAV_INTAKE_GMAIL_MARK_READ !== "on") return { state: "off" };
  try {
    const db = requireDb();
    if (!await intakeConsoleInstalled(db)) return { state: "unavailable" };
    const administrativeIds = await listSavExternalCompletionMessageIds(db, true);
    return { state: "available", ...await db.transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout','3s',true)`);
      return readBacklog(tx, administrativeIds);
    }, { accessMode: "read only" }) };
  } catch { return { state: "unavailable" }; }
}

/** Recovery of read receipts only; the fast path is the targeted wake.
 * Fair order: never-tried rows first, then the oldest failure (rotation); rows
 * whose handled message is already read (earlier messages only) after new ones;
 * capped rows last, once a day. One counter log line per pass, counts only. */
export async function reconcileHandledIntakeGmailRead(limit = 3, deadlineMs = Date.now() + 30_000) {
  if (process.env.SAV_INTAKE_GMAIL_MARK_READ !== "on") return { skipped: "off" };
  if (!await intakeConsoleInstalled()) return { skipped: "schema_absent" };
  const db = requireDb();
  // Paused: no attempt and no failure marker, so a pause never pushes rows towards the cap.
  const paused = savAgentPauseCode(await readSavAgentPause(db));
  if (paused) return { skipped: paused };
  const administrativeIds = await listSavExternalCompletionMessageIds(db, true);
  const cap = SAV_INTAKE_GMAIL_READ_FAILURE_CAP;
  const startedAt = Date.now();
  // One statement, one aggregation of audit_logs (the CTE is materialized once): totals and the selected rows.
  const rows = await rowsOf<{ id: string | null; pending: number | string; parked: number | string }>(db, sql`${scoredReadCandidates(administrativeIds)},
    total as (select count(*)::int as pending, count(*) filter (where failures>=${cap})::int as parked from scored)
    select s.id, t.pending, t.parked from total t left join lateral (
      select id from scored
      where failures=0 or last_at < now() - case when failures>=${cap} then interval '24 hours'
        else least(interval '24 hours', interval '5 minutes' * power(2, least(failures-1, 12))) end
      order by failures>=${cap}, backfill, last_at asc nulls first, received_at asc, id asc
      limit ${Math.max(1, Math.min(20, limit))}) s on true`);
  const counter = { pending: Number(rows[0]?.pending ?? 0), parked: Number(rows[0]?.parked ?? 0), checked: 0, confirmed: 0, earlierMessages: 0, goneMessages: 0, notReady: 0, failed: 0,
    selectMs: Date.now() - startedAt, durationMs: 0 };
  const selected = rows.flatMap(row => row.id ? [{ id: row.id }] : []);
  for (const row of selected) {
    if (Date.now() + 1000 >= deadlineMs) break;
    const gmail: GmailRequest = (mailbox, path, init) => requestSavGmail(mailbox, path, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadlineMs - Date.now()))) });
    try {
      const result = await syncHandledIntakeGmailRead(row.id, { gmail });
      if ("skipped" in result && String(result.skipped).startsWith("SAV_INTAKE_AGENT")) break; // pause set during the pass: no marker
      counter.checked++;
      if ("skipped" in result && !["off", "already_confirmed"].includes(result.skipped!)) {
        counter.notReady++;
        await db.insert(auditLogs).values({ actorEmail: "studio-intake", action: FAILED, entityType: "sav_message", entityId: row.id,
          technicalMetadata: { errorCode: "SAV_INTAKE_GMAIL_READ_SOURCE_NOT_READY", reason: result.skipped! } });
      }
      if ("confirmed" in result) {
        if (result.confirmed) counter.confirmed++; else counter.failed++;
        counter.earlierMessages += result.earlierMessages ?? 0; counter.goneMessages += result.goneMessages ?? 0;
      }
    }
    catch {
      counter.checked++; counter.failed++;
      await db.insert(auditLogs).values({ actorEmail: "studio-intake", action: FAILED, entityType: "sav_message", entityId: row.id,
        technicalMetadata: { errorCode: "SAV_INTAKE_GMAIL_READ_SOURCE_UNAVAILABLE" } });
    }
  }
  counter.durationMs = Date.now() - startedAt;
  console.info("sav_intake_gmail_read_pass", counter);
  return counter;
}
