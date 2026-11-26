// Ugo, 26/11: the durable side of the commercial forward (`commercial-forward.ts`). Receipts are `audit_logs` rows (no migration), one per step, keyed
// `<caseId>:<inputKey>`; the asks are stored encrypted; the lease is a `sav.sync_state` row; the Gmail calls are V1 routing's own (contact@limova.ai only);
// the authority is V1's execution policy with its right `route_intake_mail` (the right that already lets Studio forward a mail to sales) and neither
// agent paused. Entry points: `enqueueCommercialForward` (the V2 reply passage, before it proposes the reply), the targeted run right after it, and a
// bounded recovery sweep in the reconcile pass. A forward that ends without reaching sales hands the case to the team (`alertCommercialForwardTeam`).
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { requireDb } from "@/db";
import { auditLogs, savMailboxes, savMessages, savSyncState } from "@/db/schema";
import { decryptSavPayload, encryptSavPayload } from "../crypto";
import { assertSavAgentActionsAllowed } from "../intake/agent-pause";
import { intakeExecutionConfig, readIntakeExecutionAuthority } from "../intake/execution-policy";
import { SAV_INTAKE_ROUTING_MAILBOX, SAV_INTAKE_ROUTING_PERMISSION } from "../intake/routing-rules";
import { createIntakeRoutingGmail } from "../intake/routing-store";
import {
  COMMERCIAL_FORWARD_FINAL_STEPS, COMMERCIAL_FORWARD_STEPS, commercialForwardKey, forwardCommercialPart, SAV_COMMERCIAL_FORWARD_REVISION,
  type CommercialForwardDeps, type CommercialForwardFacts, type CommercialForwardStep, type CommercialForwardStore,
} from "./commercial-forward";

const ACTOR = "studio-v2";
const ENTITY = "sav_v2_commercial_forward";
const ATTEMPT = "sav_v2_commercial_forward_attempt";
const LEASE_SECONDS = 120;
/** A queued forward older than this is no longer swept (it stays visible in its receipts). */
const SWEEP_DAYS = 7;
/** The reason of the case's transfer when the commercial question did not reach sales: the team recontacts the customer about it. */
export const SAV_COMMERCIAL_FORWARD_HANDOFF_REASON = "commercial_forward_not_applied";
const actionOf = (step: CommercialForwardStep) => `sav_v2_commercial_forward_${step}`;
const where = (key: string, action: string) => and(eq(auditLogs.entityType, ENTITY), eq(auditLogs.entityId, key), eq(auditLogs.actorEmail, ACTOR), eq(auditLogs.action, action));

export const commercialForwardAuditStore: CommercialForwardStore = {
  async steps(key) {
    const rows = await requireDb().select({ action: auditLogs.action }).from(auditLogs)
      .where(and(eq(auditLogs.entityType, ENTITY), eq(auditLogs.entityId, key), eq(auditLogs.actorEmail, ACTOR)));
    return COMMERCIAL_FORWARD_STEPS.filter(step => rows.some(row => row.action === actionOf(step)));
  },
  async record(key, step, metadata) {
    return requireDb().transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sav-commercial-forward:${key}:${step}`}))`);
      const [existing] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(where(key, actionOf(step))).limit(1);
      if (existing) return false;
      await tx.insert(auditLogs).values({ actorEmail: ACTOR, action: actionOf(step), entityType: ENTITY, entityId: key, technicalMetadata: metadata });
      return true;
    });
  },
  async receipt(key, step) {
    const [row] = await requireDb().select({ metadata: auditLogs.technicalMetadata }).from(auditLogs).where(where(key, actionOf(step))).orderBy(asc(auditLogs.createdAt)).limit(1);
    return row?.metadata ?? null;
  },
  async lease(key) {
    const leaseKey = `sav-commercial-forward:${key}`, token = randomUUID();
    const taken = await requireDb().execute(sql`insert into sav.sync_state (key, cursor, status, started_at, updated_at) values (${leaseKey}, ${token}, 'leased', now(), now())
      on conflict (key) do update set cursor = excluded.cursor, status = 'leased', started_at = now(), updated_at = now()
      where sav.sync_state.status <> 'leased' or sav.sync_state.started_at < now() - make_interval(secs => ${LEASE_SECONDS})
      returning cursor`);
    const rows = (Array.isArray(taken) ? taken : (taken as { rows?: unknown[] }).rows ?? []) as Array<{ cursor?: unknown }>;
    if (rows[0]?.cursor !== token) return null;
    return async () => { await requireDb().update(savSyncState).set({ status: "idle", updatedAt: new Date() }).where(and(eq(savSyncState.key, leaseKey), eq(savSyncState.cursor, token))); };
  },
  async attempt(key, metadata) {
    const db = requireDb();
    await db.insert(auditLogs).values({ actorEmail: ACTOR, action: ATTEMPT, entityType: ENTITY, entityId: key, technicalMetadata: metadata });
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(where(key, ATTEMPT));
    return Number(row?.count ?? 0);
  },
};

export type EnqueueCommercialForwardResult = Readonly<{ ok: true; key: string; created: boolean }> | Readonly<{ ok: false; code: "trigger_not_inbound" | "no_ask" }>;

/**
 * The pending forward, recorded BEFORE the reply is proposed (a crash after it is resumed by the sweep; a replay finds the same key). Only a reply that
 * answers a stored customer mail (`inbound:<Gmail id>`) can be forwarded: anything else refuses, and the reply passage then proposes nothing.
 */
export async function enqueueCommercialForward(input: Readonly<{ caseId: string; inputKey: string; triggerEventId: string | null; asks: readonly string[] }>,
  store: CommercialForwardStore = commercialForwardAuditStore): Promise<EnqueueCommercialForwardResult> {
  const gmailMessageId = input.triggerEventId?.startsWith("inbound:") ? input.triggerEventId.slice("inbound:".length) : "";
  if (!/^[a-f0-9]{1,64}$/i.test(gmailMessageId)) return { ok: false, code: "trigger_not_inbound" };
  const asks = input.asks.map(ask => ask.trim()).filter(Boolean).slice(0, 4);
  if (!asks.length) return { ok: false, code: "no_ask" };
  const key = commercialForwardKey(input.caseId, input.inputKey);
  const created = await store.record(key, "queued", { revision: SAV_COMMERCIAL_FORWARD_REVISION, caseId: input.caseId, gmailMessageId, asksCiphertext: encryptSavPayload(asks),
    queuedAt: new Date().toISOString() });
  return { ok: true, key, created };
}

/** The stored mail the reply answers (contact@ only) and the queued asks, re-read now. Null: not queued, or the mail is not found. */
export async function readCommercialForwardFacts(key: string): Promise<CommercialForwardFacts | null> {
  const queued = await commercialForwardAuditStore.receipt(key, "queued");
  if (!queued || typeof queued.gmailMessageId !== "string" || typeof queued.asksCiphertext !== "string") return null;
  const db = requireDb();
  const [row] = await db.select({ message: savMessages, mailbox: savMailboxes.email }).from(savMessages).innerJoin(savMailboxes, eq(savMailboxes.id, savMessages.mailboxId))
    .where(and(eq(savMessages.gmailMessageId, queued.gmailMessageId), eq(savMessages.direction, "inbound"), eq(savMailboxes.email, SAV_INTAKE_ROUTING_MAILBOX))).limit(1);
  if (!row?.message.gmailMessageId) return null;
  const { message } = row;
  return {
    asks: decryptSavPayload<string[]>(queued.asksCiphertext),
    source: { mailboxEmail: row.mailbox.toLowerCase(), gmailMessageId: message.gmailMessageId!, gmailThreadId: "", fromEmail: message.fromEmail, subject: message.subject,
      receivedAt: message.receivedAt.toISOString(), text: decryptSavPayload<{ text: string }>(message.bodyCiphertext).text },
  };
}

/** V1's execution authority with the routing right, and neither agent paused. */
export async function commercialForwardAuthority(env: Record<string, string | undefined>) {
  const config = intakeExecutionConfig(env);
  if (!config) throw Error("SAV_COMMERCIAL_FORWARD_EXECUTION_OFF");
  const { policy } = await readIntakeExecutionAuthority(config);
  if (!policy.mutations.includes(SAV_INTAKE_ROUTING_PERMISSION)) throw Error("SAV_COMMERCIAL_FORWARD_PERMISSION_MISSING");
  await assertSavAgentActionsAllowed(requireDb(), "intake");
  await assertSavAgentActionsAllowed(requireDb(), "v2");
}

/**
 * Review M1 (26/11): a commercial question that did not reach sales is a person's task. The case still held by the agent is handed to the team (owner
 * `human`, phase `handoff_pending`, reason `commercial_forward_not_applied`), once per forward (command key from the forward's key): it then shows in
 * the team's queue and the existing handoff stage rule applies. A case a person already has is left as it is (they see the mail). Throws on failure
 * (the caller logs it; the final receipt is already written and the error log names the key).
 */
export async function alertCommercialForwardTeam(key: string) {
  const caseId = key.split(":")[0] ?? "";
  // Loaded here: the case store is heavy and only needed on this rare path.
  const { readCase, transitionCaseOwner } = await import("./case-store");
  const current = await readCase(caseId);
  if (!current || current.owner !== "agent") return;
  const commandKey = `commercial-forward-alert.${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
  await transitionCaseOwner({ caseId, expectedVersion: current.version, transition: "handoff", actor: { type: "agent" }, commandKey, reason: SAV_COMMERCIAL_FORWARD_HANDOFF_REASON });
}

export function commercialForwardDeps(env: () => Record<string, string | undefined> = () => process.env, signal?: AbortSignal): CommercialForwardDeps {
  return { authority: () => commercialForwardAuthority(env()), readFacts: readCommercialForwardFacts, store: commercialForwardAuditStore, gmail: createIntakeRoutingGmail(),
    alertTeam: alertCommercialForwardTeam, ...(signal ? { signal } : {}) };
}

/** Targeted run of one forward. Never throws. */
export async function syncCommercialForward(key: string, deps: CommercialForwardDeps = commercialForwardDeps()) {
  try {
    const result = await forwardCommercialPart(key, deps);
    if ("skipped" in result && result.skipped === "authority") console.warn("sav_commercial_forward_held", { detail: result.detail ?? null });
    return result;
  }
  catch (error) {
    console.error("sav_commercial_forward", { errorCode: error instanceof Error && /^SAV_[A-Z0-9_]+$/.test(error.message) ? error.message : "SAV_COMMERCIAL_FORWARD_FAILED" });
    return { skipped: "error" as const };
  }
}

/** Recovery, bounded: queued forwards of the last days without a final receipt (a dispatched one is always resumed to a read-back, never resent). */
export async function reconcileCommercialForwards(limit = 3, deadlineMs = Date.now() + 20_000, deps?: CommercialForwardDeps) {
  const db = requireDb(), bound = Math.max(1, Math.min(10, limit));
  const finals = sql.join(COMMERCIAL_FORWARD_FINAL_STEPS.map(step => sql`${actionOf(step)}`), sql`, `);
  const noFinal = sql`not exists(select 1 from public.audit_logs f where f.entity_type=${ENTITY} and f.entity_id=${auditLogs.entityId} and f.actor_email=${ACTOR} and f.action in (${finals}))`;
  const rows = await db.selectDistinct({ id: auditLogs.entityId }).from(auditLogs).where(and(eq(auditLogs.entityType, ENTITY), eq(auditLogs.actorEmail, ACTOR),
    eq(auditLogs.action, actionOf("queued")), noFinal, sql`${auditLogs.createdAt} > now() - make_interval(days => ${SWEEP_DAYS})`)).limit(bound);
  const results: Array<{ result: unknown }> = [];
  for (const row of rows) {
    if (Date.now() + 2000 >= deadlineMs) break;
    results.push({ result: await syncCommercialForward(row.id, deps) });
  }
  return { candidates: rows.length, results };
}
