// SAV-95 (18/11, OFF by default): the durable side of the acknowledgement closure. Receipts are `audit_logs` rows (no migration), facts are read from V1's
// own records only (its accepted plan and analysis of the mail, the stored thread, its sensitive dossier rule), the authority is V1's execution policy
// with its own right `close_acknowledged_ticket`. Two entry points: the targeted wake after V1's projection, and a bounded recovery sweep.
import "server-only";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { randomUUID } from "node:crypto";
import { auditLogs, savCases, savIntakeRuns, savMessages, savSyncState, savThreads } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { savEffectiveReceivedAt, savEffectiveReceivedAtOfRow } from "../message-order";
import { closeAcknowledgedTicket, createAckClosureHubspot, ACK_CLOSURE_FINAL_STEPS, type AckClosureDeps, type AckClosureStep, type AckClosureStore } from "./ack-closure";
import { savAckClosureAnalysisSchema, savAckClosureEnabled, SAV_ACK_CLOSURE_PERMISSION, type AckClosureFacts } from "./ack-closure-rules";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "./execution-policy";
import { assertSavAgentActionsAllowed } from "./agent-pause";
import type { IntakeRuntimePayload } from "./runtime-contract";

const ACTOR = "studio-intake";
const ENTITY = "sav_message";
const actionOf = (step: AckClosureStep) => `sav_ack_close_${step}`;
const STEPS: readonly AckClosureStep[] = ["claimed", "stage_dispatched", "stage_confirmed", "note_dispatched", "confirmed", "already_closed", "not_applied", "uncertain"];

/** Receipts as audit rows, one per (message, step): a transaction-scoped advisory lock serializes concurrent writers of the same step. */
export const ackClosureAuditStore: AckClosureStore = {
  async steps(messageId) {
    const rows = await requireDb().select({ action: auditLogs.action }).from(auditLogs)
      .where(and(eq(auditLogs.entityType, ENTITY), eq(auditLogs.entityId, messageId), eq(auditLogs.actorEmail, ACTOR), sql`${auditLogs.action} like 'sav_ack_close_%'`));
    return STEPS.filter(step => rows.some(row => row.action === actionOf(step)));
  },
  async record(messageId, step, metadata) {
    return requireDb().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sav-ack-close:${messageId}:${step}`}))`);
      const [existing] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityType, ENTITY), eq(auditLogs.entityId, messageId),
        eq(auditLogs.actorEmail, ACTOR), eq(auditLogs.action, actionOf(step)))).limit(1);
      if (existing) return false;
      await tx.insert(auditLogs).values({ actorEmail: ACTOR, action: actionOf(step), entityType: ENTITY, entityId: messageId, technicalMetadata: metadata });
      return true;
    });
  },
  // A lease row in sav.sync_state (no migration): taken when free, released, or older than LEASE_SECONDS (a crashed pass). The longest pass is
  // bounded by its HubSpot timeouts (six calls of at most 10 s), well inside the lease.
  async lease(messageId) {
    const key = `sav-ack-close:${messageId}`, token = randomUUID();
    const taken = await requireDb().execute(sql`insert into sav.sync_state (key, cursor, status, started_at, updated_at) values (${key}, ${token}, 'leased', now(), now())
      on conflict (key) do update set cursor = excluded.cursor, status = 'leased', started_at = now(), updated_at = now()
      where sav.sync_state.status <> 'leased' or sav.sync_state.started_at < now() - make_interval(secs => ${LEASE_SECONDS})
      returning cursor`);
    const rows = (Array.isArray(taken) ? taken : (taken as { rows?: unknown[] }).rows ?? []) as Array<{ cursor?: unknown }>;
    if (rows[0]?.cursor !== token) return null;
    return async () => { await requireDb().update(savSyncState).set({ status: "idle", updatedAt: new Date() }).where(and(eq(savSyncState.key, key), eq(savSyncState.cursor, token))); };
  },
};
const LEASE_SECONDS = 120;

/** V1's execution authority, with the closure right, and the agent not paused. */
export async function ackClosureAuthority(env: Record<string, string | undefined>) {
  const config = intakeExecutionConfig(env);
  if (!config) throw Error("SAV_ACK_CLOSE_EXECUTION_OFF");
  const { policy } = await readIntakeExecutionAuthority(config);
  if (!policy.mutations.includes(SAV_ACK_CLOSURE_PERMISSION)) throw Error("SAV_ACK_CLOSE_PERMISSION_MISSING");
  await assertSavAgentActionsAllowed(requireDb());
}

/** The facts of the rule, from V1's own records. Null only when the mail itself is not found. */
export async function readAckClosureFacts(messageId: string): Promise<AckClosureFacts | null> {
  const db = requireDb();
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, messageId));
  if (!message || message.direction !== "inbound") return null;
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, message.threadId));
  const ticketId = thread?.hubspotTicketId ?? null;
  const { readIntakeAcknowledgement } = await import("../cases/intake-boundary");
  const ack = await readIntakeAcknowledgement(messageId);
  let v1Acknowledgement = false, model: AckClosureFacts["model"] = null;
  if (ack) {
    const [run] = await db.select().from(savIntakeRuns).where(eq(savIntakeRuns.id, ack.runId));
    const payload = run ? decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext) : null;
    const decision = payload?.plan?.decision, disposition = decision?.disposition;
    v1Acknowledgement = Boolean(decision && disposition?.kind === "no_ticket" && disposition.reason === "acknowledgement_only" && !disposition.qualifiedInformation
      && decision.classification === "acknowledgement" && decision.requests.length > 0 && decision.requests.every(r => r.kind === "acknowledgement")
      && decision.latestInboundMessageId === messageId && decision.messageId === messageId);
    // The model's decision: from an accepted analysis of THIS run, its hashes intact.
    const semantics = payload?.semantics;
    if (semantics) {
      const [{ intakeSemanticInputHash }, { savIntakeEvidenceContentHash }] = await Promise.all([import("./semantic-records"), import("./engine")]);
      for (const row of [...semantics.records].reverse()) {
        if (row.method !== "analyseMessage" || row.inputHash !== intakeSemanticInputHash(row.input) || row.resultHash !== savIntakeEvidenceContentHash(row.result)) continue;
        const result = row.result as { messageId?: unknown; ackClosure?: unknown } | null;
        const parsed = result?.messageId === messageId ? savAckClosureAnalysisSchema.safeParse(result.ackClosure) : null;
        if (parsed?.success) { model = parsed.data; break; }
      }
    }
  }
  const thread_ = await db.select({ id: savMessages.id, direction: savMessages.direction }).from(savMessages).where(eq(savMessages.threadId, message.threadId))
    .orderBy(asc(savEffectiveReceivedAt), asc(savMessages.createdAt), asc(savMessages.id));
  const index = thread_.findIndex(row => row.id === messageId);
  const previous = index > 0 ? thread_[index - 1]! : null;
  const { intakeDossierSensitive } = await import("./observation-binding");
  // Review Astra (8c2891d, finding 1): a V2 case on the TICKET (any owner, any phase, whatever thread it holds) excludes the close, not only one on this thread.
  const [v2] = await db.select({ id: savCases.id }).from(savCases)
    .where(ticketId ? sql`${savCases.ticketId} = ${ticketId} or ${message.threadId}::uuid = any(${savCases.threadIds})` : sql`${message.threadId}::uuid = any(${savCases.threadIds})`).limit(1);
  // Review Astra (finding 2): a newer customer mail on ANOTHER thread of the same ticket also stops the close.
  const [siblingInbound] = ticketId ? await db.select({ id: savMessages.id }).from(savMessages).innerJoin(savThreads, eq(savThreads.id, savMessages.threadId))
    .where(and(eq(savThreads.hubspotTicketId, ticketId), sql`${savMessages.threadId} <> ${message.threadId}`, eq(savMessages.direction, "inbound"),
      sql`least(${savMessages.receivedAt}, ${savMessages.createdAt}) >= ${savEffectiveReceivedAtOfRow(message)}`)).limit(1) : [];
  return {
    v1Acknowledgement, customerMessageId: messageId, ticketId, model,
    previous: previous ? { messageId: previous.id, direction: previous.direction } : null,
    newerMessage: index < 0 || index < thread_.length - 1 || Boolean(siblingInbound),
    sensitiveDossier: await intakeDossierSensitive(message.threadId, ticketId, db),
    v2Case: Boolean(v2),
  };
}

export function ackClosureDeps(env: () => Record<string, string | undefined> = () => process.env, network: typeof fetch = fetch): AckClosureDeps {
  return { env, authority: () => ackClosureAuthority(env()), readFacts: readAckClosureFacts, store: ackClosureAuditStore, hubspot: createAckClosureHubspot({ network, env }) };
}

/** Targeted entry after V1's projection of a mail. Never throws; nothing at all unless `SAV_ACK_CLOSE=on`. */
export async function syncAckClosure(messageId: string, deps?: AckClosureDeps) {
  const resolved = deps ?? ackClosureDeps();
  if (!savAckClosureEnabled(resolved.env())) return { skipped: "off" as const };
  try { return await closeAcknowledgedTicket(messageId, resolved); }
  catch (error) {
    console.error("sav_ack_close", { messageId, errorCode: error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_ACK_CLOSE_FAILED" });
    return { skipped: "error" as const };
  }
}

/**
 * Recovery, bounded. FIRST every message whose stage write was dispatched and that has no final receipt, whatever happened since (a newer mail, an
 * older date, a changed projection): it is always resumed to a note posted once or an explicit `uncertain` (review Astra, c4316e8, finding 1). THEN
 * new acknowledgements of the last 72 hours, still the latest message of their thread, with a ticket and no receipt that ends them; the « newer mail »
 * exclusion applies only before a dispatch.
 */
export async function reconcileAckClosures(limit = 3, deadlineMs = Date.now() + 20_000, deps?: AckClosureDeps) {
  if (!savAckClosureEnabled(deps?.env() ?? process.env)) return { skipped: "off" };
  const db = requireDb(), bound = Math.max(1, Math.min(10, limit));
  const finals = sql.join(ACK_CLOSURE_FINAL_STEPS.map(step => sql`${actionOf(step)}`), sql`, `);
  const noFinal = sql`not exists(select 1 from public.audit_logs a where a.entity_type=${ENTITY} and a.entity_id=${savMessages.id}::text and a.actor_email=${ACTOR} and a.action in (${finals}))`;
  const resumes = await db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.direction, "inbound"),
    sql`exists(select 1 from public.audit_logs a where a.entity_type=${ENTITY} and a.entity_id=${savMessages.id}::text and a.actor_email=${ACTOR} and a.action=${actionOf("stage_dispatched")})`,
    noFinal)).orderBy(asc(savEffectiveReceivedAt), asc(savMessages.id)).limit(bound);
  const fresh = resumes.length >= bound ? [] : await db.select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.direction, "inbound"),
    gt(savMessages.receivedAt, new Date(Date.now() - 72 * 3_600_000)),
    sql`exists(select 1 from sav.threads t where t.id=${savMessages.threadId} and t.hubspot_ticket_id is not null)`,
    sql`exists(select 1 from sav.intake_console c where c.message_id=${savMessages.id} and c.epoch=c.projected_epoch and c.status='acknowledgement_only' and c.view='completed')`,
    sql`not exists(select 1 from sav.messages m where m.thread_id=${savMessages.threadId} and m.id<>${savMessages.id} and least(m.received_at,m.created_at)>=least(${savMessages.receivedAt},${savMessages.createdAt}))`,
    noFinal)).orderBy(desc(savEffectiveReceivedAt), desc(savMessages.id)).limit(bound - resumes.length);
  const rows = [...resumes, ...fresh.filter(row => !resumes.some(r => r.id === row.id))];
  const results: Array<{ messageId: string; result: unknown }> = [];
  for (const row of rows) {
    if (Date.now() + 2000 >= deadlineMs) break;
    results.push({ messageId: row.id, result: await syncAckClosure(row.id, deps) });
  }
  return { candidates: rows.length, resumes: resumes.length, results };
}
