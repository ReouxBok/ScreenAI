// V1 routing (Ugo, 23/11): the durable side. Decisions and receipts are `audit_logs` rows (no migration), the lease is a `sav.sync_state` row, facts are
// read from V1's own records (the current run of the mail, the stored thread and message), the authority is V1's execution policy with its own right
// `route_intake_mail`. Entry points: the decision record (shadow and live, right after the analysis), the targeted wake after V1's projection, and a
// bounded recovery sweep. The last two do nothing unless `SAV_INTAKE_ROUTING_MODE=live`.
import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb } from "@/db";
import { auditLogs, savCases, savIntakeRuns, savMailboxes, savMessages, savSyncState, savThreads } from "@/db/schema";
import { decryptSavPayload } from "../crypto";
import { requestSavGmail } from "../gmail";
import { savEffectiveReceivedAt } from "../message-order";
import { readSavExternalCompletion } from "../external-completion";
import { assertSavAgentActionsAllowed } from "./agent-pause";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "./execution-policy";
import type { GmailRequest } from "./execution-adapters";
import { savIntakeSafeArchiveEnabled, savIntakeSafeArchiveFacts } from "./to-validate-rules";
import { intakeRoutingModelFromSemantics, intakeRoutingPlanFacts, savIntakeRoutingMode, SAV_INTAKE_ROUTING_MAILBOX, SAV_INTAKE_ROUTING_PERMISSION,
  type SavIntakeRoutingDecision } from "./routing-rules";
import { INTAKE_ROUTING_FINAL_STEPS, routeIntakeMessage, type IntakeRoutingDeps, type IntakeRoutingGmail, type IntakeRoutingLiveFacts, type IntakeRoutingStep,
  type IntakeRoutingStore } from "./routing-effect";
import type { IntakeRuntimePayload } from "./runtime-contract";

const ACTOR = "studio-intake";
const ENTITY = "sav_message";
export const SAV_INTAKE_ROUTING_DECIDED = "sav_intake_routing_decided";
const ATTEMPT = "sav_intake_routing_attempt";
const LEASE_SECONDS = 120;
const actionOf = (step: IntakeRoutingStep) => `sav_intake_routing_${step}`;
const STEPS: readonly IntakeRoutingStep[] = ["claimed", "forward_dispatched", "forward_acked", "forward_confirmed", "confirmed", "not_applied", "uncertain"];

/** The decision of one analysed mail (shadow and live), codes and team recipient only: the measurable trace of the routing, and the live sweep's input. */
export async function recordIntakeRoutingDecision(decision: SavIntakeRoutingDecision & { mode: "shadow" | "live" }) {
  await requireDb().insert(auditLogs).values({ actorEmail: ACTOR, action: SAV_INTAKE_ROUTING_DECIDED, entityType: ENTITY, entityId: decision.messageId,
    technicalMetadata: { revision: decision.revision, mode: decision.mode, class: decision.class, confidence: decision.confidence, action: decision.action,
      recipient: decision.recipient, reason: decision.reason } });
}

export const intakeRoutingAuditStore: IntakeRoutingStore = {
  async steps(messageId) {
    const rows = await requireDb().select({ action: auditLogs.action }).from(auditLogs)
      .where(and(eq(auditLogs.entityType, ENTITY), eq(auditLogs.entityId, messageId), eq(auditLogs.actorEmail, ACTOR), sql`${auditLogs.action} like 'sav_intake_routing_%'`));
    return STEPS.filter(step => rows.some(row => row.action === actionOf(step)));
  },
  async record(messageId, step, metadata) {
    return requireDb().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sav-intake-routing:${messageId}:${step}`}))`);
      const [existing] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityType, ENTITY), eq(auditLogs.entityId, messageId),
        eq(auditLogs.actorEmail, ACTOR), eq(auditLogs.action, actionOf(step)))).limit(1);
      if (existing) return false;
      await tx.insert(auditLogs).values({ actorEmail: ACTOR, action: actionOf(step), entityType: ENTITY, entityId: messageId, technicalMetadata: metadata });
      return true;
    });
  },
  async lease(messageId) {
    const key = `sav-intake-routing:${messageId}`, token = randomUUID();
    const taken = await requireDb().execute(sql`insert into sav.sync_state (key, cursor, status, started_at, updated_at) values (${key}, ${token}, 'leased', now(), now())
      on conflict (key) do update set cursor = excluded.cursor, status = 'leased', started_at = now(), updated_at = now()
      where sav.sync_state.status <> 'leased' or sav.sync_state.started_at < now() - make_interval(secs => ${LEASE_SECONDS})
      returning cursor`);
    const rows = (Array.isArray(taken) ? taken : (taken as { rows?: unknown[] }).rows ?? []) as Array<{ cursor?: unknown }>;
    if (rows[0]?.cursor !== token) return null;
    return async () => { await requireDb().update(savSyncState).set({ status: "idle", updatedAt: new Date() }).where(and(eq(savSyncState.key, key), eq(savSyncState.cursor, token))); };
  },
  async receipt(messageId, step) {
    const [row] = await requireDb().select({ metadata: auditLogs.technicalMetadata }).from(auditLogs).where(and(eq(auditLogs.entityType, ENTITY),
      eq(auditLogs.entityId, messageId), eq(auditLogs.actorEmail, ACTOR), eq(auditLogs.action, actionOf(step)))).orderBy(asc(auditLogs.createdAt)).limit(1);
    return row?.metadata ?? null;
  },
  async attempt(messageId, metadata) {
    const db = requireDb();
    await db.insert(auditLogs).values({ actorEmail: ACTOR, action: ATTEMPT, entityType: ENTITY, entityId: messageId, technicalMetadata: metadata });
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(and(eq(auditLogs.entityType, ENTITY),
      eq(auditLogs.entityId, messageId), eq(auditLogs.actorEmail, ACTOR), eq(auditLogs.action, ATTEMPT)));
    return Number(row?.count ?? 0);
  },
};

/** The final receipt of a message (for the console), or null. */
export async function readIntakeRoutingFinal(messageId: string) {
  const finals = INTAKE_ROUTING_FINAL_STEPS.map(actionOf);
  const [row] = await requireDb().select({ action: auditLogs.action, metadata: auditLogs.technicalMetadata }).from(auditLogs).where(and(eq(auditLogs.entityType, ENTITY),
    eq(auditLogs.entityId, messageId), eq(auditLogs.actorEmail, ACTOR), sql`${auditLogs.action} in (${sql.join(finals.map(a => sql`${a}`), sql`, `)})`)).orderBy(asc(auditLogs.createdAt)).limit(1);
  if (!row) return null;
  return { step: STEPS.find(step => actionOf(step) === row.action)!, metadata: row.metadata };
}

/** V1's execution authority, with the routing right, and the agent not paused. */
export async function intakeRoutingAuthority(env: Record<string, string | undefined>) {
  if (savIntakeRoutingMode(env) !== "live") throw Error("SAV_INTAKE_ROUTING_OFF");
  const config = intakeExecutionConfig(env);
  if (!config) throw Error("SAV_INTAKE_ROUTING_EXECUTION_OFF");
  const { policy } = await readIntakeExecutionAuthority(config);
  if (!policy.mutations.includes(SAV_INTAKE_ROUTING_PERMISSION)) throw Error("SAV_INTAKE_ROUTING_PERMISSION_MISSING");
  await assertSavAgentActionsAllowed(requireDb());
}

/** The rule's facts re-read now from V1's records. Null only when the mail or its thread is not found. */
export async function readIntakeRoutingFacts(messageId: string): Promise<IntakeRoutingLiveFacts | null> {
  const db = requireDb();
  const [message] = await db.select().from(savMessages).where(eq(savMessages.id, messageId));
  if (!message || message.direction !== "inbound" || !message.gmailMessageId) return null;
  const [thread] = await db.select().from(savThreads).where(eq(savThreads.id, message.threadId));
  const [mailbox] = thread ? await db.select({ email: savMailboxes.email }).from(savMailboxes).where(eq(savMailboxes.id, thread.mailboxId)) : [];
  if (!thread || !mailbox) return null;
  const [run] = await db.select().from(savIntakeRuns).where(and(eq(savIntakeRuns.threadId, thread.id), eq(savIntakeRuns.isCurrent, true)));
  const payload = run && run.messageId === messageId ? decryptSavPayload<IntakeRuntimePayload>(run.payloadCiphertext) : null;
  const all = await db.select({ id: savMessages.id, direction: savMessages.direction }).from(savMessages).where(eq(savMessages.threadId, thread.id))
    .orderBy(desc(savEffectiveReceivedAt), desc(savMessages.createdAt), desc(savMessages.id));
  const latestInbound = all.find(row => row.direction === "inbound");
  const [v2] = await db.select({ id: savCases.id }).from(savCases)
    .where(thread.hubspotTicketId ? sql`${savCases.ticketId} = ${thread.hubspotTicketId} or ${thread.id}::uuid = any(${savCases.threadIds})` : sql`${thread.id}::uuid = any(${savCases.threadIds})`).limit(1);
  const input = payload?.input as { message?: { operatorInformation?: unknown; currentText?: string; fromEmail?: string }; humanResolution?: unknown; priorRequestReview?: unknown } | undefined;
  const stored = payload?.routing ?? null;
  const model = intakeRoutingModelFromSemantics(payload?.semantics, messageId);
  // SAV-139: the same server-checked safe-archive facts as the analysis, only with `SAV_INTAKE_SAFE_ARCHIVE=on`.
  const analysed = typeof input?.message?.currentText === "string" && typeof input.message.fromEmail === "string" ? { currentText: input.message.currentText, fromEmail: input.message.fromEmail, subject: message.subject } : null;
  const safeArchive = savIntakeSafeArchiveEnabled(process.env) ? savIntakeSafeArchiveFacts({ plan: payload?.plan, message: analysed, routing: model }) : null;
  return {
    stored,
    facts: { messageId, model, plan: intakeRoutingPlanFacts(payload?.plan), ...(safeArchive ? { safeArchive } : {}),
      thread: { conversationLength: all.length, ticketId: thread.hubspotTicketId ?? null,
        humanContext: Boolean(thread.aiPaused || thread.humanRequestedAt || run?.humanChoiceCiphertext || input?.message?.operatorInformation || input?.humanResolution || input?.priorRequestReview),
        // Checked on the analysed mail (its quote headers); a stored routed decision proves it passed.
        quotedReply: stored?.reason === "reply_to_team",
        v2Case: Boolean(v2), newerMessage: latestInbound?.id !== messageId, handledExternally: Boolean(await readSavExternalCompletion(message)) } },
    source: { mailboxEmail: mailbox.email.toLowerCase(), gmailMessageId: message.gmailMessageId, gmailThreadId: thread.gmailThreadId, fromEmail: message.fromEmail,
      subject: message.subject, receivedAt: message.receivedAt.toISOString(), text: decryptSavPayload<{ text: string }>(message.bodyCiphertext).text },
  };
}

const sentList = z.object({ messages: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(), nextPageToken: z.string().optional() }).passthrough();
const threadLabels = z.object({ id: z.string(), messages: z.array(z.object({ labelIds: z.array(z.string()).optional() }).passthrough()).min(1) }).passthrough();
const rawMessage = z.object({ id: z.string(), raw: z.string().min(1) }).passthrough();
const sentMetadata = z.object({ id: z.string(), labelIds: z.array(z.string()).optional(),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() }).passthrough().optional() }).passthrough();
const gmailId = (value: string) => { if (!/^[a-f0-9]{1,64}$/i.test(value)) throw Error("SAV_INTAKE_ROUTING_GMAIL_ID_INVALID"); return value; };
/** Gmail calls of the routing, on contact@limova.ai only. */
export function createIntakeRoutingGmail(gmail: GmailRequest = requestSavGmail): IntakeRoutingGmail {
  const mailbox = (email: string) => { if (email !== SAV_INTAKE_ROUTING_MAILBOX) throw Error("SAV_INTAKE_ROUTING_MAILBOX_REFUSED"); return email; };
  return {
    async readOriginal(email, messageId, signal) {
      const message = rawMessage.parse(await gmail<unknown>(mailbox(email), `messages/${gmailId(messageId)}?format=raw`, { signal }));
      if (message.id !== messageId) throw Error("SAV_INTAKE_ROUTING_ORIGINAL_MISMATCH");
      return Buffer.from(message.raw, "base64url");
    },
    send: (email, raw, signal) => gmail<{ id: string; threadId: string }>(mailbox(email), "messages/send", { method: "POST", signal, body: JSON.stringify({ raw: raw.toString("base64url") }) }),
    async sentMessageId(email, messageId, signal) {
      let message: z.infer<typeof sentMetadata>;
      try { message = sentMetadata.parse(await gmail<unknown>(mailbox(email), `messages/${gmailId(messageId)}?format=metadata&metadataHeaders=Message-ID`, { signal })); }
      catch (error) { if (error instanceof Error && /^GMAIL_HTTP_(404|410)$/.test(error.message)) return null; throw error; }
      if (message.id !== messageId || !message.labelIds?.includes("SENT")) return null;
      return message.payload?.headers?.find(h => h.name.toLowerCase() === "message-id")?.value ?? null;
    },
    async findSent(email, rfcMessageId, signal) {
      const query = new URLSearchParams({ q: `in:sent rfc822msgid:${rfcMessageId}`, maxResults: "2" });
      const list = sentList.parse(await gmail<unknown>(mailbox(email), `messages?${query}`, { signal }));
      if (!list.messages?.length) return null;
      if (list.messages.length !== 1 || list.nextPageToken) throw Error("SAV_INTAKE_ROUTING_FORWARD_AMBIGUOUS");
      return list.messages[0]!.id;
    },
    async archive(email, threadId, signal) {
      const path = `threads/${gmailId(threadId)}`;
      await gmail(mailbox(email), `${path}/modify`, { method: "POST", signal, body: JSON.stringify({ removeLabelIds: ["INBOX"] }) });
      const after = threadLabels.parse(await gmail<unknown>(email, `${path}?format=minimal`, { signal }));
      return after.id === threadId && after.messages.every(m => !m.labelIds?.includes("INBOX"));
    },
  };
}

export function intakeRoutingDeps(env: () => Record<string, string | undefined> = () => process.env): IntakeRoutingDeps {
  return { env, authority: () => intakeRoutingAuthority(env()), readFacts: readIntakeRoutingFacts, store: intakeRoutingAuditStore, gmail: createIntakeRoutingGmail() };
}

/** Targeted entry after V1's analysis of a mail. Never throws; nothing at all unless `SAV_INTAKE_ROUTING_MODE=live`. */
export async function syncIntakeRouting(messageId: string, deps?: IntakeRoutingDeps) {
  const resolved = deps ?? intakeRoutingDeps();
  if (savIntakeRoutingMode(resolved.env()) !== "live") return { skipped: "off" as const };
  try { return await routeIntakeMessage(messageId, resolved); }
  catch (error) {
    console.error("sav_intake_routing", { messageId, errorCode: error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_INTAKE_ROUTING_FAILED" });
    return { skipped: "error" as const };
  }
}

/** Recovery, bounded: first every dispatched forward without a final receipt (always resumed to a read-back), then live routed decisions of the last
 * 72 hours without a final receipt. */
export async function reconcileIntakeRoutings(limit = 3, deadlineMs = Date.now() + 20_000, deps?: IntakeRoutingDeps) {
  if (savIntakeRoutingMode(deps?.env() ?? process.env) !== "live") return { skipped: "off" };
  const db = requireDb(), bound = Math.max(1, Math.min(10, limit));
  const finals = sql.join(INTAKE_ROUTING_FINAL_STEPS.map(step => sql`${actionOf(step)}`), sql`, `);
  const noFinal = sql`not exists(select 1 from public.audit_logs f where f.entity_type=${ENTITY} and f.entity_id=${auditLogs.entityId} and f.actor_email=${ACTOR} and f.action in (${finals}))`;
  const rows = await db.selectDistinct({ id: auditLogs.entityId }).from(auditLogs).where(and(eq(auditLogs.entityType, ENTITY), eq(auditLogs.actorEmail, ACTOR), noFinal,
    sql`(${auditLogs.action} = ${actionOf("forward_dispatched")} or (${auditLogs.action} = ${SAV_INTAKE_ROUTING_DECIDED} and ${auditLogs.technicalMetadata}->>'mode' = 'live'
      and ${auditLogs.technicalMetadata}->>'action' in ('forward','archive') and ${auditLogs.createdAt} > now() - interval '72 hours'))`)).limit(bound);
  const results: Array<{ messageId: string; result: unknown }> = [];
  for (const row of rows) {
    if (Date.now() + 2000 >= deadlineMs) break;
    results.push({ messageId: row.id, result: await syncIntakeRouting(row.id, deps) });
  }
  return { candidates: rows.length, results };
}
