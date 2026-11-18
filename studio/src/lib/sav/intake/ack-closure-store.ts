// SAV-95 (18/11, OFF by default): the durable side of the acknowledgement closure. Receipts are `audit_logs` rows (no migration), facts are read from V1's
// own records only (its accepted plan and analysis of the mail, the stored thread, its sensitive dossier rule), the authority is V1's execution policy
// with its own right `close_acknowledged_ticket`. Two entry points: the targeted wake after V1's projection, and a bounded recovery sweep.
import "server-only";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savCases, savIntakeRuns, savMessages, savThreads } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { savEffectiveReceivedAt } from "../message-order";
import { closeAcknowledgedTicket, createAckClosureHubspot, ACK_CLOSURE_FINAL_STEPS, type AckClosureDeps, type AckClosureStep, type AckClosureStore } from "./ack-closure";
import { savAckClosureAnalysisSchema, savAckClosureEnabled, SAV_ACK_CLOSURE_PERMISSION, type AckClosureFacts } from "./ack-closure-rules";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "./execution-policy";
import { assertSavAgentActionsAllowed } from "./agent-pause";
import type { IntakeRuntimePayload } from "./runtime-contract";

const ACTOR = "studio-intake";
const ENTITY = "sav_message";
const actionOf = (step: AckClosureStep) => `sav_ack_close_${step}`;
const STEPS: readonly AckClosureStep[] = ["claimed", "stage_confirmed", "note_dispatched", "confirmed", "already_closed", "not_applied", "uncertain"];

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
};

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
  const [v2] = await db.select({ id: savCases.id }).from(savCases).where(sql`${message.threadId}::uuid = any(${savCases.threadIds})`).limit(1);
  return {
    v1Acknowledgement, customerMessageId: messageId, ticketId, model,
    previous: previous ? { messageId: previous.id, direction: previous.direction } : null,
    newerMessage: index < 0 || index < thread_.length - 1,
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

/** Recovery: acknowledgements of the last 72 hours, newest first, still the latest message of their thread, with a ticket and no final receipt. Bounded. */
export async function reconcileAckClosures(limit = 3, deadlineMs = Date.now() + 20_000) {
  if (!savAckClosureEnabled(process.env)) return { skipped: "off" };
  const finals = ACK_CLOSURE_FINAL_STEPS.map(step => actionOf(step));
  const rows = await requireDb().select({ id: savMessages.id }).from(savMessages).where(and(eq(savMessages.direction, "inbound"),
    gt(savMessages.receivedAt, new Date(Date.now() - 72 * 3_600_000)),
    sql`exists(select 1 from sav.threads t where t.id=${savMessages.threadId} and t.hubspot_ticket_id is not null)`,
    sql`exists(select 1 from sav.intake_console c where c.message_id=${savMessages.id} and c.epoch=c.projected_epoch and c.status='acknowledgement_only' and c.view='completed')`,
    sql`not exists(select 1 from sav.messages m where m.thread_id=${savMessages.threadId} and m.id<>${savMessages.id} and least(m.received_at,m.created_at)>=least(${savMessages.receivedAt},${savMessages.createdAt}))`,
    sql`not exists(select 1 from public.audit_logs a where a.entity_type=${ENTITY} and a.entity_id=${savMessages.id}::text and a.actor_email=${ACTOR} and a.action in (${sql.join(finals.map(a => sql`${a}`), sql`, `)}))`,
  )).orderBy(desc(savEffectiveReceivedAt), desc(savMessages.id)).limit(Math.max(1, Math.min(10, limit)));
  const results: Array<{ messageId: string; result: unknown }> = [];
  for (const row of rows) {
    if (Date.now() + 2000 >= deadlineMs) break;
    results.push({ messageId: row.id, result: await syncAckClosure(row.id) });
  }
  return { candidates: rows.length, results };
}
