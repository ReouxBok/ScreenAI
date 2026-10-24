import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savActions, savDecisions, savMessages, savPilotItems, savThreads, savIntakeHumanEvents, savIntakeExecutions, savIntakeEffects, savIntakeRuns, staffUsers } from "@/db/schema";
import { intakeConsoleInstalled } from "./intake/console-capability";
import { savV0EligibleMessageFilter } from "./cutover";
import { executionAdministrator } from "./intake/execution-policy";
import { canAccessSav } from "./access";

export const SAV_EXTERNAL_COMPLETION = "sav_dossier_completed_externally";
export const SAV_EXTERNAL_COMPLETION_REVERTED = "sav_dossier_external_completion_reverted";
export const savExternalCompletionEvents = [SAV_EXTERNAL_COMPLETION, SAV_EXTERNAL_COMPLETION_REVERTED];
type Reader = Pick<ReturnType<typeof requireDb>, "select">;
type Message = { id: string; threadId: string; receivedAt: Date };
type Audit = Pick<typeof auditLogs.$inferSelect, "id" | "actorEmail" | "action" | "entityType" | "entityId" | "technicalMetadata" | "createdAt">;
type Action = Pick<typeof savActions.$inferSelect, "kind" | "actorType" | "status" | "payload">;
const reversalSchema = z.object({ version: z.literal(1), batchId: z.uuid(), completionId: z.uuid() });
export const externalDispositionSchema = z.enum(["completed", "other", "to_validate"]);
const markerSchema = z.object({ version: z.literal(1), threadId: z.uuid(), batchId: z.uuid(), receivedBefore: z.iso.datetime({ offset: true }), reason: z.literal("processed_outside_studio"), disposition: externalDispositionSchema.optional() });
export function savExternalDisposition(event: Pick<Audit, "technicalMetadata">) {
  const marker = markerSchema.parse(event.technicalMetadata);
  const view = marker.disposition ?? "completed";
  return view === "other" ? { view, status: "human_other", reason: "Autres — classement humain de ce message. Aucun verdict IA ni action client déclarés." }
    : view === "to_validate" ? { view, status: "human_review", reason: "Décision confiée à l’équipe pour ce message. Aucun traitement automatique ne sera exécuté sur cet entrant." }
    : { view, status: "handled_externally", reason: "Traité hors Studio — clôture administrative de ce message. Aucun verdict IA, fermeture HubSpot ou apprentissage terminé ne sont déclarés." };
}

/** The same exact-proof predicate governs reads and rollback idempotence. */
function completionReverted(original: Audit, events: Audit[]) {
  const marker = markerSchema.safeParse(original.technicalMetadata);
  if (!marker.success) return false;
  return events.some(reversal => {
    if (reversal.action !== SAV_EXTERNAL_COMPLETION_REVERTED || reversal.actorEmail.toLowerCase() !== "ugo@limova.ai" || reversal.entityType !== "sav_message" || reversal.entityId !== original.entityId) return false;
    const value = reversalSchema.safeParse(reversal.technicalMetadata);
    return value.success && value.data.completionId === original.id && value.data.batchId === marker.data.batchId && reversal.createdAt >= original.createdAt;
  });
}

/** A Studio disposition, never a model verdict, provider result or learning proof. */
export function findSavExternalCompletion(message: { id: string; threadId: string; receivedAt: Date }, events: Audit[]) {
  return events.filter(event => {
    if (event.action !== SAV_EXTERNAL_COMPLETION || event.actorEmail.toLowerCase() !== "ugo@limova.ai" || event.entityType !== "sav_message" || event.entityId !== message.id) return false;
    const marker = markerSchema.safeParse(event.technicalMetadata);
    if (!marker.success || marker.data.threadId !== message.threadId || message.receivedAt.getTime() >= Date.parse(marker.data.receivedBefore)) return false;
    return !completionReverted(event, events);
  }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))[0] ?? null;
}

/** Do not hide a real queued request or an uncertain provider result. */
export function hasUnsettledSavHumanAction(actions: Action[]) {
  return actions.some(action => action.actorType === "human" && (
    ["pending", "running"].includes(action.status)
    || Boolean(action.payload.ticketCreateDispatchedAt && !action.payload.hubspotTicketId)
    || Boolean(action.payload.ticketReturnDispatchedAt && !action.payload.ticketReturnCompletedAt)
    || Boolean(action.payload.replySendDispatchedAt && action.status !== "succeeded")
    || Boolean(action.payload.forwardDispatchedAt && action.status !== "succeeded")
    || Boolean(action.payload.intakeOccupationDispatchedAt && action.status !== "succeeded")
  ));
}

/** Exact audit proof for the latest inbound. A proof fences further work even
 * when an unresolved command/effect prevents displaying administrative completion. */
export async function readSavExternalCompletion(message: Message, db: Reader = requireDb()) {
  const events = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "sav_message"), eq(auditLogs.entityId, message.id), inArray(auditLogs.action, savExternalCompletionEvents)));
  const marker = findSavExternalCompletion(message, events);
  if (!marker) return null;
  const [latest] = await db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.threadId, message.threadId), eq(savMessages.direction, "inbound"))).orderBy(desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id)).limit(1);
  return latest?.id === message.id ? marker : null;
}

// A confirmed partial result is not a completed execution. While its intake
// scope is held, an administrative marker must not hide the remaining work.
// Both the operation guard and the paginated display use this same predicate.
const unsettledIntakeEffect = sql`(
  (${savIntakeEffects.state} <> 'confirmed' and (${savIntakeEffects.state} <> 'planned' or ${savIntakeEffects.dispatchedAt} is not null or ${savIntakeEffects.dispatchToken} is not null or ${savIntakeEffects.ackCiphertext} is not null or ${savIntakeEffects.verificationCiphertext} is not null or ${savIntakeEffects.confirmedAt} is not null))
  or (${savIntakeEffects.state}='confirmed' and ${savIntakeExecutions.state} not in ('confirmed','refused')
    and exists(select 1 from sav.intake_occupations o where o.owner_kind='intake' and o.owner_id=${savIntakeExecutions.id}))
)`;

/** Include intake commands and dispatched effects: the administrative marker
 * cannot certify an outcome for work whose result still needs reconciliation. */
export async function hasUnsettledSavIntakeWork(threadId: string, db: Reader = requireDb()) {
  if (!await intakeConsoleInstalled(db)) return false;
  const [command] = await db.select({ id: savIntakeHumanEvents.id }).from(savIntakeHumanEvents).where(and(eq(savIntakeHumanEvents.threadId, threadId), inArray(savIntakeHumanEvents.state, ["pending", "reading", "waiting"])) ).limit(1);
  const [effect] = await db.select({ id: savIntakeEffects.id }).from(savIntakeEffects)
    .innerJoin(savIntakeExecutions, eq(savIntakeExecutions.id, savIntakeEffects.executionId))
    .where(and(eq(savIntakeExecutions.threadId, threadId), unsettledIntakeEffect)).limit(1);
  return Boolean(command || effect);
}

async function completionForDisplay(message: Message, db: Reader) {
  const marker = await readSavExternalCompletion(message, db);
  if (!marker) return null;
  const actions = await db.select().from(savActions).where(eq(savActions.threadId, message.threadId));
  return hasUnsettledSavHumanAction(actions) || await hasUnsettledSavIntakeWork(message.threadId, db) ? null : marker;
}
export async function getSavExternalCompletion(message: Message, db?: Reader) {
  if (db) return completionForDisplay(message, db);
  return requireDb().transaction(tx => completionForDisplay(message, tx), { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Validate only marker candidates with the canonical parser, before callers
 * apply pagination/LIMIT. No timestamp cast of arbitrary audit JSON, and no
 * arbitrary row cap that could hide a valid administrative disposition. */
export async function listSavExternalCompletionMessageIds(db: Reader = requireDb(), forDisplay = false, mailboxId?: string, disposition?: z.infer<typeof externalDispositionSchema>) {
  const candidates = await db.select({ id: savMessages.id, threadId: savMessages.threadId, receivedAt: savMessages.receivedAt }).from(savMessages)
    .where(and(mailboxId ? eq(savMessages.mailboxId, mailboxId) : undefined, eq(savMessages.direction, "inbound"),
      sql`exists(select 1 from public.audit_logs a where a.entity_type='sav_message' and a.entity_id=${savMessages.id}::text and a.action=${SAV_EXTERNAL_COMPLETION} and lower(a.actor_email)='ugo@limova.ai')`,
      sql`${savMessages.id}=(select latest.id from sav.messages latest where latest.thread_id=${savMessages.threadId} and latest.direction='inbound' order by latest.received_at desc,latest.created_at desc,latest.id desc limit 1)`));
  if (!candidates.length) return [];
  const events = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "sav_message"), inArray(auditLogs.entityId, candidates.map(message => message.id)), inArray(auditLogs.action, savExternalCompletionEvents)));
  const marked = candidates.filter(message => {
    const event = findSavExternalCompletion(message, events);
    return event && (!disposition || savExternalDisposition(event).view === disposition);
  });
  if (!forDisplay || !marked.length) return marked.map(message => message.id);
  const threadIds = marked.map(message => message.threadId);
  const actions = await db.select().from(savActions).where(inArray(savActions.threadId, threadIds));
  const blocked = new Set(threadIds.filter(id => hasUnsettledSavHumanAction(actions.filter(action => action.threadId === id))));
  if (await intakeConsoleInstalled(db)) {
    const commands = await db.select({ threadId: savIntakeHumanEvents.threadId }).from(savIntakeHumanEvents).where(and(inArray(savIntakeHumanEvents.threadId, threadIds), inArray(savIntakeHumanEvents.state, ["pending", "reading", "waiting"])));
    const effects = await db.select({ threadId: savIntakeExecutions.threadId }).from(savIntakeEffects).innerJoin(savIntakeExecutions, eq(savIntakeExecutions.id, savIntakeEffects.executionId))
      .where(and(inArray(savIntakeExecutions.threadId, threadIds), unsettledIntakeEffect));
    for (const row of [...commands, ...effects]) blocked.add(row.threadId);
  }
  return marked.filter(message => !blocked.has(message.threadId)).map(message => message.id);
}

/** Audit changes are not covered by the console row triggers. Dirty its cache
 * in the same transaction; recomputation still owns the state and CAS. */
async function invalidateCompletionProjection(db: Pick<ReturnType<typeof requireDb>, "select" | "execute">, messageIds: string[]) {
  const ids = [...new Set(messageIds)].filter(id => z.uuid().safeParse(id).success);
  if (!ids.length || !await intakeConsoleInstalled(db)) return;
  await db.execute(sql`select sav.dirty_intake_console(m.thread_id) from sav.messages m
    where m.id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`);
}

const batchSchema = z.object({ batchId: z.uuid(), receivedBefore: z.iso.datetime({ offset: true }), disposition: externalDispositionSchema.default("completed"), messages: z.array(z.object({ threadId: z.uuid(), messageId: z.uuid() })).min(1).max(1_000) });
function assertOperator(actorEmail: string) {
  if (actorEmail.toLowerCase() !== "ugo@limova.ai") throw new Error("SAV_EXTERNAL_COMPLETION_FORBIDDEN");
  if (process.env.SAV_RELEASE_STAGE !== "v0" || process.env.SAV_PILOT_MODE === "true") throw new Error("SAV_EXTERNAL_COMPLETION_V0_ONLY");
}

type CompletionActor = Pick<typeof staffUsers.$inferSelect, "id" | "email" | "clerkId">;
const manualSchema = z.object({ requestKey: z.uuid(), threadId: z.uuid(), messageId: z.uuid(), confirmed: z.literal(true) }).strict();

/** Authenticated single-message UI entry point. The boundary is server-owned;
 * a submitted stale dossier can never close a newly received inbound. */
export async function completeSavDossierManually(raw: unknown) {
  const actor = await executionAdministrator();
  assertOperator(actor.email);
  const input = manualSchema.parse(raw);
  return applyExternalCompletion({ batchId: input.requestKey, receivedBefore: new Date().toISOString(),
    messages: [{ threadId: input.threadId, messageId: input.messageId }] }, actor.email, actor);
}

/** Explicit operations entry point. No cron or model calls it.
 * The caller supplies a frozen preview; we recheck under thread row locks.
 * Only append-only audit rows are written. Snapshots/verdicts/actions are untouched. */
export async function markSavDossiersHandledExternally(raw: unknown, actorEmail: string) {
  return applyExternalCompletion(raw, actorEmail);
}
async function applyExternalCompletion(raw: unknown, actorEmail: string, actor?: CompletionActor) {
  assertOperator(actorEmail);
  const input = batchSchema.parse(raw);
  if (Date.parse(input.receivedBefore) > Date.now()) throw new Error("SAV_EXTERNAL_COMPLETION_FUTURE_BOUNDARY");
  const ids = input.messages.map(message => message.messageId);
  const threadIds = input.messages.map(message => message.threadId);
  if (new Set(ids).size !== ids.length || new Set(threadIds).size !== threadIds.length) throw new Error("SAV_EXTERNAL_COMPLETION_DUPLICATE_INPUT");
  return requireDb().transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '30s'`);
    // Same lock and order as intake admission/dispatch, before thread locks.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sav-intake-common-admission-v1'))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.batchId}))`);
    if (actor) {
      const [staff] = await tx.select().from(staffUsers).where(eq(staffUsers.id, actor.id)).for("update");
      if (!staff?.active || !["admin", "owner"].includes(staff.role) || !canAccessSav(staff.email, staff.role)
        || staff.email !== actor.email || staff.clerkId !== actor.clerkId) throw Error("SAV_EXTERNAL_COMPLETION_FORBIDDEN");
    }
    const threads = await tx.select({ id: savThreads.id, hubspotTicketId: savThreads.hubspotTicketId }).from(savThreads).where(inArray(savThreads.id, threadIds)).orderBy(asc(savThreads.id)).for("update");
    if (threads.length !== threadIds.length) throw new Error("SAV_EXTERNAL_COMPLETION_THREAD_MISSING");
    const latest = await tx.selectDistinctOn([savMessages.threadId]).from(savMessages).where(and(inArray(savMessages.threadId, threadIds), eq(savMessages.direction, "inbound")))
      .orderBy(asc(savMessages.threadId), desc(savMessages.receivedAt), desc(savMessages.createdAt), desc(savMessages.id));
    const eligible = new Set((await tx.select({ id: savMessages.id }).from(savMessages).where(and(inArray(savMessages.id, ids), savV0EligibleMessageFilter()))).map(message => message.id));
    const pilots = new Set((await tx.select({ messageId: savPilotItems.messageId }).from(savPilotItems).where(inArray(savPilotItems.messageId, ids))).map(item => item.messageId));
    const actions = await tx.select().from(savActions).where(inArray(savActions.threadId, threadIds));
    const technicalKinds = new Set(["spam", "automatic_reply", "bounce", "internal_notification", "duplicate"]);
    const decisions = await tx.select({ messageId: savDecisions.messageId, kind: savDecisions.kind }).from(savDecisions).where(and(inArray(savDecisions.messageId, ids), eq(savDecisions.isCurrent, true)));
    const technicalMessages = new Set(decisions.filter(row => technicalKinds.has(row.kind)).map(row => row.messageId));
    const events = await tx.select().from(auditLogs).where(and(eq(auditLogs.entityType, "sav_message"), inArray(auditLogs.entityId, ids), inArray(auditLogs.action, savExternalCompletionEvents)));
    const rows: Array<typeof auditLogs.$inferInsert> = [];
    const skipped: Record<string, number> = {};
    let alreadyCompleted = 0;
    for (const requested of input.messages) {
      const message = latest.find(row => row.threadId === requested.threadId);
      let reason: string | null = null;
      if (!message || message.id !== requested.messageId) reason = "new_inbound";
      else if (message.receivedAt.getTime() >= Date.parse(input.receivedBefore)) reason = "after_boundary";
      else if (!eligible.has(message.id) || pilots.has(message.id)) reason = "not_live_eligible";
      else if (technicalMessages.has(message.id) && input.disposition === "completed") reason = "technical_exclusion";
      else if (hasUnsettledSavHumanAction(actions.filter(action => action.threadId === message.threadId)) || await hasUnsettledSavIntakeWork(message.threadId, tx)) reason = "unsettled_action";
      if (!reason && await intakeConsoleInstalled(tx)) {
        const runs = await tx.select({ leaseUntil: savIntakeRuns.leaseUntil }).from(savIntakeRuns).where(eq(savIntakeRuns.threadId, requested.threadId));
        const executions = await tx.select({ leaseUntil: savIntakeExecutions.leaseUntil }).from(savIntakeExecutions).where(eq(savIntakeExecutions.threadId, requested.threadId));
        if ([...runs, ...executions].some(row => row.leaseUntil && row.leaseUntil > new Date())) reason = "active_worker";
      }
      if (reason) { skipped[reason] = (skipped[reason] ?? 0) + 1; continue; }
      const previous = findSavExternalCompletion(message!, events);
      if (previous && savExternalDisposition(previous).view === input.disposition) { alreadyCompleted++; continue; }
      // A reverted batch is never silently re-applied on retry.
      if (events.some(event => event.entityId === requested.messageId && event.technicalMetadata.batchId === input.batchId)) { skipped.previously_applied_batch = (skipped.previously_applied_batch ?? 0) + 1; continue; }
      rows.push({ actorEmail: actorEmail.toLowerCase(), action: SAV_EXTERNAL_COMPLETION, entityType: "sav_message", entityId: message!.id,
        technicalMetadata: { version: 1, threadId: message!.threadId, batchId: input.batchId, receivedBefore: input.receivedBefore, reason: "processed_outside_studio", disposition: input.disposition } });
    }
    if (rows.length) {
      await tx.insert(auditLogs).values(rows);
      await invalidateCompletionProjection(tx, rows.map(row => row.entityId!));
    }
    return { batchId: input.batchId, requested: input.messages.length, marked: rows.length, alreadyCompleted, skipped };
  });
}

/** Administrative rollback, not deletion or restoration of customer records. */
export async function revertSavExternalCompletionBatch(batchId: string, actorEmail: string) {
  assertOperator(actorEmail); z.uuid().parse(batchId);
  return requireDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${batchId}))`);
    const originals = await tx.select().from(auditLogs).where(and(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION), sql`lower(${auditLogs.actorEmail}) = 'ugo@limova.ai'`, eq(auditLogs.entityType, "sav_message"), sql`${auditLogs.technicalMetadata}->>'batchId' = ${batchId}`));
    if (!originals.length) return { reverted: 0 };
    const reversals = await tx.select().from(auditLogs).where(and(eq(auditLogs.action, SAV_EXTERNAL_COMPLETION_REVERTED), sql`lower(${auditLogs.actorEmail}) = 'ugo@limova.ai'`, eq(auditLogs.entityType, "sav_message"), sql`${auditLogs.technicalMetadata}->>'batchId' = ${batchId}`));
    const rows = originals.filter(event => markerSchema.safeParse(event.technicalMetadata).success && !completionReverted(event, reversals)).map(event => ({ actorEmail: actorEmail.toLowerCase(), action: SAV_EXTERNAL_COMPLETION_REVERTED, entityType: "sav_message", entityId: event.entityId, technicalMetadata: { version: 1, batchId, completionId: event.id } }));
    if (rows.length) {
      await tx.insert(auditLogs).values(rows);
      await invalidateCompletionProjection(tx, rows.map(row => row.entityId!));
    }
    return { reverted: rows.length };
  });
}
