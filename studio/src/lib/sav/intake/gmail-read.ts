import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savActions, savMailboxes, savMessages, savThreads, savIntakeConsole } from "@/db/schema";
import { requestSavGmail } from "../gmail";
import { getSavExternalCompletion, hasUnsettledSavHumanAction, hasUnsettledSavIntakeWork, listSavExternalCompletionMessageIds } from "../external-completion";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "./execution-policy";
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
  };
  await authority();
  const db = requireDb();
  if (!await intakeConsoleInstalled(db)) return { skipped: "schema_absent" };
  const [message] = await db.select().from(savMessages).where(and(eq(savMessages.id, messageId), eq(savMessages.direction, "inbound")));
  if (!message) return { skipped: "message_missing" };
  const [receipt] = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.action, SAV_INTAKE_GMAIL_READ), eq(auditLogs.entityType, "sav_message"), eq(auditLogs.entityId, message.id), eq(auditLogs.actorEmail, "studio-intake"))).limit(1);
  if (receipt) return { skipped: "already_confirmed" };
  const evidence = async (): Promise<Record<string, string> | null> => {
    const handled = await getSavExternalCompletion(message);
    if (handled) return { administrativeId: handled.id };
    if (await hasUnsettledSavIntakeWork(message.threadId, db)) return null;
    const actions = await db.select().from(savActions).where(eq(savActions.threadId, message.threadId));
    if (hasUnsettledSavHumanAction(actions)) return null;
    const current = await readSavIntakeCurrent(message.threadId);
    if (!current || current.messageId !== message.id) return null;
    const progress = await readIntakeExecutionProgress(message.id);
    if (progress?.confirmed) return progress.runId === current.id && progress.completionSourceHash
      && progress.completionSourceHash === current.currentSourceHash ? { executionId: progress.executionId } : null;
    if (!current.sourceMatches) return null;
    const [projection] = await db.select().from(savIntakeConsole).where(eq(savIntakeConsole.threadId, message.threadId));
    if (projection?.messageId === message.id && projection.epoch === projection.projectedEpoch
      && ["qualified_other", "human_choice"].includes(projection.status) && ["other", "to_validate"].includes(projection.view ?? "")) {
      if (current.id === projection.runId) return { classificationRunId: current.id };
    }
    return null;
  };
  const proof = await evidence();
  if (!proof) return { skipped: "not_handled" };
  const [mailbox] = await db.select().from(savMailboxes).where(eq(savMailboxes.id, message.mailboxId));
  if (!mailbox?.active || mailbox.email !== "contact@limova.ai" || !message.gmailMessageId) return { skipped: "source_invalid" };
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, message.threadId));
  if (!thread) return { skipped: "thread_missing" };
  try {
    const result = await markHandledGmailMessageRead({ mailboxEmail: mailbox.email, gmailMessageId: message.gmailMessageId, gmailThreadId: thread.gmailThreadId }, deps.gmail ?? requestSavGmail, async () => {
      await authority(); if (!await evidence()) throw Error("SAV_INTAKE_GMAIL_READ_PROOF_CHANGED");
    });
    await db.insert(auditLogs).values({ actorEmail: "studio-intake", action: SAV_INTAKE_GMAIL_READ, entityType: "sav_message", entityId: message.id,
      technicalMetadata: { version: 1, threadId: thread.id, ...proof, alreadyRead: result.alreadyRead } });
    return { confirmed: true };
  } catch (error) {
    const errorCode = error instanceof Error && /^SAV_[A-Z_]+$/.test(error.message) ? error.message : "SAV_INTAKE_GMAIL_READ_RETRY_REQUIRED";
    await db.insert(auditLogs).values({ actorEmail: "studio-intake", action: FAILED, entityType: "sav_message", entityId: message.id, technicalMetadata: { errorCode } });
    return { confirmed: false, errorCode };
  }
}

/** Recovery of read receipts only; the fast path is the targeted wake. */
export async function reconcileHandledIntakeGmailRead(limit = 3, deadlineMs = Date.now() + 30_000) {
  if (process.env.SAV_INTAKE_GMAIL_MARK_READ !== "on") return { skipped: "off" };
  if (!await intakeConsoleInstalled()) return { skipped: "schema_absent" };
  const administrativeIds = await listSavExternalCompletionMessageIds(requireDb(), true);
  const administrative = administrativeIds.length ? sql`${savMessages.id} in (${sql.join(administrativeIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`;
  const rows = await requireDb().select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.direction, "inbound"),
    sql`${savMessages.gmailMessageId} is not null`,
    sql`exists(select 1 from sav.mailboxes b where b.id=${savMessages.mailboxId} and b.email='contact@limova.ai' and b.active)`,
    sql`${savMessages.id}=(select m.id from sav.messages m where m.thread_id=${savMessages.threadId} and m.direction='inbound' order by least(m.received_at,m.created_at) desc,m.created_at desc,m.id desc limit 1)`,
    sql`(${administrative} or exists(select 1 from sav.intake_console c where c.message_id=${savMessages.id} and c.epoch=c.projected_epoch and (c.status in ('qualified_other','human_choice') and c.view in ('other','to_validate') or c.status in ('identity_sent','followup_pending','followup_started','not_applicable_sensitive','summary_finished'))))`,
    sql`not exists(select 1 from public.audit_logs a where a.entity_type='sav_message' and a.entity_id=${savMessages.id}::text and a.actor_email='studio-intake' and a.action=${SAV_INTAKE_GMAIL_READ})`,
    sql`not exists(select 1 from public.audit_logs a where a.entity_type='sav_message' and a.entity_id=${savMessages.id}::text and a.action=${FAILED} and a.created_at>now()-interval '5 minutes')`
  )).orderBy(asc(savEffectiveReceivedAt), asc(savMessages.id)).limit(Math.max(1, Math.min(20, limit)));
  const results = [];
  for (const row of rows) {
    if (Date.now() + 1000 >= deadlineMs) break;
    const gmail: GmailRequest = (mailbox, path, init) => requestSavGmail(mailbox, path, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadlineMs - Date.now()))) });
    try {
      const result = await syncHandledIntakeGmailRead(row.id, { gmail });
      if ("skipped" in result && !["off", "already_confirmed"].includes(result.skipped!)) {
        await requireDb().insert(auditLogs).values({ actorEmail: "studio-intake", action: FAILED, entityType: "sav_message", entityId: row.id,
          technicalMetadata: { errorCode: "SAV_INTAKE_GMAIL_READ_SOURCE_NOT_READY", reason: result.skipped! } });
      }
      results.push(result);
    }
    catch {
      await requireDb().insert(auditLogs).values({ actorEmail: "studio-intake", action: FAILED, entityType: "sav_message", entityId: row.id,
        technicalMetadata: { errorCode: "SAV_INTAKE_GMAIL_READ_SOURCE_UNAVAILABLE" } });
      results.push({ confirmed: false });
    }
  }
  return { checked: results.length, confirmed: results.filter(x => "confirmed" in x && x.confirmed).length };
}
